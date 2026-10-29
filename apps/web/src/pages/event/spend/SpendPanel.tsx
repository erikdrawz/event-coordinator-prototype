import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, FileText, Paperclip, Trash2, Users } from 'lucide-react';
import { PanelField, PanelSection, SidePanel } from '../../../ui/SidePanel';
import { Select } from '../../../ui/Select';
import { DateInput, formatDate } from '../../../ui/DateInput';
import { TextFieldControl } from '../attendees/attendeeControls';
import type { Attendee } from '../attendees/attendeesData';
import { RecipientPicker } from './RecipientPicker';
import { invoiceUrl, money, type Spend, type SpendInput, type SpendTypeRow, type TovCategoryRow, type TovLine } from './spendData';

/** Opens a stored invoice in a new tab (signed link, valid for a few minutes). */
export function InvoiceLink({ path, name }: { path: string; name: string | null }) {
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className="link sp-doc" disabled={busy}
      onClick={async () => { setBusy(true); try { window.open(await invoiceUrl(path), '_blank', 'noopener'); } finally { setBusy(false); } }}>
      <FileText size={14} aria-hidden />{name ?? 'Invoice'}
    </button>
  );
}

function AmountControl({ value, currency, canEdit, onSave }: { value: number; currency: string; canEdit: boolean; onSave: (amount: number, currency: string) => void }) {
  const [text, setText] = useState(String(value));
  const [cur, setCur] = useState(currency);
  const [bad, setBad] = useState(false);
  useEffect(() => { setText(String(value)); setCur(currency); }, [value, currency]);
  if (!canEdit) return <strong>{money(value, currency)}</strong>;
  const commit = () => {
    const n = Math.round(Number(text.replace(',', '.')) * 100) / 100;
    const c = cur.trim().toUpperCase();
    if (!(n > 0) || !/^[A-Z]{3}$/.test(c)) { setBad(true); return; }
    setBad(false);
    if (n !== value || c !== currency) onSave(n, c);
  };
  return (
    <span className="spend-amount">
      <input className="input" inputMode="decimal" aria-label="Amount" aria-invalid={bad || undefined} value={text}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      <input className="input spend-cur" aria-label="Currency" maxLength={3} value={cur}
        onChange={(e) => setCur(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </span>
  );
}

/** Everything about one spend line, editable in place: what, when, how much, the invoice, and who received it. */
export function SpendPanel({ s, attendees, types, categories, canEdit, onChange, onSplit, onAttach, onDelete, onClose }: {
  s: Spend; attendees: Attendee[]; types: SpendTypeRow[]; categories: TovCategoryRow[]; canEdit: boolean;
  onChange: (patch: SpendInput) => void; onSplit: (ids: string[]) => Promise<void>; onAttach: (file: File) => void; onDelete: () => void; onClose: () => void;
}) {
  const [picking, setPicking] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setPicking(null); setError(null); }, [s.id]);
  const category = categories.find((c) => c.code === s.tov_category);
  const current = s.event_spend_attribution.map((a) => a.event_attendee_id).filter((x): x is string => Boolean(x));
  const changeType = (code: string) => {
    const t = types.find((x) => x.code === code);
    const prevDefault = types.find((x) => x.code === s.spend_type)?.tov_category;
    // Keep a category someone chose on purpose; follow the type when it was the type's usual one
    onChange({ spend_type: code, ...(t && s.tov_category === prevDefault ? { tov_category: t.tov_category } : {}) });
  };
  const saveSplit = async () => {
    setSaving(true); setError(null);
    try { await onSplit(picking ?? []); setPicking(null); } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  };

  return (
    <SidePanel recordKey={s.id} onClose={onClose} title={s.description}
      subtitle={[s.vendor, formatDate(s.spend_date), money(s.amount, s.currency)].filter(Boolean).join(' · ')}
      footer={<>
        <span className="sp-foot-note">
          {s.source === 'scan' && s.drafter ? <><Bot size={14} aria-hidden /> Read by {s.drafter.display_name}{s.creator && <>, confirmed by {s.creator.display_name}</>}</>
            : s.creator ? <>Recorded by {s.creator.display_name}</> : null}
        </span>
        {canEdit && <button type="button" className="btn btn-sm btn-danger-outline" onClick={onDelete}><Trash2 size={14} />Delete</button>}
      </>}>
      <PanelSection title="Expense">
        <PanelField label="Date">{canEdit ? <DateInput aria-label="Date" value={s.spend_date} onChange={(v) => v && onChange({ spend_date: v })} /> : formatDate(s.spend_date)}</PanelField>
        <PanelField label="Description"><TextFieldControl label="Description" value={s.description} canEdit={canEdit} onSave={(v) => v && onChange({ description: v })} /></PanelField>
        <PanelField label="Type">
          {canEdit ? <Select aria-label="Type" value={s.spend_type} onChange={changeType} options={types.map((t) => ({ value: t.code, label: t.label }))} />
            : types.find((t) => t.code === s.spend_type)?.label}
        </PanelField>
        <PanelField label="Amount"><AmountControl value={s.amount} currency={s.currency} canEdit={canEdit} onSave={(amount, currency) => onChange({ amount, currency })} /></PanelField>
        <PanelField label="Vendor"><TextFieldControl label="Vendor" value={s.vendor} canEdit={canEdit} onSave={(vendor) => onChange({ vendor })} /></PanelField>
        <PanelField label="Invoice no."><TextFieldControl label="Invoice number" value={s.invoice_number} canEdit={canEdit} onSave={(invoice_number) => onChange({ invoice_number })} /></PanelField>
        <PanelField label="Invoice">
          {s.document_path ? <InvoiceLink path={s.document_path} name={s.document_name} /> : <span className="text-muted">None attached</span>}
          {canEdit && <>
            <button type="button" className="link sp-attach" onClick={() => fileRef.current?.click()}><Paperclip size={13} aria-hidden />{s.document_path ? 'Replace' : 'Attach'}</button>
            <input ref={fileRef} type="file" hidden accept="application/pdf,image/png,image/jpeg"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onAttach(f); e.target.value = ''; }} />
          </>}
        </PanelField>
      </PanelSection>

      <PanelSection title="Transfer of Value">
        <PanelField label="ToV category">
          {canEdit ? <Select aria-label="ToV category" value={s.tov_category} onChange={(v) => onChange({ tov_category: v as Spend['tov_category'] })}
            options={categories.map((c) => ({ value: c.code, label: c.label }))} /> : category?.label}
          {category && !category.reportable && <div className="dt-sub">Not reported, even when it reaches HCPs</div>}
        </PanelField>
        <PanelField label="Received by">
          {s.event_spend_attribution.length === 0 ? <span className="text-muted">No one (not attributed)</span>
            : s.event_spend_attribution.length === 1 ? 'One person' : `Split evenly across ${s.event_spend_attribution.length} people`}
        </PanelField>
        {!picking && s.event_spend_attribution.length > 0 && (
          <ul className="spend-recipients">
            {s.event_spend_attribution.map((a) => (
              <li key={a.id}>
                <span>
                  {a.hcp_id ? <Link to={`/experts/${a.hcp_id}`} className="expert-link">{a.recipient_name}</Link> : a.recipient_name}
                  {!a.hcp_id && <span className="dt-sub"> · colleague, not reported</span>}
                </span>
                <span className="spend-recipient-amount">{money(a.amount, s.currency)}</span>
              </li>
            ))}
          </ul>
        )}
        {canEdit && !picking && (
          <div className="sp-actions"><button type="button" className="btn btn-sm" onClick={() => setPicking(current)}><Users size={14} />{current.length ? 'Change who received it' : 'Assign or split'}</button></div>
        )}
        {picking && (
          <div className="spend-picking">
            <RecipientPicker attendees={attendees} selected={picking} amount={s.amount} currency={s.currency} onChange={setPicking} />
            {error && <div className="form-error" role="alert">{error}</div>}
            <div className="sp-actions">
              <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={saveSplit}>{saving ? 'Saving…' : 'Save'}</button>
              <button type="button" className="btn btn-sm" onClick={() => setPicking(null)}>Cancel</button>
            </div>
          </div>
        )}
      </PanelSection>
    </SidePanel>
  );
}

/** A signed contract's honorarium, as it appears in Spend: read-only, from the contract. */
export function FeePanel({ fee, onClose }: { fee: TovLine; onClose: () => void }) {
  return (
    <SidePanel recordKey={fee.line_id} onClose={onClose} title={fee.hcp_name} subtitle={`Speaker fee · ${money(fee.amount, fee.currency)}`}
      footer={<><span className="sp-foot-note">From the signed contract; change it there with an addendum.</span>
        <Link to={`/contracts/${fee.source_id}`} className="btn btn-sm"><FileText size={14} />View contract</Link></>}>
      <PanelSection title="Fee">
        <PanelField label="Contract">{fee.description}</PanelField>
        <PanelField label="Signed">{fee.tov_date ? formatDate(fee.tov_date) : '—'}</PanelField>
        <PanelField label="Amount"><strong>{money(fee.amount, fee.currency)}</strong></PanelField>
        <PanelField label="ToV category">Fees for service</PanelField>
      </PanelSection>
      <PanelSection title="Recipient">
        <PanelField label="Expert"><Link to={`/experts/${fee.hcp_id}`} className="expert-link">{fee.hcp_name}</Link></PanelField>
        <PanelField label="OneKey ID">{fee.onekey_id ?? <span className="text-muted">—</span>}</PanelField>
        <PanelField label="Country">{fee.country_code ?? <span className="text-muted">—</span>}</PanelField>
      </PanelSection>
    </SidePanel>
  );
}
