import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Building2, MapPin, Plus, Stethoscope } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { avatarColorFor } from '../../lib/avatar';
import { Avatar } from '../../components/Avatar';
import { RelatedTable, ViewAll } from '../../ui/RelatedList';
import { EligibilityPill } from './EligibilityPill';
import { FmvCard } from './FmvCard';
import { ExpertFormModal } from './ExpertFormModal';
import { useContractColumns, useEngagementColumns } from './expertColumns';
import { NewContractModal } from '../contracts/NewContractModal';
import { useExpertContracts } from '../contracts/contractsData';
import '../contracts/contracts.css';
import { initialsOf, useEngagements, useExpert, type Engagement, type ExpertRow } from './expertsData';
import '../event.css';
import './experts.css';

const empty = <span className="text-muted">—</span>;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="details-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

/**
 * One expert: who they are, whether they can be engaged, their FMV rates, contracts and the events
 * they were or will be part of (as an expert or an attendee). Each list shows the newest few and
 * links to its full page.
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
          <FmvCard expert={x} canEdit={can(me, 'fmv_rate', 'edit') && can(me, 'fmv_rate', 'create')} />
          <ContractsCard expert={x} canCreate={can(me, 'contract', 'create') && can(me, 'hcp', 'edit')} />
          <EngagementsCard expertId={x.id} list={list} loading={engagements.isLoading} error={engagements.error} />
        </div>
        <DetailsCard expert={x} />
      </div>
      {editing && <ExpertFormModal expert={x} onClose={() => setEditing(false)} />}
    </main>
  );
}

function EngagementsCard({ expertId, list, loading, error }: { expertId: string; list: Engagement[]; loading: boolean; error: Error | null }) {
  const columns = useEngagementColumns();
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
        <div className="ov-empty"><span><strong>No engagements yet.</strong> Events this expert speaks at or attends appear here.</span></div>
      ) : <>
        <RelatedTable label="Engagements" columns={columns} rows={list} rowKey={(e) => e.id} className="expert-table" />
        <ViewAll to={`/experts/${expertId}/engagements`} total={list.length} />
      </>}
    </section>
  );
}

function ContractsCard({ expert: x, canCreate }: { expert: ExpertRow; canCreate: boolean }) {
  const { data, isLoading, error } = useExpertContracts(x.id);
  const columns = useContractColumns();
  const [adding, setAdding] = useState(false);
  const list = data ?? [];
  return (
    <section className="card ov-card" aria-labelledby="contracts-title">
      <div className="ov-head">
        <div className="ov-title-row">
          <h2 id="contracts-title" className="ov-title">Contracts</h2>
          <span className="card-sub">{list.length ? `${list.length} contract${list.length === 1 ? '' : 's'}` : ''}</span>
        </div>
        {canCreate && <div className="ov-actions"><button className="btn btn-outline btn-sm" onClick={() => setAdding(true)}><Plus size={14} strokeWidth={2.6} />Add MSA</button></div>}
      </div>
      {error && <div className="form-error" role="alert">{error.message}</div>}
      {isLoading ? <div className="ov-empty text-muted">Loading…</div> : list.length === 0 ? (
        <div className="ov-empty"><span><strong>No contracts yet.</strong> A Master Service Agreement is added here; Work Orders and Single-event Contracts are created from the Experts section of an event.</span></div>
      ) : <>
        <RelatedTable label="Contracts" columns={columns} rows={list} rowKey={(c) => c.id} className="expert-table"
          rowClass={(c) => (c.status === 'cancelled' ? 'is-past' : undefined)} />
        <ViewAll to={`/experts/${x.id}/contracts`} total={list.length} />
      </>}
      {adding && <NewContractModal target={{ kind: 'msa', hcpId: x.id, name: x.display_name }} onClose={() => setAdding(false)} />}
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
