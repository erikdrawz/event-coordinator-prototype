import { Fragment, useMemo } from 'react';
import { parseContract, type Run } from './contractDoc';

/** Merge fields shown as chips in template previews (`fields` = the known ones; others are flagged), plain otherwise. */
function Text({ text, fields }: { text: string; fields?: string[] }) {
  if (!fields) return <>{text}</>;
  return <>{text.split(/(\{\{\s*[^}]*?\s*\}\})/).map((p, i) => {
    if (i % 2 === 0) return <Fragment key={i}>{p}</Fragment>;
    const f = p.replace(/[{}\s]/g, '');
    const known = fields.includes(f);
    return <code key={i} className={`merge-chip${known ? '' : ' unknown'}`} data-tip={known ? undefined : 'Unknown merge field'}>{f}</code>;
  })}</>;
}

function Runs({ runs, fields }: { runs: Run[]; fields?: string[] }) {
  return <>{runs.map((r, i) => {
    const t = <Text text={r.text} fields={fields} />;
    return r.bold ? <strong key={i}>{t}</strong> : r.italic ? <em key={i}>{t}</em> : <Fragment key={i}>{t}</Fragment>;
  })}</>;
}

/** The contract as a document: the same blocks the PDF is made from. `fields` (template previews) marks merge fields. */
export function ContractDocument({ body, fields }: { body: string; fields?: string[] }) {
  const blocks = useMemo(() => parseContract(body), [body]);
  return (
    <div className="cdoc">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading': {
            const H = `h${b.level}` as 'h1' | 'h2' | 'h3';
            return <H key={i}><Runs runs={b.runs} fields={fields} /></H>;
          }
          case 'para':
            return <p key={i}>{b.lines.map((l, k) => <Fragment key={k}>{k > 0 && <br />}<Runs runs={l} fields={fields} /></Fragment>)}</p>;
          case 'list': {
            const L = b.ordered ? 'ol' : 'ul';
            return <L key={i}>{b.items.map((it, k) => <li key={k}><Runs runs={it} fields={fields} /></li>)}</L>;
          }
          case 'table':
            return (
              <table key={i}>
                {b.header && <thead><tr>{b.header.map((c, k) => <th key={k} style={{ textAlign: b.align[k] }}><Runs runs={c} fields={fields} /></th>)}</tr></thead>}
                <tbody>{b.rows.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j} style={{ textAlign: b.align[j] }}><Runs runs={c} fields={fields} /></td>)}</tr>)}</tbody>
              </table>
            );
          case 'rule':
            return <hr key={i} />;
        }
      })}
    </div>
  );
}
