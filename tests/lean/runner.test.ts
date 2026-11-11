import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createLeanChecker } from '../../server/lean-runner.ts';
import type { ProofBreakdown } from '../../src/proof.ts';
import { PROOF_FIXTURE } from '../fixtures/proofs.ts';
import { RECURRENCE_PROOF } from '../fixtures/recurrence-proof.ts';

const checker = createLeanChecker();
const signal = (): AbortSignal => new AbortController().signal;
const tamper = vi.hoisted(() => ({
  enabled: false,
  kernel: false,
  network: false,
  exports: 0,
}));

// Expose the pinned TCP primitive only in the sandbox probe, never in production.
vi.mock('../../src/proof.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/proof.ts')>();
  return {
    ...original,
    renderLeanProof: (input: ProofBreakdown) => {
      const source = original.renderLeanProof(input);
      if (!source || !tamper.network) return source;
      const header = 'import Std.Internal.UV.TCP\n';
      return {
        ...source,
        code: header + source.code,
        challenge: header + source.challenge,
        steps: source.steps.map((step) => ({
          ...step,
          startLine: step.startLine + 1,
          endLine: step.endLine + 1,
        })),
      };
    },
  };
});

// Simulate a compromised elaborator/exporter; all checking stages still run for real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    writeFile: async (...args: Parameters<typeof original.writeFile>) => {
      const [path, data, options] = args;
      if (
        (tamper.enabled || tamper.kernel) &&
        typeof path === 'string' &&
        /\/(?:Challenge|Proof)\.ndjson$/.test(path) &&
        typeof data === 'string'
      ) {
        const records = data
          .trimEnd()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as {
                in?: number;
                str?: { pre: number; str: string };
                ie?: number;
                sort?: number;
                axiom?: { name: number; type: number };
                thm?: { name: number; value: number };
              },
          );
        const target = tamper.kernel ? 'brainVatProof' : 'propext';
        const name = records.find((item) => item.str?.str === target)?.in;
        const prop = records.find((item) => item.sort === 0)?.ie;
        if (prop === undefined) throw new Error('Missing sort.');
        if (tamper.kernel) {
          if (!path.endsWith('/Proof.ndjson')) return original.writeFile(...args);
          const theorem = records.find((item) => item.thm?.name === name)?.thm;
          if (!theorem) throw new Error('Missing theorem.');
          theorem.value = prop;
        } else {
          const axiom = records.find((item) => item.axiom?.name === name)?.axiom;
          if (!axiom) throw new Error('Missing axiom.');
          axiom.type = prop;
        }
        tamper.exports += 1;
        return original.writeFile(
          path,
          records.map((item) => JSON.stringify(item)).join('\n') + '\n',
          options,
        );
      }
      return original.writeFile(...args);
    },
  };
});

function proof(statement: string, tactic: string): ProofBreakdown {
  return {
    ...PROOF_FIXTURE,
    statement,
    steps: [{ ...PROOF_FIXTURE.steps[0]!, tactic }],
  };
}

describe('real isolated Lean checker', () => {
  beforeAll(async () => {
    const health = await checker.status();
    expect(health.available, health.message).toBe(true);
  });

  test('checks a theorem and reports observed before/after goal states', async () => {
    const result = await checker.check(PROOF_FIXTURE, signal());
    expect(result.status, JSON.stringify(result)).toBe('checked');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.before[0]).toContain('∀');
    expect(result.steps[0]?.after[0]).toContain('a b c : ℕ');
    expect(result.steps[1]?.after).toEqual([]);
    expect(result.axioms).not.toContain('sorryAx');
  });

  test('checks the paper’s recurrence algebra with explicit assumptions', async () => {
    const result = await checker.check(RECURRENCE_PROOF, signal());
    expect(result.status, JSON.stringify(result)).toBe('checked');
    expect(result.steps).toHaveLength(3);
    expect(result.steps.at(-1)?.after).toEqual([]);
    expect(RECURRENCE_PROOF.gaps).toHaveLength(1);
  });

  test.each([
    ['admitted', proof('False', 'sorry'), 'incomplete'],
    ['unsolved', proof('True ∧ True', 'constructor\n· trivial'), 'incomplete'],
    ['false', proof('False', 'trivial'), 'failed'],
  ])('rejects the %s proof', async (_name, input, expected) => {
    const result = await checker.check(input, signal());
    expect(result.status, JSON.stringify(result)).toBe(expected);
    if (_name === 'admitted') expect(result.axioms).toContain('sorryAx');
  });

  test('does not treat a forged success message as verification', async () => {
    const result = await checker.check(
      proof('False', 'run_tac do IO.println "Your solution is okay!"\nsorry'),
      signal(),
    );
    expect(result.status).not.toBe('checked');
  });

  test('rejects shared axiom substitution against trusted Init', async () => {
    tamper.enabled = true;
    try {
      const result = await checker.check(PROOF_FIXTURE, signal());
      expect(tamper.exports).toBe(2);
      expect(result.status, JSON.stringify(result)).toBe('failed');
      expect(result.message).toContain('propext');
    } finally {
      tamper.enabled = false;
    }
  });

  test('cancels a job and enforces its deadline', async () => {
    const aborted = new AbortController();
    aborted.abort();
    expect((await checker.check(PROOF_FIXTURE, aborted.signal)).status).toBe(
      'cancelled',
    );
    const bounded = createLeanChecker({ timeoutMs: 100 });
    const result = await bounded.check(PROOF_FIXTURE, signal());
    expect(result.status).toBe('failed');
    expect(result.message).toContain('time limit');
  });

  test('rejects a forged proof body in independent kernel replay', async () => {
    tamper.kernel = true;
    try {
      const result = await checker.check(PROOF_FIXTURE, signal());
      expect(result.status, JSON.stringify(result)).toBe('failed');
      expect(result.message).toBe(
        'The independent Lean check rejected this formalization.',
      );
    } finally {
      tamper.kernel = false;
    }
  });

  test('bounds untrusted output', async () => {
    const result = await checker.check(
      proof(
        'True',
        "run_tac do IO.print (String.ofList (List.replicate 2100000 'x'))\ntrivial",
      ),
      signal(),
    );
    expect(result.status).toBe('failed');
    expect(result.message).toContain('permitted size');
  });

  test('caps concurrency and releases cancelled slots', async () => {
    await checker.status();
    const first = new AbortController();
    const second = new AbortController();
    const running = [
      checker.check(PROOF_FIXTURE, first.signal),
      checker.check(PROOF_FIXTURE, second.signal),
    ];
    const overflow = await checker.check(PROOF_FIXTURE, signal());
    expect(overflow.status).toBe('unavailable');
    first.abort();
    second.abort();
    const cancelled = await Promise.all(running);
    expect(cancelled.map((result) => result.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
  });

  test('fails closed when the pinned runtime is absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'brain-vat-no-lean-'));
    try {
      const absent = createLeanChecker({ runtimeDirectory: directory });
      expect((await absent.status()).available).toBe(false);
      expect((await absent.check(PROOF_FIXTURE, signal())).status).toBe('unavailable');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('executable Lean input stays inside its sandbox', () => {
  let directory: string;
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test('denies private reads, writes, processes, credentials and network', async () => {
    directory = await mkdtemp(join(homedir(), '.brain-vat-sandbox-test-'));
    const sentinel = join(directory, 'sentinel');
    const marker = join(directory, 'written');
    const spawned = join(directory, 'spawned');
    await writeFile(sentinel, 'private sentinel');
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port.');
    const body = [
      'run_tac do',
      '  let readDenied ← try',
      `    let _ ← IO.FS.readFile ${JSON.stringify(sentinel)}`,
      '    pure false',
      '  catch _ => pure true',
      '  unless readDenied do throwError "private read escaped"',
      '  let aliasDenied ← try',
      `    let _ ← IO.FS.readFile ${JSON.stringify('/System/Volumes/Data' + sentinel)}`,
      '    pure false',
      '  catch _ => pure true',
      '  unless aliasDenied do throwError "data-volume alias escaped"',
      '  let writeDenied ← try',
      `    IO.FS.writeFile ${JSON.stringify(marker)} "escape"`,
      '    pure false',
      '  catch _ => pure true',
      '  unless writeDenied do throwError "outside write escaped"',
      '  let forkDenied ← try',
      '    let _ ← IO.Process.output {',
      '      cmd := "/usr/bin/touch"',
      `      args := #[${JSON.stringify(spawned)}]`,
      '      setsid := true }',
      '    pure false',
      '  catch _ => pure true',
      '  unless forkDenied do throwError "subprocess escaped"',
      '  if (← IO.getEnv "OPENAI_API_KEY").isSome then',
      '    throwError "credential environment escaped"',
      '  if (← IO.getEnv "BRAIN_VAT_TEST_SECRET").isSome then',
      '    throwError "test environment escaped"',
      '  let networkDenied ← try',
      '    let socket ← Std.Internal.UV.TCP.Socket.new',
      '    let connected ← socket.connect (.v4',
      `      ⟨Std.Net.IPv4Addr.ofParts 127 0 0 1, ${address.port}⟩)`,
      '    match connected.result!.get with',
      '    | .ok _ => pure false',
      '    | .error _ => pure true',
      '  catch _ => pure true',
      '  unless networkDenied do throwError "network escaped"',
      'trivial',
    ].join('\n');
    const previousSecret = process.env.BRAIN_VAT_TEST_SECRET;
    process.env.BRAIN_VAT_TEST_SECRET = 'synthetic-test-secret';
    tamper.network = true;
    try {
      const result = await checker.check(proof('True', body), signal());
      expect(result.status, JSON.stringify(result)).toBe('checked');
      expect(await readFile(sentinel, 'utf8')).toBe('private sentinel');
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(spawned)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(connections).toBe(0);
    } finally {
      tamper.network = false;
      if (previousSecret === undefined) delete process.env.BRAIN_VAT_TEST_SECRET;
      else process.env.BRAIN_VAT_TEST_SECRET = previousSecret;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
