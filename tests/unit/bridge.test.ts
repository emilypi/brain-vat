import { describe, expect, it } from 'vitest';
import { bridgeMessageSchema, matchesReader, validSnapshot } from '../../src/bridge';
import type { ReaderSnapshot } from '../../src/bridge';

const SNAPSHOT: ReaderSnapshot = {
  sessionId: 'fe531e63-f651-4bfb-9847-d8748ca28692',
  documentId: 'a'.repeat(64),
  title: 'Example',
  pageCount: 3,
  pageIndex: 0,
  selection: null,
};

describe('reader binding', () => {
  it('rejects selections from another paper', () => {
    const point = { x: 0.1, y: 0.2 };
    expect(
      validSnapshot({
        ...SNAPSHOT,
        selection: {
          documentId: 'b'.repeat(64),
          pageIndex: 0,
          kind: 'region',
          quote: '',
          quads: [[point, point, point, point]],
        },
      }),
    ).toBe(false);
  });

  it('rejects a stale reader session even when the document matches', () => {
    expect(matchesReader(SNAPSHOT, crypto.randomUUID(), SNAPSHOT.documentId)).toBe(
      false,
    );
  });

  it('rejects out of range pages', () => {
    expect(validSnapshot({ ...SNAPSHOT, pageIndex: 3 })).toBe(false);
  });

  it('rejects malformed message data at the boundary', () => {
    expect(
      bridgeMessageSchema.safeParse({
        type: 'publish',
        snapshot: { title: 'Untrusted' },
      }).success,
    ).toBe(false);
  });
});
