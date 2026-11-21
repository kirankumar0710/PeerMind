// Minimal, safe Markdown for the output canvas. Model output is untrusted (§7.2), so:
//  - parsing produces a plain data tree (pure, testable); rendering builds DOM nodes with
//    textContent only — never innerHTML, so no markup or script from the model can run;
//  - links are http/https only and open in a new tab;
//  - external images are NOT loaded (tracking/privacy); they render as a link instead.
//
// Supported: # headings, paragraphs, **bold**, *italic*/_italic_, `code`, ``` fenced code ```,
// - / * / 1. lists (one level), > quotes, --- rules, | pipe | tables |, [links](https://…), ![alt](url).

const SAFE_URL = /^https?:\/\//i;

/** Parse Markdown text into blocks: [{type, …}]. */
export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const isTableSep = (l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)\s*$/);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      i++; // closing fence (or end of text)
      blocks.push({ type: 'code', lang: fence[2] || '', text: code.join('\n') });
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2]) }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ type: 'rule' }); i++; continue; }

    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = cells(line).map(parseInline);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]).map(parseInline));
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', blocks: parseMarkdown(quote.join('\n')) });
      continue;
    }
    const listItem = (l) => l.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
    if (listItem(line)) {
      const ordered = /\d/.test(listItem(line)[1]);
      const items = [];
      while (i < lines.length && (listItem(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = listItem(lines[i]);
        if (m) items.push(m[2]); else items[items.length - 1] += ` ${lines[i].trim()}`; // continuation line
        i++;
      }
      blocks.push({ type: 'list', ordered, items: items.map(parseInline) });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|```|~~~|>|([-*+]|\d+[.)])\s)/.test(lines[i])) para.push(lines[i++].trim());
    if (!para.length) para.push(lines[i++].trim()); // a line no other rule took
    blocks.push({ type: 'paragraph', inline: parseInline(para.join(' ')) });
  }
  return blocks;
}

/** Parse inline Markdown into spans: [{type:'text'|'code'|'strong'|'em'|'link'|'image', …}]. */
export function parseInline(text) {
  const out = [];
  const re = /(`+)([^`]+?)\1|!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[1]) out.push({ type: 'code', text: m[2] });
    else if (m[4] !== undefined) out.push({ type: 'image', alt: m[3], url: m[4] });
    else if (m[6] !== undefined) out.push({ type: 'link', url: m[6], children: parseInline(m[5]) });
    else if (m[7] !== undefined || m[8] !== undefined) out.push({ type: 'strong', children: parseInline(m[7] ?? m[8]) });
    else out.push({ type: 'em', children: parseInline(m[9] ?? m[10]) });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

// ---------------------------------------------------------------- DOM rendering (browser only)

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const c of children) n.append(c);
  return n;
}

function renderInline(spans) {
  return spans.map((s) => {
    switch (s.type) {
      case 'text': return document.createTextNode(s.text);
      case 'code': return el('code', {}, [s.text]);
      case 'strong': return el('strong', {}, renderInline(s.children));
      case 'em': return el('em', {}, renderInline(s.children));
      case 'link':
        return SAFE_URL.test(s.url)
          ? el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, renderInline(s.children))
          : el('span', {}, renderInline(s.children)); // unsafe scheme: keep the text, drop the link
      case 'image':
        // External images are never fetched; show where they point instead.
        return SAFE_URL.test(s.url)
          ? el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', class: 'md-ext-image' }, [`🖼 ${s.alt || 'image'} (external image not loaded)`])
          : document.createTextNode(`[image: ${s.alt || 'image'}]`);
      default: return document.createTextNode('');
    }
  });
}

/** Render Markdown text as a DocumentFragment of safe DOM nodes. */
export function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  for (const b of parseMarkdown(text)) frag.append(renderBlock(b));
  return frag;
}

function renderBlock(b) {
  switch (b.type) {
    case 'heading': return el(`h${Math.min(b.level + 1, 6)}`, { class: 'md-h' }, renderInline(b.inline));
    case 'paragraph': return el('p', {}, renderInline(b.inline));
    case 'code': {
      const code = el('code', b.lang ? { 'data-lang': b.lang } : {}, [b.text]);
      return el('pre', { class: 'md-code' }, [code]);
    }
    case 'list': return el(b.ordered ? 'ol' : 'ul', {}, b.items.map((it) => el('li', {}, renderInline(it))));
    case 'quote': return el('blockquote', {}, b.blocks.map(renderBlock));
    case 'rule': return el('hr');
    case 'table':
      return el('div', { class: 'md-table' }, [el('table', {}, [
        el('thead', {}, [el('tr', {}, b.header.map((c) => el('th', {}, renderInline(c))))]),
        el('tbody', {}, b.rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, renderInline(c)))))),
      ])]);
    default: return document.createTextNode('');
  }
}
