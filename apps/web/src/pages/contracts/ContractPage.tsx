import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, CalendarDays, ChevronDown, Download, FilePlus2, FileSignature, FileText, Printer, RefreshCw, Send, Trash2, UserRound } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { timeAgo } from '../../lib/format';
import { Menu, type MenuItem } from '../../ui/Menu';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { formatDate } from '../../ui/DateInput';
import { useMyEventAccess } from '../event/eventAccess';
import { hours, money } from '../event/speakers/speakersData';
import { ContractDocument } from './ContractDocument';
import { ContractStatusPill } from './ContractStatusPill';
import { NewContractModal } from './NewContractModal';
import { contractFileName, contractPdfBlob, refreshContracts, sendContract, useContract, useTypeLabel, type ContractRow } from './contractsData';
import { saveBlob } from './contractPdf';
import '../event.css';
import './contracts.css';

const empty = <span className="text-muted">—</span>;
function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="details-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

/** What the event's honorarium is now, when it differs from the contract's. */
function feeChange(c: ContractRow) {
  const h = c.honorarium, x = c.event_expert;
  if (!h || !x) return null;
  const same = Number(h.total) === Number(x.total_payable) && Number(h.rate) === Number(x.hourly_rate)
    && Number(h.prep_hours) === Number(x.prep_hours) && Number(h.service_hours) === Number(x.service_hours) && Number(h.travel_hours) === Number(x.travel_hours);
  return same ? null : { now: Number(x.total_payable), was: Number(h.total), currency: x.currency ?? h.currency };
}

type Confirm = 'send' | 'signed' | 'cancel' | 'delete' | null;

/**
 * One contract: the document as it will be signed (printable, and as a PDF), what it's for, and
 * where it is: draft → sent for signature → signed.
 */
export function ContractPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { me } = useAuth();
  const typeLabel = useTypeLabel();
  const { data: c, isLoading, error } = useContract(id);
  const eventAccess = useMyEventAccess(c?.event_id ?? undefined);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [adding, setAdding] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  const done = () => { refreshContracts(qc, c ?? undefined); setConfirm(null); };
  const run = (fn: string) => async () => {
    const { error } = await supabase.rpc(fn, { p_id: c!.id });
    if (error) throw new Error(error.message);
  };
  const regenerate = useMutation({ mutationFn: run('regenerate_contract'), onSuccess: done });
  const send = useMutation({ mutationFn: () => sendContract(c!), onSuccess: done });
  const signed = useMutation({ mutationFn: run('mark_contract_signed'), onSuccess: done });
  const cancel = useMutation({ mutationFn: run('cancel_contract'), onSuccess: done });
  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('contract').delete().eq('id', c!.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      refreshContracts(qc, c ?? undefined);
      navigate(c?.event ? `/events/${c.event.id}` : c?.hcp ? `/experts/${c.hcp.id}` : '/');
    },
  });

  if (isLoading) return <main className="page"><div className="empty-state">Loading…</div></main>;
  if (error || !c) return <main className="page"><div className="card empty-state"><div className="empty-state-title">Contract not found</div>{error?.message ?? "It may have been deleted, or you don't have access."}</div></main>;

  const canEdit = can(me, 'contract', 'edit') && (!c.event_id || eventAccess.data?.access === 'edit');
  const isDraft = c.status === 'draft';
  const change = feeChange(c);
  const engagementType = c.contract_type === 'work_order' || c.contract_type === 'event_contract';
  const openAddenda = c.addenda.filter((a) => a.status !== 'cancelled');

  const download = async () => {
    setPdfError(null); setPdfBusy(true);
    try { saveBlob(await contractPdfBlob(c), c.document?.file_name ?? contractFileName(c)); }
    catch (e) { setPdfError((e as Error).message); }
    finally { setPdfBusy(false); }
  };

  const actions: MenuItem[] = canEdit ? [
    ...(isDraft && c.body ? [{ key: 'send', label: 'Send for signature', icon: <Send size={14} />, onSelect: () => setConfirm('send') }] : []),
    ...(c.status === 'sent' ? [{ key: 'signed', label: 'Mark as signed', icon: <FileSignature size={14} />, onSelect: () => setConfirm('signed') }] : []),
    ...(isDraft && c.contract_type !== 'venue' ? [{ key: 'regen', label: 'Draft again from template', icon: <RefreshCw size={14} />, onSelect: () => regenerate.mutate() }] : []),
    ...(engagementType && c.status !== 'cancelled' && c.event_expert_id && can(me, 'contract', 'create') ? [{ key: 'addendum', label: 'Add addendum', icon: <FilePlus2 size={14} />, onSelect: () => setAdding(true) }] : []),
    ...(c.status === 'sent' ? [{ key: 'cancel', label: 'Cancel contract', icon: <Ban size={14} />, danger: true, onSelect: () => setConfirm('cancel') }] : []),
    ...(isDraft && can(me, 'contract', 'delete') ? [{ key: 'delete', label: 'Delete draft', icon: <Trash2 size={14} />, danger: true, onSelect: () => setConfirm('delete') }] : []),
  ] : [];
  const busy = regenerate.isPending || send.isPending || signed.isPending || cancel.isPending;
  const actionError = regenerate.error ?? (confirm ? null : send.error ?? signed.error ?? cancel.error);

  return (
    <main className="page">
      <section className="card event-head contract-head">
        <nav className="crumbs">
          {c.event ? <><Link to={`/events/${c.event.id}`}>{c.event.name}</Link><span>/</span><span>Experts</span></>
            : c.hcp ? <><Link to="/experts">Experts</Link><span>/</span><Link to={`/experts/${c.hcp.id}`}>{c.hcp.display_name}</Link></> : null}
          <span>/</span><span>{c.contract_number}</span>
        </nav>
        <div className="event-head-row">
          <div className="event-head-main">
            <div className="event-title-row">
              <h1 className="event-title">{typeLabel(c.contract_type)} {c.contract_number}</h1>
              <ContractStatusPill status={c.status} />
            </div>
            <div className="event-meta">
              {c.hcp && <span><UserRound size={15} /><Link to={`/experts/${c.hcp.id}`} className="expert-link">{c.hcp.display_name}</Link></span>}
              {c.hco && <span><UserRound size={15} />{c.hco.name}</span>}
              {c.event && <span><CalendarDays size={15} /><Link to={`/events/${c.event.id}`} className="expert-link">{c.event.name}</Link></span>}
              {c.parent && <span><FileText size={15} />{c.contract_type === 'addendum' ? 'Changes' : 'Under'}&nbsp;<Link to={`/contracts/${c.parent.id}`} className="expert-link">{c.parent.contract_number}</Link></span>}
            </div>
          </div>
          <div className="event-actions">
            <button type="button" className="btn" onClick={() => window.print()} disabled={!c.body}><Printer size={15} />Print</button>
            <button type="button" className="btn" onClick={download} disabled={pdfBusy || (!c.body && !c.document)}><Download size={15} />{pdfBusy ? 'Preparing…' : 'PDF'}</button>
            {actions.length > 0 && (
              <Menu label="Contract actions" width={230} items={actions}
                trigger={(t) => <button type="button" className="btn btn-primary" disabled={busy} {...t}>{busy ? 'Working…' : 'Actions'} <ChevronDown size={16} /></button>} />
            )}
          </div>
        </div>
        {(actionError || pdfError) && <div className="form-error" role="alert" style={{ marginTop: 12 }}>{actionError?.message ?? pdfError}</div>}
        {change && c.status !== 'cancelled' && (
          <p className="contract-note">
            {isDraft
              ? <>The honorarium on the event is now <strong>{money(change.now, change.currency)}</strong>; this draft says {money(change.was, change.currency)}.
                  {canEdit && <> <button className="link" onClick={() => regenerate.mutate()}>Draft it again</button> to update it.</>}</>
              : <>The honorarium on the event is now <strong>{money(change.now, change.currency)}</strong>; this contract says {money(change.was, change.currency)}.
                  {engagementType ? ' Add an addendum to change it.' : ''}</>}
          </p>
        )}
      </section>

      <div className="contract-body">
        <article className="card contract-paper" aria-label="Contract document">
          {c.body ? <ContractDocument body={c.body} />
            : <div className="ov-empty"><span><strong>No document yet.</strong> {c.contract_type === 'venue' ? 'Venue contracts are uploaded as files for now.' : 'Draft it again from its template.'}</span></div>}
        </article>
        <aside className="contract-side">
          <section className="card details-card expert-details" aria-labelledby="contract-details-title">
            <div className="details-head"><h2 id="contract-details-title" className="card-title">Contract details</h2></div>
            <dl className="details-grid">
              <Row label="Status"><ContractStatusPill status={c.status} /></Row>
              <Row label="Type">{typeLabel(c.contract_type)}</Row>
              <Row label="Expert">{c.hcp ? <Link to={`/experts/${c.hcp.id}`}>{c.hcp.display_name}</Link> : c.hco?.name ?? empty}</Row>
              {c.event && <Row label="Event"><Link to={`/events/${c.event.id}`}>{c.event.name}</Link><div className="dt-sub">{c.event.event_number}</div></Row>}
              {c.parent && <Row label={c.contract_type === 'addendum' ? 'Changes' : 'Under'}><Link to={`/contracts/${c.parent.id}`}>{c.parent.contract_number}</Link><div className="dt-sub">{typeLabel(c.parent.contract_type)}</div></Row>}
              {openAddenda.length > 0 && <Row label="Addenda">{openAddenda.map((a) => <div key={a.id}><Link to={`/contracts/${a.id}`}>{a.contract_number}</Link> <ContractStatusPill status={a.status} small /></div>)}</Row>}
              <Row label="Term">{c.start_date ? <>{formatDate(c.start_date)}{c.end_date && c.end_date !== c.start_date && <> – {formatDate(c.end_date)}</>}</> : empty}</Row>
              <Row label="Template">{c.template?.name ?? empty}{c.rendered_at && <div className="dt-sub">Drafted {timeAgo(c.rendered_at)}</div>}</Row>
            </dl>
          </section>
          {c.honorarium && (
            <section className="card details-card expert-details" aria-labelledby="contract-fee-title">
              <div className="details-head"><h2 id="contract-fee-title" className="card-title">Honorarium</h2></div>
              <table className="fee-table">
                <tbody>
                  <tr><th>Preparation</th><td>{hours(Number(c.honorarium.prep_hours))} h</td><td>{money(Number(c.honorarium.prep_amount), c.honorarium.currency)}</td></tr>
                  <tr><th>Service</th><td>{hours(Number(c.honorarium.service_hours))} h</td><td>{money(Number(c.honorarium.service_amount), c.honorarium.currency)}</td></tr>
                  <tr><th>Travel</th><td>{hours(Number(c.honorarium.travel_hours))} h</td><td>{money(Number(c.honorarium.travel_amount), c.honorarium.currency)}</td></tr>
                </tbody>
                <tfoot><tr><th>Total</th><td>at {money(Number(c.honorarium.rate), c.honorarium.currency)} / h</td><td>{money(Number(c.honorarium.total), c.honorarium.currency)}</td></tr></tfoot>
              </table>
            </section>
          )}
          <section className="card details-card expert-details" aria-labelledby="contract-sign-title">
            <div className="details-head"><h2 id="contract-sign-title" className="card-title">Signature</h2></div>
            <dl className="details-grid">
              <Row label="Sent">{c.sent_at ? formatDate(c.sent_at.slice(0, 10)) : <span className="text-muted">Not yet</span>}</Row>
              <Row label="Signed">{c.signed_at ? formatDate(c.signed_at.slice(0, 10)) : <span className="text-muted">Not yet</span>}</Row>
              <Row label="Contracting tool">{c.clm_reference ?? <span className="text-muted">Not handed over</span>}</Row>
              <Row label="PDF">{c.document ? <button className="link" onClick={download}>{c.document.file_name}</button> : <span className="text-muted">Stored when sent</span>}</Row>
            </dl>
          </section>
        </aside>
      </div>

      {adding && c.event_expert && c.event && c.hcp && (
        <NewContractModal onClose={() => setAdding(false)} target={{
          kind: 'engagement', addendum: true, eventExpertId: c.event_expert.id, eventId: c.event.id, hcpId: c.hcp.id, name: c.hcp.display_name,
          honorarium: { total: Number(c.event_expert.total_payable), currency: c.event_expert.currency ?? 'EUR', rate: c.event_expert.hourly_rate == null ? null : Number(c.event_expert.hourly_rate),
            prep: Number(c.event_expert.prep_hours), service: Number(c.event_expert.service_hours), travel: Number(c.event_expert.travel_hours) },
        }} />
      )}
      {confirm === 'send' && (
        <ConfirmDialog title="Send for signature?" confirmLabel="Send for signature" danger={false} pending={send.isPending} error={send.error?.message}
          onConfirm={() => send.mutate()} onCancel={() => { send.reset(); setConfirm(null); }}>
          A PDF of <strong>{c.contract_number}</strong> is stored with the contract and handed to the contracting tool to collect signatures.
          The text can't be changed after this; changes go in an addendum.
          {change && <> <strong>The honorarium on the event has changed since this draft.</strong> Draft it again first if the contract should show it.</>}
        </ConfirmDialog>
      )}
      {confirm === 'signed' && (
        <ConfirmDialog title="Mark as signed?" confirmLabel="Mark as signed" danger={false} pending={signed.isPending} error={signed.error?.message}
          onConfirm={() => signed.mutate()} onCancel={() => { signed.reset(); setConfirm(null); }}>
          Do this once every party has signed <strong>{c.contract_number}</strong>. Later, the contracting tool will report it.
        </ConfirmDialog>
      )}
      {confirm === 'cancel' && (
        <ConfirmDialog title="Cancel this contract?" confirmLabel="Cancel contract" cancelLabel="Keep contract" pending={cancel.isPending} error={cancel.error?.message}
          onConfirm={() => cancel.mutate()} onCancel={() => { cancel.reset(); setConfirm(null); }}>
          <strong>{c.contract_number}</strong> is withdrawn from signature and stays on record as cancelled.
          {engagementType && ' You can then create a new contract for the expert.'}
        </ConfirmDialog>
      )}
      {confirm === 'delete' && (
        <ConfirmDialog title="Delete this draft?" confirmLabel="Delete draft" pending={remove.isPending} error={remove.error?.message}
          onConfirm={() => remove.mutate()} onCancel={() => { remove.reset(); setConfirm(null); }}>
          <strong>{c.contract_number}</strong> is deleted. This can't be undone.
        </ConfirmDialog>
      )}
    </main>
  );
}
