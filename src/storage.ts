import { openDB } from 'idb';
import type { DBSchema } from 'idb';
import type { Highlight, Paper } from './document';

interface ReaderDatabase extends DBSchema {
  papers: { key: string; value: Paper };
  highlights: {
    key: string;
    value: Highlight;
    indexes: { 'by-document': string };
  };
}

const database = openDB<ReaderDatabase>('paper-reader', 1, {
  upgrade(db) {
    db.createObjectStore('papers', { keyPath: 'id' });
    const highlights = db.createObjectStore('highlights', { keyPath: 'id' });
    highlights.createIndex('by-document', 'anchor.documentId');
  },
});

export async function listPapers(): Promise<Paper[]> {
  return (await (await database).getAll('papers')).sort((a, b) =>
    b.addedAt.localeCompare(a.addedAt),
  );
}

export async function savePaper(paper: Paper): Promise<void> {
  await (await database).put('papers', paper);
}

export async function getPaper(id: string): Promise<Paper | undefined> {
  return (await database).get('papers', id);
}

export async function listHighlights(documentId: string): Promise<Highlight[]> {
  return (await database).getAllFromIndex('highlights', 'by-document', documentId);
}

export async function saveHighlight(highlight: Highlight): Promise<void> {
  await (await database).put('highlights', highlight);
}

export async function removeHighlight(id: string): Promise<void> {
  await (await database).delete('highlights', id);
}
