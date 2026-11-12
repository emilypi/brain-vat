import type { AiRun } from './workspace-contract';

/** Metadata never authorizes access; the browser holds a separate capability. */
export interface SavedContextSummary {
  id: string;
  documentId: string;
  name: string;
  updatedAt: string;
  revision: number;
}

export interface SavedContextReference extends SavedContextSummary {
  serviceOrigin: string;
  capability: string;
}

export interface SoloContextState {
  context: SavedContextSummary | null;
  runs: AiRun[];
}

export interface SoloContextPollState {
  context: SavedContextSummary | null;
  runs: AiRun[] | null;
}

export interface SavedContextCreated {
  context: SavedContextSummary;
  capability: string;
}

export interface SavedContextOpened extends SoloContextState {
  token: string;
  context: SavedContextSummary;
}
