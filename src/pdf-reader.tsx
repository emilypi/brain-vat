import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { PdfPage } from './pdf-page';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Anchor, Highlight } from './document';
import type { SelectionMode } from './selection-geometry';

export interface PageNavigation {
  pageIndex: number;
  revision: number;
}

interface PdfReaderProps {
  document: PDFDocumentProxy;
  documentId: string;
  pageIndex: number;
  navigation: PageNavigation;
  scale: number;
  rotation: number;
  selectionMode: SelectionMode;
  showSources: boolean;
  highlights: Highlight[];
  selection: Anchor | null;
  inspectedAnchor: Anchor | null;
  onSelect: (anchor: Anchor | null) => void;
  onDefine: (anchor: Anchor) => void;
  onNavigate: (pageIndex: number) => void;
  onVisiblePage: (pageIndex: number) => void;
  onPageReady: (document: PDFDocumentProxy) => void;
}

interface PageSize {
  width: number;
  height: number;
}

interface PageLayout extends PageSize {
  top: number;
  pageIndex: number;
}

/** Show the first page immediately; refine later page geometry in the background. */
export async function loadPageSizes(
  document: Pick<PDFDocumentProxy, 'numPages' | 'getPage'>,
  onSizes: (sizes: PageSize[]) => void,
  signal: AbortSignal,
): Promise<void> {
  const sizes: PageSize[] = [];
  for (let index = 0; index < document.numPages; index += 1) {
    if (signal.aborted) return;
    const page = await document.getPage(index + 1);
    if (signal.aborted) return;
    const { width, height } = page.getViewport({ scale: 1 });
    const size = { width, height };
    if (index === 0) {
      // Reserve the whole scroll range before the remaining pages are decoded.
      sizes.push(...Array.from({ length: document.numPages }, () => size));
      onSizes([...sizes]);
    } else if (sizes[index]?.width !== width || sizes[index]?.height !== height) {
      sizes[index] = size;
      onSizes([...sizes]);
    }
  }
}

/** Keep page geometry in the flow, but only rasterize near the reading position. */
export function PdfReader({
  document,
  documentId,
  pageIndex,
  navigation,
  scale,
  rotation,
  selectionMode,
  showSources,
  highlights,
  selection,
  inspectedAnchor,
  onSelect,
  onDefine,
  onNavigate,
  onVisiblePage,
  onPageReady,
}: PdfReaderProps): React.JSX.Element {
  const stage = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [error, setError] = useState('');
  const [viewport, setViewport] = useState({ width: 0, height: 0, top: 0 });
  const [focusedPage, setFocusedPage] = useState<number | null>(null);
  const anchor = useRef({ pageIndex: navigation.pageIndex, fraction: 0 });
  const lastNavigation = useRef<PageNavigation | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void loadPageSizes(document, setSizes, controller.signal).catch(
      (reason: unknown) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : 'Unable to lay out the PDF.',
          );
      },
    );
    return () => {
      controller.abort();
    };
  }, [document]);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      // Extra space only centers the page. Keep its canvas stable as Ask slides.
      const width = Math.min(840, entry.contentRect.width);
      const height = entry.contentRect.height;
      setViewport((current) =>
        current.width === width && current.height === height
          ? current
          : { ...current, width, height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => {
    const result: PageLayout[] = [];
    for (const [index, size] of sizes.entries()) {
      const sideways = rotation % 180 !== 0;
      const width = Math.min(840, viewport.width) * (scale / 1.05);
      const height =
        width * (sideways ? size.width / size.height : size.height / size.width);
      const previous = result.at(-1);
      const top = previous ? previous.top + previous.height + 18 : 0;
      result.push({ pageIndex: index, top, width, height });
    }
    return result;
  }, [sizes, viewport.width, rotation, scale]);

  const readPosition = useCallback(() => {
    const element = stage.current;
    if (!element || layout.length === 0 || viewport.width <= 0) return;
    const top = element.scrollTop;
    const first =
      layout.find((page) => page.top + page.height > top) ?? layout[layout.length - 1]!;
    anchor.current = {
      pageIndex: first.pageIndex,
      fraction: Math.max(0, (top - first.top) / first.height),
    };
    const bottom = top + element.clientHeight;
    let current = first;
    let mostVisible = 0;
    for (const page of layout) {
      const visible =
        Math.min(bottom, page.top + page.height) - Math.max(top, page.top);
      if (visible > mostVisible) {
        current = page;
        mostVisible = visible;
      }
    }
    onVisiblePage(current.pageIndex);
    setViewport((value) => (value.top === top ? value : { ...value, top }));
  }, [layout, onVisiblePage, viewport.width]);

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element || !layout.length || viewport.width <= 0) return;
    const requested = lastNavigation.current !== navigation;
    const target = requested
      ? { pageIndex: navigation.pageIndex, fraction: 0 }
      : anchor.current;
    const page = layout[target.pageIndex];
    if (!page) return;
    lastNavigation.current = navigation;
    element.scrollTop = page.top + page.height * target.fraction;
    readPosition();
  }, [layout, navigation, readPosition, viewport.width]);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    let frame = 0;
    const scroll = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        readPosition();
      });
    };
    element.addEventListener('scroll', scroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', scroll);
      cancelAnimationFrame(frame);
    };
  }, [readPosition]);

  return (
    <div
      ref={stage}
      className="page-stage continuous-pages"
      aria-label="Paper pages"
      tabIndex={0}
    >
      {error && <p role="alert">{error}</p>}
      {!error && layout.length === 0 && <p>Opening your paper…</p>}
      {viewport.width > 0 &&
        layout.map((item) => {
          const nearby =
            item.top + item.height >= viewport.top - viewport.height &&
            item.top <= viewport.top + viewport.height * 2;
          const mounted =
            nearby ||
            item.pageIndex === selection?.pageIndex ||
            item.pageIndex === focusedPage;
          return (
            <div
              className="pdf-page-slot"
              key={item.pageIndex}
              data-page-index={item.pageIndex}
              style={{ width: item.width, height: item.height }}
              onFocusCapture={() => setFocusedPage(item.pageIndex)}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setFocusedPage(null);
                }
              }}
            >
              {mounted ? (
                <PdfPage
                  document={document}
                  documentId={documentId}
                  pageIndex={item.pageIndex}
                  width={item.width}
                  active={item.pageIndex === pageIndex}
                  rotation={rotation}
                  selectionMode={selectionMode}
                  showSources={showSources}
                  highlights={highlights}
                  selection={selection}
                  inspectedAnchor={inspectedAnchor}
                  onSelect={onSelect}
                  onDefine={onDefine}
                  onNavigate={onNavigate}
                  onPageReady={onPageReady}
                />
              ) : (
                <span className="page-placeholder">Page {item.pageIndex + 1}</span>
              )}
            </div>
          );
        })}
    </div>
  );
}
