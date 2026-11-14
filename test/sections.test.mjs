import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countSections, describeDiff, diffSections, diffTable, INTRO, parseSections } from '../src/sections.mjs';

const OLD = `# Example

> A site.

## Docs

- [Start](https://example.com/start): Getting started
- [API](https://example.com/api): The API

## Blog

- [Post](https://example.com/post): A post

<!-- Generated with https://llms.ink -->
`;

test('parseSections: intro, headings, credit line ignored', () => {
  const s = parseSections(OLD);
  assert.deepEqual(
    s.map((x) => x.name),
    [INTRO, '## Docs', '## Blog'],
  );
  assert.deepEqual(s[0].lines, ['# Example', '> A site.']);
  assert.equal(s[2].lines.length, 1);
  assert.equal(countSections(OLD), 2);
});

test('parseSections: headings inside code fences, duplicates, CRLF, deeper levels', () => {
  const s = parseSections('# T\r\n\r\n## A\r\n```md\r\n## not a heading\r\n```\r\n### Sub\r\nx\r\n## A\r\ny\r\n');
  assert.deepEqual(
    s.map((x) => x.name),
    [INTRO, '## A', '### Sub', '## A (2)'],
  );
  assert.deepEqual(s[1].lines, ['```md', '## not a heading', '```']);
  assert.deepEqual(parseSections(''), []);
});

test('diffSections: added, removed, changed, unchanged', () => {
  const next = OLD.replace('## Blog\n\n- [Post](https://example.com/post): A post\n', '## Guides\n\n- [G](https://example.com/g): A guide\n- [H](https://example.com/h): Another\n').replace(
    '- [API](https://example.com/api): The API',
    '- [API](https://example.com/api): The REST API\n- [CLI](https://example.com/cli): The CLI',
  );
  const d = diffSections(OLD, next);
  assert.deepEqual(d.added, [{ name: '## Guides', lines: 2 }]);
  assert.deepEqual(d.removed, [{ name: '## Blog', lines: 1 }]);
  assert.deepEqual(d.changed, [{ name: '## Docs', added: 2, removed: 1 }]);
  assert.equal(d.unchanged, 1);
  assert.equal(d.identical, false);
  assert.equal(describeDiff(d), 'Sections: 1 added, 1 removed, 1 changed, 1 unchanged');
  assert.equal(
    diffTable(d),
    ['| Change | Section | Lines |', '|---|---|---|', '| Added | `Guides` | +2 |', '| Removed | `Blog` | −1 |', '| Changed | `Docs` | +2 −1 |'].join('\n'),
  );
});

test('diffSections: whitespace, blank lines and the credit line are not changes', () => {
  const edited = OLD.replace('<!-- Generated with https://llms.ink -->\n', '').replace('## Docs\n\n', '## Docs\n').replace('The API', 'The API   ');
  const d = diffSections(OLD, edited);
  assert.equal(d.identical, true);
  assert.equal(describeDiff(d), 'No section changes');
  assert.equal(diffTable(d), '');
});

test('diffSections: no previous file means every section is added', () => {
  const d = diffSections(null, OLD);
  assert.equal(d.added.length, 3);
  assert.equal(d.removed.length, 0);
});
