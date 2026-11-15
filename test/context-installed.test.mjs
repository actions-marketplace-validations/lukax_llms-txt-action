// Opt-in package interoperability; CI points this at the installed public CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Writable } from 'node:stream';
import { CLI_PACKAGE, contextArgs, contextChanges } from '../src/context.mjs';

test('pinned public CLI creates a pack, preserves disabled AGENTS and remains subject to Action path checks', { skip: !process.env.LLMS_INK_CONTEXT_CLI }, async () => {
  const { main, VERSION } = await import(pathToFileURL(join(process.env.LLMS_INK_CONTEXT_CLI, 'src/cli.js')));
  assert.equal(CLI_PACKAGE, '@lukax/llms-ink@'+VERSION);
  const root = await mkdtemp(join(tmpdir(), 'ink-action-cli-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { fixture: '1.2.3' } }));
    await writeFile(join(root, 'AGENTS.md'), '# Owner guidance\n');
    const requests = [];
    const fetch = async url => {
      requests.push(String(url));
      if (url === 'https://registry.npmjs.org/fixture/1.2.3') return Response.json({ name: 'fixture', version: '1.2.3', homepage: 'https://docs.fixture.test/1.2.3/' });
      if (String(url).startsWith('https://api.test/api/v0/llms?')) return Response.json({ text: '# Fixture\n\n## Read\n\nOrdinary reference documentation.\n', source: 'native' });
      throw new Error('Unexpected request in installed CLI test');
    };
    let output = '';
    const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
    const args = contextArgs({ manifests: [], dir: '.context', max: 1, agentsMd: '' });
    assert.equal(await main({ argv: args.slice(2), env: { LLMS_INK_API: 'https://api.test' }, cwd: root, stdout: stream, stderr: stream, fetch }), 0, output);
    assert.equal(requests.length, 2); assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), '# Owner guidance\n');
    const changes = contextChanges(root, { dir: '.context', agentsMd: '' }, {});
    assert.deepEqual(Object.keys(changes).sort(), ['.context/README.md', '.context/fixture@1.2.3.md']);
    assert.match(changes['.context/fixture@1.2.3.md'], /Ordinary reference documentation/);
    await writeFile(join(root, 'private.txt'), 'PRIVATE FIXTURE');
    await symlink(join(root, 'private.txt'), join(root, '.context/extra.txt'));
    assert.throws(() => contextChanges(root, { dir: '.context', agentsMd: '' }, {}), /without symlinks/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
