import { useEffect, useRef, useState } from 'react';
import { Bot, Check, FileText, Trash2, Upload, Users, X } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { Modal } from '../../../ui/Modal';
import { Select } from '../../../ui/Select';
import { DateInput } from '../../../ui/DateInput';
import { attendeeName, type Attendee } from '../attendees/attendeesData';
import { RecipientPicker } from './RecipientPicker';
import { createSpend, extractInvoice, loadDemoInvoices, money, splitSpend, uploadInvoice, type SpendTypeRow, type TovCategory, type TovCategoryRow } from './spendData';

const STEPS = [
  'Reading the documents and their layout',
  'Finding the vendor, totals and line items',
  'Checking the currency and the date',
  'Matching the expense type and ToV category',
  'Matching guests to this event’s attendees',
];
const ACCEPT = ['application/pdf', 'image/png', 'image/jpeg'];

interface Draft {
  key: string; file: File; preview: string; path: string | null; found: boolean; agentId: string | null;
  vendor: string; invoice_number: string; spend_date: string; amount: string; currency: string;
  spend_type: string; tov_category: TovCategory; description: string; attendeeIds: string[];
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drop invoices or receipts; the Invoice Agent reads each into a draft expense (vendor, amount,
 * type, ToV category, and who received it: the guest named on it, or everyone who attended a
 * dinner). Review, change anything, then add them all. The files are kept with the expenses.
 */
export function InvoiceScanModal({ eventId, attendees, types, categories, onClose, onDone }: {
  eventId: string; attendees: Attendee[]; types: SpendTypeRow[]; categories: TovCategoryRow[]; onClose: () => void; onDone: (n: number) => void;
}) {
  const [phase, setPhase] = useState<'pick' | 'reading' | 'review' | 'saving'>('pick');
  const [files, setFiles] = useState<File[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [step, setStep] = useState(0);
  const [agentName, setAgentName] = useState('Invoice Agent');
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const previews = useRef<string[]>([]);
  useEffect(() => () => previews.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const add = (list: FileList | File[]) => {
    const ok = [...list].filter((f) => ACCEPT.includes(f.type));
    if (ok.length < [...list].length) setError('Only PDF, PNG and JPG files can be read.'); else setError(null);
    setFiles((fs) => [...fs, ...ok.filter((f) => !fs.some((x) => x.name === f.name && x.size === f.size))]);
  };

  const read = async () => {
    setPhase('reading'); setStep(0); setError(null);
    const animation = (async () => { for (let i = 1; i <= STEPS.length; i++) { await wait(650 + Math.random() * 350); setStep(i); } })();
    try {
      const results = await Promise.all(files.map(async (file, i): Promise<Draft> => {
        const path = await uploadInvoice(eventId, file);
        const x = await extractInvoice(eventId, file.name);
        if (x.agent.name) setAgentName(x.agent.name);
        const preview = URL.createObjectURL(file); previews.current.push(preview);
        return {
          key: `${i}-${file.name}`, file, preview, path, found: x.found, agentId: x.agent.id,
          vendor: x.vendor ?? '', invoice_number: x.invoice_number ?? '', spend_date: x.spend_date, amount: x.amount != null ? String(x.amount) : '',
          currency: x.currency, spend_type: x.spend_type, tov_category: x.tov_category, description: x.description, attendeeIds: x.attendee_ids ?? [],
        };
      }));
      await animation;
      setDrafts(results); setPhase('review');
    } catch (e) {
      setError((e as Error).message); setPhase('pick');
    }
  };

  const discardUploads = async (rows: Draft[]) => {
    const paths = rows.map((d) => d.path).filter((p): p is string => Boolean(p));
    if (paths.length) await supabase.storage.from('spend').remove(paths);
  };
  const close = () => { if (phase === 'review') void discardUploads(drafts); onClose(); };
  const removeDraft = (d: Draft) => { void discardUploads([d]); setDrafts((ds) => ds.filter((x) => x.key !== d.key)); };
  const patch = (key: string, p: Partial<Draft>) => setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...p } : d)));

  const problems = (d: Draft) => [
    !d.description.trim() && 'a description',
    !(Number(d.amount.replace(',', '.')) > 0) && 'the amount',
    !/^[A-Za-z]{3}$/.test(d.currency.trim()) && 'the currency',
    !d.spend_date && 'the date',
  ].filter(Boolean) as string[];

  const confirm = async () => {
    const bad = drafts.find((d) => problems(d).length);
    if (bad) { setError(`${bad.file.name}: add ${problems(bad).join(', ')}.`); return; }
    setPhase('saving'); setError(null);
    let done = 0;
    try {
      for (const d of drafts) {
        const id = await createSpend(eventId, {
          spend_type: d.spend_type, tov_category: d.tov_category, spend_date: d.spend_date, description: d.description.trim(),
          vendor: d.vendor.trim() || null, invoice_number: d.invoice_number.trim() || null, amount: Number(d.amount.replace(',', '.')),
          currency: d.currency.trim().toUpperCase(), document_path: d.path, document_name: d.file.name, source: 'scan', drafted_by: d.agentId,
        });
        if (d.attendeeIds.length) await splitSpend(id, d.attendeeIds);
        done++;
      }
      onDone(done);
    } catch (e) {
      setDrafts((ds) => ds.slice(done));
      setError(`${done ? `${done} added. ` : ''}${(e as Error).message}`); setPhase('review');
      if (done) onDone(done);
    }
  };

  const typeLabel = (code: string) => types.find((t) => t.code === code)?.label ?? code;
  const who = (d: Draft) => {
    const n = d.attendeeIds.length;
    if (n === 0) return 'No one (not attributed)';
    if (n === 1) return attendeeName(attendees.find((a) => a.id === d.attendeeIds[0]) ?? ({ display_name: 'One attendee' } as Attendee));
    return `Split across ${n} people`;
  };

  const footer = phase === 'pick' ? <>
    <button type="button" className="btn" onClick={close}>Cancel</button>
    <button type="button" className="btn btn-primary" disabled={files.length === 0} onClick={read}><Bot size={15} />Read {files.length || ''} invoice{files.length === 1 ? '' : 's'}</button>
  </> : phase === 'review' || phase === 'saving' ? <>
    <button type="button" className="btn" onClick={close} disabled={phase === 'saving'}>Cancel</button>
    <button type="button" className="btn btn-primary" onClick={confirm} disabled={phase === 'saving' || drafts.length === 0}>
      <Check size={15} />{phase === 'saving' ? 'Adding…' : `Add ${drafts.length} expense${drafts.length === 1 ? '' : 's'}`}</button>
  </> : undefined;

  return (
    <Modal open size="lg" title="Scan invoices" onClose={close} footer={footer}
      footerNote={phase === 'review' ? 'Check each line before adding it. Nothing is saved until you do.' : undefined}
      confirmClose={phase === 'review' && drafts.length ? 'Discard these drafts and the uploaded files?' : false}>
      {error && <div className="form-error" role="alert">{error}</div>}

      {phase === 'pick' && (
        <div className="scan-pick">
          <div className={`scan-drop${over ? ' is-over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}>
            <Upload size={26} aria-hidden />
            <strong>Drop invoices or receipts here</strong>
            <span className="text-muted">PDF, PNG or JPG, up to 10 MB each</span>
            <div className="scan-drop-actions">
              <button type="button" className="btn btn-sm" onClick={() => input.current?.click()}>Browse files</button>
              <button type="button" className="link" onClick={async () => add(await loadDemoInvoices())}>Use the demo invoices</button>
            </div>
            <input ref={input} type="file" multiple hidden accept={ACCEPT.join(',')} onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ''; }} />
          </div>
          {files.length > 0 && (
            <ul className="scan-queue" aria-label="Files to read">
              {files.map((f) => (
                <li key={f.name + f.size}>
                  <FileText size={15} aria-hidden /><span className="scan-file">{f.name}</span><span className="text-muted">{Math.max(1, Math.round(f.size / 1024))} KB</span>
                  <button type="button" className="icon-btn" aria-label={`Remove ${f.name}`} onClick={() => setFiles((fs) => fs.filter((x) => x !== f))}><X size={14} /></button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {phase === 'reading' && (
        <div className="scan-agent" role="status" aria-live="polite">
          <div className="scan-agent-head"><span className="scan-agent-avatar"><Bot size={18} /></span>
            <div><strong>{agentName}</strong><div className="text-muted">Reading {files.length} document{files.length === 1 ? '' : 's'}…</div></div></div>
          <ol className="scan-steps">
            {STEPS.map((s, i) => (
              <li key={s} className={i < step ? 'is-done' : i === step ? 'is-active' : ''}>
                <span className="scan-step-mark">{i < step ? <Check size={12} strokeWidth={3} /> : i + 1}</span>{s}
              </li>
            ))}
          </ol>
        </div>
      )}

      {(phase === 'review' || phase === 'saving') && (
        <div className="scan-review">
          <p className="scan-review-head"><Bot size={15} aria-hidden /> {agentName} read {drafts.length} expense{drafts.length === 1 ? '' : 's'}. Review and add them.</p>
          {drafts.map((d) => (
            <article key={d.key} className="scan-card" aria-label={d.file.name}>
              <button type="button" className="scan-thumb" onClick={() => setZoom(zoom === d.key ? null : d.key)} aria-label={`Preview ${d.file.name}`}>
                {d.file.type === 'application/pdf' ? <span className="scan-thumb-pdf"><FileText size={22} />PDF</span> : <img src={d.preview} alt="" />}
                <span className="scan-thumb-name">{d.file.name}</span>
              </button>
              <div className="scan-fields">
                {!d.found && <p className="scan-note">The agent couldn’t read this one. Fill in the details.</p>}
                <label>Vendor<input className="input" value={d.vendor} onChange={(e) => patch(d.key, { vendor: e.target.value })} /></label>
                <label>Invoice no.<input className="input" value={d.invoice_number} onChange={(e) => patch(d.key, { invoice_number: e.target.value })} /></label>
                <label>Date<DateInput aria-label="Date" value={d.spend_date} onChange={(v) => patch(d.key, { spend_date: v })} /></label>
                <label>Amount
                  <span className="spend-amount"><input className="input" inputMode="decimal" value={d.amount} onChange={(e) => patch(d.key, { amount: e.target.value })} aria-invalid={!(Number(d.amount.replace(',', '.')) > 0) || undefined} />
                    <input className="input spend-cur" aria-label="Currency" maxLength={3} value={d.currency} onChange={(e) => patch(d.key, { currency: e.target.value })} /></span>
                </label>
                <label>Type<Select aria-label="Type" value={d.spend_type} options={types.map((t) => ({ value: t.code, label: t.label }))}
                  onChange={(v) => patch(d.key, { spend_type: v, tov_category: types.find((t) => t.code === v)?.tov_category ?? d.tov_category })} /></label>
                <label>ToV category<Select aria-label="ToV category" value={d.tov_category} options={categories.map((c) => ({ value: c.code, label: c.label }))}
                  onChange={(v) => patch(d.key, { tov_category: v as TovCategory })} /></label>
                <label className="scan-wide">Description<input className="input" value={d.description} onChange={(e) => patch(d.key, { description: e.target.value })} /></label>
                <div className="scan-wide scan-who">
                  <span className="scan-who-label">Received by</span>
                  <span>{who(d)}{d.attendeeIds.length > 1 && Number(d.amount) > 0 && <span className="text-muted"> · {money(Number(d.amount) / d.attendeeIds.length, d.currency.toUpperCase() || 'EUR')} each</span>}</span>
                  <button type="button" className="link" onClick={() => setPicking(picking === d.key ? null : d.key)}><Users size={13} aria-hidden />{picking === d.key ? 'Done' : 'Change'}</button>
                </div>
                {picking === d.key && (
                  <div className="scan-wide"><RecipientPicker attendees={attendees} selected={d.attendeeIds} amount={Number(d.amount.replace(',', '.')) || 0}
                    currency={d.currency.toUpperCase() || 'EUR'} onChange={(ids) => patch(d.key, { attendeeIds: ids })} /></div>
                )}
                <div className="scan-wide scan-card-foot">
                  <span className="text-muted">{typeLabel(d.spend_type)}</span>
                  <button type="button" className="link danger" onClick={() => removeDraft(d)}><Trash2 size={13} aria-hidden />Don’t add</button>
                </div>
              </div>
              {zoom === d.key && d.file.type !== 'application/pdf' && (
                <div className="scan-zoom"><img src={d.preview} alt={`Invoice ${d.file.name}`} /></div>
              )}
            </article>
          ))}
        </div>
      )}
    </Modal>
  );
}
