import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { Highlight, Paper } from './document';
import type { SavedContextReference } from './saved-context';

interface ReaderDatabase extends DBSchema {
  papers: { key: string; value: Paper };
  highlights: {
    key: string;
    value: Highlight;
    indexes: { 'by-document': string };
  };
  contexts: {
    key: [string, string, string];
    value: SavedContextReference;
    indexes: { 'by-paper-service': [string, string] };
  };
  activeContexts: {
    key: [string, string];
    value: { serviceOrigin: string; documentId: string; contextId: string | null };
  };
}

const database = new Promise<IDBPDatabase<ReaderDatabase>>((resolve, reject) => {
  let blocked = false;
  const opening = openDB<ReaderDatabase>('paper-reader', 2, {
    blocked() {
      blocked = true;
      reject(
        new Error(
          'Close other Brain Vat tabs, then refresh to update local paper storage.',
        ),
      );
    },
    blocking() {
      void opening.then((db) => db.close());
    },
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('papers', { keyPath: 'id' });
        const highlights = db.createObjectStore('highlights', { keyPath: 'id' });
        highlights.createIndex('by-document', 'anchor.documentId');
      }
      if (oldVersion < 2) {
        const contexts = db.createObjectStore('contexts', {
          keyPath: ['serviceOrigin', 'documentId', 'id'],
        });
        contexts.createIndex('by-paper-service', ['serviceOrigin', 'documentId']);
        db.createObjectStore('activeContexts', {
          keyPath: ['serviceOrigin', 'documentId'],
        });
      }
    },
  });
  void opening.then((db) => {
    if (blocked) db.close();
    else resolve(db);
  }, reject);
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

export async function listSavedContexts(
  serviceOrigin: string,
  documentId: string,
): Promise<SavedContextReference[]> {
  const contexts = await (
    await database
  ).getAllFromIndex('contexts', 'by-paper-service', [serviceOrigin, documentId]);
  return contexts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveContextReference(
  context: SavedContextReference,
): Promise<void> {
  await (await database).put('contexts', context);
}

export async function removeContextReference(
  context: SavedContextReference,
): Promise<void> {
  const db = await database;
  const tx = db.transaction(['contexts', 'activeContexts'], 'readwrite');
  await tx
    .objectStore('contexts')
    .delete([context.serviceOrigin, context.documentId, context.id]);
  const key: [string, string] = [context.serviceOrigin, context.documentId];
  const active = await tx.objectStore('activeContexts').get(key);
  if (active?.contextId === context.id) {
    await tx.objectStore('activeContexts').put({ ...active, contextId: null });
  }
  await tx.done;
}

export async function activeContextId(
  serviceOrigin: string,
  documentId: string,
): Promise<string | null> {
  const current = await (
    await database
  ).get('activeContexts', [serviceOrigin, documentId]);
  return current?.contextId ?? null;
}

export async function setActiveContext(
  serviceOrigin: string,
  documentId: string,
  contextId: string | null,
): Promise<void> {
  await (
    await database
  ).put('activeContexts', {
    serviceOrigin,
    documentId,
    contextId,
  });
}
