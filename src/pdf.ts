import { useCallback, useEffect, useState } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Paper, PaperPassage } from './document';

GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfState {
  documentId: string | null;
  document: PDFDocumentProxy | null;
  pages: PaperPassage[];
  indexing: boolean;
  error: string | null;
}

interface PdfReaderState extends PdfState {
  onPageReady: (document: PDFDocumentProxy) => void;
}

export function usePdf(paper: Paper | null, enhanced = false): PdfReaderState {
  const [readyDocument, setReadyDocument] = useState<PDFDocumentProxy | null>(null);
  const onPageReady = useCallback((document: PDFDocumentProxy) => {
    setReadyDocument(document);
  }, []);
  const [state, setState] = useState<PdfState>({
    documentId: null,
    document: null,
    pages: [],
    indexing: false,
    error: null,
  });
  const bytes = paper?.bytes;
  const documentId = paper?.id ?? null;
  useEffect(() => {
    setReadyDocument(null);
    if (!bytes) {
      setState({ documentId, document: null, pages: [], indexing: false, error: null });
      return;
    }
    let cancelled = false;
    const assets = new URL('/pdfjs/', location.href).href;
    const task = getDocument({
      data: bytes.slice(0),
      cMapUrl: assets + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: assets + 'standard_fonts/',
      wasmUrl: assets + 'wasm/',
      iccUrl: assets + 'iccs/',
    });
    setState({ documentId, document: null, pages: [], indexing: true, error: null });
    void task.promise
      .then((document) => {
        if (cancelled) return;
        setState({ documentId, document, pages: [], indexing: true, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState((current) => ({
            ...current,
            indexing: false,
            error: error instanceof Error ? error.message : 'Unable to read this PDF.',
          }));
        }
      });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [bytes, documentId]);

  const document = state.documentId === documentId ? state.document : null;
  // Enhanced mode needs extracted text itself; otherwise let the visible PDF win.
  const canIndex = Boolean(document && (readyDocument === document || enhanced));
  useEffect(() => {
    if (!document || !canIndex) return;
    let cancelled = false;
    void (async () => {
      const pages: PaperPassage[] = [];
      for (let index = 0; index < document.numPages; index += 1) {
        if (cancelled) return;
        const page = await document.getPage(index + 1);
        if (cancelled) return;
        const content = await page.getTextContent();
        if (cancelled) return;
        const text = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        pages.push({ pageIndex: index, text });
      }
      setState((current) =>
        current.document === document
          ? { ...current, pages, indexing: false }
          : current,
      );
    })().catch((reason: unknown) => {
      if (!cancelled) {
        setState((current) =>
          current.document === document
            ? {
                ...current,
                indexing: false,
                error: reason instanceof Error ? reason.message : 'Indexing failed.',
              }
            : current,
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [document, canIndex]);

  const current =
    state.documentId === documentId
      ? state
      : {
          documentId,
          document: null,
          pages: [],
          indexing: Boolean(bytes),
          error: null,
        };
  return { ...current, onPageReady };
}

export async function destinationPage(
  pdf: PDFDocumentProxy,
  destination: string | unknown[] | null,
): Promise<number | null> {
  const target: unknown =
    typeof destination === 'string'
      ? await pdf.getDestination(destination)
      : destination;
  if (!Array.isArray(target)) return null;
  const first: unknown = target[0];
  if (
    typeof first === 'number' &&
    Number.isInteger(first) &&
    first >= 0 &&
    first < pdf.numPages
  )
    return first;
  if (
    first &&
    typeof first === 'object' &&
    'num' in first &&
    'gen' in first &&
    typeof first.num === 'number' &&
    typeof first.gen === 'number'
  ) {
    const index = await pdf.getPageIndex({ num: first.num, gen: first.gen });
    return index >= 0 && index < pdf.numPages ? index : null;
  }
  return null;
}
