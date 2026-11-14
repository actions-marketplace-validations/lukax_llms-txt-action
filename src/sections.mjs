// Split an llms.txt into sections by Markdown headings and compare two versions section by section.

export const INTRO = 'Title and summary';
const CREDIT = /^<!--\s*Generated with https:\/\/llms\.ink\s*-->$/;
const HEADING = /^(#{2,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Sections in file order. Everything before the first `##`-or-deeper heading (the `# Title` and `> summary`) is
 * one section named `Title and summary`. Repeated headings get ` (2)`, ` (3)`… so each name is unique.
 * The llms.ink credit line is ignored, so a hand-edited copy without it doesn't show a change.
 * @param {string} text
 * @returns {{ name: string, lines: string[] }[]}
 */
export function parseSections(text) {
  const sections = [{ name: INTRO, lines: [] }];
  const seen = new Map();
  let fence = null;
  for (const raw of (text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const f = FENCE.exec(line);
    if (f && (!fence || f[1].startsWith(fence))) fence = fence ? null : f[1][0].repeat(f[1].length);
    const h = !fence && !f && HEADING.exec(line);
    if (h) {
      const base = `${h[1]} ${h[2]}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      sections.push({ name: n > 1 ? `${base} (${n})` : base, lines: [] });
      continue;
    }
    if (CREDIT.test(line.trim())) continue;
    if (line.trim()) sections.at(-1).lines.push(line.trim());
  }
  return sections[0].lines.length ? sections : sections.slice(1);
}

/** `## Docs` → `Docs`; the intro keeps its name. */
export const label = (name) => name.replace(/^#+\s+/, '');

/** H2 sections in a file (what llmstxt.org calls sections). */
export const countSections = (text) => parseSections(text).filter((s) => s.name.startsWith('## ')).length;

/** Lines in `a` that are not in `b`, as a multiset. */
function minus(a, b) {
  const left = new Map();
  for (const l of b) left.set(l, (left.get(l) ?? 0) + 1);
  let n = 0;
  for (const l of a) {
    const c = left.get(l) ?? 0;
    if (c) left.set(l, c - 1);
    else n++;
  }
  return n;
}

/**
 * Compare the previous file (`before`, null when there was none) with the new one.
 * @returns {{ added: {name:string, lines:number}[], removed: {name:string, lines:number}[],
 *   changed: {name:string, added:number, removed:number}[], unchanged: number, identical: boolean }}
 */
export function diffSections(before, after) {
  const old = new Map(parseSections(before ?? '').map((s) => [s.name, s.lines]));
  const next = parseSections(after ?? '');
  const diff = { added: [], removed: [], changed: [], unchanged: 0, identical: false };
  for (const { name, lines } of next) {
    const prev = old.get(name);
    if (!prev) diff.added.push({ name, lines: lines.length });
    else if (prev.join('\n') === lines.join('\n')) diff.unchanged++;
    else diff.changed.push({ name, added: minus(lines, prev), removed: minus(prev, lines) });
    old.delete(name);
  }
  for (const [name, lines] of old) diff.removed.push({ name, lines: lines.length });
  diff.identical = !diff.added.length && !diff.removed.length && !diff.changed.length;
  return diff;
}

/** One line, e.g. `2 sections added, 1 changed, 4 unchanged`. */
export function describeDiff(diff) {
  if (diff.identical) return 'No section changes';
  const parts = [];
  if (diff.added.length) parts.push(`${diff.added.length} added`);
  if (diff.removed.length) parts.push(`${diff.removed.length} removed`);
  if (diff.changed.length) parts.push(`${diff.changed.length} changed`);
  if (diff.unchanged) parts.push(`${diff.unchanged} unchanged`);
  return `Sections: ${parts.join(', ')}`;
}

const cell = (s) => s.replace(/\|/g, '\\|').replace(/`/g, "'");

/** Markdown table of added, removed and changed sections; empty string when nothing changed. */
export function diffTable(diff) {
  if (diff.identical) return '';
  const rows = [
    ...diff.added.map((s) => `| Added | \`${cell(label(s.name))}\` | +${s.lines} |`),
    ...diff.removed.map((s) => `| Removed | \`${cell(label(s.name))}\` | −${s.lines} |`),
    ...diff.changed.map((s) => `| Changed | \`${cell(label(s.name))}\` | +${s.added} −${s.removed} |`),
  ];
  return ['| Change | Section | Lines |', '|---|---|---|', ...rows].join('\n');
}
