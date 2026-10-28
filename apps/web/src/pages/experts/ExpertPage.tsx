import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Building2, FileSignature, MapPin, Stethoscope } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { avatarColorFor } from '../../lib/avatar';
import { daysUntil, ymdInZone } from '../../lib/format';
import { Avatar } from '../../components/Avatar';
import { StatusPill } from '../../components/StatusPill';
import { formatDate } from '../../ui/DateInput';
import { money, roleLabel } from '../event/speakers/speakersData';
import { EligibilityPill } from './EligibilityPill';
import { ExpertFormModal } from './ExpertFormModal';
import { fmvState, initialsOf, useEngagements, useExpert, type Engagement, type ExpertRow } from './expertsData';
import '../event.css';
import './experts.css';

const empty = <span className="text-muted">—</span>;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="details-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

function relative(iso: string) {
  const d = daysUntil(iso);
  return d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : d === -1 ? 'Yesterday' : d > 0 ? `In ${d} days` : `${-d} days ago`;
}

const FMV_STATE = { current: { label: 'Current', tone: 'green' }, upcoming: { label: 'Upcoming', tone: 'blue' }, expired: { label: 'Expired', tone: 'grey' } } as const;

/**
 * One expert: who they are, whether they can be engaged, their FMV rates and the events they
 * were or will be part of. Contracts come later.
 */
export function ExpertPage() {
  const { id } = useParams();
  const { data: x, isLoading } = useExpert(id);
  const engagements = useEngagements(id);
  const { me } = useAuth();
  const [editing, setEditing] = useState(false);

  if (isLoading) return <main className="page"><div className="empty-state">Loading…</div></main>;
  if (!x) return <main className="page"><div className="card empty-state"><div className="empty-state-title">Expert not found</div>They may have been removed, or you don't have access.</div></main>;

  const list = engagements.data ?? [];
  const place = [x.city ?? x.primary_hco?.city, x.country?.name].filter(Boolean).join(', ');

  return (
    <main className="page">
      <section className="card event-head expert-head">
        <nav className="crumbs"><Link to="/experts">Experts</Link><span>/</span><span>{x.display_name}</span></nav>
        <div className="event-head-row">
          <Avatar size={60} initials={initialsOf(x)} color={avatarColorFor(x.display_name)} />
          <div className="event-head-main">
            <div className="event-title-row">
              <h1 className="event-title">{x.display_name}</h1>
              <EligibilityPill value={x.eligibility} />
              {x.tier && <span className="pill pill-grey">{x.tier}</span>}
            </div>
            <div className="event-meta">
              {x.specialty && <span><Stethoscope size={15} />{x.specialty.name}</span>}
              {x.primary_hco && <span><Building2 size={15} />{x.primary_hco.name}</span>}
              {place && <span><MapPin size={15} />{place}</span>}
            </div>
          </div>
          {can(me, 'hcp', 'edit') && (
            <div className="event-actions"><button type="button" className="btn" onClick={() => setEditing(true)}>Edit expert</button></div>
          )}
        </div>
        {x.eligibility !== 'eligible' && x.eligibility_note && (
          <p className={`expert-note ${x.eligibility === 'ineligible' ? 'is-red' : 'is-yellow'}`}>{x.eligibility_note}</p>
        )}
      </section>

      <div className="expert-body">
        <div className="expert-main">
          <EngagementsCard list={list} loading={engagements.isLoading} error={engagements.error} />
          <FmvCard expert={x} />
          <section className="card ov-card" aria-labelledby="contracts-title">
            <div className="ov-head"><div className="ov-title-row"><h2 id="contracts-title" className="ov-title">Contracts</h2></div></div>
            <div className="ov-empty"><span><FileSignature size={15} className="inline-icon" aria-hidden /><strong>Contracts come next.</strong> Service agreements and work orders with {x.first_name} {x.last_name} will be listed here.</span></div>
          </section>
        </div>
        <DetailsCard expert={x} />
      </div>
      {editing && <ExpertFormModal expert={x} onClose={() => setEditing(false)} />}
    </main>
  );
}

function EngagementsCard({ list, loading, error }: { list: Engagement[]; loading: boolean; error: Error | null }) {
  return (
    <section className="card ov-card" aria-labelledby="engagements-title">
      <div className="ov-head">
        <div className="ov-title-row">
          <h2 id="engagements-title" className="ov-title">Engagements</h2>
          <span className="card-sub">{list.length ? `${list.length} event${list.length === 1 ? '' : 's'}` : ''}</span>
        </div>
      </div>
      {error && <div className="form-error" role="alert">{error.message}</div>}
      {loading ? <div className="ov-empty text-muted">Loading…</div> : list.length === 0 ? (
        <div className="ov-empty"><span><strong>No engagements yet.</strong> Events this expert is added to appear here.</span></div>
      ) : (
        <div className="table-scroll">
          <table className="agenda-table expert-table">
            <thead>
              <tr><th>Event</th><th>Date</th><th>Role</th><th>Status</th><th className="num">Rate / h</th><th className="num">Honorarium</th></tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id}>
                  <td>
                    {e.event ? <Link to={`/events/${e.event.id}`} className="agenda-title expert-link">{e.event.name}</Link> : empty}
                    <div className="dt-sub">{[e.event?.event_type?.name, e.event?.city, e.event?.country?.name].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="dt-nowrap">
                    {e.event?.starts_at ? <>{formatDate(ymdInZone(e.event.starts_at, e.event.timezone))}<div className="dt-sub">{relative(e.event.starts_at)}</div></> : <span className="text-muted">Not scheduled</span>}
                  </td>
                  <td>{roleLabel(e.role)}</td>
                  <td>{e.event && <StatusPill status={e.event.status} />}</td>
                  <td className="num">{e.hourly_rate != null ? money(e.hourly_rate, e.currency ?? 'EUR') : empty}</td>
                  <td className="num">{e.eligibility === 'ineligible' ? <span className="text-muted" data-tip="Not eligible on this event" tabIndex={0}>—</span> : money(e.total_payable, e.currency ?? 'EUR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FmvCard({ expert }: { expert: ExpertRow }) {
  const rates = expert.fmv_rate;
  return (
    <section className="card ov-card" aria-labelledby="fmv-title">
      <div className="ov-head">
        <div className="ov-title-row">
          <h2 id="fmv-title" className="ov-title">FMV rates</h2>
          <span className="card-sub">Hourly; new engagements default to the rate valid on the event's date</span>
        </div>
      </div>
      {rates.length === 0 ? (
        <div className="ov-empty"><span><strong>No FMV rate yet.</strong> Until there is one, engagements use the default: €100 per hour, negotiable between €80 and €120.</span></div>
      ) : (
        <div className="table-scroll">
          <table className="agenda-table expert-table">
            <thead>
              <tr><th>Effective date</th><th>Expiration date</th><th className="num">Rate</th><th className="num">Min rate</th><th className="num">Max rate</th></tr>
            </thead>
            <tbody>
              {rates.map((f) => {
                const st = FMV_STATE[fmvState(f)];
                return (
                  <tr key={f.id} className={st.label === 'Expired' ? 'is-past' : undefined}>
                    <td className="dt-nowrap">{formatDate(f.effective_date)} <span className={`pill pill-${st.tone} pill-sm`}>{st.label}</span></td>
                    <td className="dt-nowrap">{f.expiration_date ? formatDate(f.expiration_date) : <span className="text-muted">Until replaced</span>}</td>
                    <td className="num"><strong>{money(f.rate, f.currency)}</strong></td>
                    <td className="num">{money(f.min_rate, f.currency)}</td>
                    <td className="num">{money(f.max_rate, f.currency)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DetailsCard({ expert: x }: { expert: ExpertRow }) {
  const address = [x.primary_hco?.address, x.primary_hco?.city ?? x.city].filter(Boolean).join(', ');
  return (
    <section className="card details-card expert-details" aria-labelledby="expert-details-title">
      <div className="details-head"><h2 id="expert-details-title" className="card-title">Expert details</h2></div>
      <dl className="details-grid">
        <Row label="Eligibility"><EligibilityPill value={x.eligibility} /></Row>
        <Row label="Email">{x.email ? <a href={`mailto:${x.email}`}>{x.email}</a> : empty}</Row>
        <Row label="Specialty">{x.specialty?.name ?? empty}</Row>
        <Row label="Tier">{x.tier ?? empty}</Row>
        <Row label="Organisation">{x.primary_hco?.name ?? empty}</Row>
        <Row label="Address">{address || empty}</Row>
        <Row label="Country">{x.country?.name ?? empty}</Row>
        <Row label="OneKey ID">{x.onekey_id ?? empty}</Row>
        <Row label="CRM record">{x.crm_connection ? <>{x.crm_connection.name}<div className="dt-sub">{x.crm_external_id}</div></> : <span className="text-muted">Not linked</span>}</Row>
      </dl>
    </section>
  );
}
