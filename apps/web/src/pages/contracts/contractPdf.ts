import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { parseContract, type Run } from './contractDoc';

const runs = (rs: Run[]) => rs.map((r) => ({ text: r.text, bold: r.bold, italics: r.italic }));

function toPdf(body: string): Content[] {
  return parseContract(body).map((b): Content => {
    switch (b.kind) {
      case 'heading':
        return { text: runs(b.runs), style: `h${b.level}` };
      case 'para':
        return { text: b.lines.flatMap((l, k) => [...(k > 0 ? [{ text: '\n' }] : []), ...runs(l)]), style: 'p' };
      case 'list':
        return b.ordered ? { ol: b.items.map((it) => ({ text: runs(it) })), style: 'p' } : { ul: b.items.map((it) => ({ text: runs(it) })), style: 'p' };
      case 'table': {
        const numeric = b.align.some((a) => a === 'right');
        const cell = (c: Run[], k: number, head = false) => ({ text: runs(c), alignment: b.align[k], bold: head || undefined, color: head ? '#5b6573' : undefined });
        return {
          style: 'table',
          table: {
            headerRows: b.header ? 1 : 0,
            widths: b.align.map((_, k) => (numeric && k > 0 ? 'auto' : '*')),
            body: [...(b.header ? [b.header.map((c, k) => cell(c, k, true))] : []), ...b.rows.map((r) => r.map((c, k) => cell(c, k)))],
          },
          layout: { hLineWidth: (i) => (i === 0 ? 0 : 0.5), vLineWidth: () => 0, hLineColor: () => '#dfe4eb',
                    paddingTop: () => 4, paddingBottom: () => 4, paddingLeft: (i) => (i === 0 ? 0 : 6), paddingRight: () => 6 },
        };
      }
      case 'rule':
        return { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#dfe4eb' }], margin: [0, 6, 0, 10] };
    }
  });
}

/**
 * The contract as a PDF: what is handed to the contracting tool for signatures. Drafts carry a
 * DRAFT watermark. pdfmake loads on first use, so it stays out of the main bundle.
 */
export async function contractPdf(c: { body: string; contract_number: string; title: string | null; status: string }): Promise<Blob> {
  const [{ default: pdfMake }, { default: vfs }] = await Promise.all([import('pdfmake/build/pdfmake'), import('pdfmake/build/vfs_fonts')]);
  pdfMake.addVirtualFileSystem(vfs);
  const doc: TDocumentDefinitions = {
    info: { title: `${c.contract_number} ${c.title ?? ''}`.trim() },
    pageSize: 'A4',
    pageMargins: [56, 56, 56, 64],
    watermark: c.status === 'draft' ? { text: 'DRAFT', opacity: 0.06, bold: true } : undefined,
    footer: (page, pages) => ({
      columns: [{ text: c.contract_number, color: '#8a94a3' }, { text: `Page ${page} of ${pages}`, alignment: 'right', color: '#8a94a3' }],
      margin: [56, 24, 56, 0], fontSize: 8,
    }),
    content: toPdf(c.body),
    defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.3, color: '#1f2933' },
    styles: {
      h1: { fontSize: 18, bold: true, margin: [0, 0, 0, 12] },
      h2: { fontSize: 12, bold: true, margin: [0, 12, 0, 6] },
      h3: { fontSize: 10.5, bold: true, margin: [0, 8, 0, 4] },
      p: { margin: [0, 0, 0, 8] },
      table: { margin: [0, 2, 0, 12] },
    },
  };
  return pdfMake.createPdf(doc).getBlob();
}

export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
