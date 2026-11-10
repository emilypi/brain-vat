import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { ApiError, base64ToBytes, bytesToBase64 } from './workspace-client';
import type { RoomConnection } from './workspace-client';

export function RoomNotes({ room }: { room: RoomConnection }): React.JSX.Element {
  const { client } = room;
  const id = room.state.room.id;
  const [value, setValue] = useState('');
  const [status, setStatus] = useState('Connecting…');
  const [locked, setLocked] = useState(false);
  const document = useMemo(() => new Y.Doc(), []);
  const notes = useMemo(() => document.getText('notes'), [document]);
  const composition = useRef(false);
  const localKey =
    'brain-vat-notes:' + client.baseUrl + ':' + id + ':' + client.token?.slice(-12);

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    let revision = 0;
    let denied = false;
    try {
      const cached = localStorage.getItem(localKey);
      if (cached) Y.applyUpdate(document, base64ToBytes(cached), 'restore');
    } catch {
      setStatus('The local draft could not be restored.');
    }
    const update = (_update: Uint8Array, origin: unknown): void => {
      if (!composition.current) setValue(notes.toString());
      if (origin !== 'server') {
        revision += 1;
        setStatus('Saved on this device · syncing…');
      }
      try {
        localStorage.setItem(localKey, bytesToBase64(Y.encodeStateAsUpdate(document)));
      } catch {
        setStatus('Local storage is full. Keep this tab open until synced.');
      }
    };
    document.on('update', update);
    setValue(notes.toString());
    const sync = async (): Promise<void> => {
      if (pending || cancelled || denied) return;
      pending = true;
      const sent = revision;
      try {
        const response = await client.request<{ update: string }>(
          '/rooms/' + id + '/notes',
          {
            method: 'POST',
            body: JSON.stringify({
              update: bytesToBase64(Y.encodeStateAsUpdate(document)),
            }),
          },
        );
        if (cancelled) return;
        Y.applyUpdate(document, base64ToBytes(response.update), 'server');
        if (sent === revision) setStatus('All changes saved to the room');
      } catch (reason) {
        if (cancelled) return;
        denied = reason instanceof ApiError && [401, 403, 404].includes(reason.status);
        if (denied) {
          localStorage.removeItem(localKey);
          setValue('');
          setLocked(true);
        }
        const rejected =
          reason instanceof ApiError && [400, 413].includes(reason.status);
        if (rejected) {
          denied = true;
          setLocked(true);
        }
        setStatus(
          rejected
            ? 'Notes reached a server limit. Copy your local draft to keep it.'
            : denied
              ? 'Access ended.'
              : 'Offline · draft is on this device; retrying…',
        );
      } finally {
        pending = false;
      }
    };
    void sync();
    const timer = setInterval(() => void sync(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.off('update', update);
    };
  }, [client, document, id, localKey, notes]);

  const edit = (next: string): void => {
    const previous = notes.toString();
    let prefix = 0;
    let suffix = 0;
    while (prefix < Math.min(previous.length, next.length)) {
      if (previous[prefix] !== next[prefix]) break;
      prefix += 1;
    }
    while (suffix < Math.min(previous.length, next.length) - prefix) {
      if (previous[previous.length - suffix - 1] !== next[next.length - suffix - 1]) {
        break;
      }
      suffix += 1;
    }
    document.transact(() => {
      notes.delete(prefix, previous.length - prefix - suffix);
      notes.insert(prefix, next.slice(prefix, next.length - suffix));
    }, 'editor');
    setValue(notes.toString());
  };

  return (
    <section className="room-notes" aria-label="Collaborative notes">
      <label htmlFor="room-notes">Shared notes</label>
      <textarea
        id="room-notes"
        value={value}
        maxLength={80_000}
        readOnly={locked}
        placeholder="Work through an idea together…"
        onCompositionStart={() => {
          composition.current = true;
        }}
        onCompositionEnd={(event) => {
          composition.current = false;
          edit(event.currentTarget.value);
        }}
        onChange={(event) => {
          if (composition.current) setValue(event.target.value);
          else edit(event.target.value);
        }}
      />
      <p className="small muted" role="status">
        {status}
      </p>
    </section>
  );
}
