import { useEffect, useRef, useState } from 'react';
import type { useSoloContext } from './solo-context';
import type { SavedContextReference } from './saved-context';
import './saved-context.css';

type ContextController = ReturnType<typeof useSoloContext>;

export function SavedContextControl({
  controller,
  disabled,
}: {
  controller: ContextController;
  disabled: boolean;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const [replacement, setReplacement] = useState<SavedContextReference | 'new' | null>(
    null,
  );
  const active = controller.active;
  const blocked = disabled || controller.loading;
  const missing = controller.contexts.find(
    (item) => item.id === controller.unavailableId,
  );
  useEffect(() => {
    setName(active?.name ?? '');
    setDeleting(false);
    setReplacement(null);
  }, [active?.id, active?.name, controller.sessionKey]);

  const replace = (target: SavedContextReference | 'new'): void => {
    if (!active && controller.runs.length > 0) setReplacement(target);
    else if (target === 'new') controller.beginNew();
    else void controller.open(target);
  };

  return (
    <div className="context-controls">
      <details
        className="saved-context-control"
        ref={menu}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && menu.current?.open) {
            event.preventDefault();
            event.stopPropagation();
            menu.current.open = false;
            menu.current.querySelector('summary')?.focus();
          }
        }}
      >
        <summary>
          <span>Contexts</span>
          <span className="context-current" title={active?.name}>
            {controller.loading ? 'Loading…' : (active?.name ?? 'Unsaved conversation')}
          </span>
        </summary>
        <div className="saved-context-menu">
          <label>
            <span>Saved for this PDF</span>
            <select
              aria-label="Saved contexts"
              value={active?.id ?? ''}
              disabled={blocked}
              onChange={(event) => {
                const selected = controller.contexts.find(
                  (item) => item.id === event.target.value,
                );
                if (selected) replace(selected);
              }}
            >
              <option value="">Choose a context</option>
              {controller.contexts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (blocked || !name.trim()) return;
              if (active) void controller.rename(name.trim());
              else void controller.save(name.trim());
            }}
          >
            <label>
              <span>Context name</span>
              <input
                aria-label="Context name"
                value={name}
                maxLength={80}
                disabled={blocked || Boolean(missing)}
                placeholder="e.g. Understanding Theorem 3"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <button
              className="text-button"
              disabled={
                blocked ||
                !name.trim() ||
                Boolean(missing) ||
                name.trim() === active?.name
              }
            >
              {active ? 'Rename context' : 'Save context'}
            </button>
          </form>
          <p className="muted small context-storage-note">
            {active
              ? 'Updates save automatically. Reopening keeps your conversation, ' +
                'walkthroughs and recorded Lean checks.'
              : 'Save this conversation and its proof results on your local server. ' +
                'New questions will keep updating the named context.'}
          </p>
          <div className="context-actions">
            <button
              className="text-button"
              disabled={blocked}
              onClick={() => replace('new')}
            >
              New conversation
            </button>
            {active && (
              <button
                className="text-button"
                disabled={blocked}
                onClick={() => setDeleting(true)}
              >
                Delete context
              </button>
            )}
          </div>
          {replacement && (
            <div className="context-confirmation" role="status">
              <p>
                This conversation is unsaved. Save it above to keep its proof results.
              </p>
              <button
                className="text-button"
                disabled={blocked}
                onClick={() => {
                  if (replacement === 'new') controller.beginNew();
                  else void controller.open(replacement);
                  setReplacement(null);
                }}
              >
                Continue without saving
              </button>
              <button className="text-button" onClick={() => setReplacement(null)}>
                Keep this conversation
              </button>
            </div>
          )}
          {deleting && active && (
            <div className="context-confirmation" role="status">
              <p>
                Delete “{active.name}” and its saved conversation and proof results?
              </p>
              <button
                className="text-button"
                disabled={blocked}
                onClick={() => void controller.remove(active)}
              >
                Delete saved context
              </button>
              <button className="text-button" onClick={() => setDeleting(false)}>
                Keep context
              </button>
            </div>
          )}
          {missing && (
            <div className="context-confirmation">
              <p>“{missing.name}” is unavailable. Its local reference is still here.</p>
              <button
                className="text-button"
                disabled={blocked}
                onClick={() => void controller.open(missing)}
              >
                Retry opening context
              </button>
              <button
                className="text-button"
                disabled={blocked}
                onClick={() => void controller.remove(missing, true)}
              >
                Forget local reference
              </button>
            </div>
          )}
        </div>
      </details>
      {controller.error && (
        <p className="research-error" role="alert">
          {controller.error}
        </p>
      )}
    </div>
  );
}
