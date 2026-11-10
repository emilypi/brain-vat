import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, RefObject } from 'react';
import { pointToViewport, rectToQuad } from './document';
import type { Anchor, PageBox, Point, Quad, Transform } from './document';
import {
  adjustRectangle,
  readSelectionWords,
  rectangle,
  wordsInside,
} from './selection-geometry';
import type {
  SelectionHandle,
  SelectionMode,
  SelectionRect,
  SelectionWord,
} from './selection-geometry';

interface SelectionToolProps {
  documentId: string;
  pageIndex: number;
  mode: Exclude<SelectionMode, null>;
  geometry: { width: number; height: number; transform: Transform; box: PageBox };
  canvas: RefObject<HTMLCanvasElement | null>;
  textLayer: RefObject<HTMLDivElement | null>;
  selection: Anchor | null;
  disabled: boolean;
  onSelect: (anchor: Anchor | null) => void;
}
interface Gesture {
  id: number;
  handle: SelectionHandle | 'draw';
  start: Point;
  original: SelectionRect;
  rect: SelectionRect;
}
const handles: { handle: SelectionHandle; label: string; x: number; y: number }[] = [
  { handle: 'nw', label: 'top left', x: 0, y: 0 },
  { handle: 'n', label: 'top', x: 50, y: 0 },
  { handle: 'ne', label: 'top right', x: 100, y: 0 },
  { handle: 'e', label: 'right', x: 100, y: 50 },
  { handle: 'se', label: 'bottom right', x: 100, y: 100 },
  { handle: 's', label: 'bottom', x: 50, y: 100 },
  { handle: 'sw', label: 'bottom left', x: 0, y: 100 },
  { handle: 'w', label: 'left', x: 0, y: 50 },
];
const styleFor = (rect: SelectionRect): React.CSSProperties => ({
  left: rect.left,
  top: rect.top,
  width: rect.right - rect.left,
  height: rect.bottom - rect.top,
});

/** An adjustable, canonical box independent of the browser's text selection. */
export function SelectionTool({
  documentId,
  pageIndex,
  mode,
  geometry,
  canvas,
  textLayer,
  selection,
  disabled,
  onSelect,
}: SelectionToolProps): React.JSX.Element {
  const layer = useRef<HTMLDivElement>(null);
  const lens = useRef<HTMLCanvasElement>(null);
  const moveButton = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<{ quad: Quad; anchor: Anchor | null } | null>(
    () => {
      if (!selection) return null;
      const points = selection.quads
        .flat()
        .map((point) => pointToViewport(point, geometry.transform, geometry.box));
      const bounds = {
        left: Math.min(...points.map((point) => point.x)),
        top: Math.min(...points.map((point) => point.y)),
        right: Math.max(...points.map((point) => point.x)),
        bottom: Math.max(...points.map((point) => point.y)),
      };
      return {
        quad: rectToQuad(bounds, geometry.transform, geometry.box),
        anchor: selection,
      };
    },
  );
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [words, setWords] = useState<SelectionWord[]>([]);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [message, setMessage] = useState('');
  const owned = draft?.anchor === selection;
  const points = owned
    ? draft?.quad.map((point) =>
        pointToViewport(point, geometry.transform, geometry.box),
      )
    : undefined;
  const committed = points
    ? {
        left: Math.min(...points.map((point) => point.x)),
        top: Math.min(...points.map((point) => point.y)),
        right: Math.max(...points.map((point) => point.x)),
        bottom: Math.max(...points.map((point) => point.y)),
      }
    : null;
  const rect = gesture?.rect ?? committed;
  const snapped = gesture && mode === 'text' ? wordsInside(words, gesture.rect) : [];

  useEffect(() => {
    if (!pointer || !canvas.current || !lens.current) return;
    const context = lens.current.getContext('2d');
    if (!context) return;
    const ratio = canvas.current.width / geometry.width;
    const zoom = 2.5;
    const width = 168 / zoom;
    const height = 112 / zoom;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 168, 112);
    context.drawImage(
      canvas.current,
      (pointer.x - width / 2) * ratio,
      (pointer.y - height / 2) * ratio,
      width * ratio,
      height * ratio,
      0,
      0,
      168,
      112,
    );
  }, [pointer, canvas, geometry.width]);

  const position = (event: PointerEvent): Point => {
    const bounds = layer.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(geometry.width, event.clientX - bounds.left)),
      y: Math.max(0, Math.min(geometry.height, event.clientY - bounds.top)),
    };
  };
  const collectWords = (): SelectionWord[] => {
    const next =
      mode === 'text' && textLayer.current ? readSelectionWords(textLayer.current) : [];
    setWords(next);
    return next;
  };
  const publish = (box: SelectionRect, available: SelectionWord[]): void => {
    const quad = rectToQuad(box, geometry.transform, geometry.box);
    const selected = wordsInside(available, box);
    const anchor: Anchor | null =
      mode === 'region'
        ? { documentId, pageIndex, kind: 'region', quote: '', quads: [quad] }
        : selected.length && selected.length <= 500
          ? {
              documentId,
              pageIndex,
              kind: 'text',
              quote: selected
                .map((word) => word.text)
                .join(' ')
                .slice(0, 20000),
              quads: selected.map((word) =>
                rectToQuad(word.rect, geometry.transform, geometry.box),
              ),
            }
          : null;
    setDraft({ quad, anchor });
    onSelect(anchor);
    setMessage(
      mode === 'region'
        ? 'Area selected'
        : selected.length > 500
          ? 'Select a smaller passage (up to 500 words).'
          : selected.length
            ? `${selected.length} ${selected.length === 1 ? 'word' : 'words'} selected`
            : 'No text here. Try Area for equations or scanned pages.',
    );
  };
  const begin = (event: PointerEvent, handle: Gesture['handle']): void => {
    if (disabled || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    window.getSelection()?.removeAllRanges();
    const start = position(event);
    if (handle !== 'draw' && !committed) return;
    const box = handle === 'draw' ? rectangle(start, start) : committed!;
    collectWords();
    layer.current?.focus({ preventScroll: true });
    layer.current?.setPointerCapture(event.pointerId);
    setGesture({ id: event.pointerId, handle, start, original: box, rect: box });
    setPointer(start);
    setMessage('');
  };
  const edited = (current: Gesture, end: Point): SelectionRect =>
    current.handle === 'draw'
      ? rectangle(current.start, end)
      : adjustRectangle(
          current.original,
          current.handle,
          {
            x: end.x - current.start.x,
            y: end.y - current.start.y,
          },
          geometry,
        );
  const finish = (event: PointerEvent): void => {
    if (!gesture || gesture.id !== event.pointerId) return;
    event.stopPropagation();
    const end = position(event);
    let box = edited(gesture, end);
    if (
      gesture.handle === 'draw' &&
      mode === 'text' &&
      Math.hypot(end.x - gesture.start.x, end.y - gesture.start.y) < 5
    ) {
      const word = words.find(
        ({ rect }) =>
          end.x >= rect.left &&
          end.x <= rect.right &&
          end.y >= rect.top &&
          end.y <= rect.bottom,
      );
      if (word) box = word.rect;
    }
    if (box.right - box.left >= 2 && box.bottom - box.top >= 2) publish(box, words);
    setGesture(null);
    setPointer(null);
    layer.current?.releasePointerCapture(event.pointerId);
    // Focus the box after React mounts it, without scrolling the paper.
    requestAnimationFrame(() => moveButton.current?.focus({ preventScroll: true }));
  };
  const nudge = (event: KeyboardEvent, handle: SelectionHandle): void => {
    if (!committed || !event.key.startsWith('Arrow')) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 10 : 1;
    const delta = {
      x: event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
      y: event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0,
    };
    const next = adjustRectangle(committed, handle, delta, geometry);
    publish(next, collectWords());
  };
  const cancelGesture = (): void => {
    setGesture(null);
    setPointer(null);
  };

  return (
    <div
      ref={layer}
      className="precision-layer"
      data-testid="region-layer"
      tabIndex={-1}
      inert={disabled}
      style={{ visibility: disabled ? 'hidden' : undefined }}
      aria-label={mode === 'text' ? 'Text box selection' : 'Area selection'}
      onPointerDown={(event) => begin(event, 'draw')}
      onPointerMove={(event) => {
        if (!gesture || gesture.id !== event.pointerId) return;
        const end = position(event);
        setGesture({ ...gesture, rect: edited(gesture, end) });
        setPointer(end);
      }}
      onPointerUp={finish}
      onPointerCancel={cancelGesture}
      onLostPointerCapture={cancelGesture}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (gesture) cancelGesture();
          else {
            setDraft(null);
            onSelect(null);
            setMessage('Selection cleared');
          }
        }
      }}
    >
      {snapped.map((word, index) => (
        <span className="snapped-word" key={index} style={styleFor(word.rect)} />
      ))}
      {rect && (
        <div className="precision-box" style={styleFor(rect)}>
          <button
            ref={moveButton}
            className="precision-move"
            aria-label="Move selection box"
            title="Drag to move. Arrow keys nudge; Shift moves 10 pixels."
            onPointerDown={(event) => begin(event, 'move')}
            onKeyDown={(event) => nudge(event, 'move')}
          />
          {handles.map(({ handle, label, x, y }) => (
            <button
              key={handle}
              className={'precision-handle handle-' + handle}
              style={{ left: x + '%', top: y + '%' }}
              aria-label={'Resize selection ' + label}
              title="Drag or use arrow keys to resize. Shift adjusts 10 pixels."
              onPointerDown={(event) => begin(event, handle)}
              onKeyDown={(event) => nudge(event, handle)}
            />
          ))}
        </div>
      )}
      {message && rect && (
        <div
          className="precision-status"
          role="status"
          style={{
            left: Math.max(0, Math.min(rect.left, geometry.width - 230)),
            top:
              rect.bottom + 12 < geometry.height - 40
                ? rect.bottom + 12
                : Math.max(0, rect.top - 45),
          }}
        >
          {message}
        </div>
      )}
      {pointer && <Magnifier point={pointer} layer={layer} lens={lens} />}
    </div>
  );
}

function Magnifier({
  point,
  layer,
  lens,
}: {
  point: Point;
  layer: RefObject<HTMLDivElement | null>;
  lens: RefObject<HTMLCanvasElement | null>;
}): React.JSX.Element {
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useEffect(() => {
    const bounds = layer.current?.getBoundingClientRect();
    if (!bounds) return;
    const x = bounds.left + point.x;
    const y = bounds.top + point.y;
    setPosition({
      left: Math.max(8, Math.min(x + 22, window.innerWidth - 180)),
      top: y >= 138 ? y - 130 : y + 24,
    });
  }, [point, layer]);
  return (
    <div className="selection-magnifier" style={position} aria-hidden="true">
      <canvas ref={lens} width={168} height={112} />
      <span>2.5×</span>
    </div>
  );
}
