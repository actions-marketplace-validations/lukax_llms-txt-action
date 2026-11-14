// `mode: aeo`: the llms.ink agent's-eye report (GET /api/v0/report) as a job summary, annotations and a sticky PR
// comment, and the safe subset of its fixes (robots.txt, _headers, llms.txt) as file changes for `autofix`.

import { posix } from 'node:path';

export const AEO_FAIL_ON = ['fail', 'warn', 'none'];
/** Fix kinds `autofix` applies, and the file names each may write. Everything else is reported, never applied. */
export const FIX_FILES = { robots: ['robots.txt'], headers: ['_headers'], 'llms-txt': ['llms.txt', 'llms-full.txt'] };
/** Folders a fix may land in: the repo root and the usual static folders. */
export const FIX_DIRS = ['', 'public', 'static'];
const COMMENT_LIMIT = 60_000;
const ICON = { fail: '❌', warn: '⚠️', pass: '✅', info: 'ℹ️' };

/** Every check with its section, in report order. */
export const checksOf = (report) => (report.sections ?? []).flatMap((s) => (s.checks ?? []).map((c) => ({ ...c, section: s.id, sectionTitle: s.title })));

/** Whether the report fails the job under `aeo-fail-on`. */
export function aeoFailed(report, failOn) {
  if (failOn === 'none') return false;
  const { fail = 0, warn = 0 } = report.summary ?? {};
  return fail > 0 || (failOn === 'warn' && warn > 0);
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
export const reportLink = (url) => `https://llms.ink/report/?url=${encodeURIComponent(url)}`;
export const aeoMarker = (url) => `<!-- llms-txt-action:aeo:${url} -->`;

/** Markdown lines: counts, then a table of the fail and warn checks with their fixes, then the rest collapsed. */
export function reportMarkdown(url, report, { limit = COMMENT_LIMIT } = {}) {
  const { pass = 0, warn = 0, fail = 0, info = 0 } = report.summary ?? {};
  const checks = checksOf(report);
  const problems = checks.filter((c) => c.status === 'fail' || c.status === 'warn').sort((a, b) => (a.status === b.status ? 0 : a.status === 'fail' ? -1 : 1));
  const rest = checks.filter((c) => c.status === 'pass' || c.status === 'info');
  const lines = [
    `### Agent's-eye view of ${report.url ?? url}`,
    '',
    `${ICON.fail} **${fail} failed** · ${ICON.warn} **${warn} warnings** · ${ICON.pass} ${pass} passed · ${ICON.info} ${info} notes — [full report](${reportLink(report.url ?? url)})${report.checkedAt ? `, checked ${report.checkedAt}` : ''}`,
    '',
  ];
  if (problems.length) {
    lines.push('| | Section | Check | What we saw | Fix |', '|---|---|---|---|---|');
    for (const c of problems) {
      const fix = c.fix ? `${cell(c.fix.summary)}${c.fix.patch ? ` (\`${cell(c.fix.patch.file)}\`)` : ''}` : '';
      lines.push(`| ${ICON[c.status]} | ${cell(c.sectionTitle ?? c.section)} | ${cell(c.title)} | ${cell(c.detail)} | ${fix} |`);
    }
    lines.push('');
  } else lines.push('No failures or warnings.', '');
  if (rest.length) {
    lines.push('<details><summary>Passed and notes</summary>', '', '| | Section | Check | Detail |', '|---|---|---|---|');
    for (const c of rest) lines.push(`| ${ICON[c.status]} | ${cell(c.sectionTitle ?? c.section)} | ${cell(c.title)} | ${cell(c.detail)} |`);
    lines.push('', '</details>', '');
  }
  let text = lines.join('\n');
  if (text.length > limit) text = `${text.slice(0, limit - 40)}\n\n… (truncated; see the full report)\n`;
  return text;
}

/**
 * The safe fixes of a report as repo files. A fix applies when its kind is in FIX_FILES, it carries a patch, and the
 * patch's file is one of that kind's names, at the root or in a FIX_DIRS folder. A bare name goes to `dir` when set,
 * else next to the same name already in the repo (`repoFiles`: paths on the base branch), else into `public/` or
 * `static/` when the repo has one, else the root. Two different patches for one file: the first wins.
 * @returns {{ files: Record<string,string>, applied: object[], skipped: { check: object, reason: string }[] }}
 */
export function fixFiles(report, { dir = '', repoFiles = [] } = {}) {
  const files = {};
  const applied = [];
  const skipped = [];
  const has = new Set(repoFiles);
  for (const c of checksOf(report)) {
    const fix = c.fix;
    if (!fix || (c.status !== 'fail' && c.status !== 'warn')) continue;
    if (!(fix.kind in FIX_FILES)) continue;
    if (!fix.patch?.file || typeof fix.patch.content !== 'string') {
      skipped.push({ check: c, reason: 'no patch to apply' });
      continue;
    }
    const raw = String(fix.patch.file).replace(/\\/g, '/').replace(/^\/+/, '');
    const norm = posix.normalize(raw);
    const name = posix.basename(norm);
    const folder = posix.dirname(norm) === '.' ? null : posix.dirname(norm);
    if (norm.startsWith('../') || norm === '..' || !FIX_FILES[fix.kind].includes(name) || (folder !== null && !FIX_DIRS.includes(folder))) {
      skipped.push({ check: c, reason: `\`${fix.patch.file}\` isn’t a file \`${fix.kind}\` fixes may write` });
      continue;
    }
    let where = folder;
    if (where === null && dir) where = dir.replace(/^\/+|\/+$/g, '');
    where ??= FIX_DIRS.find((d) => has.has(d ? `${d}/${name}` : name)) ?? FIX_DIRS.find((d) => d && repoFiles.some((p) => p.startsWith(`${d}/`))) ?? '';
    const path = where ? `${where}/${name}` : name;
    const content = fix.patch.content.endsWith('\n') ? fix.patch.content : `${fix.patch.content}\n`;
    if (path in files && files[path] !== content) {
      skipped.push({ check: c, reason: `another fix already changes \`${path}\`` });
      continue;
    }
    files[path] = content;
    applied.push({ ...c, path });
  }
  return { files, applied, skipped };
}

/** The autofix pull request's body. */
export function fixBody(url, applied, skipped) {
  const lines = [
    `Fixes from the [llms.ink](https://llms.ink) agent's-eye report of ${url} ([full report](${reportLink(url)})):`,
    '',
    ...applied.map((c) => `- \`${c.path}\` — ${c.fix.summary} (${c.sectionTitle ?? c.section}: ${c.title})`),
    '',
  ];
  if (skipped.length) lines.push('Not applied (fix by hand):', '', ...skipped.map(({ check, reason }) => `- ${check.title}: ${reason}`), '');
  lines.push('Only robots.txt, `_headers` and llms.txt files are ever changed. Review before merging: these files decide what crawlers may read.', '', 'Opened by [lukax/llms-txt-action](https://github.com/lukax/llms-txt-action). Later runs update this branch and PR.');
  return lines.join('\n');
}
