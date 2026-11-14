// `mode: context`: version-pinned docs for the repo's dependencies (`llms-ink context`, from the llms.ink CLI), written
// to `.context/` and indexed in AGENTS.md, proposed as a pull request when they change.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const CLI_PACKAGE = '@lukax/llms-ink';

/** The CLI's argv: `npx -y @lukax/llms-ink context [--manifest f]... --out <dir> --max <n> [--agents-md <file>]`. */
export function contextArgs({ manifests, dir, max, agentsMd }) {
  const args = ['-y', CLI_PACKAGE, 'context'];
  for (const m of manifests) args.push('--manifest', m);
  args.push('--out', dir, '--max', String(max));
  if (agentsMd) args.push('--agents-md', agentsMd);
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

/** Files under `dir` (workspace-relative, `/`-separated) → their content. */
export function readTree(root, dir) {
  const out = {};
  const walk = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) for (const name of readdirSync(abs).sort()) walk(`${rel}/${name}`);
    else out[rel] = readFileSync(abs, 'utf8');
  };
  walk(dir.replace(/\/+$/, ''));
  return out;
}

/**
 * What to commit so `dir` (and `agentsMd`) on the branch match the workspace: changed or new files with their
 * content, files gone from `dir` as null. `remote` is the base branch's {path: blob sha}.
 */
export function contextChanges(root, { dir, agentsMd }, remote) {
  const local = readTree(root, dir);
  if (agentsMd && existsSync(join(root, agentsMd))) local[agentsMd] = readFileSync(join(root, agentsMd), 'utf8');
  const changes = {};
  for (const [path, content] of Object.entries(local)) if (remote[path] !== blobSha(content)) changes[path] = content;
  const prefix = `${dir.replace(/\/+$/, '')}/`;
  for (const path of Object.keys(remote)) if (path.startsWith(prefix) && !(path in local)) changes[path] = null;
  return changes;
}
