// Run action.yml's step locally the way a runner would: inputs (with action.yml defaults) mapped through the step's
// env block, GITHUB_* files in a temp dir, `bash --noprofile --norc -eo pipefail` on the step's script.
//
//   node test/harness.mjs url=https://llmstxt.org mode=check
//   node test/harness.mjs url=https://llmstxt.org path=out/llms.txt            # live llms.ink
//   node test/harness.mjs --mock mode=pr url=https://acme.test                 # mocked llms.ink + GitHub
//   node test/harness.mjs --mock --pr 7 mode=comment url=https://acme.test     # as a pull_request event
//   --workspace <dir> keeps the files somewhere you choose.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockApi, REPO, serve } from './mock.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const yml = readFileSync(join(root, 'action.yml'), 'utf8');

const args = process.argv.slice(2);
/** Remove `--name` (and its value, unless `bare`) from args. */
const flag = (name, bare = false) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return bare ? !!args.splice(i, 1) : args.splice(i, 2)[1];
};
const mocked = flag('--mock', true) === true;
const pr = flag('--pr');
const dir = mkdtempSync(join(tmpdir(), 'llms-harness-'));
const ws = flag('--workspace') ?? join(dir, 'ws');
mkdirSync(ws, { recursive: true });

// Inputs: action.yml defaults, then name=value arguments.
const block = yml.slice(yml.indexOf('\ninputs:'), yml.indexOf('\noutputs:'));
const inputs = {};
for (const m of block.matchAll(/^ {2}([\w-]+):\n((?: {4}.*\n)*)/gm)) {
  const d = m[2].match(/^ {4}default: (.*)$/m)?.[1] ?? '';
  inputs[m[1]] = d.includes('${{') ? '' : d.replace(/^'(.*)'$/, '$1');
}
for (const a of args) {
  const [k, ...v] = a.split('=');
  if (!(k in inputs)) throw new Error(`Unknown input ${k}; action.yml has ${Object.keys(inputs).join(', ')}`);
  inputs[k] = v.join('=');
}

const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GITHUB_ACTIONS: 'true',
  GITHUB_ACTION_PATH: root,
  GITHUB_WORKSPACE: ws,
  GITHUB_OUTPUT: join(dir, 'output'),
  GITHUB_STEP_SUMMARY: join(dir, 'summary'),
  GITHUB_REPOSITORY: REPO,
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: pr ? 'pull_request' : 'workflow_dispatch',
  GITHUB_EVENT_PATH: join(dir, 'event.json'),
};
writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(pr ? { pull_request: { number: Number(pr) } } : {}));

let server;
let mock;
if (mocked) {
  mock = mockApi({ files: { 'README.md': '# Acme\n' } });
  server = await serve(mock);
  env.LLMS_INK_API = `${server.origin}/api/v0`;
  env.GITHUB_API_URL = server.origin;
  inputs.token ||= 'ghs_mock';
}

// The step's env block: INPUT_X: ${{ inputs.x }}.
for (const m of yml.matchAll(/^ {8}(\w+): \$\{\{ inputs\.([\w-]+) \}\}$/gm)) env[m[1]] = inputs[m[2]];
const script = yml.match(/^ {6}run: \|\n((?: {8}.*\n)+)/m)[1].replace(/^ {8}/gm, '');

// The child calls the local mock server in this process, so wait for it asynchronously.
const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { cwd: ws, env, stdio: 'inherit' });
const code = await new Promise((ok) => child.on('close', ok));
server?.close();

const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
console.log(`\n── exit code: ${code}`);
console.log('── outputs ($GITHUB_OUTPUT)');
console.log(read(env.GITHUB_OUTPUT).trimEnd());
console.log('── job summary ($GITHUB_STEP_SUMMARY)');
console.log(read(env.GITHUB_STEP_SUMMARY).trimEnd());
console.log(`── workspace ${ws}`);
for (const f of walk(ws)) console.log(`${relative(ws, f)} (${statSync(f).size} bytes)`);
if (mock) {
  console.log('── mocked GitHub writes');
  for (const c of mock.writes()) if (!c.path.startsWith('/api/')) console.log(`${c.method} ${c.path}`);
}
process.exitCode = code;
