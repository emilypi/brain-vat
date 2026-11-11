import { useEffect, useRef, useState } from 'react';
import { TextLayer } from 'pdfjs-dist';
import { destinationPage } from './pdf';
import { SelectionTool } from './selection-tool';
import { pointToViewport, rectToQuad } from './document';
import { findTextReferences, readLinkAnnotations } from './source-links';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type { Anchor, Highlight, PageBox, Transform } from './document';
import type { SelectionMode } from './selection-geometry';
import './research.css';

interface PdfPageProps {
  document: PDFDocumentProxy;
  documentId: string;
  pageIndex: number;
  width: number;
  active: boolean;
  showSources?: boolean;
  rotation: number;
  selectionMode: SelectionMode;
  highlights: Highlight[];
  selection: Anchor | null;
  onSelect: (anchor: Anchor | null) => void;
  onDefine: (anchor: Anchor) => void;
  onNavigate?: (pageIndex: number) => void;
}

interface SourceOverlay {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  label: string;
  url: string | null;
  pageIndex: number | null;
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
  width,
  active,
  showSources = true,
  rotation,
  selectionMode,
  highlights,
  selection,
  onSelect,
  onDefine,
  onNavigate,
}: PdfPageProps): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const textContainer = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceLinks, setSourceLinks] = useState<SourceOverlay[]>([]);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    let page: PDFPageProxy | undefined;
    setReady(false);
    setError(null);
    setSourceLinks([]);
    setPreview(null);
    if (width <= 0) return;
    void (async () => {
      page = await document.getPage(pageIndex + 1);
      if (cancelled || !canvas.current || !textContainer.current) return;
      const pageRotation = (page.rotate + rotation) % 360;
      const original = page.getViewport({ scale: 1, rotation: pageRotation });
      const renderScale = width / original.width;
      const viewport = page.getViewport({ scale: renderScale, rotation: pageRotation });
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
      textContainer.current.style.setProperty(
        '--total-scale-factor',
        String(renderScale),
      );
      textContainer.current.style.setProperty('--scale-factor', String(renderScale));
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
      if (cancelled) return;
      setReady(true);
      const annotations: unknown[] = await page
        .getAnnotations({ intent: 'display' })
        .catch(() => []);
      const links = await Promise.all(
        readLinkAnnotations(annotations).map(async (link) => {
          const [a, b, c, d, e, f] = transform;
          const [left, bottom, right, top] = link.rect;
          const x1 = a * left + c * bottom + e;
          const y1 = b * left + d * bottom + f;
          const x2 = a * right + c * top + e;
          const y2 = b * right + d * top + f;
          const target = await destinationPage(document, link.destination).catch(
            () => null,
          );
          return {
            id: link.id,
            left: Math.min(x1, x2),
            top: Math.min(y1, y2),
            width: Math.abs(x2 - x1),
            height: Math.abs(y2 - y1),
            label: link.label,
            url: link.url,
            pageIndex: target,
          };
        }),
      );
      if (cancelled || !textContainer.current || !surface.current) return;
      const bounds = surface.current.getBoundingClientRect();
      const walker = globalThis.document.createTreeWalker(
        textContainer.current,
        NodeFilter.SHOW_TEXT,
      );
      let node = walker.nextNode();
      while (node && links.length < 160) {
        for (const reference of findTextReferences(node.textContent ?? '')) {
          const range = globalThis.document.createRange();
          range.setStart(node, reference.start);
          range.setEnd(node, reference.end);
          const rect = range.getBoundingClientRect();
          const left = rect.left - bounds.left;
          const top = rect.top - bounds.top;
          const overlaps = links.some(
            (link) =>
              left < link.left + link.width &&
              left + rect.width > link.left &&
              top < link.top + link.height &&
              top + rect.height > link.top,
          );
          if (!overlaps && rect.width > 1 && rect.height > 1)
            links.push({
              id: 'text-reference-' + links.length,
              left,
              top,
              width: rect.width,
              height: rect.height,
              label: reference.label,
              url: reference.url,
              pageIndex: null,
            });
        }
        node = walker.nextNode();
      }
      if (!cancelled) setSourceLinks(links);
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
  }, [document, pageIndex, width, rotation]);

  const captureText = (): void => {
    if (selectionMode || !geometry || !surface.current || !ready) return;
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

  const term =
    selection?.documentId === documentId &&
    selection.pageIndex === pageIndex &&
    selection.kind === 'text' &&
    selection.quote.trim()
      ? selection
      : null;
  const termPoints =
    geometry && term
      ? term.quads.flatMap((quad) =>
          quad.map((point) => pointToViewport(point, geometry.transform, geometry.box)),
        )
      : [];
  const termTop = Math.min(...termPoints.map((point) => point.y));
  const termBottom = Math.max(...termPoints.map((point) => point.y));
  const termRight = Math.max(...termPoints.map((point) => point.x));

  return (
    <div
      ref={surface}
      className="pdf-page"
      data-testid="pdf-page"
      data-active={active}
      data-page-index={pageIndex}
      data-ready={ready}
      aria-label={'Page ' + (pageIndex + 1)}
      style={{ width: geometry?.width, height: geometry?.height }}
      onPointerUp={captureText}
      onKeyUp={captureText}
    >
      <canvas ref={canvas} aria-hidden="true" />
      <div ref={textContainer} className="textLayer" />
      {ready && sourceLinks.length > 0 && !selectionMode && (
        <>
          {showSources && (
            <div className="pdf-source-layer" aria-label="Paper sources">
              {sourceLinks.map((link) => {
                const tipId = 'source-tip-' + pageIndex + '-' + link.id;
                const label =
                  link.pageIndex !== null
                    ? `This paper · page ${link.pageIndex + 1}`
                    : 'Cited reference · metadata only';
                return (
                  <div
                    className="pdf-source"
                    key={link.id}
                    style={{
                      left: link.left,
                      top: link.top,
                      width: link.width,
                      height: link.height,
                    }}
                  >
                    {link.url ? (
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={link.label + ' · open cited source'}
                        aria-describedby={tipId}
                      />
                    ) : (
                      <button
                        aria-label={link.label}
                        aria-describedby={tipId}
                        onClick={() => {
                          if (link.pageIndex !== null && onNavigate)
                            onNavigate(link.pageIndex);
                          else setPreview(preview === link.id ? null : link.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setPreview(null);
                        }}
                      />
                    )}
                    <span
                      id={tipId}
                      className={
                        'source-preview' + (preview === link.id ? ' preview-open' : '')
                      }
                      role="tooltip"
                    >
                      <strong>{label}</strong>
                      <span>{link.label}</span>
                      {link.url ? (
                        <span>
                          {new URL(link.url).hostname} · content not retrieved
                        </span>
                      ) : (
                        link.pageIndex === null && (
                          <span>Bibliography details are unresolved.</span>
                        )
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
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
      {selectionMode && geometry && (
        <SelectionTool
          key={selectionMode}
          documentId={documentId}
          pageIndex={pageIndex}
          mode={selectionMode}
          geometry={geometry}
          canvas={canvas}
          textLayer={textContainer}
          selection={selection?.pageIndex === pageIndex ? selection : null}
          disabled={!ready}
          onSelect={onSelect}
        />
      )}
      {!ready && !error && <div className="page-loading">Rendering page…</div>}
      {ready && geometry && term && termPoints.length > 0 && (
        <button
          className="inline-define-trigger"
          data-define-selection
          aria-label="Define selected text"
          style={{
            left: Math.max(4, Math.min(termRight - 60, geometry.width - 68)),
            top: Math.min(
              geometry.height - 34,
              termTop >= 40 ? termTop - 36 : termBottom + 12,
            ),
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onPointerUp={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onDefine(term);
          }}
        >
          Define
        </button>
      )}
      {error && (
        <div className="page-loading" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
