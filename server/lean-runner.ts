import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  LEAN_VERSION,
  MATHLIB_VERSION,
  PROOF_THEOREM,
  proofBreakdownSchema,
  renderLeanProof,
} from '../src/proof.ts';
import type {
  LeanChecker,
  LeanSource,
  LeanStatus,
  ProofCheckResult,
  ProofDiagnostic,
  ProofStepGoals,
} from '../src/proof.ts';

const ROOT = fileURLToPath(new URL('../lean/', import.meta.url));
const REVISION = '56a005855ea17e0b0958f73ec801ae140b0a1679';
const AXIOMS = ['propext', 'Classical.choice', 'Quot.sound'];
// The primitive comparison targets are pinned to Lean 4.35's Lake.Check module.
const PRIMITIVES = [
  'Nat.add',
  'Nat.sub',
  'Nat.mul',
  'Nat.pow',
  'Nat.gcd',
  'Nat.div',
  'Nat.mod',
  'Nat.beq',
  'Nat.ble',
  'Nat.land',
  'Nat.lor',
  'Nat.xor',
  'Nat.shiftLeft',
  'Nat.shiftRight',
  'String.ofList',
  'Char.ofNat',
  'List',
  'eagerReduce',
  'Nat',
  'String',
  'String.mk',
  'Char',
  'optParam',
  'autoParam',
  'semiOutParam',
  'outParam',
  'Quot',
  'Quot.mk',
  'Quot.lift',
  'Quot.ind',
];
const runtimeSchema = z.strictObject({
  leanVersion: z.literal(LEAN_VERSION),
  mathlibVersion: z.literal(MATHLIB_VERSION),
  mathlibCommit: z.literal(REVISION),
  lockHash: z.string().regex(/^[0-9a-f]{64}$/),
  toolchain: z.string().min(1),
  libraries: z.array(z.string().min(1)).min(1).max(30),
});
type Runtime = z.infer<typeof runtimeSchema> & { root: string; launcher: string };
interface Stage {
  runtime: Runtime;
  directory: string;
  readable: string[];
  writable?: string[];
  command: string;
  args: string[];
  signal: AbortSignal;
  outputLimit?: number;
  onOutput?: (chunk: Buffer) => void;
}
interface StageResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
class LeanFailure extends Error {}

function profile(stage: Stage): string {
  const quoted = (value: string): string => JSON.stringify(value);
  const reads = [
    stage.runtime.toolchain,
    stage.runtime.launcher,
    ...stage.runtime.libraries,
    ...stage.readable,
    '/System/Library',
    '/System/Cryptexes/OS/System/Library',
    '/System/Cryptexes/OS/usr/lib',
    '/usr/lib',
    '/usr/share/locale',
    '/private/var/db/dyld',
  ];
  const executables = [stage.runtime.launcher, stage.command];
  return [
    '(version 1)',
    '(deny default)',
    '(allow sysctl-read)',
    '(allow file-read-metadata)',
    '(allow file-read* ' +
      reads.map((path) => '(subpath ' + quoted(path) + ')').join(' ') +
      ')',
    '(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/urandom") ' +
      '(literal "/dev/random"))',
    '(allow file-write* (literal "/dev/null") ' +
      (stage.writable ?? []).map((path) => '(subpath ' + quoted(path) + ')').join(' ') +
      ')',
    '(allow process-exec ' +
      executables.map((path) => '(literal ' + quoted(path) + ')').join(' ') +
      ')',
  ].join('\n');
}

/** Every invocation has an explicit filesystem policy and a clean environment. */
function launch(stage: Stage): {
  child: ChildProcessWithoutNullStreams;
  done: Promise<StageResult>;
} {
  if (stage.signal.aborted) throw new LeanFailure('Lean checking was cancelled.');
  const bin = join(stage.runtime.toolchain, 'bin');
  const child = spawn(
    '/usr/bin/sandbox-exec',
    ['-p', profile(stage), stage.runtime.launcher, stage.command, ...stage.args],
    {
      cwd: stage.directory,
      env: {
        PATH: bin + ':/usr/bin:/bin',
        LEAN_SYSROOT: stage.runtime.toolchain,
        LEAN_PATH: stage.readable.concat(stage.runtime.libraries).join(delimiter),
        LEAN_ABORT_ON_PANIC: '1',
        TMPDIR: stage.directory,
        // Workers must use only the prebuilt search path, never spawn Lake setup.
        LAKE: '/brain-vat-no-lake',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    },
  );
  let size = 0;
  let stdout = '';
  let stderr = '';
  let failure: Error | null = null;
  const kill = (): void => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  };
  const abort = (): void => {
    failure = new LeanFailure('Lean checking was cancelled or exceeded its deadline.');
    kill();
  };
  stage.signal.addEventListener('abort', abort, { once: true });
  const done = new Promise<StageResult>((resolve, reject) => {
    child.on('error', (error) => {
      failure = error;
    });
    child.stdin.on('error', () => undefined);
    const consume = (chunk: Buffer, error: boolean): void => {
      size += chunk.length;
      if (size > (stage.outputLimit ?? 2_000_000)) {
        failure = new LeanFailure('Lean output exceeded the permitted size.');
        kill();
        return;
      }
      if (error) stderr += chunk.toString('utf8');
      else if (stage.onOutput) {
        try {
          stage.onOutput(chunk);
        } catch (reason) {
          failure =
            reason instanceof Error ? reason : new LeanFailure('Invalid output.');
          kill();
        }
      } else stdout += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => consume(chunk, false));
    child.stderr.on('data', (chunk: Buffer) => consume(chunk, true));
    child.on('close', (code, signal) => {
      stage.signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, done };
}

async function execute(stage: Stage): Promise<StageResult> {
  const process = launch(stage);
  process.child.stdin.end();
  return process.done;
}

const positionSchema = z.object({
  line: z.number().int().min(0),
  character: z.number().int().min(0),
});
const diagnosticSchema = z.object({
  message: z.string(),
  severity: z.number().optional(),
  isSilent: z.boolean().optional(),
  range: z.object({ start: positionSchema }).optional(),
});
const goalSchema = z.object({ goals: z.array(z.string()) }).nullish();

async function goals(
  stage: Stage,
  source: LeanSource,
): Promise<{
  diagnostics: ProofDiagnostic[];
  steps: ProofStepGoals[];
}> {
  const uri = pathToFileURL(join(stage.directory, 'Proof.lean')).href;
  let buffer = Buffer.alloc(0);
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let diagnostics: ProofDiagnostic[] = [];
  const fail = (error: Error): void => {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  const process = launch({
    ...stage,
    args: ['--worker', '-M4096', '-j2', uri],
    onOutput: (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) break;
        const size = Number(
          buffer
            .subarray(0, end)
            .toString()
            .match(/^Content-Length: (\d+)/im)?.[1],
        );
        if (!Number.isSafeInteger(size) || size < 0)
          throw new LeanFailure('Invalid Lean protocol response.');
        if (size > 1_000_000)
          throw new LeanFailure('Lean output exceeded the permitted size.');
        if (buffer.length < end + 4 + size) break;
        const message = z
          .object({
            id: z.number().optional(),
            method: z.string().optional(),
            result: z.unknown().optional(),
            error: z.unknown().optional(),
            params: z.unknown().optional(),
          })
          .parse(JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString()));
        buffer = buffer.subarray(end + 4 + size);
        // Server-initiated requests have their own ID sequence; they are not replies.
        if (message.method && message.id !== undefined) {
          send({ id: message.id, result: null });
          continue;
        }
        const waiter = message.id !== undefined ? pending.get(message.id) : undefined;
        if (waiter && message.id !== undefined) {
          pending.delete(message.id);
          if (message.error)
            waiter.reject(new LeanFailure('Lean could not inspect this step.'));
          else waiter.resolve(message.result);
        } else if (message.method === 'textDocument/publishDiagnostics') {
          const params = z
            .object({
              uri: z.string(),
              diagnostics: z.array(diagnosticSchema).max(500),
            })
            .parse(message.params);
          if (params.uri === uri)
            diagnostics = params.diagnostics
              .filter((item) => !item.isSilent)
              .slice(0, 20)
              .map((item) => ({
                message: item.message.slice(0, 2000),
                severity:
                  item.severity === 1
                    ? 'error'
                    : item.severity === 2
                      ? 'warning'
                      : 'information',
                line: item.range?.start.line ?? null,
                column: item.range?.start.character ?? null,
              }));
        }
      }
    },
  });
  void process.done.then(
    (closed) =>
      fail(
        new LeanFailure(
          'Lean worker closed (' +
            (closed.signal ?? closed.code) +
            '): ' +
            closed.stderr.slice(0, 2000),
        ),
      ),
    fail,
  );
  const send = (message: object): void => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    process.child.stdin.write('Content-Length: ' + body.length + '\r\n\r\n');
    process.child.stdin.write(body);
  };
  const request = (method: string, params: object): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  try {
    send({
      id: 0,
      method: 'initialize',
      params: {
        processId: null,
        rootUri: pathToFileURL(stage.directory + '/').href,
        capabilities: { lean: { silentDiagnosticSupport: true } },
        initializationOptions: { hasWidgets: false },
      },
    });
    send({
      method: 'textDocument/didOpen',
      params: {
        textDocument: { uri, languageId: 'lean', version: 1, text: source.code },
        dependencyBuildMode: 'never',
      },
    });
    await request('textDocument/waitForDiagnostics', { uri, version: 1 });
    const lines = source.code.split('\n');
    let remaining = 90_000;
    const at = async (line: number, character: number): Promise<string[] | null> => {
      const result = goalSchema.parse(
        await request('$/lean/plainGoal', {
          textDocument: { uri },
          position: { line, character },
        }),
      );
      if (
        !result ||
        result.goals.length > 8 ||
        result.goals.some((goal) => goal.length > 3000) ||
        result.goals.reduce((size, goal) => size + goal.length, 0) > remaining
      )
        return null;
      remaining -= result.goals.reduce((size, goal) => size + goal.length, 0);
      return result.goals;
    };
    const steps: ProofStepGoals[] = [];
    for (const step of source.steps) {
      const before = await at(step.startLine, lines[step.startLine]?.search(/\S/) ?? 2);
      const after = await at(step.endLine, lines[step.endLine]?.length ?? 2);
      if (before === null || after === null) continue;
      steps.push({
        stepId: step.stepId,
        before,
        after,
      });
    }
    return { diagnostics, steps };
  } finally {
    process.child.kill('SIGKILL');
    await process.done.catch(() => undefined);
  }
}

function result(status: ProofCheckResult['status'], message: string): ProofCheckResult {
  return { status, message, diagnostics: [], steps: [], axioms: [] };
}

async function loadRuntime(root: string): Promise<Runtime> {
  if (process.platform !== 'darwin')
    throw new LeanFailure('This checker currently requires macOS sandbox-exec.');
  const parsed = runtimeSchema.parse(
    JSON.parse(await readFile(join(root, '.lake/runtime.json'), 'utf8')),
  );
  const manifest = await readFile(join(root, 'lake-manifest.json'));
  if (createHash('sha256').update(manifest).digest('hex') !== parsed.lockHash)
    throw new LeanFailure('The Lean dependency lock changed. Run pnpm setup:lean.');
  const revision = await readFile(
    join(root, '.lake/packages/mathlib/.git/HEAD'),
    'utf8',
  );
  if (revision.trim() !== REVISION)
    throw new LeanFailure('Mathlib no longer matches the pinned revision.');
  const toolchain = await realpath(parsed.toolchain);
  const libraries = await Promise.all(parsed.libraries.map((path) => realpath(path)));
  const launcher = await realpath(join(root, '.lake/limit-process'));
  await access('/usr/bin/sandbox-exec');
  await access(join(toolchain, 'bin/lean'));
  await access(join(toolchain, 'bin/leanexport'));
  await access(join(toolchain, 'bin/leanchecker'));
  const mathlib = libraries.find((path) =>
    path.includes('/mathlib/.lake/build/lib/lean'),
  );
  if (!mathlib) throw new LeanFailure('Pinned Mathlib library is missing.');
  await access(join(mathlib, 'Mathlib.olean'));
  return { ...parsed, root, toolchain, libraries, launcher };
}

export interface LeanCheckerOptions {
  runtimeDirectory?: string;
  timeoutMs?: number;
}

/** Offline runner; untrusted compilation cannot write into trusted comparison. */
export function createLeanChecker(options: LeanCheckerOptions = {}): LeanChecker {
  const root = options.runtimeDirectory ?? ROOT;
  let active = 0;
  let cached: { time: number; value: LeanStatus } | null = null;
  const status = async (): Promise<LeanStatus> => {
    if (cached && Date.now() - cached.time < 30_000) return cached.value;
    let available = false;
    let message = 'Run pnpm setup:lean to install the pinned local proof runtime.';
    let directory: string | null = null;
    try {
      const runtime = await loadRuntime(root);
      directory = await realpath(
        await mkdtemp(join(tmpdir(), 'brain-vat-lean-status-')),
      );
      const checked = await execute({
        runtime,
        directory,
        readable: [directory],
        command: join(runtime.toolchain, 'bin/lean'),
        args: ['--version'],
        signal: AbortSignal.timeout(5000),
      });
      available =
        checked.code === 0 && checked.stdout.includes('version ' + LEAN_VERSION);
      message = available
        ? 'Pinned Lean and Mathlib are ready for isolated checking.'
        : 'The local Lean sandbox could not start. Checking is unavailable.';
    } catch {
      /* Missing runtime or unavailable sandbox fails closed. */
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
    const value = {
      available,
      leanVersion: LEAN_VERSION,
      mathlibVersion: MATHLIB_VERSION,
      message,
    };
    cached = { time: Date.now(), value };
    return value;
  };
  return {
    status,
    check: async (input, signal) => {
      if (signal.aborted) return result('cancelled', 'Lean checking was cancelled.');
      const health = await status();
      if (!health.available) return result('unavailable', health.message);
      const parsed = proofBreakdownSchema.safeParse(input);
      if (!parsed.success) return result('failed', 'Invalid proof structure.');
      const source = renderLeanProof(parsed.data);
      if (!source)
        return result('incomplete', 'This explanation has no Lean statement yet.');
      if (source.code.length > 50_000)
        return result('failed', 'Lean source is too large.');
      if (active >= 2)
        return result('unavailable', 'Lean is busy checking other proofs. Try again.');
      active += 1;
      let directory: string | null = null;
      let observed: Pick<ProofCheckResult, 'steps' | 'diagnostics'> = {
        steps: [],
        diagnostics: [],
      };
      const bounded = AbortSignal.any([
        signal,
        AbortSignal.timeout(options.timeoutMs ?? 90_000),
      ]);
      try {
        const runtime = await loadRuntime(root);
        directory = await realpath(await mkdtemp(join(tmpdir(), 'brain-vat-lean-')));
        const proof = join(directory, 'proof');
        const challenge = join(directory, 'challenge');
        const checker = join(directory, 'checker');
        await Promise.all([proof, challenge, checker].map((path) => mkdir(path)));
        await writeFile(join(proof, 'Proof.lean'), source.code, { mode: 0o400 });
        await writeFile(join(challenge, 'Challenge.lean'), source.challenge, {
          mode: 0o400,
        });
        const stage = (path: string): Stage => ({
          runtime,
          directory: path,
          readable: [path],
          command: join(runtime.toolchain, 'bin/lean'),
          args: [],
          signal: bounded,
        });
        observed = await goals(stage(proof), source);
        if (observed.diagnostics.some((item) => item.severity === 'error')) {
          const incomplete = observed.diagnostics.some((item) =>
            /unsolved goals/i.test(item.message),
          );
          return {
            ...result(
              incomplete ? 'incomplete' : 'failed',
              incomplete
                ? 'Lean reports remaining goals.'
                : 'Lean could not elaborate this proof.',
            ),
            ...observed,
          };
        }
        const exportFile = async (path: string, name: string): Promise<string> => {
          const output = join(path, 'build');
          await mkdir(output);
          const compiled = await execute({
            ...stage(path),
            writable: [output],
            args: [
              '-M4096',
              '-j2',
              '-o',
              join(output, name + '.olean'),
              join(path, name + '.lean'),
            ],
          });
          if (compiled.code !== 0)
            throw new LeanFailure(
              'Lean compilation failed (' +
                (compiled.signal ?? compiled.code) +
                '): ' +
                (compiled.stdout + compiled.stderr).slice(0, 3000),
            );
          const exported = await execute({
            ...stage(path),
            readable: [output],
            command: join(runtime.toolchain, 'bin/leanexport'),
            args: [name, '--', PROOF_THEOREM, ...AXIOMS, ...PRIMITIVES],
            outputLimit: 20_000_000,
          });
          if (exported.code !== 0 || !exported.stdout.startsWith('{"meta"'))
            throw new LeanFailure('Lean could not safely export the formalization.');
          const destination = join(checker, name + '.ndjson');
          await writeFile(destination, exported.stdout, { mode: 0o400 });
          return destination;
        };
        const expected = await exportFile(challenge, 'Challenge');
        const actual = await exportFile(proof, 'Proof');
        const baseline = await execute({
          ...stage(checker),
          readable: [],
          command: join(runtime.toolchain, 'bin/leanexport'),
          args: ['Init', '--', ...AXIOMS, ...PRIMITIVES],
          outputLimit: 20_000_000,
        });
        if (baseline.code !== 0)
          throw new LeanFailure('The trusted Lean baseline could not be exported.');
        const baselinePath = join(checker, 'Baseline.ndjson');
        await writeFile(baselinePath, baseline.stdout, { mode: 0o400 });
        const inspected = await execute({
          ...stage(checker),
          readable: [checker, join(runtime.root, 'InspectExport.lean')],
          args: [
            '-M1024',
            '-j2',
            '--run',
            join(runtime.root, 'InspectExport.lean'),
            baselinePath,
            expected,
            actual,
          ],
        });
        if (inspected.code !== 0)
          throw new LeanFailure(
            'Lean axiom inspection failed: ' +
              (inspected.stdout + inspected.stderr).slice(0, 3000),
          );
        const axioms = z
          .array(z.string().max(200))
          .max(100)
          .parse(JSON.parse(inspected.stdout));
        if (axioms.some((axiom) => !AXIOMS.includes(axiom)))
          return {
            ...result(
              axioms.includes('sorryAx') ? 'incomplete' : 'failed',
              axioms.includes('sorryAx')
                ? 'The formalization contains admitted steps.'
                : 'The proof uses unapproved axioms.',
            ),
            ...observed,
            axioms,
          };
        const compared = await execute({
          ...stage(checker),
          readable: [checker],
          command: join(runtime.toolchain, 'bin/leanchecker'),
          args: ['--silent', '--from-export', actual],
        });
        if (compared.code !== 0)
          return {
            ...result(
              'failed',
              'The independent Lean check rejected this formalization.',
            ),
            ...observed,
            axioms,
            diagnostics: [
              ...observed.diagnostics,
              {
                severity: 'error',
                line: null,
                column: null,
                message: compared.stderr.slice(-3000),
              },
            ],
          };
        return {
          ...result(
            'checked',
            'Lean checked this formal statement and proof against the standard axioms. ' +
              'Its interpretation of the paper still needs review.',
          ),
          ...observed,
          axioms,
        };
      } catch (reason) {
        return {
          ...result(
            signal.aborted ? 'cancelled' : 'failed',
            signal.aborted
              ? 'Lean checking was cancelled.'
              : bounded.aborted
                ? 'Lean checking exceeded its time limit.'
                : reason instanceof LeanFailure
                  ? reason.message
                  : 'The isolated Lean check could not finish: ' +
                    (reason instanceof Error
                      ? reason.message.slice(0, 600)
                      : 'unknown error'),
          ),
          ...observed,
        };
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
        active -= 1;
      }
    },
  };
}
