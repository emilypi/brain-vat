import { z } from 'zod';
import { anchorSchema } from './document';
import type { Anchor, PaperPassage } from './document';

export const snapshotSchema = z.object({
  sessionId: z.string().uuid(),
  documentId: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().max(500),
  pageCount: z.number().int().positive(),
  pageIndex: z.number().int().nonnegative(),
  selection: anchorSchema.nullable(),
  roomId: z.string().uuid().nullable().optional(),
});

export type ReaderSnapshot = z.infer<typeof snapshotSchema>;

export const bridgeMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('clear'), sessionId: z.string().uuid() }),
  z.object({ type: z.literal('publish'), snapshot: snapshotSchema }),
  z.object({
    type: z.literal('read-active'),
    windowId: z.number().int(),
  }),
  z.object({
    type: z.literal('navigate'),
    sessionId: z.string().uuid(),
    documentId: z.string().regex(/^[a-f0-9]{64}$/),
    tabId: z.number().int(),
    pageIndex: z.number().int().nonnegative(),
  }),
]);

export interface ReaderEnvironment {
  nativePanel: boolean;
  clear: (sessionId: string) => Promise<void>;
  requestOrigin: (url: string) => Promise<void>;
  publish: (snapshot: ReaderSnapshot) => Promise<void>;
  openPanel: () => Promise<void>;
  onNavigate: (
    callback: (documentId: string, sessionId: string, pageIndex: number) => void,
  ) => () => void;
}

export const WEB_ENVIRONMENT: ReaderEnvironment = {
  nativePanel: false,
  clear: async () => undefined,
  requestOrigin: async () => undefined,
  publish: async () => undefined,
  openPanel: async () => undefined,
  onNavigate: () => () => undefined,
};

export interface AssistantContext {
  title: string;
  documentId: string;
  selection: Anchor | null;
  pages: PaperPassage[];
}

export function validSnapshot(snapshot: ReaderSnapshot): boolean {
  return (
    snapshot.pageIndex < snapshot.pageCount &&
    (snapshot.selection === null ||
      (snapshot.selection.documentId === snapshot.documentId &&
        snapshot.selection.pageIndex < snapshot.pageCount))
  );
}

export function matchesReader(
  snapshot: ReaderSnapshot,
  sessionId: string,
  documentId: string,
): boolean {
  return snapshot.sessionId === sessionId && snapshot.documentId === documentId;
}
