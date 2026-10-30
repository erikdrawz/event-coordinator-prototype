import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, MoreVertical, Pencil, Plus, Trash2, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { DateInput, formatDate } from '../../ui/DateInput';
import { Menu } from '../../ui/Menu';
import { RELATED_LIMIT, ViewAll } from '../../ui/RelatedList';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { currencySymbol, money } from '../event/speakers/speakersData';
import { fmvState, type ExpertRow, type FmvRate } from './expertsData';

const FMV_STATE = { current: { label: 'Current', tone: 'green' }, upcoming: { label: 'Upcoming', tone: 'blue' }, expired: { label: 'Expired', tone: 'grey' } } as const;

type Draft = { effective_date: string; expiration_date: string; rate: string; min_rate: string; max_rate: string };
const toDraft = (f?: FmvRate): Draft => f
  ? { effective_date: f.effective_date, expiration_date: f.expiration_date ?? '', rate: String(f.rate), min_rate: String(f.min_rate), max_rate: String(f.max_rate) }
  : { effective_date: '', expiration_date: '', rate: '', min_rate: '', max_rate: '' };
const num = (s: string) => (s.trim() === '' ? NaN : Number(s.replace(',', '.')));
/** The usual negotiable range: 20% either side, to the nearest 10 */
const around = (rate: number, f: number) => String(Math.round((rate * f) / 10) * 10);

function problem(d: Draft): string | null {
  const [rate, min, max] = [num(d.rate), num(d.min_rate), num(d.max_rate)];
  if (!d.effective_date) return 'Choose the effective date';
  if (d.expiration_date && d.expiration_date < d.effective_date) return 'The expiration date is before the effective date';
  if ([rate, min, max].some((n) => Number.isNaN(n) || n <= 0)) return 'Enter the rate, min rate and max rate as amounts above 0';
  if (min > rate || rate > max) return 'The rate must lie between the min rate and the max rate';
  return null;
}
const friendly = (m: string) => (m.includes('fmv_rate_range_ok') ? 'The rate must lie between the min rate and the max rate' : m);

/** An FMV rate typed straight into the table; Enter saves, Esc cancels. */
function FmvRow({ initial, currency, saving, onSave, onCancel }: {
  initial?: FmvRate; currency: string; saving: boolean; onSave: (d: Draft) => void; onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(toDraft(initial));
  const set = (k: keyof Draft) => (v: string) => setD((p) => ({ ...p, [k]: v }));
  const fillRange = () => {
    const rate = num(d.rate);
    if (!Number.isNaN(rate) && rate > 0 && !d.min_rate && !d.max_rate) setD((p) => ({ ...p, min_rate: around(rate, 0.8), max_rate: around(rate, 1.2) }));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); onSave(d); }
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };
  const amount = (k: 'rate' | 'min_rate' | 'max_rate', label: string, onBlur?: () => void) => (
    <span className="money-input"><span aria-hidden>{currencySymbol(currency)}</span>
      <input className="hours-input fmv-amount" inputMode="decimal" aria-label={label} value={d[k]} onChange={(e) => set(k)(e.target.value)} onBlur={onBlur} /></span>
  );
  return (
    <tr className="agenda-inline" onKeyDown={onKey}>
      <td><DateInput aria-label="Effective date" value={d.effective_date} onChange={set('effective_date')} /></td>
      <td><DateInput aria-label="Expiration date" placeholder="Until replaced" value={d.expiration_date} min={d.effective_date || undefined} onChange={set('expiration_date')} /></td>
      <td className="num">{amount('rate', 'Rate', fillRange)}</td>
      <td className="num">{amount('min_rate', 'Min rate')}</td>
      <td className="num">{amount('max_rate', 'Max rate')}</td>
      <td className="agenda-inline-actions">
        <button type="button" className="icon-btn ok" aria-label={initial ? 'Save FMV rate' : 'Add FMV rate'} title="Save (Enter)" disabled={saving} onClick={() => onSave(d)}><Check size={16} /></button>
        <button type="button" className="icon-btn" aria-label="Cancel" title="Cancel (Esc)" onClick={onCancel}><X size={16} /></button>
      </td>
    </tr>
  );
}

/**
 * The expert's FMV rates by period; people who can edit experts add, change and delete them inline.
 * On the expert page it shows the newest ones; `full` is the page with all of them.
 */
export function FmvCard({ expert, canEdit, full }: { expert: ExpertRow; canEdit: boolean; full?: boolean }) {
  const qc = useQueryClient();
  const rates = expert.fmv_rate;
  const currency = rates[0]?.currency ?? 'EUR';
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<FmvRate | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['expert', expert.id] });
    qc.invalidateQueries({ queryKey: ['experts'] });
    qc.invalidateQueries({ queryKey: ['event'] });             // rates on events may have filled in
    qc.invalidateQueries({ queryKey: ['expert-rate-policy'] });
  };
  const save = useMutation({
    mutationFn: async ({ id, d }: { id: string | null; d: Draft }) => {
      const row = { effective_date: d.effective_date, expiration_date: d.expiration_date || null,
                    rate: num(d.rate), min_rate: num(d.min_rate), max_rate: num(d.max_rate) };
      const { error } = id
        ? await supabase.from('fmv_rate').update(row).eq('id', id)
        : await supabase.from('fmv_rate').insert({ ...row, hcp_id: expert.id, currency });
      if (error) throw new Error(friendly(error.message));
    },
    onSuccess: () => { refresh(); setEditing(null); setError(null); },
    onError: (e) => setError(e.message),
  });
  const remove = useMutation({
    mutationFn: async (f: FmvRate) => {
      const { error } = await supabase.from('fmv_rate').delete().eq('id', f.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { refresh(); setRemoving(null); },
  });
  const submit = (id: string | null) => (d: Draft) => {
    const bad = problem(d);
    if (bad) { setError(bad); return; }
    save.mutate({ id, d });
  };
  const cancel = () => { setEditing(null); setError(null); };
  const showTable = rates.length > 0 || editing === 'new';

  return (
    <section className="card ov-card" aria-label="FMV rates">
      <div className="ov-head">
        <div className="ov-title-row">
          {!full && <h2 id="fmv-title" className="ov-title">FMV rates</h2>}
          <span className="card-sub">Hourly; new engagements default to the rate valid on the event's date</span>
        </div>
        {canEdit && editing === null && (
          <div className="ov-actions"><button className="btn btn-outline btn-sm" onClick={() => setEditing('new')}><Plus size={14} strokeWidth={2.6} />Add FMV rate</button></div>
        )}
      </div>
      {!showTable ? (
        <div className="ov-empty"><span><strong>No FMV rate yet.</strong> Until there is one, their rate on events is €0, so no honorarium is calculated.</span></div>
      ) : (
        <div className="table-scroll">
          <table className="agenda-table expert-table fmv-table">
            <thead>
              <tr><th>Effective date</th><th>Expiration date</th><th className="num">Rate</th><th className="num">Min rate</th><th className="num">Max rate</th>{canEdit && <th aria-label="Actions" />}</tr>
            </thead>
            <tbody>
              {editing === 'new' && <FmvRow currency={currency} saving={save.isPending} onSave={submit(null)} onCancel={cancel} />}
              {(full ? rates : rates.slice(0, RELATED_LIMIT)).map((f) => {
                if (editing === f.id) return <FmvRow key={f.id} initial={f} currency={f.currency} saving={save.isPending} onSave={submit(f.id)} onCancel={cancel} />;
                const st = FMV_STATE[fmvState(f)];
                return (
                  <tr key={f.id} className={st.label === 'Expired' ? 'is-past' : undefined}>
                    <td className="dt-nowrap">{formatDate(f.effective_date)} <span className={`pill pill-${st.tone} pill-sm`}>{st.label}</span></td>
                    <td className="dt-nowrap">{f.expiration_date ? formatDate(f.expiration_date) : <span className="text-muted">Until replaced</span>}</td>
                    <td className="num"><strong>{money(f.rate, f.currency)}</strong></td>
                    <td className="num">{money(f.min_rate, f.currency)}</td>
                    <td className="num">{money(f.max_rate, f.currency)}</td>
                    {canEdit && (
                      <td className="agenda-menu">
                        {editing === null && (
                          <Menu label={`Actions for the FMV rate from ${formatDate(f.effective_date)}`} width={180}
                            items={[
                              { key: 'edit', label: 'Edit rate', icon: <Pencil size={14} />, onSelect: () => { setError(null); setEditing(f.id); } },
                              { key: 'delete', label: 'Delete rate', icon: <Trash2 size={14} />, danger: true, onSelect: () => setRemoving(f) },
                            ]}
                            trigger={(t) => <button type="button" className="icon-btn" aria-label={`Actions for the FMV rate from ${formatDate(f.effective_date)}`} {...t}><MoreVertical size={16} /></button>} />
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!full && <ViewAll to={`/experts/${expert.id}/fmv-rates`} total={rates.length} />}
      {error && <div className="form-error" role="alert">{error}</div>}
      {editing !== null && <p className="field-hint">The range fills in 20% either side of the rate when left empty. Enter saves, Esc cancels.</p>}

      {removing && (
        <ConfirmDialog title="Delete this FMV rate?" confirmLabel="Delete rate" pending={remove.isPending} error={remove.error?.message}
          onConfirm={() => remove.mutate(removing)} onCancel={() => { setRemoving(null); remove.reset(); }}>
          The rate from {formatDate(removing.effective_date)} ({money(removing.rate, removing.currency)} per hour) is deleted. A rate that priced an
          engagement stays on record; set an expiration date on it instead.
        </ConfirmDialog>
      )}
    </section>
  );
}
