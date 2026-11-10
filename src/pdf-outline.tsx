import { useEffect, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { destinationPage } from './pdf';

interface OutlineEntry {
  id: string;
  title: string;
  pageIndex: number | null;
  children: OutlineEntry[];
}

interface PdfOutlineProps {
  document: PDFDocumentProxy;
  pageIndex: number;
  onNavigate: (pageIndex: number) => void;
}

interface RawOutline {
  title: string;
  dest: string | unknown[] | null;
  items: RawOutline[];
}

async function readOutline(document: PDFDocumentProxy): Promise<OutlineEntry[]> {
  let remaining = 2000;
  const visit = async (
    nodes: RawOutline[],
    path = '',
    depth = 0,
  ): Promise<OutlineEntry[]> => {
    if (depth > 20) return [];
    const result: OutlineEntry[] = [];
    for (const [index, node] of nodes.entries()) {
      if (remaining-- <= 0) break;
      const id = path + '/' + index;
      result.push({
        id,
        title: node.title.trim() || 'Untitled section',
        pageIndex: await destinationPage(document, node.dest).catch(() => null),
        children: await visit(node.items ?? [], id, depth + 1),
      });
    }
    return result;
  };
  return visit((await document.getOutline()) ?? []);
}

function filterOutline(entries: OutlineEntry[], query: string): OutlineEntry[] {
  return entries.flatMap((entry) => {
    if (entry.title.toLowerCase().includes(query)) return [entry];
    const children = filterOutline(entry.children, query);
    return children.length ? [{ ...entry, children }] : [];
  });
}

function flatten(entries: OutlineEntry[]): OutlineEntry[] {
  return entries.flatMap((entry) => [entry, ...flatten(entry.children)]);
}

/** Browse the PDF's own bookmarks without inferring headings from body text. */
export function PdfOutline({
  document,
  pageIndex,
  onNavigate,
}: PdfOutlineProps): React.JSX.Element {
  const [entries, setEntries] = useState<OutlineEntry[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError('');
    setQuery('');
    void readOutline(document).then(
      (outline) => {
        if (!cancelled) setEntries(outline);
      },
      () => {
        if (!cancelled) setError('The PDF outline could not be read.');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [document]);

  const current = flatten(entries ?? [])
    .filter((entry) => entry.pageIndex !== null && entry.pageIndex <= pageIndex)
    .sort((a, b) => a.pageIndex! - b.pageIndex!)
    .at(-1)?.id;
  const filtered = filterOutline(entries ?? [], query.trim().toLowerCase());
  const render = (items: OutlineEntry[]): React.JSX.Element => (
    <ol>
      {items.map((entry) => (
        <li key={entry.id}>
          <button
            disabled={entry.pageIndex === null}
            aria-current={entry.id === current ? 'location' : undefined}
            onClick={() => {
              if (entry.pageIndex !== null) onNavigate(entry.pageIndex);
            }}
          >
            <span>{entry.title}</span>
            {entry.pageIndex !== null && <small>{entry.pageIndex + 1}</small>}
          </button>
          {entry.children.length > 0 && render(entry.children)}
        </li>
      ))}
    </ol>
  );

  return (
    <section className="library-section pdf-outline" aria-label="Table of contents">
      <div className="section-label">CONTENTS</div>
      {error ? (
        <p className="muted small" role="status">
          {error}
        </p>
      ) : entries === null ? (
        <p className="muted small">Loading contents…</p>
      ) : entries.length === 0 ? (
        <p className="muted small">This PDF has no embedded table of contents.</p>
      ) : (
        <>
          <input
            type="search"
            className="library-search"
            aria-label="Find a section"
            placeholder="Find a section…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {filtered.length ? (
            render(filtered)
          ) : (
            <p className="muted small">No sections match your search.</p>
          )}
        </>
      )}
    </section>
  );
}
