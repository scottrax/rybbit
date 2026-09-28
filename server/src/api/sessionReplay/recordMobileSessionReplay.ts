import { Transform, type TransformCallback } from "node:stream";
import { createGunzip } from "node:zlib";
import { type FastifyReply, type FastifyRequest, type RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { siteConfig } from "../../lib/siteConfig.js";
import { SessionReplayIngestService } from "../../services/replay/sessionReplayIngestService.js";
import { usageService } from "../../services/usageService.js";
import { decideSiteExclusion } from "../../services/sites/siteExclusionDecision.js";
import { collectCandidateClientIps, resolveClientIp } from "../../services/tracker/resolveClientIp.js";
import type { MobileSessionReplayRequest } from "../../types/sessionReplay.js";

export const MOBILE_REPLAY_COMPRESSED_LIMIT_BYTES = 5 * 1024 * 1024;
export const MOBILE_REPLAY_EXPANDED_LIMIT_BYTES = 20 * 1024 * 1024;
const MOBILE_REPLAY_DECODED_IMAGE_LIMIT_BYTES = 10 * 1024 * 1024;
const MOBILE_REPLAY_EVENT_LIMIT = 1_000;
const MAX_DIMENSION = 16_384;
const MIN_EVENT_TIMESTAMP = Date.UTC(2000, 0, 1);
const MAX_EVENT_TIMESTAMP = Date.UTC(2100, 0, 1);
const DATA_IMAGE_PREFIX = /^data:image\/(?:png|jpe?g|webp);base64,/i;

class HttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
  }
}

class CompressedBodyLimit extends Transform {
  receivedEncodedLength = 0;

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.receivedEncodedLength += chunk.length;
    if (this.receivedEncodedLength > MOBILE_REPLAY_COMPRESSED_LIMIT_BYTES) {
      callback(new HttpError("Compressed session replay body is too large", 413));
      return;
    }
    callback(null, chunk);
  }
}

function contentEncoding(request: FastifyRequest): string {
  const value = request.headers["content-encoding"];
  return (Array.isArray(value) ? value[0] : value || "identity").trim().toLowerCase();
}

export const mobileSessionReplayRouteOptions: RouteShorthandOptions = {
  bodyLimit: MOBILE_REPLAY_EXPANDED_LIMIT_BYTES,
  preParsing: async (request, _reply, payload) => {
    const encoding = contentEncoding(request);
    if (encoding !== "identity" && encoding !== "gzip") {
      throw new HttpError(`Unsupported content encoding: ${encoding}`, 415);
    }
    if (encoding === "identity") {
      return payload;
    }

    const declaredLength = Number(request.headers["content-length"] || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MOBILE_REPLAY_COMPRESSED_LIMIT_BYTES) {
      throw new HttpError("Compressed session replay body is too large", 413);
    }

    const limiter = new CompressedBodyLimit();
    payload.pipe(limiter);
    const decompressed = limiter.pipe(createGunzip()) as ReturnType<typeof createGunzip> & {
      receivedEncodedLength?: number;
    };
    Object.defineProperty(decompressed, "receivedEncodedLength", {
      configurable: true,
      get: () => limiter.receivedEncodedLength,
    });
    return decompressed;
  },
};

const timestampSchema = z.number().finite().int().min(MIN_EVENT_TIMESTAMP).max(MAX_EVENT_TIMESTAMP);
const dimensionSchema = z.number().finite().int().positive().max(MAX_DIMENSION);
const snapshotDataSchema = z.object({
  type: z.union([z.string().min(1).max(64), z.number().finite().int()]),
  timestamp: timestampSchema,
  data: z.unknown(),
});

const mobileSnapshotSchema = z.object({
  event: z.literal("$snapshot"),
  distinct_id: z.string().min(1).max(512).optional(),
  timestamp: z.string().datetime({ offset: true }),
  properties: z
    .object({
      $session_id: z.string().uuid(),
      $snapshot_source: z.literal("mobile").optional(),
      $snapshot_data: z.array(snapshotDataSchema).min(1).max(MOBILE_REPLAY_EVENT_LIMIT),
      $screen_width: dimensionSchema.optional(),
      $screen_height: dimensionSchema.optional(),
      distinct_id: z.string().min(1).max(512).optional(),
      $device_id: z.string().min(1).max(512).optional(),
      $locale: z.string().min(1).max(64).optional(),
      $current_url: z.string().max(2_048).optional(),
      $screen_name: z.string().max(512).optional(),
    })
    .passthrough(),
});

const mobileBatchSchema = z.object({
  api_key: z.string().min(1).max(512).optional(),
  batch: z.array(mobileSnapshotSchema).min(1).max(100),
});

type ParsedSnapshot = z.infer<typeof mobileSnapshotSchema>;

function decodedBase64Size(value: string): number {
  const comma = value.indexOf(",");
  const encoded = value.slice(comma + 1).replace(/\s/g, "");
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new HttpError("Invalid base64 image in mobile replay", 400);
  }
  const firstPadding = encoded.indexOf("=");
  if (firstPadding !== -1 && firstPadding < encoded.length - 2) {
    throw new HttpError("Invalid base64 image in mobile replay", 400);
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return (encoded.length / 4) * 3 - padding;
}

function validateAndMeasureImages(values: unknown[]): number {
  const stack = [...values];
  const seen = new Set<object>();
  let visited = 0;
  let decodedBytes = 0;

  while (stack.length > 0) {
    const value = stack.pop();
    visited += 1;
    if (visited > 100_000) {
      throw new HttpError("Mobile replay payload is too complex", 400);
    }
    if (typeof value === "string" && value.startsWith("data:image/")) {
      if (!DATA_IMAGE_PREFIX.test(value)) {
        throw new HttpError("Unsupported image data URL in mobile replay", 400);
      }
      decodedBytes += decodedBase64Size(value);
      if (decodedBytes > MOBILE_REPLAY_DECODED_IMAGE_LIMIT_BYTES) {
        throw new HttpError("Decoded mobile replay images are too large", 413);
      }
    } else if (value && typeof value === "object") {
      if (seen.has(value)) continue;
      seen.add(value);
      if (Array.isArray(value)) stack.push(...value);
      else stack.push(...Object.values(value));
    }
  }

  return decodedBytes;
}

function dimensions(snapshot: ParsedSnapshot): { width?: number; height?: number } {
  let width = snapshot.properties.$screen_width;
  let height = snapshot.properties.$screen_height;
  for (const event of snapshot.properties.$snapshot_data) {
    if (event.type !== 4 || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) continue;
    const data = event.data as Record<string, unknown>;
    if (width === undefined && typeof data.width === "number") width = dimensionSchema.parse(data.width);
    if (height === undefined && typeof data.height === "number") height = dimensionSchema.parse(data.height);
  }
  return { width, height };
}

function normalizeMobileBatch(body: unknown): MobileSessionReplayRequest {
  const parsed = mobileBatchSchema.parse(body);
  const sessionId = parsed.batch[0].properties.$session_id;
  if (parsed.batch.some(snapshot => snapshot.properties.$session_id !== sessionId)) {
    throw new HttpError("All snapshot events must use the same session ID", 400);
  }

  const events = parsed.batch.flatMap(snapshot =>
    snapshot.properties.$snapshot_data.map(event => ({
      type: event.type,
      timestamp: event.timestamp,
      data: event.data,
    }))
  );
  if (events.length > MOBILE_REPLAY_EVENT_LIMIT) {
    throw new HttpError(`Mobile replay batches may contain at most ${MOBILE_REPLAY_EVENT_LIMIT} events`, 400);
  }

  const decodedImageSizeBytes = validateAndMeasureImages(events.map(event => event.data));
  const { width, height } = dimensions(parsed.batch[0]);
  if (width === undefined || height === undefined) {
    throw new HttpError("Mobile replay dimensions are required", 400);
  }

  const first = parsed.batch[0];
  const userId = first.distinct_id || first.properties.distinct_id || first.properties.$device_id || "";
  if (!userId) {
    throw new HttpError("Mobile replay distinct ID is required", 400);
  }
  const pageUrl =
    first.properties.$current_url || `app://${encodeURIComponent(first.properties.$screen_name || "unknown")}`;
  const metadata: MobileSessionReplayRequest["metadata"] = {
    pageUrl,
    viewportWidth: width,
    viewportHeight: height,
    decodedImageSizeBytes,
  };
  if (first.properties.$locale) metadata.language = first.properties.$locale;

  return {
    userId,
    sessionId,
    replaySource: "react-native",
    events,
    metadata,
  };
}

export async function recordMobileSessionReplay(
  request: FastifyRequest<{ Params: { siteId: string }; Body: unknown }>,
  reply: FastifyReply
) {
  try {
    const siteConfiguration = await siteConfig.getConfig(request.params.siteId);
    if (!siteConfiguration?.siteId) {
      return reply.status(404).send({ error: "Site not found" });
    }
    const siteId = Number(siteConfiguration.siteId);
    if (!siteConfiguration.sessionReplay) {
      request.log.info({ siteId }, "Skipping mobile session replay because replay is not enabled");
      return reply.status(200).send({ success: true, message: "Session replay not enabled" });
    }
    if (usageService.isSiteOverLimit(siteId)) {
      request.log.info({ siteId }, "Skipping mobile session replay because the Site is over its monthly limit");
      return reply.status(200).send({ success: true, message: "Site over monthly limit, event not tracked" });
    }
    if (usageService.isSiteWithoutReplay(siteId)) {
      request.log.info({ siteId }, "Skipping mobile session replay because replay is unavailable for plan or quota");
      return reply.status(200).send({ success: true, message: "Session replay not available for plan or quota" });
    }

    const body = normalizeMobileBatch(request.body);
    const requestIP = resolveClientIp(request, { firstPartyProxy: siteConfiguration.firstPartyProxy });
    const userAgent = String(request.headers["user-agent"] || "");
    let pageContext: { hostname?: string; pathname?: string; querystring?: string } = {};
    try {
      const pageUrl = new URL(body.metadata?.pageUrl || "");
      pageContext = { hostname: pageUrl.hostname, pathname: pageUrl.pathname, querystring: pageUrl.search };
    } catch {
      // Mobile screen names are allowed to be non-URL identifiers.
    }
    const exclusionDecision = await decideSiteExclusion(siteConfiguration, {
      ipAddress: requestIP,
      candidateIps: collectCandidateClientIps(request, [requestIP]),
      ...pageContext,
      userAgent,
    });
    if (exclusionDecision.excluded) {
      request.log.info(
        { siteId, exclusionReason: exclusionDecision.reason },
        "Skipping mobile session replay because a Site Exclusion Decision matched"
      );
      return reply.status(200).send({
        success: true,
        message: `Session replay not recorded - ${exclusionDecision.label} excluded`,
      });
    }

    const service = new SessionReplayIngestService();
    await service.recordEvents(siteId, body, {
      userAgent,
      ipAddress: requestIP,
      origin: String(request.headers.origin || ""),
      referrer: String(request.headers.referer || ""),
    });
    return reply.send({ success: true, eventCount: body.events.length });
  } catch (error) {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ error: error.message });
    }
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ error: error.errors });
    }
    request.log.error({ err: error }, "Error recording mobile session replay");
    return reply.status(500).send({ error: "Internal server error" });
  }
}
