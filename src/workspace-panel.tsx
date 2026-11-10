import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { bytesToBase64 } from './workspace-client';
import type { RoomConnection, useService } from './workspace-client';
import type { Paper } from './document';
import type { RoomSummary } from './workspace-contract';
import { RoomNotes } from './room-notes';

type Service = ReturnType<typeof useService>;

export function WorkspacePanel({
  service,
  paper,
  room,
  inviteToken,
  requestOrigin,
  onOpen,
  onClose,
}: {
  service: Service;
  paper: Paper | null;
  room: RoomConnection | null;
  inviteToken: string | null;
  requestOrigin: (url: string) => Promise<void>;
  onOpen: (room: RoomSummary) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState(service.client.baseUrl);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [register, setRegister] = useState(Boolean(inviteToken));
  const [inviteConsumed, setInviteConsumed] = useState(false);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const { client, session } = service;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (!session) {
      setRooms([]);
      return;
    }
    void client
      .request<RoomSummary[]>('/rooms')
      .then((next) => {
        if (!cancelled) setRooms(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [client, session]);

  const perform = (task: () => Promise<void>): void => {
    setError('');
    setBusy(true);
    void task()
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Connection failed.');
      })
      .finally(() => setBusy(false));
  };

  return (
    <dialog
      ref={dialog}
      className="workspace-dialog"
      aria-labelledby="workspace-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <button className="icon-button modal-close" onClick={onClose}>
        <X size={18} aria-label="Close workspace" />
      </button>
      <div className="eyebrow">A PLACE TO THINK TOGETHER</div>
      <h2 id="workspace-title">Your reading rooms</h2>
      {error && (
        <p role="alert" className="import-error">
          {error}
        </p>
      )}
      <details className="connection-settings" open={!service.status}>
        <summary>Server connection</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            perform(async () => {
              await requestOrigin(baseUrl);
              await service.connect(baseUrl);
            });
          }}
        >
          <label htmlFor="server-url">Brain Vat server</label>
          <input
            id="server-url"
            type="url"
            required
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <button className="text-button" disabled={busy}>
            Connect
          </button>
        </form>
      </details>
      <p className="small muted">
        {service.status
          ? service.status.configured
            ? service.status.model + ' is connected'
            : 'Astra is ready to configure · add the server API key to enable answers'
          : 'Start the Brain Vat server or connect to a hosted instance.'}
      </p>
      {!session ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            perform(async () => {
              await requestOrigin(baseUrl);
              await service.connect(baseUrl);
              // Connect uses an origin check; use the current origin for login.
              if (baseUrl.replace(/\/$/, '') !== client.baseUrl) {
                throw new Error('Server connected. Submit again to sign in there.');
              }
              await service.authenticate(
                register ? 'register' : 'login',
                username,
                password,
                inviteToken,
              );
              setPassword('');
              if (register && inviteToken) {
                setInviteConsumed(true);
                history.replaceState(null, '', location.pathname);
              }
            });
          }}
        >
          <p>
            {inviteToken
              ? 'Sign in or create an account to join this invitation.'
              : 'Sign in to sync papers and collaborate across devices.'}
          </p>
          <label htmlFor="account-name">Username</label>
          <input
            id="account-name"
            autoComplete="username"
            required
            minLength={3}
            maxLength={32}
            pattern="[a-zA-Z0-9_-]+"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <label htmlFor="account-password">Password</label>
          <input
            id="account-password"
            type="password"
            autoComplete={register ? 'new-password' : 'current-password'}
            required
            minLength={12}
            maxLength={200}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button className="primary-button" disabled={busy}>
            {busy ? 'Connecting…' : register ? 'Create account' : 'Sign in'}
          </button>
          <button
            className="text-button"
            type="button"
            onClick={() => setRegister(!register)}
          >
            {register ? 'Already have an account? Sign in' : 'Create an account'}
          </button>
        </form>
      ) : (
        <>
          <div className="room-account">
            <span>
              Signed in as <strong>{session.account.username}</strong>
            </span>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => perform(service.logout)}
            >
              Sign out
            </button>
          </div>
          {inviteToken && !inviteConsumed && (
            <button
              className="primary-button"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  const invited = await client.request<RoomSummary>('/invites/redeem', {
                    method: 'POST',
                    body: JSON.stringify({ token: inviteToken }),
                  });
                  await onOpen(invited);
                  onClose();
                })
              }
            >
              Join invited room
            </button>
          )}
          <div className="rooms-list">
            {rooms.length === 0 && <p className="muted">No rooms yet.</p>}
            {rooms.map((item) => (
              <button
                className="library-paper"
                key={item.id}
                disabled={busy}
                onClick={() =>
                  perform(async () => {
                    await onOpen(item);
                    onClose();
                  })
                }
              >
                <span>
                  {item.title}
                  <small>
                    {item.role} · {item.pageCount} pages
                  </small>
                </span>
              </button>
            ))}
          </div>
          {paper && !room && (
            <div className="publish-paper">
              <p>
                Create a room for <strong>{paper.title}</strong>. This uploads the PDF
                to your server. Everyone invited can read it and all room activity.
              </p>
              <button
                className="primary-button"
                disabled={busy}
                onClick={() =>
                  perform(async () => {
                    const created = await client.request<RoomSummary>('/rooms', {
                      method: 'POST',
                      body: JSON.stringify({
                        title: paper.title,
                        filename: paper.filename,
                        sourceUrl: paper.sourceUrl,
                        pdf: bytesToBase64(new Uint8Array(paper.bytes)),
                      }),
                    });
                    await onOpen(created);
                    onClose();
                  })
                }
              >
                {busy ? 'Uploading and indexing…' : 'Upload paper and create room'}
              </button>
            </div>
          )}
        </>
      )}
    </dialog>
  );
}

export function RoomInspector({
  room,
  pageIndex,
  onLeave,
}: {
  room: RoomConnection;
  pageIndex: number;
  onLeave: () => void;
}): React.JSX.Element {
  const { client } = room;
  const id = room.state.room.id;
  const [present, setPresent] = useState(false);
  const [inviteLink, setInviteLink] = useState('');
  const [notice, setNotice] = useState('');
  const isOwner = room.state.room.role === 'owner';
  useEffect(() => {
    if (!present) return;
    const publish = (): void => {
      void client
        .request('/rooms/' + id + '/presence', {
          method: 'POST',
          body: JSON.stringify({ pageIndex }),
        })
        .catch(() => undefined);
    };
    publish();
    const timer = setInterval(publish, 10_000);
    return () => {
      clearInterval(timer);
      void client
        .request('/rooms/' + id + '/presence', {
          method: 'POST',
          body: JSON.stringify({ pageIndex: null }),
        })
        .catch(() => undefined);
    };
  }, [client, id, pageIndex, present]);

  const perform = (task: () => Promise<void>): void => {
    setNotice('');
    void task().catch((reason: unknown) => {
      setNotice(reason instanceof Error ? reason.message : 'Room action failed.');
    });
  };
  return (
    <details className="room-inspector">
      <summary>
        Shared room · {room.state.members.length} readers
        {room.state.presence.length > 0 && ` · ${room.state.presence.length} here`}
      </summary>
      <div className="room-inspector-content">
        <RoomNotes key={id + client.token} room={room} />
        <section className="room-members" aria-label="Room members">
          <label className="presence-toggle">
            <input
              type="checkbox"
              checked={present}
              onChange={(event) => setPresent(event.target.checked)}
            />{' '}
            Share my presence and page
          </label>
          {room.state.presence.map((person) => (
            <p className="small" key={person.id}>
              {person.username} · page {person.pageIndex + 1}
            </p>
          ))}
          <ul>
            {room.state.members.map((member) => (
              <li key={member.id}>
                {member.username} <span className="muted">{member.role}</span>
                {isOwner && member.role !== 'owner' && (
                  <button
                    className="text-button"
                    aria-label={'Remove ' + member.username}
                    onClick={() =>
                      perform(async () => {
                        await client.request('/rooms/' + id + '/members/' + member.id, {
                          method: 'DELETE',
                        });
                        await room.refresh();
                      })
                    }
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          {isOwner && (
            <>
              <button
                className="text-button"
                onClick={() =>
                  perform(async () => {
                    const invite = await client.request<{ token: string }>(
                      '/rooms/' + id + '/invites',
                      { method: 'POST' },
                    );
                    setInviteLink(client.baseUrl + '/#invite=' + invite.token);
                  })
                }
              >
                Create invite link
              </button>
              {inviteLink && (
                <label>
                  Single-use invitation (expires in 24 hours)
                  <input
                    readOnly
                    value={inviteLink}
                    onFocus={(e) => e.target.select()}
                  />
                  <button
                    className="text-button"
                    onClick={() =>
                      perform(async () => {
                        await navigator.clipboard.writeText(inviteLink);
                        setNotice('Invite copied.');
                      })
                    }
                  >
                    Copy invite
                  </button>
                </label>
              )}
              <button
                className="text-button"
                onClick={() =>
                  perform(async () => {
                    await client.request('/rooms/' + id + '/invites', {
                      method: 'DELETE',
                    });
                    setInviteLink('');
                    setNotice('Outstanding invitations revoked.');
                  })
                }
              >
                Revoke outstanding invitations
              </button>
              <button
                className="text-button"
                onClick={() => {
                  if (
                    !window.confirm(
                      'Delete this room, its PDF and all shared activity?',
                    )
                  ) {
                    return;
                  }
                  perform(async () => {
                    await client.request('/rooms/' + id, { method: 'DELETE' });
                    onLeave();
                  });
                }}
              >
                Delete room
              </button>
            </>
          )}
          <button className="text-button" onClick={onLeave}>
            Close room
          </button>
          {notice && (
            <p role="status" className="small">
              {notice}
            </p>
          )}
        </section>
      </div>
    </details>
  );
}
