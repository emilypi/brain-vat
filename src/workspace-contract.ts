import { z } from 'zod';
import { anchorSchema } from './document.ts';
import type { Anchor, Highlight, PaperPassage } from './document.ts';

export const credentialsSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_-]+$/),
  password: z.string().min(12).max(200),
  inviteToken: z.string().max(200).optional(),
});

export const runInputSchema = z.object({
  requestId: z.string().uuid(),
  question: z.string().trim().min(1).max(8000),
  kind: z.enum(['question', 'definition', 'guide']),
  selection: anchorSchema.nullable(),
  image: z.string().max(3_000_000).nullable(),
  externalQuery: z.string().trim().max(500).nullable(),
});

export type RunInput = z.infer<typeof runInputSchema>;

export interface Account {
  id: string;
  username: string;
}

export interface Session {
  token: string;
  account: Account;
}

export interface ServiceStatus {
  provider: string;
  model: string;
  configured: boolean;
  registrationOpen: boolean;
}

export interface RoomSummary {
  id: string;
  title: string;
  documentId: string;
  filename: string;
  sourceUrl: string | null;
  pageCount: number;
  createdAt: string;
  role: 'owner' | 'editor';
}

export interface SharedHighlight extends Highlight {
  authorId: string;
  authorName: string;
  version: number;
}

export interface SourceEvidence {
  id: string;
  origin: 'thisPaper' | 'citedReference' | 'externalSource';
  title: string;
  excerpt: string;
  pageIndex: number | null;
  url: string | null;
  availability: 'excerpt' | 'metadataOnly';
}

export interface AnswerBlock {
  heading: string;
  text: string;
  evidenceIds: string[];
}

export interface GeneratedAnswer {
  blocks: AnswerBlock[];
  evidence: SourceEvidence[];
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ChatMessage {
  id: string;
  authorId: string;
  authorName: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  runId: string | null;
  answer: GeneratedAnswer | null;
}

export interface AiRun {
  id: string;
  requestId: string;
  authorId: string;
  kind: RunInput['kind'];
  question: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
  createdAt: string;
  error: string | null;
  answer: GeneratedAnswer | null;
}

export interface Member extends Account {
  role: 'owner' | 'editor';
}

export interface Presence extends Account {
  pageIndex: number;
}

export interface RoomState {
  room: RoomSummary;
  highlights: SharedHighlight[];
  messages: ChatMessage[];
  runs: AiRun[];
  guide: AiRun | null;
  members: Member[];
  presence: Presence[];
}

export interface ProviderInput {
  title: string;
  question: string;
  kind: RunInput['kind'];
  selection: Anchor | null;
  image: string | null;
  externalQuery: string | null;
  pages: PaperPassage[];
  history: ChatMessage[];
}

export interface AiProvider {
  name: string;
  model: string;
  configured: boolean;
  generate(input: ProviderInput, signal: AbortSignal): Promise<GeneratedAnswer>;
}
