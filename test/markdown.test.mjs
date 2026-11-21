import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline } from '../src/sidepanel/markdown.js';

test('blocks: headings, paragraphs, lists, code, quotes, rules, tables', () => {
  const md = [
    '# Transformers',
    'A **transformer** is a *neural network*.',
    '',
    '- attention',
    '- feed-forward',
    '',
    '1. encode',
    '2. decode',
    '',
    '```python',
    'print("<b>hi</b>")',
    '```',
    '> quoted **text**',
    '---',
    '| Model | Year |',
    '|---|---:|',
    '| GPT | 2018 |',
  ].join('\n');
  const b = parseMarkdown(md);
  assert.deepEqual(b.map((x) => x.type), ['heading', 'paragraph', 'list', 'list', 'code', 'quote', 'rule', 'table']);
  assert.equal(b[0].level, 1);
  assert.equal(b[2].ordered, false);
  assert.equal(b[3].ordered, true);
  assert.equal(b[3].items.length, 2);
  assert.deepEqual(b[4], { type: 'code', lang: 'python', text: 'print("<b>hi</b>")' }); // kept as text, never HTML
  assert.equal(b[5].blocks[0].type, 'paragraph');
  assert.equal(b[7].rows[0][1][0].text, '2018');
});

test('inline: bold, italic, code, links, images', () => {
  const spans = parseInline('Use `x`, **bold**, _em_, [docs](https://example.com) and ![cat](https://img.example/cat.png).');
  assert.deepEqual(spans.map((s) => s.type), ['text', 'code', 'text', 'strong', 'text', 'em', 'text', 'link', 'text', 'image', 'text']);
  assert.equal(spans[7].url, 'https://example.com');
  assert.equal(spans[9].url, 'https://img.example/cat.png');
});

test('unsafe content stays plain data (rendering never uses innerHTML)', () => {
  const spans = parseInline('<script>alert(1)</script> [x](javascript:alert(1))');
  assert.equal(spans[0].type, 'text');
  assert.equal(spans[0].text, '<script>alert(1)</script> ');
  assert.equal(spans[1].type, 'link');
  assert.equal(spans[1].url, 'javascript:alert(1)'); // the renderer drops non-http(s) links
});

test('URLs may contain one level of brackets (e.g. Wikipedia)', () => {
  const [link] = parseInline('[wiki](https://en.wikipedia.org/wiki/Transformer_(machine_learning_model))');
  assert.equal(link.url, 'https://en.wikipedia.org/wiki/Transformer_(machine_learning_model)');
});

test('unclosed code fence and blank input do not throw', () => {
  assert.deepEqual(parseMarkdown('```\ncode without end'), [{ type: 'code', lang: '', text: 'code without end' }]);
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown(null), []);
});
