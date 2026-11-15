import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from '../src/action.mjs';

const key = 'lk_' + 'a'.repeat(32);
const sha = text => createHash('sha256').update(text).digest('hex');
const receipt = text => ({ detection: 'no_finding', coverage: 'complete', recommendation: 'continue', reason: 'no_finding',
  modelRevision: '4a43fec65a670e48835d8e8c85c705b4b0d1c907', policyRevision: 'llms-ink-inspect-1', preprocessingRevision: 'utf8-json-stringify-1',
  contentDigest: sha(text), inputTokens: 5, inspectedTokens: 5, windows: 1, enforced: false });

async function fixture(t, files = { 'a.md': '# Read this documentation.\n', 'nested/b.json': '\uFEFF{ "note": "PRIVATE_SOURCE café" }\r\n' }) {
  const parent = await mkdtemp(join(tmpdir(), 'ink-action-pack-')), cwd = join(parent, 'repo'), temp = join(parent, 'temp');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(join(cwd, '.context'), { recursive: true }); await mkdir(temp);
  for (const [path, text] of Object.entries(files)) { await mkdir(join(cwd, '.context', path, '..'), { recursive: true }); await writeFile(join(cwd, '.context', path), text); }
  const env = { GITHUB_WORKSPACE: cwd, RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: join(parent, 'summary'), GITHUB_OUTPUT: join(parent, 'output'),
    INPUT_MODE: 'inspect-context', INPUT_INSPECT_DIR: '.context', INPUT_API_KEY: key, INPUT_TOKEN: 'GITHUB_TOKEN_MUST_NOT_BE_SENT',
    INPUT_INDEXNOW_KEY: 'must-not-submit', LLMS_INK_API: 'https://attacker.invalid' };
  const calls = [], sleeps = []; let log = '';
  const go = (extra = {}) => run({ env, stdout: s => log += s, sleep: async ms => sleeps.push(ms),
    exec: () => assert.fail('Pack inspection must not run an external command'),
    fetch: async (url, init) => { calls.push({ url, ...init }); assert.equal(url, 'https://llms.ink/api/v0/inspect'); return Response.json(receipt(JSON.parse(init.body).content)); }, ...extra });
  return { cwd, parent, temp, env, calls, sleeps, go, log: () => log, summary: () => readFile(env.GITHUB_STEP_SUMMARY, 'utf8'),
    report: result => readFile(result.outputs['inspection-report'], 'utf8').then(JSON.parse) };
}

test('explicit pack mode produces a CLI manifest, exact JSON/BOM digests, private outputs and no GitHub/IndexNow work', async t => {
  const f = await fixture(t), result = await f.go(); assert.equal(result.ok, true);
  assert.equal(result.outputs.changed, 'false'); assert.equal(result.outputs['pr-url'], '');
  assert.equal(result.outputs['inspection-status'], 'current'); assert.equal(result.outputs['inspection-recommendation'], 'continue');
  assert.equal(result.outputs['inspection-clean'], '2'); assert.equal(result.outputs['inspection-not-attempted'], '0');
  const manifest = await f.report(result); assert.equal(manifest.schema, 'llms-ink-context-inspection-1');
  assert.deepEqual(manifest.files.map(x => x.path), ['a.md', 'nested/b.json']);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.sleeps, [7000]);
  for (const [i, call] of f.calls.entries()) {
    const body = JSON.parse(call.body); assert.equal(body.format, 'text');
    assert.equal(manifest.files[i].sha256, sha(body.content)); assert.equal(call.headers.authorization, 'Bearer ' + key); assert.equal(call.redirect, 'error');
  }
  assert.ok(JSON.parse(f.calls[1].body).content.startsWith('\uFEFF'));
  for (const value of [JSON.stringify(manifest), await f.summary(), f.log()]) { assert.ok(!value.includes('PRIVATE_SOURCE')); assert.ok(!value.includes('GITHUB_TOKEN_MUST_NOT_BE_SENT')); }
  assert.ok(!JSON.stringify(manifest).includes(key)); assert.ok(!await f.summary().then(x => x.includes(key)));
  if (process.platform !== 'win32') {
    assert.equal((await stat(result.outputs['inspection-report'])).mode & 0o777, 0o600);
    assert.equal((await stat(join(result.outputs['inspection-report'], '..'))).mode & 0o777, 0o700);
  }
  assert.deepEqual(await readdir(f.cwd), ['.context']);
  assert.match(await readFile(f.env.GITHUB_OUTPUT, 'utf8'), /^inspection-recommendation=continue$/m);
});

test('pack uploads require explicit mode, directory, valid key and nonprivileged events', async t => {
  for (const overrides of [{ INPUT_INSPECT_DIR: '' }, { INPUT_API_KEY: '' }, { INPUT_API_KEY: 'wrong' },
    { INPUT_INSPECT_PATHS: '.context/a.md' }, { GITHUB_EVENT_NAME: 'pull_request_target' },
    { INPUT_MODE: 'inspect', INPUT_INSPECT_PATHS: '.context/a.md' }, { INPUT_MODE: 'write', INPUT_URL: 'https://example.com' }]) {
    const f = await fixture(t); Object.assign(f.env, overrides); const result = await f.go();
    assert.equal(result.ok, false); assert.equal(f.calls.length, 0); assert.deepEqual(await readdir(f.temp), []);
    assert.deepEqual(await readdir(f.cwd), ['.context']);
  }
});

test('preflight refuses linked, unsupported, oversized and missing pack inputs before uploads and cleans temporary files', async t => {
  for (const kind of ['link', 'unsupported', 'oversized', 'missing', 'outside', 'empty']) {
    const f = await fixture(t);
    if (kind === 'link') { await writeFile(join(f.parent, 'private.md'), 'PRIVATE_SOURCE'); await symlink(join(f.parent, 'private.md'), join(f.cwd, '.context/z.md')); }
    if (kind === 'unsupported') await writeFile(join(f.cwd, '.context/z.env'), 'PRIVATE_SOURCE');
    if (kind === 'oversized') await writeFile(join(f.cwd, '.context/z.md'), 'x'.repeat(131073));
    if (kind === 'missing') f.env.INPUT_INSPECT_DIR = 'missing';
    if (kind === 'outside') f.env.INPUT_INSPECT_DIR = '../outside';
    if (kind === 'empty') { await rm(join(f.cwd, '.context'), { recursive: true }); await mkdir(join(f.cwd, '.context')); }
    const result = await f.go(); assert.equal(result.ok, false, kind); assert.equal(f.calls.length, 0);
    assert.equal(result.outputs['inspection-report'], ''); assert.equal(result.outputs['inspection-recommendation'], 'withhold');
    assert.deepEqual(await readdir(f.temp), []); assert.deepEqual(await readdir(f.cwd), ['.context']);
  }
});

test('invalid or in-pack report storage fails before uploads', async t => {
  for (const kind of ['missing', 'file', 'in-pack']) {
    const f = await fixture(t);
    if (kind === 'missing') f.env.RUNNER_TEMP = join(f.parent, 'missing');
    if (kind === 'file') { await writeFile(join(f.parent, 'file'), 'data'); f.env.RUNNER_TEMP = join(f.parent, 'file'); }
    if (kind === 'in-pack') f.env.RUNNER_TEMP = join(f.cwd, '.context');
    const result = await f.go(); assert.equal(result.ok, false, kind); assert.equal(f.calls.length, 0); assert.deepEqual(await readdir(f.cwd), ['.context']);
  }
});

test('rate limits, unavailable service and invalid receipts preserve failures and unattempted files without retries', async t => {
  for (const reply of [() => Response.json({ detail: 'PRIVATE_REMOTE' }, { status: 429, headers: { 'retry-after': '1' } }),
    () => new Response('PRIVATE_REMOTE', { status: 503 }), () => { throw Error('PRIVATE_REMOTE'); },
    r => Response.json({ ...r, contentDigest: '0'.repeat(64) }),
    r => Response.json({ ...r, detection: 'unknown', recommendation: 'withhold', reason: 'model_unavailable', coverage: 'none', inspectedTokens: 0, windows: 0 }, { status: 503 })]) {
    const f = await fixture(t); let calls = 0;
    const result = await f.go({ fetch: async (_, init) => { calls++; return reply(receipt(JSON.parse(init.body).content)); } });
    assert.equal(result.ok, false); assert.equal(calls, 1); assert.equal(f.sleeps.length, 0);
    assert.equal(result.outputs['inspection-unknown'], '1'); assert.equal(result.outputs['inspection-not-attempted'], '1');
    assert.equal(result.outputs['inspection-recommendation'], 'withhold');
    assert.equal((await f.report(result)).files[1].inspection.state, 'not_attempted');
    assert.ok(!f.log().includes('PRIVATE_REMOTE')); assert.ok(!(await f.summary()).includes('PRIVATE_REMOTE'));
    assert.deepEqual(await readdir(f.cwd), ['.context']);
  }
});

test('flagged content and token-limit results fail the job while retaining later scan results', async t => {
  for (const detection of ['flagged', 'unknown']) {
    const f = await fixture(t); let calls = 0;
    const result = await f.go({ fetch: async (_, init) => {
      const r = receipt(JSON.parse(init.body).content); calls++;
      return Response.json(calls > 1 ? r : { ...r, detection, recommendation: 'withhold', ...(detection === 'flagged'
        ? { reason: 'instruction_pattern' } : { reason: 'token_limit', coverage: 'none', inputTokens: 9000, inspectedTokens: 0, windows: 0 }) }, { status: calls === 1 && detection === 'unknown' ? 422 : 200 });
    } });
    assert.equal(result.ok, false); assert.equal(calls, 2); assert.equal(result.outputs['inspection-clean'], '1');
    assert.equal(result.outputs['inspection-not-attempted'], '0');
    assert.match(f.log(), /::error file=\.context\/a.md,/); assert.equal((await f.report(result)).files.length, 2);
  }
});

test('pack changes fail freshness; newly invalid files still preserve the original scan report', async t => {
  for (const kind of ['changed', 'added', 'unsupported']) {
    const f = await fixture(t); let calls = 0;
    const result = await f.go({ fetch: async (_, init) => {
      calls++;
      if (calls === 1) await writeFile(join(f.cwd, '.context', kind === 'changed' ? 'a.md' : kind === 'added' ? 'new.md' : 'new.env'), 'New file content');
      return Response.json(receipt(JSON.parse(init.body).content));
    } });
    assert.equal(result.ok, false, kind); assert.equal(result.outputs['inspection-recommendation'], 'withhold');
    assert.equal(result.outputs['inspection-status'], kind === 'unsupported' ? 'invalid' : 'stale');
    assert.equal(result.outputs['inspection-clean'], '2'); assert.equal((await f.report(result)).files.length, 2);
    assert.match(f.log(), /::error title=Context inspection/);
  }
});

test('cancellation preserves partial manifests and never starts another request', async t => {
  for (const when of ['before', 'request', 'pacing', 'last']) {
    const f = await fixture(t), controller = new AbortController(); let calls = 0;
    if (when === 'before') controller.abort();
    const result = await f.go({ signal: controller.signal,
      sleep: async () => { if (when === 'pacing') { controller.abort(); throw Error('cancel'); } },
      fetch: async (_, init) => {
        calls++;
        if (when === 'request') return new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(Error('cancel'))); controller.abort(); });
        if (when === 'last' && calls === 2) controller.abort();
        return Response.json(receipt(JSON.parse(init.body).content));
      } });
    assert.equal(result.ok, false, when); assert.equal(calls, when === 'before' ? 0 : when === 'last' ? 2 : 1);
    assert.equal(result.outputs['inspection-recommendation'], 'withhold'); assert.equal((await f.report(result)).runState, 'interrupted');
    assert.deepEqual(await readdir(f.cwd), ['.context']);
  }
});

test('a checkout-supplied manifest is ignored; only fresh results can pass', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'context-inspection.json'), JSON.stringify({ schema: 'llms-ink-context-inspection-1', recommendation: 'continue' }));
  const result = await f.go({ fetch: async (_, init) => Response.json({ ...receipt(JSON.parse(init.body).content), detection: 'flagged', recommendation: 'withhold', reason: 'model_detection' }) });
  assert.equal(result.ok, false); assert.equal(result.outputs['inspection-flagged'], '2');
  assert.equal(JSON.parse(await readFile(join(f.cwd, 'context-inspection.json'), 'utf8')).recommendation, 'continue');
  assert.equal((await f.report(result)).files.length, 2);
});

test('summary and annotation escaping does not interpret repository-controlled filenames', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { 'note|<tag>`&.md': 'ordinary docs' });
  const result = await f.go(); assert.equal(result.ok, true);
  const summary = await f.summary(); assert.ok(summary.includes('note&#124;&lt;tag&gt;&#96;&amp;.md')); assert.ok(!summary.includes('<tag>'));
});

test('bundled code has only Node builtin imports and a checked bundle digest', async () => {
  const path = new URL('../src/generated/context-inspection.mjs', import.meta.url), source = await readFile(path, 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../src/generated/context-inspection.json', import.meta.url), 'utf8'));
  assert.equal(sha(source), manifest.bundleSha256); assert.equal(manifest.version, '0.8.0');
  for (const [, imported] of source.matchAll(/from "([^"]+)"/g)) assert.ok(imported.startsWith('node:'), imported);
});

test('bundled source hashes and Action manifests match the published CLI contract', { skip: !process.env.LLMS_INK_INSPECTION_CLI }, async t => {
  const root = process.env.LLMS_INK_INSPECTION_CLI, manifest = JSON.parse(await readFile(new URL('../src/generated/context-inspection.json', import.meta.url), 'utf8'));
  const { main, VERSION } = await import(pathToFileURL(join(root, 'src/cli.js'))); assert.equal(VERSION, manifest.version);
  for (const [path, digest] of Object.entries(manifest.sources)) assert.equal(sha(await readFile(join(root, path))), digest, path);
  const f = await fixture(t), result = await f.go(), actual = await f.report(result);
  let output = '';
  const code = await main({ argv: ['context', 'inspect', '--dir', '.context', '--output', 'reference.json'], cwd: f.cwd,
    env: { LLMS_INK_INSPECT_KEY: key }, stdout: { write: s => output += s }, stderr: { write() {} }, sleep: async () => {},
    fetch: async (_, init) => Response.json(receipt(JSON.parse(init.body).content)) });
  assert.equal(code, 0, output); const expected = JSON.parse(await readFile(join(f.cwd, 'reference.json'), 'utf8'));
  const createdAt = actual.createdAt;
  delete actual.createdAt; delete expected.createdAt; assert.deepEqual(actual, expected);
  await writeFile(join(f.cwd, 'action.json'), JSON.stringify({ ...actual, createdAt }));
  const verify = () => main({ argv: ['context', 'verify', '--dir', '.context', '--receipt', 'action.json'], cwd: f.cwd,
    env: {}, stdout: { write() {} }, stderr: { write() {} }, fetch: () => assert.fail('Offline verification made a request') });
  assert.equal(await verify(), 0); await writeFile(join(f.cwd, '.context/new.txt'), 'new notes'); assert.equal(await verify(), 1);
});

test('real SIGTERM saves partial Action outputs and cleans the workspace', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), preload = join(f.parent, 'preload.mjs');
  await writeFile(preload, `import {writeFileSync} from 'node:fs';\nglobalThis.fetch=async(_url,init)=>new Promise((_resolve,reject)=>{writeFileSync('started','yes');init.signal.addEventListener('abort',()=>reject(Error('cancelled')));});\n`);
  const child = spawn(process.execPath, ['--import', preload, fileURLToPath(new URL('../src/main.mjs', import.meta.url))], { cwd: f.cwd, env: { ...process.env, ...f.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  let ready = false;
  for (let i = 0; i < 150; i++) { if (await stat(join(f.cwd, 'started')).then(() => true, () => false)) { ready = true; break; } await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.ok(ready); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  let stopped; try { stopped = await closed; } finally { clearTimeout(timer); }
  assert.deepEqual(stopped, { code: 1, signal: null });
  const outputs = Object.fromEntries((await readFile(f.env.GITHUB_OUTPUT, 'utf8')).trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  assert.equal(outputs['inspection-recommendation'], 'withhold'); assert.equal(outputs['inspection-not-attempted'], '1');
  assert.equal(JSON.parse(await readFile(outputs['inspection-report'], 'utf8')).runState, 'interrupted');
  assert.deepEqual((await readdir(f.cwd)).sort(), ['.context', 'started']);
});
