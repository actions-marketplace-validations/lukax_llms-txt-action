// `mode: context`: version-pinned docs for the repo's dependencies (`llms-ink context`, from the llms.ink CLI), written
// to `.context/` and indexed in AGENTS.md, proposed as a pull request when they change.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const CLI_PACKAGE = '@lukax/llms-ink@0.7.2';

/** The CLI's argv: `npx -y @lukax/llms-ink context [--manifest f]... --out <dir> --max <n> [--agents-md <file>]`. */
export function contextArgs({ manifests, dir, max, agentsMd }) {
  const args = ['-y', CLI_PACKAGE, 'context'];
  for (const m of manifests) args.push('--manifest', m);
  args.push('--out', dir, '--max', String(max));
  args.push('--agents-md', agentsMd || 'none');
  return args;
}

/** Runs a command with inherited output; resolves to its exit code (spawn errors reject). */
export function exec(cmd, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Git's blob id of `content`: compares local files with the tree on GitHub without downloading them. */
export const blobSha = (content) => {
  const body = Buffer.from(content);
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
};

const FILE_BYTES = 8 * 1024 * 1024, PACK_BYTES = 32 * 1024 * 1024, FILES = 256;
const unsafe = () => new Error('Context outputs must be regular files inside the workspace, without symlinks or hard links.');
function checked(root, rel) {
  if (!rel || isAbsolute(rel) || /[\\\x00-\x1f\x7f]/.test(rel) || rel.split('/').some(part => part === '..' || part === '.git')) throw unsafe();
  const path = resolve(root, rel), inside = relative(root, path);
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) throw unsafe();
  let at = root;
  const parts = inside.split(sep);
  for (let n = 0; n < parts.length; n++) {
    at = join(at, parts[n]);
    const info = lstatSync(at);
    if (info.isSymbolicLink() || (n < parts.length - 1 && !info.isDirectory())) throw unsafe();
  }
  if (realpathSync(path) !== path) throw unsafe();
  return path;
}

function readRegular(root, rel, budget) {
  const path = checked(root, rel), before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1) throw unsafe();
  if (before.size > FILE_BYTES || budget.files >= FILES || budget.bytes + before.size > PACK_BYTES)
    throw new Error('Context pack exceeds 256 files, 8 MiB per file or 32 MiB total. Reduce the selected output.');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const start = fstatSync(fd);
    if (!start.isFile() || start.ino !== before.ino || start.dev !== before.dev || start.size !== before.size || start.nlink !== 1) throw unsafe();
    const buffer = Buffer.alloc(start.size + 1); let bytes = 0;
    while (bytes < buffer.length) { const n = readSync(fd, buffer, bytes, buffer.length - bytes, null); if (!n) break; bytes += n; }
    const end = fstatSync(fd), current = lstatSync(checked(root, rel));
    if (bytes !== start.size || end.size !== start.size || end.mtimeMs !== start.mtimeMs || end.ctimeMs !== start.ctimeMs
        || current.ino !== start.ino || current.dev !== start.dev || current.nlink !== 1) throw unsafe();
    budget.files++; budget.bytes += bytes;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes));
  } finally { closeSync(fd); }
}

/** Snapshot selected files before any GitHub mutation. The workspace owner is
 * trusted; this is not isolation from concurrent parent-directory replacement. */
export function readTree(root, dir, budget = { files: 0, bytes: 0 }) {
  root = realpathSync(root);
  const out = {}; let directories = 0;
  const walk = (rel, depth) => {
    const path = checked(root, rel), info = lstatSync(path);
    if (info.isDirectory()) {
      if (++directories > 256 || depth > 32) throw new Error('Context output has too many directories or is nested too deeply.');
      for (const name of readdirSync(path).sort()) walk(`${rel}/${name}`, depth + 1);
    } else out[rel] = readRegular(root, rel, budget);
  };
  const clean = dir.replace(/\/+$/, '');
  if (!lstatSync(checked(root, clean)).isDirectory()) throw unsafe();
  walk(clean, 0);
  return out;
}

/**
 * What to commit so `dir` (and `agentsMd`) on the branch match the workspace: changed or new files with their
 * content, files gone from `dir` as null. `remote` is the base branch's {path: blob sha}.
 */
export function contextChanges(root, { dir, agentsMd }, remote) {
  root = realpathSync(root);
  const budget = { files: 0, bytes: 0 }, local = readTree(root, dir, budget);
  if (agentsMd && !Object.hasOwn(local, agentsMd)) local[agentsMd] = readRegular(root, agentsMd, budget);
  const changes = {};
  for (const [path, content] of Object.entries(local)) if (remote[path] !== blobSha(content)) changes[path] = content;
  const prefix = `${dir.replace(/\/+$/, '')}/`;
  for (const path of Object.keys(remote)) if (path.startsWith(prefix) && !(path in local)) changes[path] = null;
  return changes;
}
