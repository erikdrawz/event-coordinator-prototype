/**
 * Contract text is Markdown (drafted in the database from a template). This reads the part of
 * Markdown contracts need: headings, paragraphs (a line break is kept), lists, tables, rules,
 * **bold** and *italic*. The same blocks render on screen, in print and in the PDF, so the three
 * always match. No HTML is ever passed through.
 */
export type Run = { text: string; bold?: boolean; italic?: boolean };
export type Align = 'left' | 'right' | 'center';
export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; runs: Run[] }
  | { kind: 'para'; lines: Run[][] }
  | { kind: 'list'; ordered: boolean; items: Run[][] }
  | { kind: 'table'; header: Run[][] | null; align: Align[]; rows: Run[][][] }
  | { kind: 'rule' };

const INLINE = /(\*\*[^*]+?\*\*|(?<![\w*])\*(?!\s)[^*]+?\*(?![\w*])|(?<!\w)_(?!\s)[^_]+?_(?!\w))/;

export function parseInline(s: string): Run[] {
  return s.split(INLINE).filter(Boolean).map((part) => {
    if (!INLINE.test(part) || part.length < 3) return { text: part };
    return part.startsWith('**') ? { text: part.slice(2, -2), bold: true } : { text: part.slice(1, -1), italic: true };
  });
}

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isSeparator = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const LIST = /^\s*([-*]|\d+\.)\s+(.*)$/;

export function parseContract(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { blocks.push({ kind: 'heading', level: h[1].length as 1 | 2 | 3, runs: parseInline(h[2].trim()) }); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { blocks.push({ kind: 'rule' }); i++; continue; }
    if (line.trim().startsWith('|')) {
      const rows: string[][] = [];
      let align: Align[] = [];
      let header: string[] | null = null;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        if (isSeparator(lines[i])) {
          align = cells(lines[i]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'));
          header = rows.pop() ?? null;
        } else rows.push(cells(lines[i]));
        i++;
      }
      const width = Math.max(header?.length ?? 0, ...rows.map((r) => r.length));
      const pad = (r: string[]) => Array.from({ length: width }, (_, k) => parseInline(r[k] ?? ''));
      blocks.push({
        kind: 'table', align: Array.from({ length: width }, (_, k) => align[k] ?? 'left'),
        header: header && header.some(Boolean) ? pad(header) : null, rows: rows.map(pad),
      });
      continue;
    }
    if (LIST.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: Run[][] = [];
      while (i < lines.length && LIST.test(lines[i])) { items.push(parseInline(LIST.exec(lines[i])![2])); i++; }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    const para: Run[][] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3})\s/.test(lines[i]) && !lines[i].trim().startsWith('|') && !LIST.test(lines[i])) {
      para.push(parseInline(lines[i].trim())); i++;
    }
    blocks.push({ kind: 'para', lines: para });
  }
  return blocks;
}
