import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const directory = fileURLToPath(new URL('../lean/', import.meta.url));
const version = '4.35.0';
const mathlibCommit = '56a005855ea17e0b0958f73ec801ae140b0a1679';
const toolchain = await realpath(
  join(homedir(), '.elan', 'toolchains', 'leanprover--lean4---v' + version),
).catch(() => {
  throw new Error(
    'Install elan and run: elan toolchain install leanprover/lean4:v' + version,
  );
});
const bin = join(toolchain, 'bin');
const env = {
  HOME: homedir(),
  PATH: bin + ':/usr/bin:/bin:/usr/sbin:/sbin',
  LEAN_SYSROOT: toolchain,
};

function run(command, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
      env,
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(command + ' failed with exit code ' + code));
      else resolve(output);
    });
  });
}

await mkdir(join(directory, '.lake'), { recursive: true });
await run('/usr/bin/clang', [
  '-O2',
  '-Wall',
  '-Wextra',
  '-Werror',
  'limit-process.c',
  '-o',
  '.lake/limit-process',
]);
await run(join(bin, 'lake'), ['update']);
const actual = (
  await run('/usr/bin/git', ['-C', '.lake/packages/mathlib', 'rev-parse', 'HEAD'], true)
).trim();
if (actual !== mathlibCommit) throw new Error('Mathlib revision does not match pin.');
await run(join(bin, 'lake'), ['exe', 'cache', 'get']);
const environment = await run(join(bin, 'lake'), ['env'], true);
await mkdir(join(directory, '.lake/build/lib/lean'), { recursive: true });
const searchPath = environment
  .split('\n')
  .find((line) => line.startsWith('LEAN_PATH='))
  ?.slice('LEAN_PATH='.length);
if (!searchPath) throw new Error('Lake did not provide a Lean search path.');
const paths = [];
for (const path of searchPath.split(delimiter)) {
  // Lake lists unused packages whose build directory need not exist.
  try {
    paths.push(await realpath(path.startsWith('/') ? path : join(directory, path)));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const mathlib = paths.find((path) => path.includes('/mathlib/.lake/build/lib/lean'));
if (!mathlib) throw new Error('Mathlib library directory is missing.');
await access(join(mathlib, 'Mathlib.olean'));
const manifest = await readFile(join(directory, 'lake-manifest.json'));
const metadata = {
  leanVersion: version,
  mathlibVersion: 'v' + version,
  mathlibCommit,
  lockHash: createHash('sha256').update(manifest).digest('hex'),
  toolchain,
  libraries: paths,
};
await writeFile(
  join(directory, '.lake', 'runtime.json'),
  JSON.stringify(metadata, null, 2) + '\n',
  { mode: 0o600 },
);
console.log(
  'Pinned Lean and Mathlib are ready. Checking never downloads dependencies.',
);
