export enum EventType {
  DomContentLoaded = 0,
  Load = 1,
  FullSnapshot = 2,
  IncrementalSnapshot = 3,
  Meta = 4,
  Custom = 5,
  Plugin = 6,
}

export enum IncrementalSource {
  Mutation = 0,
  MouseMove = 1,
  MouseInteraction = 2,
  Scroll = 3,
  ViewportResize = 4,
  Input = 5,
  TouchMove = 6,
  MediaInteraction = 7,
  StyleSheetRule = 8,
  CanvasMutation = 9,
  Font = 10,
  Log = 11,
  Drag = 12,
  StyleDeclaration = 13,
  Selection = 14,
  AdoptedStyleSheet = 15,
  CustomElement = 16,
}

export interface eventWithTime {
  type: EventType;
  data: any;
  timestamp: number;
  delay?: number;
}

export type customEvent = eventWithTime;
export type fullSnapshotEvent = eventWithTime;
export type incrementalSnapshotEvent = eventWithTime;
export type metaEvent = eventWithTime;

export interface addedNodeMutation {
  parentId: number;
  nextId: number | null;
  node: any;
}

export interface removedNodeMutation {
  parentId: number;
  id: number;
}

export interface mutationData {
  source: IncrementalSource.Mutation;
  adds: addedNodeMutation[];
  removes: removedNodeMutation[];
  texts: any[];
  attributes: any[];
}
