import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import type { RoomState, ServiceStatus, Session } from './workspace-contract';

const SETTINGS_KEY = 'brain-vat-service';
const CHANGE_EVENT = 'brain-vat-service-change';
const sessionSchema = z.object({
  token: z.string().min(20),
  account: z.object({ id: z.string(), username: z.string() }),
});
const settingsSchema = z.object({
  baseUrl: z.string(),
  session: sessionSchema.nullable(),
});
type Settings = z.infer<typeof settingsSchema>;

export function validateServiceUrl(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Use an HTTPS server origin, or localhost for development.');
  }
  return url.origin;
}

function readSettings(): Settings {
  try {
    const parsed = settingsSchema.parse(
      JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null'),
    );
    validateServiceUrl(parsed.baseUrl);
    return parsed;
  } catch {
    return {
      baseUrl:
        import.meta.env.VITE_API_URL ||
        (location.protocol === 'chrome-extension:'
          ? 'http://127.0.0.1:8787'
          : location.origin),
      session: null,
    };
  }
}

function storeSettings(settings: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class WorkspaceClient {
  readonly baseUrl: string;
  readonly token: string | null;

  constructor(baseUrl: string, token: string | null) {
    this.baseUrl = validateServiceUrl(baseUrl);
    this.token = token;
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new Error('Invalid API path.');
    }
    const headers = new Headers(init.headers);
    if (this.token) headers.set('Authorization', 'Bearer ' + this.token);
    if (init.body) headers.set('Content-Type', 'application/json');
    const signal = AbortSignal.timeout(60_000);
    const response = await fetch(this.baseUrl + '/api' + path, {
      ...init,
      headers,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const error = z.object({ error: z.string() }).safeParse(body);
      throw new ApiError(
        error.success ? error.data.error : 'The server could not finish this request.',
        response.status,
      );
    }
    return response;
  }

  async request<Result>(path: string, init?: RequestInit): Promise<Result> {
    return (await (await this.fetch(path, init)).json()) as Result;
  }
}

export interface RoomConnection {
  client: WorkspaceClient;
  state: RoomState;
  refresh: () => Promise<void>;
}

export function useService(): {
  client: WorkspaceClient;
  session: Session | null;
  status: ServiceStatus | null;
  connect: (baseUrl: string) => Promise<void>;
  authenticate: (
    mode: 'login' | 'register',
    username: string,
    password: string,
    inviteToken: string | null,
  ) => Promise<void>;
  logout: () => Promise<void>;
} {
  const [settings, setSettings] = useState(readSettings);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const client = useMemo(
    () => new WorkspaceClient(settings.baseUrl, settings.session?.token ?? null),
    [settings.baseUrl, settings.session?.token],
  );
  useEffect(() => {
    const update = (): void => setSettings(readSettings());
    const storageChanged = (event: StorageEvent): void => {
      if (event.key === SETTINGS_KEY || event.key === null) update();
    };
    window.addEventListener('storage', storageChanged);
    window.addEventListener(CHANGE_EVENT, update);
    return () => {
      window.removeEventListener('storage', storageChanged);
      window.removeEventListener(CHANGE_EVENT, update);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    void client
      .request<ServiceStatus>('/health')
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => undefined);
    if (settings.session) {
      void client.request('/auth/me').catch((error: unknown) => {
        if (!cancelled && error instanceof ApiError && error.status === 401) {
          storeSettings({ baseUrl: settings.baseUrl, session: null });
        }
      });
    }
    return () => {
      cancelled = true;
    };
  }, [client, settings.baseUrl, settings.session]);

  return {
    client,
    session: settings.session,
    status,
    connect: async (baseUrl) => {
      const next = validateServiceUrl(baseUrl);
      const available = await new WorkspaceClient(next, null).request<ServiceStatus>(
        '/health',
      );
      storeSettings({
        baseUrl: next,
        session: next === settings.baseUrl ? settings.session : null,
      });
      setStatus(available);
    },
    authenticate: async (mode, username, password, inviteToken) => {
      const session = await client.request<Session>('/auth/' + mode, {
        method: 'POST',
        body: JSON.stringify({
          username,
          password,
          ...(mode === 'register' && inviteToken ? { inviteToken } : {}),
        }),
      });
      storeSettings({ baseUrl: settings.baseUrl, session });
    },
    logout: async () => {
      await client.request('/auth/logout', { method: 'POST' });
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('brain-vat-notes:')) localStorage.removeItem(key);
      }
      storeSettings({ baseUrl: settings.baseUrl, session: null });
    },
  };
}

export function useRoom(
  client: WorkspaceClient,
  roomId: string | null,
): { connection: RoomConnection | null; error: string; forbidden: boolean } {
  const [snapshot, setSnapshot] = useState<{
    client: WorkspaceClient;
    id: string;
    state: RoomState;
  } | null>(null);
  const [failure, setFailure] = useState<{
    client: WorkspaceClient;
    id: string;
    message: string;
    forbidden: boolean;
  } | null>(null);
  // Each client/room pair owns its responses, including imperative refresh calls.
  const activeScope = useRef<{
    client: WorkspaceClient;
    roomId: string | null;
    request: number;
    accepted: number;
  } | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    if (!roomId || !client.token) return;
    const scope = activeScope.current;
    if (!scope || scope.client !== client || scope.roomId !== roomId) return;
    const request = ++scope.request;
    try {
      const state = await client.request<RoomState>('/rooms/' + roomId);
      if (activeScope.current !== scope || request < scope.accepted) return;
      scope.accepted = request;
      setSnapshot({ client, id: roomId, state });
      setFailure(null);
    } catch (reason) {
      if (activeScope.current !== scope || request < scope.accepted) return;
      scope.accepted = request;
      const forbidden =
        reason instanceof ApiError && [401, 403, 404].includes(reason.status);
      setFailure({
        client,
        id: roomId,
        message: reason instanceof Error ? reason.message : 'Room sync failed.',
        forbidden,
      });
      if (forbidden) setSnapshot(null);
    }
  }, [client, roomId]);
  useEffect(() => {
    const scope = { client, roomId, request: 0, accepted: 0 };
    activeScope.current = scope;
    let pending = false;
    const poll = (): void => {
      if (pending) return;
      pending = true;
      void refresh().finally(() => {
        pending = false;
      });
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      if (activeScope.current === scope) activeScope.current = null;
      clearInterval(timer);
    };
  }, [refresh, client, roomId]);
  const current = snapshot?.client === client && snapshot.id === roomId;
  const failed = failure?.client === client && failure.id === roomId;
  return {
    connection: current ? { client, state: snapshot.state, refresh } : null,
    error: failed ? failure.message : '',
    forbidden: failed && failure.forbidden,
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return btoa(binary);
}

export function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
}
