import { gzipSync } from "node:zlib";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MOBILE_REPLAY_COMPRESSED_LIMIT_BYTES,
  MOBILE_REPLAY_EXPANDED_LIMIT_BYTES,
  mobileSessionReplayRouteOptions,
  recordMobileSessionReplay,
} from "./recordMobileSessionReplay.js";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  decideSiteExclusion: vi.fn(),
  isSiteOverLimit: vi.fn(),
  isSiteWithoutReplay: vi.fn(),
  recordEvents: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("../../lib/siteConfig.js", () => ({
  siteConfig: { getConfig: mocks.getConfig },
}));

vi.mock("../../services/sites/siteExclusionDecision.js", () => ({
  decideSiteExclusion: mocks.decideSiteExclusion,
}));

vi.mock("../../services/usageService.js", () => ({
  usageService: {
    isSiteOverLimit: mocks.isSiteOverLimit,
    isSiteWithoutReplay: mocks.isSiteWithoutReplay,
  },
}));

vi.mock("../../services/replay/sessionReplayIngestService.js", () => ({
  SessionReplayIngestService: vi.fn().mockImplementation(() => ({
    recordEvents: mocks.recordEvents,
  })),
}));

const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const image = `data:image/webp;base64,${Buffer.from("mobile screenshot").toString("base64")}`;

function postHogBatch(overrides: Record<string, unknown> = {}) {
  return {
    api_key: "site_public_key",
    batch: [
      {
        event: "$snapshot",
        distinct_id: "mobile-user-1",
        timestamp: "2026-09-27T12:34:56.789Z",
        properties: {
          $session_id: sessionId,
          $snapshot_source: "mobile",
          $screen_width: 390,
          $screen_height: 844,
          $screen_name: "Home",
          $snapshot_data: [
            { type: 4, timestamp: 1_796_000_096_700, data: { href: "Home", width: 390, height: 844 } },
            {
              type: 2,
              timestamp: 1_796_000_096_789,
              data: { wireframes: [{ id: 1, type: "screenshot", base64: image }] },
            },
          ],
        },
        ...overrides,
      },
    ],
  };
}

function requestFor(body: unknown) {
  return {
    params: { siteId: "site_public_key" },
    body,
    headers: {
      "user-agent": "PostHogReactNative/4.78.0",
      origin: "capacitor://localhost",
      referer: "",
    },
    ip: "198.51.100.20",
    log: { info: mocks.loggerInfo, error: mocks.loggerError },
  } as unknown as FastifyRequest<{ Params: { siteId: string }; Body: unknown }>;
}

function replyStub() {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  return reply as unknown as FastifyReply & typeof reply;
}

describe("mobile replay route protection", () => {
  it("rate-limits by site and IP before decompressing request bodies", () => {
    const rateLimit = mobileSessionReplayRouteOptions.config?.rateLimit;
    expect(rateLimit).toMatchObject({
      hook: "onRequest",
      max: 300,
      timeWindow: "1 minute",
      skipOnError: false,
    });
    expect(rateLimit).toBeTypeOf("object");
    if (!rateLimit || typeof rateLimit.keyGenerator !== "function") {
      throw new Error("mobile replay route is missing its rate-limit key generator");
    }
    expect(rateLimit.keyGenerator(requestFor(postHogBatch()))).toBe(
      "mobile-replay:site_public_key:198.51.100.20",
    );
  });
});

describe("recordMobileSessionReplay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockResolvedValue({ siteId: 42, sessionReplay: true });
    mocks.decideSiteExclusion.mockResolvedValue({ excluded: false });
    mocks.isSiteOverLimit.mockReturnValue(false);
    mocks.isSiteWithoutReplay.mockReturnValue(false);
    mocks.recordEvents.mockResolvedValue(undefined);
  });

  it("normalizes a PostHog mobile snapshot batch and preserves its UUID session", async () => {
    const reply = replyStub();

    await recordMobileSessionReplay(requestFor(postHogBatch()), reply);

    expect(mocks.recordEvents).toHaveBeenCalledWith(
      42,
      {
        userId: "mobile-user-1",
        sessionId,
        replaySource: "react-native",
        events: [
          { type: 4, timestamp: 1_796_000_096_700, data: { href: "Home", width: 390, height: 844 } },
          {
            type: 2,
            timestamp: 1_796_000_096_789,
            data: { wireframes: [{ id: 1, type: "screenshot", base64: image }] },
          },
        ],
        metadata: {
          pageUrl: "app://Home",
          viewportWidth: 390,
          viewportHeight: 844,
          decodedImageSizeBytes: Buffer.byteLength("mobile screenshot"),
        },
      },
      {
        userAgent: "PostHogReactNative/4.78.0",
        ipAddress: "198.51.100.20",
        origin: "capacitor://localhost",
        referrer: "",
      }
    );
    expect(reply.payload).toEqual({ success: true, eventCount: 2 });
  });

  it("rejects mixed client session IDs", async () => {
    const payload = postHogBatch();
    payload.batch.push({
      ...payload.batch[0],
      properties: { ...payload.batch[0].properties, $session_id: "223e4567-e89b-42d3-a456-426614174000" },
    });
    const reply = replyStub();

    await recordMobileSessionReplay(requestFor(payload), reply);

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ error: "All snapshot events must use the same session ID" });
    expect(mocks.recordEvents).not.toHaveBeenCalled();
  });

  it("rejects malformed session IDs, timestamps, dimensions, and image base64", async () => {
    const cases = [
      { properties: { ...postHogBatch().batch[0].properties, $session_id: "not-a-uuid" } },
      { timestamp: "not-a-timestamp" },
      { properties: { ...postHogBatch().batch[0].properties, $screen_width: 100_000 } },
      {
        properties: {
          ...postHogBatch().batch[0].properties,
          $snapshot_data: [{ type: 2, timestamp: 1_796_000_096_789, data: { base64: "data:image/webp;base64,***" } }],
        },
      },
    ];

    for (const invalidEvent of cases) {
      const reply = replyStub();
      await recordMobileSessionReplay(requestFor(postHogBatch(invalidEvent)), reply);
      expect(reply.statusCode).toBe(400);
    }
    expect(mocks.recordEvents).not.toHaveBeenCalled();
  });

  it("rejects decoded images over the batch limit", async () => {
    const oversizedImage = `data:image/webp;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64")}`;
    const payload = postHogBatch({
      properties: {
        ...postHogBatch().batch[0].properties,
        $snapshot_data: [{ type: 2, timestamp: 1_796_000_096_789, data: { wireframes: [{ base64: oversizedImage }] } }],
      },
    });
    const reply = replyStub();

    await recordMobileSessionReplay(requestFor(payload), reply);

    expect(reply.statusCode).toBe(413);
    expect(mocks.recordEvents).not.toHaveBeenCalled();
  });

  it("honors site replay configuration and entitlement before ingest", async () => {
    mocks.isSiteWithoutReplay.mockReturnValue(true);
    const reply = replyStub();

    await recordMobileSessionReplay(requestFor(postHogBatch()), reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({ success: true, message: "Session replay not available for plan or quota" });
    expect(mocks.recordEvents).not.toHaveBeenCalled();
  });

  it("does not ingest native replay blocked by a Site Exclusion Decision", async () => {
    mocks.decideSiteExclusion.mockResolvedValue({ excluded: true, reason: "ip", label: "IP" });
    const reply = replyStub();

    await recordMobileSessionReplay(requestFor(postHogBatch()), reply);

    expect(reply.payload).toEqual({ success: true, message: "Session replay not recorded - IP excluded" });
    expect(mocks.recordEvents).not.toHaveBeenCalled();
  });
});

describe("mobile replay gzip route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockResolvedValue({ siteId: 42, sessionReplay: true });
    mocks.decideSiteExclusion.mockResolvedValue({ excluded: false });
    mocks.isSiteOverLimit.mockReturnValue(false);
    mocks.isSiteWithoutReplay.mockReturnValue(false);
    mocks.recordEvents.mockResolvedValue(undefined);
  });

  async function buildApp() {
    const app = Fastify();
    app.post<{ Params: { siteId: string }; Body: unknown }>(
      "/session-replay/mobile/:siteId",
      mobileSessionReplayRouteOptions,
      recordMobileSessionReplay
    );
    await app.ready();
    return app;
  }

  it("decompresses a gzipped JSON body", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/session-replay/mobile/site_public_key",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      payload: gzipSync(JSON.stringify(postHogBatch())),
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, eventCount: 2 });
  });

  it("rejects compressed request bodies over the compressed limit", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/session-replay/mobile/site_public_key",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      payload: Buffer.alloc(MOBILE_REPLAY_COMPRESSED_LIMIT_BYTES + 1),
    });
    await app.close();

    expect(response.statusCode).toBe(413);
  });

  it("accepts identity-encoded bodies larger than the compressed limit", async () => {
    const app = await buildApp();
    const payload = postHogBatch();
    Object.assign(payload.batch[0].properties, {
      $sdk_padding: "x".repeat(MOBILE_REPLAY_COMPRESSED_LIMIT_BYTES + 1),
    });
    const response = await app.inject({
      method: "POST",
      url: "/session-replay/mobile/site_public_key",
      headers: { "content-type": "application/json" },
      payload,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
  });

  it("rejects gzip bombs over the expanded limit", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/session-replay/mobile/site_public_key",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      payload: gzipSync(Buffer.alloc(MOBILE_REPLAY_EXPANDED_LIMIT_BYTES + 1, 32)),
    });
    await app.close();

    expect(response.statusCode).toBe(413);
  });

  it("rejects unsupported content encodings", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/session-replay/mobile/site_public_key",
      headers: { "content-type": "application/json", "content-encoding": "br" },
      payload: Buffer.from("{}"),
    });
    await app.close();

    expect(response.statusCode).toBe(415);
  });
});
