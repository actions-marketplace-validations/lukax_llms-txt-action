import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { contextChanges, readTree } from '../src/context.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'ink-context-paths-'));
  try {
    mkdirSync(join(root, '.context')); writeFileSync(join(root, '.context/README.md'), '# Docs\n');
    writeFileSync(join(root, 'AGENTS.md'), '# Agents\n'); writeFileSync(join(root, 'private.txt'), 'PRIVATE FIXTURE');
    run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const type of ['file', 'directory', 'parent', 'agents', 'hard link']) test('context snapshot refuses '+type+' links', () => fixture(root => {
  if (type === 'file') symlinkSync(join(root, 'private.txt'), join(root, '.context/extra.txt'));
  if (type === 'directory') symlinkSync(root, join(root, '.context/loop'), 'dir');
  if (type === 'parent') symlinkSync(root, join(root, 'linked'), 'dir');
  if (type === 'agents') { rmSync(join(root, 'AGENTS.md')); symlinkSync(join(root, 'private.txt'), join(root, 'AGENTS.md')); }
  if (type === 'hard link') linkSync(join(root, 'private.txt'), join(root, '.context/extra.txt'));
  assert.throws(() => contextChanges(root, { dir: type === 'parent' ? 'linked/.context' : '.context', agentsMd: 'AGENTS.md' }, {}));
}));

test('a missing pack cannot become deletion of every remote file', () => fixture(root => {
  rmSync(join(root, '.context'), { recursive: true });
  assert.throws(() => contextChanges(root, { dir: '.context', agentsMd: 'AGENTS.md' }, { '.context/old.md': 'old' }));
}));

test('non-UTF-8 output is refused instead of silently changing bytes', () => fixture(root => {
  writeFileSync(join(root, '.context/bad.txt'), Buffer.from([0xc3, 0x28]));
  assert.throws(() => readTree(root, '.context'));
}));

test('per-file and file-count limits bound the snapshot', () => fixture(root => {
  const big = join(root, '.context/big.txt'); writeFileSync(big, Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.throws(() => readTree(root, '.context'), /exceeds/); rmSync(big);
  for (let n = 0; n < 256; n++) writeFileSync(join(root, '.context/'+n+'.txt'), 'x');
  assert.throws(() => readTree(root, '.context'), /exceeds/);
}));

test('an AGENTS file inside the pack counts once toward the shared file bound', () => fixture(root => {
  writeFileSync(join(root, '.context/AGENTS.md'), '# Agents\n');
  for (let n = 0; n < 254; n++) writeFileSync(join(root, '.context/'+n+'.txt'), 'x');
  assert.equal(Object.keys(contextChanges(root, { dir: '.context', agentsMd: '.context/AGENTS.md' }, {})).length, 256);
  assert.throws(() => contextChanges(root, { dir: '.context', agentsMd: 'AGENTS.md' }, {}), /exceeds/);
}));

test('total bytes include a separately selected AGENTS file', () => fixture(root => {
  writeFileSync(join(root, '.context/README.md'), '');
  for (let n = 0; n < 4; n++) writeFileSync(join(root, '.context/'+n+'.txt'), Buffer.alloc(8 * 1024 * 1024, 65));
  assert.equal(Object.keys(readTree(root, '.context')).length, 5);
  assert.throws(() => contextChanges(root, { dir: '.context', agentsMd: 'AGENTS.md' }, {}), /exceeds/);
}));

test('directory depth is bounded even when directories contain no files', () => fixture(root => {
  let at = join(root, '.context');
  for (let n = 0; n < 33; n++) { at = join(at, 'a'); mkdirSync(at); }
  assert.throws(() => readTree(root, '.context'), /nested too deeply/);
}));

test('directory count is bounded independently of file count', () => fixture(root => {
  for (let n = 0; n < 256; n++) mkdirSync(join(root, '.context', String(n)));
  assert.throws(() => readTree(root, '.context'), /too many directories/);
}));

test('FIFO output is refused without opening or waiting on it', { skip: process.platform === 'win32', timeout: 2000 }, () => fixture(root => {
  execFileSync('mkfifo', [join(root, '.context/pipe')]);
  assert.throws(() => readTree(root, '.context'), /regular files/);
}));

test('snapshot preserves exact UTF-8 including BOM and only deletes files inside its selected prefix', () => fixture(root => {
  writeFileSync(join(root, '.context/a.txt'), '\ufeffline\r\n');
  const result = contextChanges(root, { dir: '.context', agentsMd: 'AGENTS.md' }, { '.context/old.md': 'old', '.context-other/keep.md': 'keep' });
  assert.equal(result['.context/a.txt'], '\ufeffline\r\n'); assert.equal(result['.context/old.md'], null);
  assert.ok(!Object.hasOwn(result, '.context-other/keep.md'));
}));
