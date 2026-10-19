import assert from 'node:assert/strict';
import test from 'node:test';
import { decorate, lineClasses, markWords } from './public/word-diff.js';

test('word marks cover only the changed words, across a reflowed block', () => {
  const lines = [
    { kind: 'ctx', text: 'unchanged' },
    { kind: 'del', text: 'It pins atlas==1.30 exactly.' },
    { kind: 'add', text: 'It pins atlas==1.31' },
    { kind: 'add', text: 'exactly, always.' },
  ];
  markWords(lines);
  assert.equal(lines[0].marks, undefined);
  assert.deepEqual(lines[1].marks, [[17, 19, 'word']]);
  assert.deepEqual(lines[2].marks, [[17, 19, 'word']]);
  assert.deepEqual(lines[3].marks, [[7, 15, 'word']]);
});

test('a mostly rewritten block keeps plain line colors', () => {
  const lines = [{ kind: 'del', text: 'alpha beta gamma delta' }, { kind: 'add', text: 'one two three delta' }];
  markWords(lines);
  assert.equal(lines[0].marks, undefined);
});

test('a changed phrase is one mark, spaces included', () => {
  const lines = [{ kind: 'del', text: 'keep alpha beta keep too' }, { kind: 'add', text: 'keep one two keep too' }];
  markWords(lines);
  assert.deepEqual(lines[0].marks, [[5, 15, 'word']]);
});

test('re-indentation alone is a whitespace mark', () => {
  const lines = [{ kind: 'del', text: '    {' }, { kind: 'add', text: '        {' }];
  markWords(lines);
  assert.deepEqual(lines.map((line) => line.marks), [[[0, 4, 'space']], [[0, 8, 'space']]]);
});

test('marks wrap highlighted HTML without breaking its spans or entities', () => {
  const classAt = lineClasses({ kind: 'add', text: '  for "x"', marks: [[4, 7, 'word']] });
  assert.equal(decorate('  <span class="k">for</span> &quot;x&quot;', classAt), '<mark class="code-sp">  </mark><span class="k">fo<mark class="code-word">r</mark></span><mark class="code-word"> &quot;</mark>x&quot;');
});

test('a diff fence colors lines by sign and keeps code aligned under a sign column', async () => {
  const { renderMarkdown } = await import('./public/markdown.js');
  const html = renderMarkdown('```diff\n file.py\n+  added\n-  <gone>\n@@ -1 +1 @@\n```\n\n```py\nplain\n```');
  assert.equal(html.replace(/<\/?mark[^>]*>/g, ''), '<pre class="markdown-diff"><code><span class="markdown-diff-ctx"><span class="markdown-diff-sign"></span>file.py</span><span class="markdown-diff-add"><span class="markdown-diff-sign">+</span>  added</span><span class="markdown-diff-del"><span class="markdown-diff-sign">-</span>  &lt;gone&gt;</span><span class="markdown-diff-hunk"><span class="markdown-diff-sign"></span>@@ -1 +1 @@</span></code></pre><pre><code>plain</code></pre>');
});

test('a diff fence marks the changed words of a paired -/+ run', async () => {
  const { renderMarkdown } = await import('./public/markdown.js');
  const html = renderMarkdown('```diff\n-  config: dict | None\n+  config: Secret[dict] | None\n```');
  assert.match(html, /<span class="markdown-diff-add"><span class="markdown-diff-sign">\+<\/span>  config: <mark class="code-word">Secret\[<\/mark>dict<mark class="code-word">\]<\/mark> \| None<\/span>/);
});

test('change map fills the area, keeps files apart and ghosts each rename at its old path', async () => {
  const { squarify, layoutMap } = await import('./public/diff-map.js');
  const rects = squarify([{ value: 6 }, { value: 3 }, { value: 1 }], 0, 0, 100, 50);
  assert.equal(Math.round(rects.reduce((sum, r) => sum + r.w * r.h, 0)), 5000);
  const files = [
    { path: 'new/a.md', old: 'docs/a.md', status: 'R', additions: 0, deletions: 0 },
    { path: 'new/b.md', old: 'docs/b.md', status: 'R', additions: 2, deletions: 1 },
    { path: 'src/c.ts', old: 'src/c.ts', status: 'M', additions: 5, deletions: 5 },
  ];
  const map = layoutMap(files, { before: { 'docs/a.md': 40, 'docs/b.md': 40, 'src/c.ts': 100 }, after: { 'new/a.md': 40, 'new/b.md': 41, 'src/c.ts': 100 } }, 400, 300);
  assert.deepEqual(map.tiles.filter((t) => t.ghost).map((t) => t.path).sort(), ['docs/a.md', 'docs/b.md']);
  assert.equal(map.tiles.find((t) => t.path === 'src/c.ts').value, 100);
  assert.deepEqual(map.ribbons.map((r) => [r.from, r.to, r.count]), [['docs', 'new', 2]]);
  assert.deepEqual(map.moves.map((m) => [m.from, m.to, m.count, m.within]), [['docs', 'new', 2, '']]);
  const { mapSvg } = await import('./public/diff-map.js');
  const svg = mapSvg(files, null, 400, 300, { title: 'PR <1>', subtitle: 'x' });
  assert.match(svg, /^<svg[^>]+xmlns/);
  assert.match(svg, /PR &lt;1&gt;/);
  // Every file keeps a tile even when its folder is too small for padding.
  const tiny = layoutMap(Array.from({ length: 60 }, (_, i) => ({ path: `d${i}/e/f${i}.md`, old: `d${i}/e/f${i}.md`, status: 'M', additions: 1, deletions: 0 })), null, 60, 40);
  assert.equal(tiny.tiles.length, 60);
});
