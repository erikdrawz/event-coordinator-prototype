import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useEventAccess } from '../eventAccess';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Check, ChevronDown, FilePlus2, FileSignature, MoreVertical, PanelRight, Plus, Trash2, X } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../lib/auth';
import { can } from '../../../lib/permissions';
import { avatarColorFor } from '../../../lib/avatar';
import { Avatar } from '../../../components/Avatar';
import { Select } from '../../../ui/Select';
import { Menu } from '../../../ui/Menu';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { BulkBar, SelectAllCell, SelectRowCell, isRowClick, useRowSelection } from '../../../ui/BulkSelect';
import { eventKey, initials, type SpeakerOption } from '../agenda/agendaData';
import { PersonPicker } from '../people/PersonPicker';
import { NewContractModal } from '../../contracts/NewContractModal';
import { ContractStatusPill } from '../../contracts/ContractStatusPill';
import '../../contracts/contracts.css';
import { RequestFormModal } from '../../requests/RequestFormModal';
import { RequestStatusPill } from '../../requests/RequestStatusPill';
import { HoursCell, RateCell, ServiceHours, rateProblem } from './speakerCells';
import { ExpertPanel, expertInitials } from './ExpertPanel';
import {
  ROLES, currencySymbol, hcpSub, isOpenRequest, keepsWithoutSessions, mainContract, money, rateRange, roleLabel, useEventTieringRequests, useExperts, useHcps, useRatePolicies, useRatePolicy, type Expert, type ExpertRole,
} from './speakersData';

const ELIGIBILITY = { eligible: 'Eligible', ineligible: 'Not eligible', pending: 'Eligibility pending' } as const;

/** Eligibility as a small mark by the name: green check when eligible, yellow "!" otherwise; the value shows on hover or focus. */
function EligibilityMark({ value }: { value: Expert['eligibility'] }) {
  const ok = value === 'eligible';
  return (
    <span className={`elig-mark ${ok ? 'ok' : 'warn'}`} role="img" tabIndex={0} aria-label={ELIGIBILITY[value]} data-tip={ELIGIBILITY[value]}>
      {ok ? <Check size={10} strokeWidth={3.5} aria-hidden /> : '!'}
    </span>
  );
}
const plural = (n: number) => `${n} expert${n === 1 ? '' : 's'}`;
const friendly = (m: string) => (/event_expert_event_id_hcp_id_key/.test(m) ? 'That expert is already on this event.' : m);

/**
 * The event's experts (speakers, chairs, advisors, …) and their honoraria. Experts arrive here from
 * the agenda automatically or are added directly. Service hours come from the agenda; prep and
 * travel are typed in the row; the rate defaults from the expert's FMV record. Clicking a row opens
 * the expert in a side panel with every detail; ticking rows offers bulk changes.
 */
export function SpeakersSection({ eventId, eventName, timezone }: { eventId: string; eventName: string; timezone: string }) {
  const { me } = useAuth();
  const navigate = useNavigate();
  const { canEdit: canEditEvent } = useEventAccess();
  const qc = useQueryClient();
  const experts = useExperts(eventId);
  const [adding, setAdding] = useState<number | null>(null);
  const [removing, setRemoving] = useState<Expert[] | null>(null);
  const [contracting, setContracting] = useState<{ x: Expert; addendum: boolean } | null>(null);
  const [tiering, setTiering] = useState<Expert | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const tieringRequests = useEventTieringRequests(eventId).data;
  const [cellError, setCellError] = useState<string | null>(null);
  const policies = useRatePolicies(eventId).data;
  const canAdd = can(me, 'event_expert', 'create') && canEditEvent;
  const canEdit = can(me, 'event_expert', 'edit') && canEditEvent;
  const canDelete = can(me, 'event_expert', 'delete') && canEditEvent;
  const canContract = can(me, 'contract', 'create') && canEditEvent;
  const canRequestTiering = can(me, 'event_request', 'create');
  const list = experts.data ?? [];
  const grand = list.reduce((a, x) => a + x.total_payable, 0);
  const currency = list[0]?.currency ?? 'EUR';
  const selection = useRowSelection(list.map((x) => x.id));
  const canSelect = canEdit || canDelete;
  const open = list.find((x) => x.id === openId) ?? null;
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(null), 6000); return () => clearTimeout(t); }, [notice]);

  const update = useMutation({
    mutationFn: async ({ ids, patch }: { ids: string[]; patch: Partial<Pick<Expert, 'prep_hours' | 'travel_hours' | 'hourly_rate' | 'role'>> }) => {
      const { data, error } = await supabase.from('event_expert').update(patch).in('id', ids).select('id');
      if (error) throw new Error(error.message);
      return data.length;
    },
    onMutate: () => setCellError(null),
    onSuccess: (n, { ids }) => { if (ids.length > 1) setNotice(n === ids.length ? `${plural(n)} updated` : `${plural(n)} updated; ${ids.length - n} you can't edit were left as they were`); },
    onSettled: () => qc.invalidateQueries({ queryKey: eventKey(eventId) }),
  });
  const setOne = (id: string) => (patch: Partial<Pick<Expert, 'prep_hours' | 'travel_hours' | 'hourly_rate' | 'role'>>) => update.mutate({ ids: [id], patch });
  // Experts with a contract out for signature or signed stay (the database refuses them); the rest go in one call
  const remove = useMutation({
    mutationFn: async (rows: Expert[]) => {
      const go = rows.filter((x) => !keepsWithoutSessions(x));
      if (go.length === 0) throw new Error(rows.length === 1
        ? `${rows[0].hcp?.display_name ?? 'This expert'} has a contract that is out for signature or signed. Cancel it before removing them from the event.`
        : 'Each of them has a contract that is out for signature or signed, so none were removed.');
      const { data, error } = await supabase.from('event_expert').delete().in('id', go.map((x) => x.id)).select('id');
      if (error) throw new Error(error.message);
      return { removed: data.length, kept: rows.length - go.length };
    },
    onSuccess: ({ removed, kept }, rows) => {
      if (rows.some((x) => x.id === openId)) setOpenId(null);
      if (rows.length > 1) setNotice(`${plural(removed)} removed${kept ? `; ${kept} with a sent or signed contract stayed` : ''}`);
      qc.invalidateQueries({ queryKey: eventKey(eventId) }); setRemoving(null);
    },
  });

  const sub = list.length === 0 ? 'No experts yet'
    : `${list.length} expert${list.length === 1 ? '' : 's'}`;
  const ticked = list.filter((x) => selection.has(x.id));
  const sessionsOf = (rows: Expert[]) => rows.reduce((n, x) => n + x.event_session_speaker.length, 0);

  return (
    <section className="card ov-card" aria-labelledby="speakers-title">
      {selection.some ? (
        <BulkBar selection={selection} noun={['expert', 'experts']} notice={notice}>
          {canEdit && (
            <Menu label="Set the role of the selected experts" width={180}
              items={ROLES.map((r) => ({ key: r, label: roleLabel(r), onSelect: () => update.mutate({ ids: [...selection.selected], patch: { role: r } }) }))}
              trigger={(t) => <button type="button" className="btn btn-sm" {...t}>Role<ChevronDown size={14} aria-hidden /></button>} />
          )}
          {canDelete && <button type="button" className="btn btn-sm btn-danger-outline" onClick={() => setRemoving(ticked)}><Trash2 size={14} />Remove</button>}
        </BulkBar>
      ) : (
        <div className="ov-head">
          <div className="ov-title-row"><h2 id="speakers-title" className="ov-title">Experts</h2><span className="card-sub">{sub}</span></div>
          <div className="ov-actions">
            {notice && <span className="bs-notice" role="status">{notice}</span>}
            {canAdd && <button className="btn btn-outline btn-sm" onClick={() => setAdding((n) => (n ?? 0) + 1)} disabled={adding != null}>
              <Plus size={14} strokeWidth={2.6} />Add expert</button>}
          </div>
        </div>
      )}

      {(cellError || update.error || experts.error) && <div className="form-error" role="alert">{cellError ?? (update.error ?? experts.error)!.message}</div>}

      {experts.isLoading ? <div className="ov-empty text-muted">Loading…</div> : list.length === 0 && adding == null ? (
        <div className="ov-empty">
          <span><strong>No experts yet.</strong> Add them here, or add speakers to agenda sessions and they appear here with their hours.</span>
          {canAdd && <button className="btn btn-primary btn-sm" onClick={() => setAdding(1)}><Plus size={14} strokeWidth={2.6} />Add expert</button>}
        </div>
      ) : (
        <div className="table-scroll">
          <table className="agenda-table speakers-table">
            <thead>
              <tr>
                {canSelect && <SelectAllCell selection={selection} label="Select all experts" />}
                <th>Expert</th><th>Role</th><th>Contract</th>
                <th className="num">Rate / h</th><th className="num">Prep h</th><th className="num">Service h</th><th className="num">Travel h</th>
                <th className="num">Total</th><th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.map((x) => {
                const { main, addenda } = mainContract(x);
                const name = x.hcp?.display_name ?? 'Unknown HCP';
                // The Contract column shows a tiering request only while it waits on a decision; the menu keeps the latest one
                const tier = tieringRequests?.get(x.hcp_id);
                const openTier = x.eligibility !== 'eligible' && isOpenRequest(tier) ? tier : undefined;
                const menu = [
                  { key: 'details', label: 'Show details', icon: <PanelRight size={14} />, onSelect: () => setOpenId(x.id) },
                  ...(tier ? [{ key: 'tiering', label: `View tiering request ${tier.request_number}`, icon: <BadgeCheck size={14} />, onSelect: () => navigate(`/requests/${tier.id}`) }] : []),
                  ...(x.eligibility !== 'eligible' && !openTier && canRequestTiering ? [{ key: 'log-tiering', label: 'Log tiering request', icon: <BadgeCheck size={14} />, onSelect: () => setTiering(x) }] : []),
                  ...(canContract && !main && x.eligibility === 'eligible' ? [{ key: 'contract', label: 'Add contract', icon: <FileSignature size={14} />, onSelect: () => setContracting({ x, addendum: false }) }] : []),
                  ...(canContract && main ? [{ key: 'addendum', label: 'Add addendum', icon: <FilePlus2 size={14} />, onSelect: () => setContracting({ x, addendum: true }) }] : []),
                  ...(canDelete ? [{ key: 'remove', label: 'Remove expert', icon: <Trash2 size={14} />, danger: true, onSelect: () => setRemoving([x]) }] : []),
                ];
                const cls = ['row-openable', x.id === openId && 'is-open', selection.has(x.id) && 'is-selected'].filter(Boolean).join(' ');
                return (
                  <tr key={x.id} className={cls} tabIndex={0}
                    onClick={(e) => { if (isRowClick(e)) setOpenId(x.id); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) setOpenId(x.id); }}>
                    {canSelect && <SelectRowCell selection={selection} id={x.id} label={`Select ${name}`} />}
                    <td>
                      <span className="dt-person">
                        <Avatar size={30} initials={expertInitials(name)} color={avatarColorFor(name)} />
                        <span><span className="speaker-name"><Link to={`/experts/${x.hcp_id}`} className="agenda-title expert-link">{name}</Link><EligibilityMark value={x.eligibility} /></span><div className="dt-sub">{hcpSub(x.hcp)}</div></span>
                      </span>
                    </td>
                    <td>
                      {canEdit ? (
                        <div className="cell-select">
                          <Select aria-label={`Role for ${name}`} value={x.role} onChange={(v) => setOne(x.id)({ role: v as ExpertRole })}
                            options={ROLES.map((r) => ({ value: r, label: roleLabel(r) }))} />
                        </div>
                      ) : roleLabel(x.role)}
                    </td>
                    <td>
                      {main ? (
                        <span className="contract-cell">
                          <Link to={`/contracts/${main.id}`} data-tip={main.contract_number}>View contract</Link>
                          <ContractStatusPill status={main.status as 'draft'} small />
                          {addenda.length > 0 && <span className="dt-sub">+{addenda.length} addend{addenda.length === 1 ? 'um' : 'a'}</span>}
                        </span>
                      ) : openTier ? (
                        <span className="contract-cell">
                          <Link to={`/requests/${openTier.id}`} data-tip={`Tiering request ${openTier.request_number}`}>View request</Link>
                          <span className="tiering-status"><RequestStatusPill status={openTier.status as 'draft'} /></span>
                        </span>
                      ) : canContract && x.eligibility === 'eligible'
                        ? <button type="button" className="link" onClick={() => setContracting({ x, addendum: false })}>Add contract</button>
                        : x.eligibility !== 'eligible' && canRequestTiering
                          ? <button type="button" className="link" data-tip="Only eligible experts can be contracted" onClick={() => setTiering(x)}>Request tiering</button>
                          : <span className="text-muted" data-tip={x.eligibility === 'eligible' ? undefined : 'Only eligible experts can be contracted'}>—</span>}
                    </td>
                    <td className="num"><RateCell value={x.hourly_rate} currency={x.currency ?? 'EUR'} policy={policies?.[x.hcp_id]} label={`Hourly rate for ${name}`} disabled={!canEdit}
                      onInvalid={setCellError} onSave={(v) => setOne(x.id)({ hourly_rate: v })} /></td>
                    <td className="num"><HoursCell value={x.prep_hours} label={`Prep hours for ${name}`} disabled={!canEdit}
                      onSave={(v) => setOne(x.id)({ prep_hours: v })} /></td>
                    <td className="num"><ServiceHours value={x.service_hours} sessions={x.event_session_speaker.length} /></td>
                    <td className="num"><HoursCell value={x.travel_hours} label={`Travel hours for ${name}`} disabled={!canEdit}
                      onSave={(v) => setOne(x.id)({ travel_hours: v })} /></td>
                    <td className="num total">{x.eligibility === 'ineligible' ? '—' : money(x.total_payable, x.currency ?? 'EUR')}</td>
                    <td className="agenda-menu">
                      <Menu label={`Actions for ${name}`} width={280}
                        items={menu}
                        trigger={(t) => <button className="icon-btn" aria-label={`Actions for ${name}`} {...t}><MoreVertical size={16} /></button>} />
                    </td>
                  </tr>
                );
              })}
              {adding != null && (
                <AddSpeakerRow key={adding} eventId={eventId} taken={list.map((x) => x.hcp_id)} withSelect={canSelect}
                  onSaved={() => setAdding((n) => (n ?? 0) + 1)} onCancel={() => setAdding(null)} />
              )}
            </tbody>
            {list.length > 0 && (
              <tfoot>
                <tr><td colSpan={canSelect ? 8 : 7}>Total payable for this event</td><td className="num total">{money(grand, currency)}</td><td /></tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {list.length > 0 && <p className="field-hint speakers-note">Boxed values can be edited. Service hours come from the agenda. Rates default from each expert's FMV record and can be negotiated within its range (hover a rate to see it); without one the rate is €0. Click a row for every detail{canSelect ? '; tick rows to change several at once' : ''}.</p>}

      {open && (
        <ExpertPanel x={open} timezone={timezone} policy={policies?.[open.hcp_id]} tier={tieringRequests?.get(open.hcp_id)}
          canEdit={canEdit} canContract={canContract} canDelete={canDelete} canRequestTiering={canRequestTiering}
          onChange={setOne(open.id)} onInvalid={setCellError} onContract={(addendum) => setContracting({ x: open, addendum })}
          onTiering={() => setTiering(open)} onRemove={() => setRemoving([open])} onClose={() => setOpenId(null)} />
      )}
      {removing && (
        <ConfirmDialog title={removing.length === 1 ? 'Remove expert?' : `Remove ${plural(removing.length)}?`} confirmLabel={removing.length === 1 ? 'Remove expert' : 'Remove experts'}
          pending={remove.isPending} error={remove.error ? friendly(remove.error.message) : null}
          onConfirm={() => remove.mutate(removing)} onCancel={() => { remove.reset(); setRemoving(null); }}>
          {removing.length === 1 ? removing[0].hcp?.display_name : plural(removing.length)} will be removed from this event's experts
          {sessionsOf(removing) ? ` and from ${sessionsOf(removing)} agenda session${sessionsOf(removing) === 1 ? '' : 's'}` : ''}.
          {removing.some((x) => x.contract.some((c) => c.status === 'draft')) && ' Draft contracts are deleted with them.'}
          {' '}They stay on the attendee list, so their attendance and spend are kept.
          {removing.length > 1 && removing.some(keepsWithoutSessions) && ` ${removing.filter(keepsWithoutSessions).length} with a contract out for signature or signed will stay.`}
        </ConfirmDialog>
      )}
      {tiering && (
        <RequestFormModal onClose={() => setTiering(null)}
          tiering={{ hcp: { id: tiering.hcp_id, name: tiering.hcp?.display_name ?? 'This expert' }, event: { id: eventId, name: eventName } }} />
      )}
      {contracting && (
        <NewContractModal onClose={() => setContracting(null)} target={{
          kind: 'engagement', addendum: contracting.addendum, eventExpertId: contracting.x.id, eventId, hcpId: contracting.x.hcp_id,
          name: contracting.x.hcp?.display_name ?? 'This expert',
          honorarium: { total: contracting.x.total_payable, currency: contracting.x.currency ?? 'EUR', rate: contracting.x.hourly_rate,
            prep: contracting.x.prep_hours, service: contracting.x.service_hours, travel: contracting.x.travel_hours },
        }} />
      )}
    </section>
  );
}

const HCP_GROUPS = [{ group: 'hcp' as const, label: 'In Event Center' }];

/** Add an expert directly: choose who, their role, and prep/travel; the rate defaults from their FMV. Enter saves and opens the next row; Esc cancels. */
function AddSpeakerRow({ eventId, taken, withSelect, onSaved, onCancel }: { eventId: string; taken: string[]; withSelect: boolean; onSaved: () => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const hcps = useHcps();
  const { me } = useAuth();
  const [who, setWho] = useState<SpeakerOption | null>(null);
  const hcpId = who?.hcp_id ?? '';
  const [role, setRole] = useState<ExpertRole>('speaker');
  const policy = useRatePolicy(hcpId || undefined, eventId).data;
  const [rate, setRate] = useState('');
  const [prep, setPrep] = useState('');
  const [travel, setTravel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const options = (hcps.data ?? []).filter((h) => !taken.includes(h.id)).map((h): SpeakerOption => ({
    key: `h:${h.id}`, hcp_id: h.id, name: h.display_name, sub: hcpSub(h), initials: initials(h.display_name), color: null, group: 'hcp' }));

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('event_expert').insert({
        event_id: eventId, hcp_id: hcpId, role, ...(rate.trim() && policy?.source !== 'none' ? { hourly_rate: Number(rate.replace(',', '.')) } : {}), prep_hours: Number(prep.replace(',', '.')) || 0, travel_hours: Number(travel.replace(',', '.')) || 0,
      });
      if (error) throw new Error(friendly(error.message));
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: eventKey(eventId) }); onSaved(); },
    onError: (e) => setError(e.message),
  });
  const submit = () => {
    if (!hcpId) { setError('Choose an expert'); return; }
    const r = rate.trim() && policy?.source !== 'none' ? Number(rate.replace(',', '.')) : null;
    const bad = r != null && policy ? rateProblem(r, policy) : null;
    if (bad) { setError(bad); return; }
    setError(null); save.mutate();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };

  return (
    <>
      <tr className="agenda-inline" onKeyDown={onKey}>
        {withSelect && <td />}
        <td colSpan={2}>
          <div className="speaker-add-who">
            <PersonPicker label="Choose an expert" options={options} groups={HCP_GROUPS} canSearchCrm={can(me, 'hcp', 'create')} autoOpen
              onPick={(o) => { setWho(o); setError(null); }}
              trigger={(t) => (
                <button type="button" className="input sel-trigger picker-field" aria-label="Expert" aria-invalid={error === 'Choose an expert' || undefined} {...t}>
                  <span className={who ? 'sel-value' : 'sel-value placeholder'}>{who?.name ?? 'Choose an expert…'}</span><ChevronDown size={15} className="sel-chevron" aria-hidden />
                </button>
              )} />
            <Select aria-label="Role" value={role} onChange={(v) => setRole(v as ExpertRole)} options={ROLES.map((r) => ({ value: r, label: roleLabel(r) }))} />
          </div>
        </td>
        <td><span className="dt-sub">Contracts follow once added</span></td>
        <td className="num">
          {policy?.source === 'none' ? <span data-tip={rateRange(policy)} tabIndex={0}>{money(0, policy.currency)}</span> : (
          <span className="money-input" data-tip={policy ? rateRange(policy) : undefined}><span aria-hidden>{currencySymbol(policy?.currency)}</span>
            <input className="hours-input" inputMode="decimal" aria-label="Hourly rate" placeholder={policy ? String(policy.default) : ''} value={rate}
              aria-invalid={Boolean(error && error.startsWith('The rate')) || undefined} onChange={(e) => setRate(e.target.value)} /></span>)}
        </td>
        <td className="num"><input className="hours-input" inputMode="decimal" aria-label="Prep hours" placeholder="0.0" value={prep} onChange={(e) => setPrep(e.target.value)} /></td>
        <td className="num"><ServiceHours value={0} sessions={0} /></td>
        <td className="num"><input className="hours-input" inputMode="decimal" aria-label="Travel hours" placeholder="0.0" value={travel} onChange={(e) => setTravel(e.target.value)} /></td>
        <td />
        <td className="agenda-inline-actions">
          <button type="button" className="icon-btn ok" aria-label="Add expert" title="Add (Enter)" disabled={save.isPending} onClick={submit}><Check size={16} /></button>
          <button type="button" className="icon-btn" aria-label="Cancel" title="Cancel (Esc)" onClick={onCancel}><X size={16} /></button>
        </td>
      </tr>
      <tr className="agenda-inline-note">
        <td colSpan={9}>{error ? <span className="field-error" role="alert">{error}</span>
          : <span className="field-hint">Search Event Center, then the CRMs if they're not there · Enter adds and starts the next · Esc cancels</span>}</td>
      </tr>
    </>
  );
}
