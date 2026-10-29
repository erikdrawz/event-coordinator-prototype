import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, Download, FileSignature, MoreVertical, PanelRight, Plus, ScanLine, Trash2, X } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { can } from '../../../lib/permissions';
import { ymdInZone } from '../../../lib/format';
import { Menu } from '../../../ui/Menu';
import { Select } from '../../../ui/Select';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { DateInput, formatDate } from '../../../ui/DateInput';
import { isRowClick } from '../../../ui/BulkSelect';
import { useEventAccess } from '../eventAccess';
import { useAttendees } from '../attendees/attendeesData';
import { InvoiceScanModal } from './InvoiceScanModal';
import { FeePanel, SpendPanel } from './SpendPanel';
import {
  createSpend, deleteSpend, money, spendKey, splitSpend, updateSpend, uploadInvoice, useSpend, useSpendTypes, useTov, useTovCategories,
  type Spend, type SpendInput, type TovCategory, type TovLine,
} from './spendData';
import './spend.css';

type View = 'lines' | 'hcp';
type Row = { kind: 'spend'; s: Spend; date: string } | { kind: 'fee'; f: TovLine; date: string };

/** Sums per currency: "€1,234.00" or "€1,234.00 + £80.00". */
function sum(items: { amount: number; currency: string }[]) {
  const by = new Map<string, number>();
  items.forEach((i) => by.set(i.currency, (by.get(i.currency) ?? 0) + i.amount));
  if (by.size === 0) return money(0);
  return [...by].map(([c, n]) => money(n, c)).join(' + ');
}
const csvCell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/**
 * What the event cost and who received it. Expenses are recorded here (typed in, or read from
 * invoices by the Invoice Agent) and attributed to people: one person, or split evenly across a
 * group. Speaker fees join from signed contracts only. The per-HCP view and the CSV export are the
 * Transfer of Value report.
 */
export function SpendTab({ event }: { event: { id: string; name: string; starts_at: string | null; timezone: string } }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const { canEdit: canEditEvent } = useEventAccess();
  const spend = useSpend(event.id);
  const tov = useTov(event.id);
  const types = useSpendTypes().data ?? [];
  const categories = useTovCategories().data ?? [];
  const attendees = useAttendees(event.id).data ?? [];
  const canAdd = canEditEvent && can(me, 'event_spend', 'create');
  const canEdit = canEditEvent && can(me, 'event_spend', 'edit');
  const canDelete = canEditEvent && can(me, 'event_spend', 'delete');
  const [view, setView] = useState<View>('lines');
  const [open, setOpen] = useState<{ kind: 'spend' | 'fee'; id: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [removing, setRemoving] = useState<Spend | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: spendKey(event.id) });
  const change = useMutation({ mutationFn: ({ id, patch }: { id: string; patch: SpendInput }) => updateSpend(id, patch), onSettled: refresh });
  const attach = useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => updateSpend(id, { document_path: await uploadInvoice(event.id, file), document_name: file.name }),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (s: Spend) => deleteSpend(s.id),
    onSuccess: (_, s) => { if (open?.id === s.id) setOpen(null); setRemoving(null); refresh(); },
  });

  const list = spend.data ?? [];
  const fees = (tov.data ?? []).filter((t) => t.source === 'contract');
  const reportable = (tov.data ?? []);
  const rows: Row[] = useMemo(() => [
    ...list.map((s): Row => ({ kind: 'spend', s, date: s.spend_date })),
    ...fees.map((f): Row => ({ kind: 'fee', f, date: f.tov_date ?? '' })),
  ].sort((a, b) => b.date.localeCompare(a.date)), [list, fees]);
  const openSpend = open?.kind === 'spend' ? list.find((s) => s.id === open.id) ?? null : null;
  const openFee = open?.kind === 'fee' ? fees.find((f) => f.line_id === open.id) ?? null : null;
  const typeLabel = (code: string) => types.find((t) => t.code === code)?.label ?? code;
  const catLabel = (code: TovCategory) => categories.find((c) => c.code === code)?.label ?? code;
  const eventDay = event.starts_at ? ymdInZone(event.starts_at, event.timezone) : ymdInZone(new Date());

  const exportCsv = () => {
    const head = ['Event', 'HCP', 'OneKey ID', 'CRM ID', 'Country', 'ToV category', 'Date', 'Description', 'Vendor', 'Invoice or contract', 'Amount', 'Currency', 'Source'];
    const lines = [...reportable].sort((a, b) => a.hcp_name.localeCompare(b.hcp_name) || (a.tov_date ?? '').localeCompare(b.tov_date ?? '')).map((t) => [
      event.name, t.hcp_name, t.onekey_id, t.crm_external_id, t.country_code, catLabel(t.tov_category), t.tov_date, t.description, t.vendor,
      t.invoice_number, t.amount.toFixed(2), t.currency, t.source === 'contract' ? 'Signed contract' : 'Expense',
    ]);
    const csv = [head, ...lines].map((r) => r.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `ToV - ${event.name}.csv` });
    a.click(); URL.revokeObjectURL(url);
  };

  return (
    <section className="card ov-card" aria-labelledby="spend-title">
      <div className="ov-head">
        <div className="ov-title-row">
          <h2 id="spend-title" className="ov-title">Spend</h2>
          <span className="card-sub">Expenses and signed speaker fees, with who received them</span>
        </div>
        <div className="ov-actions">
          {notice && <span className="bs-notice" role="status">{notice}</span>}
          <button type="button" className="btn btn-sm" onClick={exportCsv} disabled={reportable.length === 0}><Download size={14} />Export ToV (CSV)</button>
          {canAdd && <button type="button" className="btn btn-sm" onClick={() => setScanning(true)}><ScanLine size={14} />Scan invoices</button>}
          {canAdd && <button type="button" className="btn btn-outline btn-sm" onClick={() => { setView('lines'); setAdding(true); }} disabled={adding}><Plus size={14} strokeWidth={2.6} />Add expense</button>}
        </div>
      </div>

      <div className="spend-tiles">
        <div className="spend-tile"><span>Expenses</span><strong>{sum(list)}</strong><small>{list.length} line{list.length === 1 ? '' : 's'}</small></div>
        <div className="spend-tile"><span>Speaker fees (signed)</span><strong>{sum(fees)}</strong><small>{fees.length} contract{fees.length === 1 ? '' : 's'}</small></div>
        <div className="spend-tile"><span>Total</span><strong>{sum([...list, ...fees])}</strong><small>Expenses and fees</small></div>
        <div className="spend-tile is-tov"><span>Reportable to HCPs</span><strong>{sum(reportable)}</strong><small>{new Set(reportable.map((t) => t.hcp_id)).size} HCPs</small></div>
      </div>

      <div className="segmented spend-views" role="group" aria-label="View">
        <button type="button" aria-pressed={view === 'lines'} onClick={() => setView('lines')}>Spend lines</button>
        <button type="button" aria-pressed={view === 'hcp'} onClick={() => setView('hcp')}>Per HCP (ToV)</button>
      </div>

      {(spend.error || tov.error || change.error || attach.error) && <div className="form-error" role="alert">{(spend.error ?? tov.error ?? change.error ?? attach.error)!.message}</div>}

      {spend.isLoading || tov.isLoading ? <div className="ov-empty text-muted">Loading…</div> : view === 'lines' ? (
        rows.length === 0 && !adding ? (
          <div className="ov-empty">
            <span><strong>No spend yet.</strong> Add expenses as they come in, or scan invoices and let the Invoice Agent read them. Speaker fees appear once their contracts are signed.</span>
            {canAdd && <span className="ov-actions"><button className="btn btn-sm" onClick={() => setScanning(true)}><ScanLine size={14} />Scan invoices</button>
              <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><Plus size={14} strokeWidth={2.6} />Add expense</button></span>}
          </div>
        ) : (
          <div className="table-scroll">
            <table className="agenda-table spend-table">
              <thead><tr><th>Date</th><th>Description</th><th>Type</th><th>ToV category</th><th>Received by</th><th className="num">Amount</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {adding && <AddSpendRow eventDay={eventDay} types={types} onCancel={() => setAdding(false)}
                  onSave={async (input) => { const id = await createSpend(event.id, input); setAdding(false); await refresh(); setOpen({ kind: 'spend', id }); }} />}
                {rows.map((r) => r.kind === 'spend' ? (
                  <tr key={r.s.id} className={`row-openable${open?.id === r.s.id ? ' is-open' : ''}`} tabIndex={0}
                    onClick={(e) => { if (isRowClick(e)) setOpen({ kind: 'spend', id: r.s.id }); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) setOpen({ kind: 'spend', id: r.s.id }); }}>
                    <td className="dt-nowrap">{formatDate(r.s.spend_date)}</td>
                    <td>
                      <span className="agenda-title">{r.s.description}</span>
                      <div className="dt-sub">{[r.s.vendor, r.s.invoice_number].filter(Boolean).join(' · ')}
                        {r.s.source === 'scan' && <span className="spend-tag" data-tip={r.s.drafter ? `Read by ${r.s.drafter.display_name}` : undefined}><Bot size={11} aria-hidden />Scanned</span>}</div>
                    </td>
                    <td>{typeLabel(r.s.spend_type)}</td>
                    <td className={categories.find((c) => c.code === r.s.tov_category)?.reportable ? '' : 'text-muted'}>{catLabel(r.s.tov_category)}</td>
                    <td><Recipients s={r.s} /></td>
                    <td className="num"><strong>{money(r.s.amount, r.s.currency)}</strong></td>
                    <td className="agenda-menu">
                      <Menu label={`Actions for ${r.s.description}`} width={200}
                        items={[
                          { key: 'details', label: 'Show details', icon: <PanelRight size={14} />, onSelect: () => setOpen({ kind: 'spend', id: r.s.id }) },
                          ...(canDelete ? [{ key: 'delete', label: 'Delete expense', icon: <Trash2 size={14} />, danger: true, onSelect: () => setRemoving(r.s) }] : []),
                        ]}
                        trigger={(t) => <button type="button" className="icon-btn" aria-label={`Actions for ${r.s.description}`} {...t}><MoreVertical size={16} /></button>} />
                    </td>
                  </tr>
                ) : (
                  <tr key={r.f.line_id} className={`row-openable spend-fee${open?.id === r.f.line_id ? ' is-open' : ''}`} tabIndex={0}
                    onClick={(e) => { if (isRowClick(e)) setOpen({ kind: 'fee', id: r.f.line_id }); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) setOpen({ kind: 'fee', id: r.f.line_id }); }}>
                    <td className="dt-nowrap">{r.f.tov_date ? formatDate(r.f.tov_date) : '—'}</td>
                    <td><span className="agenda-title">Speaker fee</span>
                      <div className="dt-sub"><Link to={`/contracts/${r.f.source_id}`}>{r.f.description}</Link><span className="spend-tag is-fee"><FileSignature size={11} aria-hidden />Signed contract</span></div></td>
                    <td>Speaker fee</td>
                    <td>{catLabel('fees_for_service')}</td>
                    <td><Link to={`/experts/${r.f.hcp_id}`} className="expert-link">{r.f.hcp_name}</Link></td>
                    <td className="num"><strong>{money(r.f.amount, r.f.currency)}</strong></td>
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <PerHcp lines={reportable} categories={categories.filter((c) => c.reportable).map((c) => c.code)} catLabel={catLabel} />
      )}
      {view === 'lines' && rows.length > 0 && <p className="field-hint spend-note">Click a line for its invoice and who received it; split group costs like dinners evenly across attendees. Speaker fees come from signed contracts only.</p>}

      {openSpend && (
        <SpendPanel s={openSpend} attendees={attendees} types={types} categories={categories} canEdit={canEdit}
          onChange={(patch) => change.mutate({ id: openSpend.id, patch })}
          onSplit={async (ids) => { await splitSpend(openSpend.id, ids); await refresh(); }}
          onAttach={(file) => attach.mutate({ id: openSpend.id, file })}
          onDelete={() => setRemoving(openSpend)} onClose={() => setOpen(null)} />
      )}
      {openFee && <FeePanel fee={openFee} onClose={() => setOpen(null)} />}
      {scanning && (
        <InvoiceScanModal eventId={event.id} attendees={attendees} types={types} categories={categories} onClose={() => setScanning(false)}
          onDone={(n) => { setScanning(false); setNotice(`${n} expense${n === 1 ? '' : 's'} added from invoices`); setTimeout(() => setNotice(null), 6000); refresh(); }} />
      )}
      {removing && (
        <ConfirmDialog title="Delete expense?" confirmLabel="Delete expense" pending={remove.isPending} error={remove.error?.message}
          onConfirm={() => remove.mutate(removing)} onCancel={() => { setRemoving(null); remove.reset(); }}>
          <strong>{removing.description}</strong> ({money(removing.amount, removing.currency)}) is deleted with who received it.
          {removing.document_path && <> The invoice file stays in storage.</>}
        </ConfirmDialog>
      )}
    </section>
  );
}

function Recipients({ s }: { s: Spend }) {
  const a = s.event_spend_attribution;
  if (a.length === 0) return <span className="text-muted">—</span>;
  if (a.length === 1) return <span>{a[0].recipient_name}</span>;
  return <span data-tip={a.map((x) => `${x.recipient_name}: ${money(x.amount, s.currency)}`).join(' · ')}>Split · {a.length} people</span>;
}

/** The ToV report on screen: one row per HCP, one column per reportable category. */
function PerHcp({ lines, categories, catLabel }: { lines: TovLine[]; categories: TovCategory[]; catLabel: (c: TovCategory) => string }) {
  const hcps = [...new Map(lines.map((l) => [l.hcp_id, l])).values()].sort((a, b) => a.hcp_name.localeCompare(b.hcp_name));
  const used = categories.filter((c) => lines.some((l) => l.tov_category === c));
  if (hcps.length === 0) return <div className="ov-empty"><span><strong>Nothing to report yet.</strong> HCP shares of reportable expenses and signed speaker fees appear here.</span></div>;
  const cell = (rows: TovLine[]) => (rows.length ? sum(rows) : <span className="text-muted">—</span>);
  return (
    <div className="table-scroll">
      <table className="agenda-table spend-table spend-hcp">
        <thead><tr><th>HCP</th><th>OneKey ID</th>{used.map((c) => <th key={c} className="num">{catLabel(c)}</th>)}<th className="num">Total</th></tr></thead>
        <tbody>
          {hcps.map((h) => {
            const mine = lines.filter((l) => l.hcp_id === h.hcp_id);
            return (
              <tr key={h.hcp_id}>
                <td><Link to={`/experts/${h.hcp_id}`} className="agenda-title expert-link">{h.hcp_name}</Link><div className="dt-sub">{h.country_code}</div></td>
                <td className="dt-nowrap">{h.onekey_id ?? <span className="text-muted">—</span>}</td>
                {used.map((c) => <td key={c} className="num">{cell(mine.filter((l) => l.tov_category === c))}</td>)}
                <td className="num"><strong>{sum(mine)}</strong></td>
              </tr>
            );
          })}
        </tbody>
        <tfoot><tr><td colSpan={2}>Total reportable</td>{used.map((c) => <td key={c} className="num">{cell(lines.filter((l) => l.tov_category === c))}</td>)}<td className="num total">{sum(lines)}</td></tr></tfoot>
      </table>
    </div>
  );
}

/** A new expense typed into the list: date, type, description, amount. Enter saves and opens it to attach the invoice and say who received it. */
function AddSpendRow({ eventDay, types, onSave, onCancel }: {
  eventDay: string; types: { code: string; label: string; tov_category: string }[]; onSave: (input: SpendInput) => Promise<void>; onCancel: () => void;
}) {
  const [date, setDate] = useState(eventDay);
  const [type, setType] = useState('meals');
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const n = Math.round(Number(amount.replace(',', '.')) * 100) / 100;
    if (!desc.trim()) { setError('Add a description'); return; }
    if (!(n > 0)) { setError('Enter the amount'); return; }
    if (!/^[A-Za-z]{3}$/.test(currency.trim())) { setError('Enter a three-letter currency, e.g. EUR'); return; }
    setBusy(true); setError(null);
    try { await onSave({ spend_date: date, spend_type: type, description: desc.trim(), amount: n, currency: currency.trim().toUpperCase() }); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); void submit(); }
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };
  return (
    <>
      <tr className="agenda-inline spend-add" onKeyDown={onKey}>
        <td><DateInput aria-label="Date" value={date} onChange={setDate} /></td>
        <td><input className="input" aria-label="Description" placeholder="e.g. Faculty dinner" value={desc} autoFocus onChange={(e) => setDesc(e.target.value)} /></td>
        <td colSpan={2}><Select aria-label="Type" value={type} onChange={setType} options={types.map((t) => ({ value: t.code, label: t.label }))} /></td>
        <td className="text-muted">Set after adding</td>
        <td className="num"><span className="spend-amount"><input className="input" inputMode="decimal" aria-label="Amount" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input className="input spend-cur" aria-label="Currency" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value)} /></span></td>
        <td className="agenda-inline-actions">
          <button type="button" className="icon-btn ok" aria-label="Add expense" title="Add (Enter)" disabled={busy} onClick={() => void submit()}><Check size={16} /></button>
          <button type="button" className="icon-btn" aria-label="Cancel" title="Cancel (Esc)" onClick={onCancel}><X size={16} /></button>
        </td>
      </tr>
      {error && <tr className="agenda-inline"><td colSpan={7}><span className="form-error inline" role="alert">{error}</span></td></tr>}
    </>
  );
}

