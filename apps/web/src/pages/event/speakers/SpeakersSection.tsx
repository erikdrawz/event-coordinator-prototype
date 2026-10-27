import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, FileText, MoreVertical, Plus, Trash2, X } from 'lucide-react';
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
import { ROLES, TEMP_RATE, hcpSub, hours, money, roleLabel, useExperts, useHcps, type Expert, type ExpertRole } from './speakersData';

const ELIGIBILITY = { eligible: 'Eligible', ineligible: 'Not eligible', pending: 'Eligibility in review' } as const;

/** Eligibility as a small mark by the name: green check when eligible, yellow "!" otherwise; the value shows on hover or focus. */
function EligibilityMark({ value }: { value: Expert['eligibility'] }) {
  const ok = value === 'eligible';
  return (
    <span className={`elig-mark ${ok ? 'ok' : 'warn'}`} role="img" tabIndex={0} aria-label={ELIGIBILITY[value]} data-tip={ELIGIBILITY[value]}>
      {ok ? <Check size={10} strokeWidth={3.5} aria-hidden /> : '!'}
    </span>
  );
}
const CHECK_TONE = { passed: 'green', pending: 'yellow', failed: 'red' } as const;
const initialsOf = (n: string) => n.replace(/^(Dr|Prof)\.?\s+/i, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const friendly = (m: string) => (/event_expert_event_id_hcp_id_key/.test(m) ? 'That HCP is already a speaker on this event.' : m);

/**
 * The honorarium grid. Speakers arrive here from the agenda automatically or are added directly.
 * Service hours come from the agenda; prep and travel are typed in the row.
 */
export function SpeakersSection({ eventId }: { eventId: string }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const experts = useExperts(eventId);
  const [adding, setAdding] = useState<number | null>(null);
  const [removing, setRemoving] = useState<Expert | null>(null);
  const canAdd = can(me, 'event_expert', 'create');
  const canEdit = can(me, 'event_expert', 'edit');
  const canDelete = can(me, 'event_expert', 'delete');
  const list = experts.data ?? [];
  const pendingChecks = list.filter((x) => x.check_status === 'pending').length;
  const grand = list.reduce((a, x) => a + x.total_payable, 0);
  const currency = list[0]?.currency ?? 'EUR';

  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Pick<Expert, 'prep_hours' | 'travel_hours' | 'role'>> }) => {
      const { error } = await supabase.from('event_expert').update(patch).eq('id', id);
      if (error) throw new Error(error.message);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: eventKey(eventId) }),
  });
  const remove = useMutation({
    mutationFn: async (x: Expert) => {
      const { error } = await supabase.from('event_expert').delete().eq('id', x.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: eventKey(eventId) }); setRemoving(null); },
  });

  const sub = list.length === 0 ? 'No speakers yet'
    : `${list.length} HCP${list.length === 1 ? '' : 's'}${pendingChecks ? ` · ${pendingChecks} check${pendingChecks === 1 ? '' : 's'} pending` : ''}`;

  return (
    <section className="card ov-card" aria-labelledby="speakers-title">
      <div className="ov-head">
        <div className="ov-title-row"><h2 id="speakers-title" className="ov-title">Speakers</h2><span className="card-sub">{sub}</span></div>
        <div className="ov-actions">
          {canAdd && <button className="btn btn-outline btn-sm" onClick={() => setAdding((n) => (n ?? 0) + 1)} disabled={adding != null}>
            <Plus size={14} strokeWidth={2.6} />Add speaker</button>}
        </div>
      </div>

      {(update.error || experts.error) && <div className="form-error" role="alert">{(update.error ?? experts.error)!.message}</div>}

      {experts.isLoading ? <div className="ov-empty text-muted">Loading…</div> : list.length === 0 && adding == null ? (
        <div className="ov-empty">
          <span><strong>No speakers yet.</strong> Add HCPs here, or add them to agenda sessions and they appear here with their hours.</span>
          {canAdd && <button className="btn btn-primary btn-sm" onClick={() => setAdding(1)}><Plus size={14} strokeWidth={2.6} />Add speaker</button>}
        </div>
      ) : (
        <div className="table-scroll">
          <table className="agenda-table speakers-table">
            <thead>
              <tr>
                <th>HCP</th><th>Role</th><th>Check</th><th>Contract</th>
                <th className="num">Rate / h</th><th className="num">Prep h</th><th className="num">Service h</th><th className="num">Travel h</th>
                <th className="num">Total</th><th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.map((x) => {
                const contract = x.event_expert_contract.map((c) => c.contract).find((c) => c?.contract_type === 'service_agreement') ?? x.event_expert_contract[0]?.contract;
                const name = x.hcp?.display_name ?? 'Unknown HCP';
                return (
                  <tr key={x.id}>
                    <td>
                      <span className="dt-person">
                        <Avatar size={30} initials={initialsOf(name)} color={avatarColorFor(name)} />
                        <span><span className="speaker-name"><span className="agenda-title">{name}</span><EligibilityMark value={x.eligibility} /></span><div className="dt-sub">{hcpSub(x.hcp)}</div></span>
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
                    <td><span className={`pill pill-${CHECK_TONE[x.check_status]}`} title={x.check_notes ?? undefined}>{roleLabel(x.check_status)}</span></td>
                    <td>{contract ? <span className="contract-ref"><FileText size={13} aria-hidden />{contract.contract_number}</span> : <span className="text-muted">—</span>}</td>
                    <td className="num" title="Temporary flat rate until FMV rates are in place">{x.hourly_rate != null ? money(x.hourly_rate, x.currency ?? 'EUR') : '—'}</td>
                    <td className="num"><HoursCell value={x.prep_hours} label={`Prep hours for ${name}`} disabled={!canEdit}
                      onSave={(v) => update.mutate({ id: x.id, patch: { prep_hours: v } })} /></td>
                    <td className="num service-h" title={`From ${x.event_session_speaker.length} agenda session${x.event_session_speaker.length === 1 ? '' : 's'}`}>
                      {hours(x.service_hours)}
                    </td>
                    <td className="num"><HoursCell value={x.travel_hours} label={`Travel hours for ${name}`} disabled={!canEdit}
                      onSave={(v) => update.mutate({ id: x.id, patch: { travel_hours: v } })} /></td>
                    <td className="num total">{x.eligibility === 'ineligible' ? '—' : money(x.total_payable, x.currency ?? 'EUR')}</td>
                    <td className="agenda-menu">
                      {canDelete && (
                        <Menu label={`Actions for ${name}`} width={190}
                          items={[{ key: 'remove', label: 'Remove speaker', icon: <Trash2 size={14} />, danger: true, onSelect: () => setRemoving(x) }]}
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
                <tr><td colSpan={8}>Total payable for this event</td><td className="num total">{money(grand, currency)}</td><td /></tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {list.length > 0 && <p className="field-hint speakers-note">Service hours come from the agenda. Rates are a temporary flat {money(TEMP_RATE)} per hour until FMV rates are in place.</p>}

      {removing && (
        <ConfirmDialog title="Remove speaker?" confirmLabel="Remove speaker" pending={remove.isPending} error={remove.error ? friendly(remove.error.message) : null}
          onConfirm={() => remove.mutate(removing)} onCancel={() => { remove.reset(); setRemoving(null); }}>
          {removing.hcp?.display_name} will be removed from this event's speakers
          {removing.event_session_speaker.length ? ` and from ${removing.event_session_speaker.length} agenda session${removing.event_session_speaker.length === 1 ? '' : 's'}` : ''}.
          {removing.event_expert_contract.length > 0 && ' Their contracts stay on record but are no longer linked to this event.'}
        </ConfirmDialog>
      )}
    </section>
  );
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

const HCP_GROUPS = [{ group: 'hcp' as const, label: 'In Event Coordinator' }];

/** Add an HCP directly: choose who, their type, and prep/travel. Enter saves and opens the next row; Esc cancels. */
function AddSpeakerRow({ eventId, taken, onSaved, onCancel }: { eventId: string; taken: string[]; onSaved: () => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const hcps = useHcps();
  const { me } = useAuth();
  const [who, setWho] = useState<SpeakerOption | null>(null);
  const hcpId = who?.hcp_id ?? '';
  const [role, setRole] = useState<ExpertRole>('speaker');
  const [prep, setPrep] = useState('');
  const [travel, setTravel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const options = (hcps.data ?? []).filter((h) => !taken.includes(h.id)).map((h): SpeakerOption => ({
    key: `h:${h.id}`, hcp_id: h.id, name: h.display_name, sub: hcpSub(h), initials: initials(h.display_name), color: null, group: 'hcp' }));

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('event_expert').insert({
        event_id: eventId, hcp_id: hcpId, role, prep_hours: Number(prep.replace(',', '.')) || 0, travel_hours: Number(travel.replace(',', '.')) || 0,
      });
      if (error) throw new Error(friendly(error.message));
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: eventKey(eventId) }); onSaved(); },
    onError: (e) => setError(e.message),
  });
  const submit = () => { if (!hcpId) { setError('Choose an HCP'); return; } setError(null); save.mutate(); };
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
            <PersonPicker label="Choose an HCP" options={options} groups={HCP_GROUPS} canSearchCrm={can(me, 'hcp', 'create')} autoOpen
              onPick={(o) => { setWho(o); setError(null); }}
              trigger={(t) => (
                <button type="button" className="input sel-trigger picker-field" aria-label="HCP" aria-invalid={error === 'Choose an HCP' || undefined} {...t}>
                  <span className={who ? 'sel-value' : 'sel-value placeholder'}>{who?.name ?? 'Choose an HCP…'}</span><ChevronDown size={15} className="sel-chevron" aria-hidden />
                </button>
              )} />
            <Select aria-label="Role" value={role} onChange={(v) => setRole(v as ExpertRole)} options={ROLES.map((r) => ({ value: r, label: roleLabel(r) }))} />
          </div>
        </td>
        <td colSpan={2}><span className="dt-sub">Checks and contracts follow once added</span></td>
        <td className="num">{money(TEMP_RATE)}</td>
        <td className="num"><input className="hours-input" inputMode="decimal" aria-label="Prep hours" placeholder="0.0" value={prep} onChange={(e) => setPrep(e.target.value)} /></td>
        <td className="num service-h" title="Comes from the agenda">0.0</td>
        <td className="num"><input className="hours-input" inputMode="decimal" aria-label="Travel hours" placeholder="0.0" value={travel} onChange={(e) => setTravel(e.target.value)} /></td>
        <td />
        <td className="agenda-inline-actions">
          <button type="button" className="icon-btn ok" aria-label="Add speaker" title="Add (Enter)" disabled={save.isPending} onClick={submit}><Check size={16} /></button>
          <button type="button" className="icon-btn" aria-label="Cancel" title="Cancel (Esc)" onClick={onCancel}><X size={16} /></button>
        </td>
      </tr>
      <tr className="agenda-inline-note">
        <td colSpan={10}>{error ? <span className="field-error" role="alert">{error}</span>
          : <span className="field-hint">Search Event Coordinator, then the CRMs if they're not there · Enter adds and starts the next · Esc cancels</span>}</td>
      </tr>
    </>
  );
}
