import type { eventWithTime } from "./rrweb-types";
import type { mobileEventWithTime } from "./mobile.types";
import { noOpTelemetry, type ReplayTelemetry } from "./vendorSupport";
import { makeCustomEvent, makeFullEvent, makeIncrementalEvent, makeMetaEvent } from "./transformer/transformers";

function couldBeEventWithTime(value: unknown): value is eventWithTime | mobileEventWithTime {
  return typeof value === "object" && value !== null && "type" in value && "timestamp" in value;
}

export function transformEventToWeb(event: unknown, telemetry: ReplayTelemetry = noOpTelemetry): eventWithTime {
  let result = event as eventWithTime;

  try {
    if (couldBeEventWithTime(event)) {
      const transformers: Record<number, (value: any) => eventWithTime> = {
        2: makeFullEvent,
        3: makeIncrementalEvent,
        4: makeMetaEvent,
        5: value => makeCustomEvent(value, telemetry),
      };
      const transformer = transformers[event.type];
      if (transformer) {
        result = transformer(event);
      }
    }
  } catch (error) {
    telemetry.captureException(error as Error, { event });
  }

  return result;
}
