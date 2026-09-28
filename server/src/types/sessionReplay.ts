export interface SessionReplayEvent {
  siteId: number;
  sessionId: string;
  userId: string;
  identifiedUserId?: string;
  replaySource?: string;
  timestamp: Date;
  eventType: string;
  eventData: string;
  sequenceNumber: number;
  eventSizeBytes: number;
  viewportWidth?: number;
  viewportHeight?: number;
  isComplete: boolean;
}

export interface SessionReplayMetadata {
  siteId: number;
  sessionId: string;
  userId: string;
  identifiedUserId?: string;
  replaySource?: string;
  startTime: Date;
  endTime?: Date;
  durationMs?: number;
  eventCount: number;
  compressedSizeBytes: number;
  pageUrl: string;
  country: string;
  region: string;
  city: string;
  lat: number;
  lon: number;
  browser: string;
  browserVersion: string;
  operatingSystem: string;
  operatingSystemVersion: string;
  language: string;
  screenWidth: number;
  screenHeight: number;
  deviceType: string;
  channel: string;
  hostname: string;
  referrer: string;
  hasReplayData: boolean;
  recordingStatus: "recording" | "completed" | "failed";
  createdAt: Date;
}

export interface RecordSessionReplayRequest {
  userId: string;
  /** Validated client session ID used by native replay SDKs to correlate analytics. */
  sessionId?: string;
  replaySource?: "react-native";
  events: Array<{
    type: string | number;
    data: any;
    timestamp: number;
  }>;
  metadata?: {
    pageUrl: string;
    viewportWidth?: number;
    viewportHeight?: number;
    language?: string;
    decodedImageSizeBytes?: number;
  };
  apiKey?: string;
}

export interface MobileSessionReplayRequest extends RecordSessionReplayRequest {
  sessionId: string;
  replaySource: "react-native";
}

export interface SessionReplayListItem {
  sessionId: string;
  userId: string;
  identifiedUserId?: string;
  replaySource?: string;
  startTime: Date;
  endTime?: Date;
  durationMs?: number;
  pageUrl: string;
  eventCount: number;
  recordingStatus: string;
  country: string;
  browser: string;
  deviceType: string;
}

export interface GetSessionReplayEventsResponse {
  events: Array<{
    timestamp: number;
    type: string;
    data: any;
  }>;
  metadata: SessionReplayMetadata;
}
