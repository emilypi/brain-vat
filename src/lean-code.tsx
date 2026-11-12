interface LeanCodeProps {
  code: string;
  firstLine?: number;
}

const keywords = new Set([
  'import',
  'theorem',
  'lemma',
  'def',
  'by',
  'intro',
  'intros',
  'exact',
  'apply',
  'refine',
  'have',
  'obtain',
  'rcases',
  'cases',
  'constructor',
  'simp',
  'simpa',
  'rw',
  'rfl',
  'induction',
  'with',
  'fun',
  'let',
  'show',
  'from',
  'where',
]);

/** A text-only presentation of Lean source; never evaluates generated code. */
export function LeanCode({ code, firstLine = 1 }: LeanCodeProps): React.JSX.Element {
  const lines = code.trimEnd().split('\n');
  return (
    <pre className="lean-code">
      <code>
        {lines.map((line, index) => (
          <span className="lean-line" key={index}>
            <span className="lean-line-number" aria-hidden="true">
              {firstLine + index}
            </span>
            <span className="lean-line-content">
              {line
                .split(/(--.*$|"(?:[^"\\]|\\.)*"|[\p{L}_][\p{L}\p{N}_']*)/u)
                .map((token, part) => (
                  <span
                    key={part}
                    className={
                      token.startsWith('--')
                        ? 'lean-comment'
                        : token.startsWith('"')
                          ? 'lean-string'
                          : token === 'sorry'
                            ? 'lean-admission'
                            : keywords.has(token)
                              ? 'lean-keyword'
                              : undefined
                    }
                  >
                    {token}
                  </span>
                ))}
              {index < lines.length - 1 ? '\n' : ''}
            </span>
          </span>
        ))}
      </code>
    </pre>
  );
}
