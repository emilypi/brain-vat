import { useRef } from 'react';

interface CompanionResizeProps {
  width: number;
  onResize: (width: number) => void;
  onDragging: (dragging: boolean) => void;
}

export const DEFAULT_COMPANION_WIDTH = 420;

function clampCompanionWidth(width: number): number {
  return Math.max(320, Math.min(680, width));
}

export function CompanionResize({
  width,
  onResize,
  onDragging,
}: CompanionResizeProps): React.JSX.Element {
  const drag = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      className="companion-resize"
      role="separator"
      aria-label="Resize reading companion"
      aria-orientation="vertical"
      aria-valuemin={320}
      aria-valuemax={680}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title="Drag to resize · Arrow keys adjust · Enter resets"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width };
        onDragging(true);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        onResize(
          clampCompanionWidth(drag.current.width + drag.current.x - event.clientX),
        );
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        onDragging(false);
      }}
      onDoubleClick={() => onResize(DEFAULT_COMPANION_WIDTH)}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Enter', 'Home'].includes(event.key)) return;
        event.preventDefault();
        const delta = event.shiftKey ? 40 : 20;
        onResize(
          event.key === 'Enter' || event.key === 'Home'
            ? DEFAULT_COMPANION_WIDTH
            : clampCompanionWidth(width + (event.key === 'ArrowLeft' ? delta : -delta)),
        );
      }}
    />
  );
}
