import { Select } from '../../ui/Select';
import { useFieldSources, type FieldMapping, type TemplateField, type TemplateFields } from '../event/content/agendaTemplate';

/**
 * Maps an agenda template's PDF fields to event data, one row per field in reading order. Session
 * sources need the agenda row they show; "Ask when generating" needs the question. Fields left on
 * "Keep template text" are never touched (job code, date of preparation, fixed wording).
 */
export function TemplateFieldsEditor({ fields, value, onChange }: { fields: TemplateField[]; value: TemplateFields; onChange: (v: TemplateFields) => void }) {
  const sources = useFieldSources();
  const set = (name: string, m: FieldMapping | null) => {
    const next = { ...value };
    if (m) next[name] = m; else delete next[name];
    onChange(next);
  };
  const options = [{ value: '', label: 'Keep template text' }, ...(sources.data ?? []).map((s) => ({ value: s.code, label: s.label }))];
  const isSession = (code: string) => code.startsWith('session.');

  return (
    <div className="tf-wrap">
      <div className="table-scroll">
        <table className="tf-table">
          <thead><tr><th>Field in the PDF</th><th>Fills with</th><th className="tf-extra">Row or question</th></tr></thead>
          <tbody>
            {fields.map((f) => {
              const m = value[f.name];
              return (
                <tr key={f.name}>
                  <td>
                    <span className="tf-name">{f.name}</span>
                    {f.kind === 'choice' && <span className={`tf-tag${f.editable ? '' : ' is-locked'}`}>{f.editable ? 'List, any text' : `${f.options.length} approved options only`}</span>}
                    {f.kind === 'other' && <span className="tf-tag">Not filled (checkbox or button)</span>}
                    {f.value.trim() && <div className="dt-sub tf-sample">Now: {f.value}</div>}
                  </td>
                  <td>
                    {f.kind !== 'other' && (
                      <Select aria-label={`What fills ${f.name}`} value={m?.source ?? ''} options={options}
                        onChange={(source) => set(f.name, !source ? null
                          : isSession(source) ? { source, row: m?.row ?? 1 }
                          : source === 'ask' ? { source, label: m?.label ?? '' } : { source })} />
                    )}
                  </td>
                  <td className="tf-extra">
                    {m && isSession(m.source) && (
                      <input className="input tf-row" type="number" min={1} max={99} aria-label={`Agenda row for ${f.name}`} value={m.row ?? ''}
                        onChange={(e) => set(f.name, { ...m, row: Number(e.target.value) || undefined })} />
                    )}
                    {m?.source === 'ask' && (
                      <input className="input" aria-label={`Question for ${f.name}`} placeholder="e.g. Contact number" value={m.label ?? ''}
                        onChange={(e) => set(f.name, { ...m, label: e.target.value })} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
