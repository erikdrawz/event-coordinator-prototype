import { Link } from 'react-router-dom';
import { BadgeCheck, FilePlus2, FileSignature, Trash2, UserRound } from 'lucide-react';
import { avatarColorFor } from '../../../lib/avatar';
import { Avatar } from '../../../components/Avatar';
import { PanelField, PanelSection, SidePanel } from '../../../ui/SidePanel';
import { Select } from '../../../ui/Select';
import { ContractStatusPill } from '../../contracts/ContractStatusPill';
import { useTypeLabel } from '../../contracts/contractsData';
import { RequestStatusPill } from '../../requests/RequestStatusPill';
import { EligibilityPill } from '../../experts/EligibilityPill';
import { HoursCell, RateCell } from './speakerCells';
import { ROLES, hcpSub, hours, mainContract, money, rateRange, roleLabel, type Expert, type ExpertRole, type RatePolicy } from './speakersData';

const CHECK = { passed: { label: 'Passed', tone: 'green' }, pending: { label: 'Pending', tone: 'yellow' }, failed: { label: 'Failed', tone: 'red' } } as const;
export const expertInitials = (n: string) => n.replace(/^(Dr|Prof)\.?\s+/i, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

type Patch = Partial<Pick<Expert, 'prep_hours' | 'travel_hours' | 'hourly_rate' | 'role'>>;

/** Everything about one expert on this event: engagement, honorarium, sessions, contracts and tiering. */
export function ExpertPanel({ x, timezone, policy, tier, canEdit, canContract, canDelete, canRequestTiering, onChange, onInvalid, onContract, onTiering, onRemove, onClose }: {
  x: Expert; timezone: string; policy: RatePolicy | undefined; tier: { id: string; request_number: string; status: string } | undefined;
  canEdit: boolean; canContract: boolean; canDelete: boolean; canRequestTiering: boolean;
  onChange: (patch: Patch) => void; onInvalid: (m: string) => void; onContract: (addendum: boolean) => void; onTiering: () => void; onRemove: () => void; onClose: () => void;
}) {
  const typeLabel = useTypeLabel();
  const name = x.hcp?.display_name ?? 'Unknown HCP';
  const { main } = mainContract(x);
  const time = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  const sessions = x.event_session_speaker.filter((s) => s.event_session).sort((a, b) => a.event_session!.starts_at.localeCompare(b.event_session!.starts_at));
  const contracts = [...x.contract].sort((a, b) => Number(Boolean(a.parent_contract_id)) - Number(Boolean(b.parent_contract_id)) || a.contract_number.localeCompare(b.contract_number));
  const check = CHECK[x.check_status];

  return (
    <SidePanel recordKey={x.id} onClose={onClose}
      leading={<Avatar size={40} initials={expertInitials(name)} color={avatarColorFor(name)} />}
      title={name} subtitle={[roleLabel(x.role), hcpSub(x.hcp)].filter(Boolean).join(' · ')}
      footer={<>
        <Link to={`/experts/${x.hcp_id}`} className="btn btn-sm"><UserRound size={14} />View expert profile</Link>
        {canDelete && <button type="button" className="btn btn-sm btn-danger-outline" onClick={onRemove}><Trash2 size={14} />Remove expert</button>}
      </>}>
      <PanelSection title="Engagement">
        <PanelField label="Role">
          {canEdit ? <Select aria-label={`Role for ${name}`} value={x.role} onChange={(v) => onChange({ role: v as ExpertRole })} options={ROLES.map((r) => ({ value: r, label: roleLabel(r) }))} />
            : roleLabel(x.role)}
        </PanelField>
        <PanelField label="Eligibility">
          <EligibilityPill value={x.eligibility} />
          {x.hcp && x.hcp.eligibility !== x.eligibility && <div className="dt-sub">Set for this event; the expert is {x.hcp.eligibility === 'eligible' ? 'eligible' : x.hcp.eligibility === 'pending' ? 'pending' : 'not eligible'}</div>}
          {x.eligibility !== 'eligible' && x.hcp?.eligibility_note && <div className="dt-sub">{x.hcp.eligibility_note}</div>}
        </PanelField>
        <PanelField label="Tier">{x.hcp?.tier ?? <span className="text-muted">—</span>}</PanelField>
        <PanelField label="Compliance check">
          <span className={`pill pill-${check.tone}`}>{check.label}</span>
          {x.check_notes && <div className="dt-sub">{x.check_notes}</div>}
        </PanelField>
      </PanelSection>

      <PanelSection title="Honorarium">
        <PanelField label="Rate / h">
          <RateCell value={x.hourly_rate} currency={x.currency ?? 'EUR'} policy={policy} label={`Hourly rate for ${name}`} disabled={!canEdit}
            onInvalid={onInvalid} onSave={(v) => onChange({ hourly_rate: v })} />
          {policy && <div className="dt-sub">{rateRange(policy)}</div>}
        </PanelField>
        <PanelField label="Prep h"><HoursCell value={x.prep_hours} label={`Prep hours for ${name}`} disabled={!canEdit} onSave={(v) => onChange({ prep_hours: v })} /></PanelField>
        <PanelField label="Service h">{hours(x.service_hours)} <span className="dt-sub">from the agenda</span></PanelField>
        <PanelField label="Travel h"><HoursCell value={x.travel_hours} label={`Travel hours for ${name}`} disabled={!canEdit} onSave={(v) => onChange({ travel_hours: v })} /></PanelField>
        <PanelField label="Total"><strong>{x.eligibility === 'ineligible' ? '—' : money(x.total_payable, x.currency ?? 'EUR')}</strong></PanelField>
      </PanelSection>

      <PanelSection title={`Sessions (${sessions.length})`}>
        {sessions.length === 0 ? <p className="text-muted sp-empty">Not on the agenda. Added straight to the Experts list.</p> : sessions.map((s) => (
          <PanelField key={s.id} label={time(s.event_session!.starts_at)}>
            {s.event_session!.title}
            {s.minutes != null && <span className="dt-sub"> · {s.minutes} min</span>}
          </PanelField>
        ))}
      </PanelSection>

      <PanelSection title="Contracts">
        {contracts.length === 0 ? (
          <p className="text-muted sp-empty">
            {x.eligibility === 'eligible' ? 'No contract yet.' : 'Only eligible experts can be contracted.'}
          </p>
        ) : contracts.map((c) => (
          <PanelField key={c.id} label={typeLabel(c.contract_type)}>
            <span className="contract-cell"><Link to={`/contracts/${c.id}`}>{c.contract_number}</Link><ContractStatusPill status={c.status as 'draft'} small /></span>
          </PanelField>
        ))}
        {canContract && x.eligibility === 'eligible' && (
          <div className="sp-actions">
            {main ? <button type="button" className="btn btn-sm" onClick={() => onContract(true)}><FilePlus2 size={14} />Add addendum</button>
              : <button type="button" className="btn btn-sm" onClick={() => onContract(false)}><FileSignature size={14} />Add contract</button>}
          </div>
        )}
      </PanelSection>

      {(tier || (x.eligibility !== 'eligible' && canRequestTiering)) && (
        <PanelSection title="Tiering">
          {tier && (
            <PanelField label="Request">
              <span className="contract-cell"><Link to={`/requests/${tier.id}`}>{tier.request_number}</Link><span className="tiering-status"><RequestStatusPill status={tier.status as 'draft'} /></span></span>
            </PanelField>
          )}
          {x.eligibility !== 'eligible' && canRequestTiering && (tier?.status !== 'draft' && tier?.status !== 'review') && (
            <div className="sp-actions"><button type="button" className="btn btn-sm" onClick={onTiering}><BadgeCheck size={14} />Request tiering</button></div>
          )}
        </PanelSection>
      )}
    </SidePanel>
  );
}
