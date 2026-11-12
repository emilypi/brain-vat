import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistantContext } from './bridge';
import type { AiRun } from './workspace-contract';
import type {
  SavedContextCreated,
  SavedContextOpened,
  SavedContextReference,
  SavedContextSummary,
  SoloContextPollState,
} from './saved-context';
import {
  activeContextId,
  listSavedContexts,
  removeContextReference,
  saveContextReference,
  setActiveContext,
} from './storage';
import { ApiError, WorkspaceClient } from './workspace-client';

function detach(client: WorkspaceClient | null): void {
  if (client)
    void client.fetch('/solo/session', { method: 'DELETE' }).catch(() => undefined);
}

function sameRun(previous: AiRun, next: AiRun): boolean {
  return (
    previous.id === next.id &&
    previous.status === next.status &&
    previous.error === next.error
  );
}

/** Owns the server session and local capabilities, never the trusted proof data. */
export function useSoloContext(
  service: WorkspaceClient,
  paper: AssistantContext | null,
) {
  const documentId = paper?.documentId;
  const scope = service.baseUrl + ':' + (documentId ?? '');
  const [readyScope, setReadyScope] = useState('');
  const [runs, setRuns] = useState<AiRun[]>([]);
  const [client, setClient] = useState<WorkspaceClient | null>(null);
  const [contexts, setContexts] = useState<SavedContextReference[]>([]);
  const [active, setActive] = useState<SavedContextReference | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unavailableId, setUnavailableId] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState(0);
  const generation = useRef(0);
  const mutation = useRef(0);
  // Metadata may advance after rename/save before this tab has the full history.
  const historyRevision = useRef<number | undefined>(undefined);
  const session = useRef<WorkspaceClient | null>(null);
  const activeRef = useRef<SavedContextReference | null>(null);
  const opening = useRef<{
    generation: number;
    promise: Promise<WorkspaceClient | null>;
  } | null>(null);
  const saveRequest = useRef<{ requestId: string; name: string } | null>(null);

  const remember = useCallback((reference: SavedContextReference): void => {
    activeRef.current = reference;
    setActive(reference);
    setContexts((current) => [
      reference,
      ...current.filter((item) => item.id !== reference.id),
    ]);
  }, []);

  const install = useCallback(
    (opened: SavedContextOpened, reference: SavedContextReference): void => {
      detach(session.current);
      const next = new WorkspaceClient(reference.serviceOrigin, opened.token);
      session.current = next;
      setClient(next);
      setRuns(opened.runs);
      historyRevision.current = opened.context.revision;
      remember({ ...reference, ...opened.context });
      setSessionKey((value) => value + 1);
      saveRequest.current = null;
    },
    [remember],
  );

  useEffect(() => {
    const current = ++generation.current;
    setRuns([]);
    historyRevision.current = undefined;
    setClient(null);
    setContexts([]);
    setActive(null);
    activeRef.current = null;
    saveRequest.current = null;
    setError('');
    setUnavailableId(null);
    setBusy(true);
    setSessionKey((value) => value + 1);
    void (async () => {
      if (!documentId) return;
      const [references, selectedId] = await Promise.all([
        listSavedContexts(service.baseUrl, documentId),
        activeContextId(service.baseUrl, documentId),
      ]);
      if (current !== generation.current) return;
      setContexts(references);
      const selected = references.find((item) => item.id === selectedId);
      if (!selected) return;
      try {
        const capability = new WorkspaceClient(service.baseUrl, selected.capability);
        const opened = await capability.request<SavedContextOpened>(
          '/solo/contexts/' + selected.id + '/open',
          { method: 'POST', body: JSON.stringify({ documentId }) },
        );
        if (current !== generation.current) {
          detach(new WorkspaceClient(service.baseUrl, opened.token));
          return;
        }
        install(opened, selected);
        await saveContextReference({ ...selected, ...opened.context });
      } catch (reason) {
        if (current === generation.current) {
          setUnavailableId(selected.id);
          throw reason;
        }
      }
    })()
      .catch((reason: unknown) => {
        if (current === generation.current)
          setError(reason instanceof Error ? reason.message : 'Context unavailable.');
      })
      .finally(() => {
        if (current === generation.current) {
          setReadyScope(scope);
          setBusy(false);
        }
      });
    return () => {
      generation.current += 1;
      detach(session.current);
      session.current = null;
    };
  }, [service, documentId, scope, install]);

  const ensureSession = useCallback(async (): Promise<WorkspaceClient | null> => {
    if (!paper) return null;
    if (session.current) return session.current;
    const current = generation.current;
    if (opening.current?.generation === current) return opening.current.promise;
    const promise = (async () => {
      const result = await service.request<{ token: string }>('/solo/sessions', {
        method: 'POST',
        body: JSON.stringify({
          documentId: paper.documentId,
          title: paper.title,
          pages: paper.pages,
        }),
      });
      const next = new WorkspaceClient(service.baseUrl, result.token);
      if (current !== generation.current) {
        detach(next);
        return null;
      }
      session.current = next;
      setClient(next);
      return next;
    })();
    opening.current = { generation: current, promise };
    try {
      return await promise;
    } finally {
      if (opening.current?.promise === promise) opening.current = null;
    }
  }, [paper, service]);

  const acceptRun = useCallback((run: AiRun): void => {
    mutation.current += 1;
    setRuns((current) => [...current.filter((item) => item.id !== run.id), run]);
  }, []);

  const running = runs.some((run) => run.status === 'running');
  useEffect(() => {
    if (!client || (!active?.id && !running)) return;
    const current = generation.current;
    const controller = new AbortController();
    let polling = false;
    const poll = async (): Promise<void> => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      const started = mutation.current;
      try {
        const revision = historyRevision.current;
        const path =
          '/solo/session' + (revision === undefined ? '' : '?revision=' + revision);
        const state = await client.request<SoloContextPollState>(path, {
          signal: controller.signal,
        });
        if (
          current !== generation.current ||
          controller.signal.aborted ||
          started !== mutation.current
        )
          return;
        const prior = activeRef.current;
        if (state.context && prior && state.context.revision < prior.revision) return;
        const nextRuns = state.runs;
        if (nextRuns) {
          historyRevision.current = state.context?.revision;
          setRuns((previous) => {
            if (
              previous.length === nextRuns.length &&
              previous.every((run, index) => sameRun(run, nextRuns[index]!))
            )
              return previous;
            return nextRuns;
          });
        }
        if (state.context && prior && state.context.revision !== prior.revision) {
          const reference = { ...prior, ...state.context };
          remember(reference);
          await saveContextReference(reference);
        }
      } catch (reason) {
        if (current === generation.current && !controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Context unavailable.');
          if (reason instanceof ApiError && [401, 404].includes(reason.status)) {
            setUnavailableId(activeRef.current?.id ?? null);
            controller.abort();
          }
        }
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [client, active?.id, running, remember]);

  const save = async (name: string): Promise<void> => {
    if (busy || !documentId || active) return;
    const current = generation.current;
    setBusy(true);
    setError('');
    try {
      const pending = saveRequest.current ?? { requestId: crypto.randomUUID(), name };
      saveRequest.current = pending;
      if (pending.name !== name)
        throw new Error(
          'Retry saving “' + pending.name + '” before changing its name.',
        );
      const target = await ensureSession();
      if (!target || current !== generation.current) return;
      const created = await target.request<SavedContextCreated>('/solo/context', {
        method: 'POST',
        body: JSON.stringify(pending),
      });
      const reference: SavedContextReference = {
        ...created.context,
        capability: created.capability,
        serviceOrigin: service.baseUrl,
      };
      // Retain the capability even when the user switched papers during the request.
      await saveContextReference(reference);
      await setActiveContext(service.baseUrl, documentId, reference.id);
      if (current !== generation.current) return;
      remember(reference);
      saveRequest.current = null;
    } catch (reason) {
      if (current === generation.current)
        setError(reason instanceof Error ? reason.message : 'Could not save context.');
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  const open = async (reference: SavedContextReference): Promise<void> => {
    if (busy || !documentId || (reference.id === active?.id && !unavailableId)) return;
    if (
      reference.documentId !== documentId ||
      reference.serviceOrigin !== service.baseUrl
    )
      return;
    let current = generation.current;
    setBusy(true);
    setError('');
    setUnavailableId(null);
    try {
      const capability = new WorkspaceClient(service.baseUrl, reference.capability);
      const opened = await capability.request<SavedContextOpened>(
        '/solo/contexts/' + reference.id + '/open',
        { method: 'POST', body: JSON.stringify({ documentId }) },
      );
      if (current !== generation.current) {
        detach(new WorkspaceClient(service.baseUrl, opened.token));
        return;
      }
      current = ++generation.current;
      install(opened, reference);
      await saveContextReference({ ...reference, ...opened.context });
      await setActiveContext(service.baseUrl, documentId, reference.id);
    } catch (reason) {
      if (current === generation.current) {
        setUnavailableId(reference.id);
        setError(reason instanceof Error ? reason.message : 'Could not open context.');
      }
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };

  const beginNew = (): void => {
    if (busy || !documentId) return;
    const current = ++generation.current;
    detach(session.current);
    session.current = null;
    activeRef.current = null;
    saveRequest.current = null;
    setClient(null);
    setActive(null);
    setRuns([]);
    historyRevision.current = undefined;
    setError('');
    setUnavailableId(null);
    setSessionKey((value) => value + 1);
    void setActiveContext(service.baseUrl, documentId, null).catch(() => {
      if (current === generation.current)
        setError('Could not remember the new conversation in this browser.');
    });
  };

  const rename = async (name: string): Promise<void> => {
    if (!active || busy) return;
    const current = generation.current;
    setBusy(true);
    setError('');
    try {
      const capability = new WorkspaceClient(service.baseUrl, active.capability);
      const summary = await capability.request<SavedContextSummary>(
        '/solo/contexts/' + active.id,
        { method: 'PATCH', body: JSON.stringify({ name }) },
      );
      const reference = { ...active, ...summary };
      await saveContextReference(reference);
      if (current === generation.current) remember(reference);
    } catch (reason) {
      if (current === generation.current)
        setError(
          reason instanceof Error ? reason.message : 'Could not rename context.',
        );
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  const remove = async (
    reference: SavedContextReference,
    localOnly = false,
  ): Promise<void> => {
    if (busy) return;
    let current = generation.current;
    setBusy(true);
    setError('');
    try {
      if (!localOnly) {
        const capability = new WorkspaceClient(service.baseUrl, reference.capability);
        await capability.fetch('/solo/contexts/' + reference.id, { method: 'DELETE' });
      }
      await removeContextReference(reference);
      if (current !== generation.current) return;
      setContexts((items) => items.filter((item) => item.id !== reference.id));
      setUnavailableId(null);
      if (reference.id === activeRef.current?.id) {
        current = ++generation.current;
        detach(session.current);
        session.current = null;
        activeRef.current = null;
        setClient(null);
        setActive(null);
        setRuns([]);
        historyRevision.current = undefined;
        setSessionKey((value) => value + 1);
      }
    } catch (reason) {
      if (current === generation.current)
        setError(
          reason instanceof Error ? reason.message : 'Could not delete context.',
        );
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };

  const ready = readyScope === scope;
  const getGeneration = useCallback((): number => generation.current, []);
  const isCurrent = useCallback(
    (value: number): boolean => generation.current === value,
    [],
  );
  return {
    runs: ready ? runs : [],
    client: ready ? client : null,
    contexts: ready ? contexts : [],
    active: ready ? active : null,
    loading: !ready || busy,
    unavailableId,
    error,
    sessionKey,
    getGeneration,
    isCurrent,
    ensureSession,
    acceptRun,
    save,
    open,
    beginNew,
    rename,
    remove,
  };
}
