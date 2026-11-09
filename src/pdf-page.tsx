import { useEffect, useRef, useState } from 'react';
import { TextLayer } from 'pdfjs-dist';
import { pointToViewport, rectToQuad } from './document';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type { Anchor, Highlight, PageBox, Point, Transform } from './document';
import type { PointerEvent as ReactPointerEvent } from 'react';

interface PdfPageProps {
  document: PDFDocumentProxy;
  documentId: string;
  pageIndex: number;
  scale: number;
  rotation: number;
  regionMode: boolean;
  highlights: Highlight[];
  selection: Anchor | null;
  onSelect: (anchor: Anchor) => void;
}

interface Geometry {
  width: number;
  height: number;
  transform: Transform;
  box: PageBox;
}

export function PdfPage({
  document,
  documentId,
  pageIndex,
  scale,
  rotation,
  regionMode,
  highlights,
  selection,
  onSelect,
}: PdfPageProps): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const textContainer = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [dragEnd, setDragEnd] = useState<Point | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    let page: PDFPageProxy | undefined;
    setReady(false);
    setError(null);
    void (async () => {
      page = await document.getPage(pageIndex + 1);
      if (cancelled || !canvas.current || !textContainer.current) return;
      const viewport = page.getViewport({
        scale,
        rotation: (page.rotate + rotation) % 360,
      });
      const transform = viewport.transform as unknown as Transform;
      const box = page.view as unknown as PageBox;
      setGeometry({
        width: viewport.width,
        height: viewport.height,
        transform,
        box,
      });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.current.width = Math.ceil(viewport.width * pixelRatio);
      canvas.current.height = Math.ceil(viewport.height * pixelRatio);
      canvas.current.style.width = viewport.width + 'px';
      canvas.current.style.height = viewport.height + 'px';
      textContainer.current.replaceChildren();
      textContainer.current.style.setProperty('--total-scale-factor', String(scale));
      textContainer.current.style.setProperty('--scale-factor', String(scale));
      renderTask = page.render({
        canvas: canvas.current,
        viewport,
        transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      await renderTask.promise;
      if (cancelled) return;
      const content = await page.getTextContent();
      if (cancelled) return;
      textLayer = new TextLayer({
        textContentSource: content,
        container: textContainer.current,
        viewport,
      });
      await textLayer.render();
      if (!cancelled) setReady(true);
    })().catch((reason: unknown) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : 'Page rendering failed.');
      }
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [document, pageIndex, scale, rotation]);

  const captureText = (): void => {
    if (regionMode || !geometry || !surface.current || !ready) return;
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || selected.rangeCount === 0) return;
    const range = selected.getRangeAt(0);
    if (!textContainer.current?.contains(range.commonAncestorContainer)) return;
    const bounds = surface.current.getBoundingClientRect();
    const quads = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 1 && rect.height > 1)
      .slice(0, 500)
      .map((rect) =>
        rectToQuad(
          {
            left: rect.left - bounds.left,
            top: rect.top - bounds.top,
            right: rect.right - bounds.left,
            bottom: rect.bottom - bounds.top,
          },
          geometry.transform,
          geometry.box,
        ),
      );
    if (quads.length === 0) return;
    onSelect({
      documentId,
      pageIndex,
      kind: 'text',
      quote: selected.toString().slice(0, 20000),
      quads,
    });
  };

  const pointerPosition = (event: ReactPointerEvent): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  const finishRegion = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragStart || !geometry) return;
    const start = dragStart;
    const end = pointerPosition(event);
    setDragStart(null);
    setDragEnd(null);
    if (Math.abs(start.x - end.x) < 5 || Math.abs(start.y - end.y) < 5) return;
    const quad = rectToQuad(
      {
        left: Math.min(start.x, end.x),
        top: Math.min(start.y, end.y),
        right: Math.max(start.x, end.x),
        bottom: Math.max(start.y, end.y),
      },
      geometry.transform,
      geometry.box,
    );
    onSelect({ documentId, pageIndex, kind: 'region', quote: '', quads: [quad] });
  };

  const polygons = highlights
    .filter((item) => item.anchor.pageIndex === pageIndex)
    .flatMap((item) =>
      item.anchor.quads.map((quad, index) => ({
        key: item.id + ':' + index,
        quad,
        kind: 'saved',
      })),
    );
  if (selection?.pageIndex === pageIndex) {
    selection.quads.forEach((quad, index) => {
      polygons.push({ key: 'selection:' + index, quad, kind: 'selected' });
    });
  }

  return (
    <div
      ref={surface}
      className="pdf-page"
      data-testid="pdf-page"
      data-ready={ready}
      aria-label={'Page ' + (pageIndex + 1)}
      style={{ width: geometry?.width, height: geometry?.height }}
      onPointerUp={captureText}
      onKeyUp={captureText}
    >
      <canvas ref={canvas} aria-hidden="true" />
      <div ref={textContainer} className="textLayer" />
      {geometry && (
        <svg
          className="highlight-layer"
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          aria-hidden="true"
        >
          {polygons.map((item) => (
            <polygon
              key={item.key}
              data-testid={item.kind + '-highlight'}
              className={item.kind}
              points={item.quad
                .map((point) => {
                  const p = pointToViewport(point, geometry.transform, geometry.box);
                  return p.x + ',' + p.y;
                })
                .join(' ')}
            />
          ))}
        </svg>
      )}
      {regionMode && (
        <div
          className="region-layer"
          data-testid="region-layer"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragStart(pointerPosition(event));
            setDragEnd(pointerPosition(event));
          }}
          onPointerMove={(event) => {
            if (dragStart) setDragEnd(pointerPosition(event));
          }}
          onPointerUp={finishRegion}
          onPointerCancel={() => {
            setDragStart(null);
            setDragEnd(null);
          }}
        >
          {dragStart && dragEnd && (
            <div
              className="region-preview"
              style={{
                left: Math.min(dragStart.x, dragEnd.x),
                top: Math.min(dragStart.y, dragEnd.y),
                width: Math.abs(dragStart.x - dragEnd.x),
                height: Math.abs(dragStart.y - dragEnd.y),
              }}
            />
          )}
        </div>
      )}
      {!ready && !error && <div className="page-loading">Rendering page…</div>}
      {error && (
        <div className="page-loading" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
