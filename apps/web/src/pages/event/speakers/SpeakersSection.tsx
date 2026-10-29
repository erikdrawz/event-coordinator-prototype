import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useEventAccess } from '../eventAccess';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Check, ChevronDown, FilePlus2, FileSignature, MoreVertical, Plus, Trash2, X } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../lib/auth';
import { can } from '../../../lib/permissions';
import { avatarColorFor } from '../../../lib/avatar';
import { Avatar } from '../../../components/Avatar';
import { Select } from '../../../ui/Select';
import { Menu } from '../../../ui/Menu';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { eventKey, initials, type SpeakerOption } from '../agenda/agendaData';
import { PersonPicker } from '../people/PersonPicker';
import { NewContractModal } from '../../contracts/NewContractModal';
import { ContractStatusPill } from '../../contracts/ContractStatusPill';
import '../../contracts/contracts.css';
import { RequestFormModal } from '../../requests/RequestFormModal';
import { RequestStatusPill } from '../../requests/RequestStatusPill';
import {
  ROLES, currencySymbol, hcpSub, hours, mainContract, money, rateRange, roleLabel, useEventTieringRequests, useExperts, useHcps, useRatePolicies, useRatePolicy, type Expert, type ExpertRole, type RatePolicy,
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
const initialsOf = (n: string) => n.replace(/^(Dr|Prof)\.?\s+/i, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const friendly = (m: string) => (/event_expert_event_id_hcp_id_key/.test(m) ? 'That expert is already on this event.' : m);

/**
 * The event's experts (speakers, chairs, advisors, …) and their honoraria. Experts arrive here from
 * the agenda automatically or are added directly. Service hours come from the agenda; prep and
 * travel are typed in the row; the rate defaults from the expert's FMV record.
 */
export function SpeakersSection({ eventId, eventName }: { eventId: string; eventName: string }) {
  const { me } = useAuth();
  const navigate = useNavigate();
  const { canEdit: canEditEvent } = useEventAccess();
  const qc = useQueryClient();
  const experts = useExperts(eventId);
  const [adding, setAdding] = useState<number | null>(null);
  const [removing, setRemoving] = useState<Expert | null>(null);
  const [contracting, setContracting] = useState<{ x: Expert; addendum: boolean } | null>(null);
  const [tiering, setTiering] = useState<Expert | null>(null);
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

  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Pick<Expert, 'prep_hours' | 'travel_hours' | 'hourly_rate' | 'role'>> }) => {
      const { error } = await supabase.from('event_expert').update(patch).eq('id', id);
      if (error) throw new Error(error.message);
    },
    onMutate: () => setCellError(null),
    onSettled: () => qc.invalidateQueries({ queryKey: eventKey(eventId) }),
  });
  const remove = useMutation({
    mutationFn: async (x: Expert) => {
      const { error } = await supabase.from('event_expert').delete().eq('id', x.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: eventKey(eventId) }); setRemoving(null); },
  });

  const sub = list.length === 0 ? 'No experts yet'
    : `${list.length} expert${list.length === 1 ? '' : 's'}`;

  return (
    <section className="card ov-card" aria-labelledby="speakers-title">
      <div className="ov-head">
        <div className="ov-title-row"><h2 id="speakers-title" className="ov-title">Experts</h2><span className="card-sub">{sub}</span></div>
        <div className="ov-actions">
          {canAdd && <button className="btn btn-outline btn-sm" onClick={() => setAdding((n) => (n ?? 0) + 1)} disabled={adding != null}>
            <Plus size={14} strokeWidth={2.6} />Add expert</button>}
        </div>
      </div>

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
                <th>Expert</th><th>Role</th><th>Contract</th>
                <th className="num">Rate / h</th><th className="num">Prep h</th><th className="num">Service h</th><th className="num">Travel h</th>
                <th className="num">Total</th><th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.map((x) => {
                const { main, addenda } = mainContract(x);
                const name = x.hcp?.display_name ?? 'Unknown HCP';
                const tier = x.eligibility !== 'eligible' ? tieringRequests?.get(x.hcp_id) : undefined;
                const menu = [
                  ...(x.eligibility !== 'eligible' && tier ? [{ key: 'tiering', label: `View tiering request ${tier.request_number}`, icon: <BadgeCheck size={14} />, onSelect: () => navigate(`/requests/${tier.id}`) }]
                    : x.eligibility !== 'eligible' && canRequestTiering ? [{ key: 'tiering', label: 'Log tiering request', icon: <BadgeCheck size={14} />, onSelect: () => setTiering(x) }] : []),
                  ...(canContract && !main && x.eligibility === 'eligible' ? [{ key: 'contract', label: 'Add contract', icon: <FileSignature size={14} />, onSelect: () => setContracting({ x, addendum: false }) }] : []),
                  ...(canContract && main ? [{ key: 'addendum', label: 'Add addendum', icon: <FilePlus2 size={14} />, onSelect: () => setContracting({ x, addendum: true }) }] : []),
                  ...(canDelete ? [{ key: 'remove', label: 'Remove expert', icon: <Trash2 size={14} />, danger: true, onSelect: () => setRemoving(x) }] : []),
                ];
                return (
                  <tr key={x.id}>
                    <td>
                      <span className="dt-person">
                        <Avatar size={30} initials={initialsOf(name)} color={avatarColorFor(name)} />
                        <span><span className="speaker-name"><Link to={`/experts/${x.hcp_id}`} className="agenda-title expert-link">{name}</Link><EligibilityMark value={x.eligibility} /></span><div className="dt-sub">{hcpSub(x.hcp)}</div></span>
                      </span>
                    </td>
                    <td>
                      {canEdit ? (
                        <div className="cell-select">
                          <Select aria-label={`Role for ${name}`} value={x.role} onChange={(v) => update.mutate({ id: x.id, patch: { role: v as ExpertRole } })}
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
                      ) : tier ? (
                        <span className="contract-cell">
                          <Link to={`/requests/${tier.id}`} data-tip={`Tiering request ${tier.request_number}`}>View request</Link>
                          <span className="tiering-status"><RequestStatusPill status={tier.status as 'draft'} /></span>
                        </span>
                      ) : canContract && x.eligibility === 'eligible'
                        ? <button type="button" className="link" onClick={() => setContracting({ x, addendum: false })}>Add contract</button>
                        : x.eligibility !== 'eligible' && canRequestTiering
                          ? <button type="button" className="link" data-tip="Only eligible experts can be contracted" onClick={() => setTiering(x)}>Request tiering</button>
                          : <span className="text-muted" data-tip={x.eligibility === 'eligible' ? undefined : 'Only eligible experts can be contracted'}>—</span>}
                    </td>
                    <td className="num"><RateCell value={x.hourly_rate} currency={x.currency ?? 'EUR'} policy={policies?.[x.hcp_id]} label={`Hourly rate for ${name}`} disabled={!canEdit}
                      onInvalid={setCellError} onSave={(v) => update.mutate({ id: x.id, patch: { hourly_rate: v } })} /></td>
                    <td className="num"><HoursCell value={x.prep_hours} label={`Prep hours for ${name}`} disabled={!canEdit}
                      onSave={(v) => update.mutate({ id: x.id, patch: { prep_hours: v } })} /></td>
                    <td className="num"><ServiceHours value={x.service_hours} sessions={x.event_session_speaker.length} /></td>
                    <td className="num"><HoursCell value={x.travel_hours} label={`Travel hours for ${name}`} disabled={!canEdit}
                      onSave={(v) => update.mutate({ id: x.id, patch: { travel_hours: v } })} /></td>
                    <td className="num total">{x.eligibility === 'ineligible' ? '—' : money(x.total_payable, x.currency ?? 'EUR')}</td>
                    <td className="agenda-menu">
                      {menu.length > 0 && (
                        <Menu label={`Actions for ${name}`} width={190}
                          items={menu}
                          trigger={(t) => <button className="icon-btn" aria-label={`Actions for ${name}`} {...t}><MoreVertical size={16} /></button>} />
                      )}
                    </td>
                  </tr>
                );
              })}
              {adding != null && (
                <AddSpeakerRow key={adding} eventId={eventId} taken={list.map((x) => x.hcp_id)}
                  onSaved={() => setAdding((n) => (n ?? 0) + 1)} onCancel={() => setAdding(null)} />
              )}
            </tbody>
            {list.length > 0 && (
              <tfoot>
                <tr><td colSpan={7}>Total payable for this event</td><td className="num total">{money(grand, currency)}</td><td /></tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {list.length > 0 && <p className="field-hint speakers-note">Boxed values can be edited. Service hours come from the agenda. Rates default from each expert's FMV record and can be negotiated within its range (hover a rate to see it); without one the rate is €0.</p>}

      {removing && (
        <ConfirmDialog title="Remove expert?" confirmLabel="Remove expert" pending={remove.isPending} error={remove.error ? friendly(remove.error.message) : null}
          onConfirm={() => remove.mutate(removing)} onCancel={() => { remove.reset(); setRemoving(null); }}>
          {removing.hcp?.display_name} will be removed from this event's experts
          {removing.event_session_speaker.length ? ` and from ${removing.event_session_speaker.length} agenda session${removing.event_session_speaker.length === 1 ? '' : 's'}` : ''}.
          {removing.contract.some((c) => c.status === 'draft') && ' Their draft contracts are deleted with them.'}
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

const rateProblem = (v: number, p: RatePolicy) =>
  Number.isNaN(v) ? 'Enter the rate as a number'
    : p.source === 'none' && v !== 0 ? "This expert has no FMV rate for the event's date. Record one on their expert page to set a rate"
    : p.mode === 'fixed' && v !== p.default ? `The rate is fixed at ${money(p.default, p.currency)} per hour`
      : v < p.min || v > p.max ? `The rate must be between ${money(p.min, p.currency)} and ${money(p.max, p.currency)} per hour` : null;

/** The hourly rate, editable within the rate policy; an out-of-range value is refused and put back. */
function RateCell({ value, currency, policy, onSave, onInvalid, label, disabled }: {
  value: number | null; currency: string; policy: RatePolicy | undefined; onSave: (v: number) => void; onInvalid: (m: string) => void; label: string; disabled?: boolean;
}) {
  const shown = value == null ? '' : String(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  if (disabled || policy?.mode === 'fixed') {
    const tip = policy?.source === 'none' ? rateRange(policy) : undefined;
    return <span data-tip={tip} tabIndex={tip ? 0 : undefined}>{value != null ? money(value, currency) : '—'}</span>;
  }
  const commit = () => {
    if (text.trim() === '') { setText(shown); return; }
    const v = Math.round(Number(text.replace(',', '.')) * 100) / 100;
    const bad = policy ? rateProblem(v, policy) : null;
    if (bad) { onInvalid(bad); setText(shown); return; }
    setText(String(v));
    if (v !== value) onSave(v);
  };
  return (
    <span className="money-input" data-tip={policy ? rateRange(policy) : undefined}>
      <span aria-hidden>{currencySymbol(currency)}</span>
      <input className="hours-input" inputMode="decimal" aria-label={label} value={text}
        onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } if (e.key === 'Escape') setText(shown); }} />
    </span>
  );
}

/** Read-only: service hours come from the agenda. */
function ServiceHours({ value, sessions }: { value: number; sessions: number }) {
  const tip = sessions ? `From the agenda: ${sessions} session${sessions === 1 ? '' : 's'}` : 'From the agenda';
  return <span className="service-h" tabIndex={0} data-tip={tip} aria-label={`${hours(value)} service hours, ${tip.toLowerCase()}`}>{hours(value)}</span>;
}

/** An hours figure typed straight into the grid; saves on Enter or when leaving the field. */
function HoursCell({ value, onSave, label, disabled }: { value: number; onSave: (v: number) => void; label: string; disabled?: boolean }) {
  const [text, setText] = useState(hours(value));
  useEffect(() => setText(hours(value)), [value]);
  if (disabled) return <>{hours(value)}</>;
  const commit = () => {
    const v = text.trim() === '' ? 0 : Number(text.replace(',', '.'));
    if (Number.isNaN(v) || v < 0) { setText(hours(value)); return; }
    const rounded = Math.round(v * 100) / 100;
    setText(hours(rounded));
    if (rounded !== value) onSave(rounded);
  };
  return (
    <input className="hours-input" inputMode="decimal" aria-label={label} value={text}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } if (e.key === 'Escape') { setText(hours(value)); } }} />
  );
}

const HCP_GROUPS = [{ group: 'hcp' as const, label: 'In Event Center' }];

/** Add an expert directly: choose who, their role, and prep/travel; the rate defaults from their FMV. Enter saves and opens the next row; Esc cancels. */
function AddSpeakerRow({ eventId, taken, onSaved, onCancel }: { eventId: string; taken: string[]; onSaved: () => void; onCancel: () => void }) {
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
