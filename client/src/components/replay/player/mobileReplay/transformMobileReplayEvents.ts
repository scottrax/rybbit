import { transformEventToWeb } from "./posthogReplayShared";

export interface ReplayEvent {
  timestamp: number;
  type: string | number;
  data: any;
  [key: string]: unknown;
}

function isPostHogMobileFullSnapshot(event: ReplayEvent): boolean {
  return (
    Number(event.type) === 2 &&
    typeof event.data === "object" &&
    event.data !== null &&
    Array.isArray(event.data.wireframes)
  );
}

function sanitizeStyle(style: Record<string, unknown>): void {
  for (const [property, value] of Object.entries(style)) {
    if (property !== "backgroundImage" && typeof value === "string" && /[;{}]|url\s*\(/i.test(value)) {
      delete style[property];
    }
  }
}

function sanitizeMobileStyles(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(sanitizeMobileStyles);
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }

  for (const [property, child] of Object.entries(value)) {
    if (property === "style" && typeof child === "object" && child !== null && !Array.isArray(child)) {
      sanitizeStyle(child as Record<string, unknown>);
    }
    sanitizeMobileStyles(child);
  }
}

/**
 * Converts PostHog's React Native wireframe protocol to rrweb's web protocol.
 * Web recordings are returned by reference and remain entirely untouched.
 */
export function transformMobileReplayEvents<T extends ReplayEvent>(events: T[]): ReplayEvent[] | T[] {
  if (!events.some(isPostHogMobileFullSnapshot)) {
    return events;
  }

  return events.map(event => {
    const mobileEvent = structuredClone(event);
    mobileEvent.type = Number(mobileEvent.type);
    sanitizeMobileStyles(mobileEvent.data);
    return transformEventToWeb(mobileEvent) as ReplayEvent;
  });
}
