export interface ReplayTelemetry {
  captureException(error: Error, context?: Record<string, unknown>): void;
}

export const noOpTelemetry: ReplayTelemetry = {
  captureException: () => undefined,
};

export function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
