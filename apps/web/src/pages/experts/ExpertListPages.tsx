import { useMemo, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { DataTable, useTableSort } from '../../ui/DataTable';
import { RelatedPage } from '../../ui/RelatedList';
import { SearchInput, Segmented, Toolbar } from '../../ui/Toolbar';
import { useExpertContracts } from '../contracts/contractsData';
import '../contracts/contracts.css';
import { useContractColumns, useEngagementColumns } from './expertColumns';
import { useEngagements, useExpert, type ExpertRow } from './expertsData';
import { FmvCard } from './FmvCard';
import '../event.css';
import './experts.css';

/** The full lists behind the cards on the expert page. */
function Frame({ expert, loading, title, sub, children }: { expert: ExpertRow | null | undefined; loading: boolean; title: string; sub?: ReactNode; children: ReactNode }) {
  if (loading) return <main className="page"><div className="empty-state">Loading…</div></main>;
  if (!expert) return <main className="page"><div className="card empty-state"><div className="empty-state-title">Expert not found</div>They may have been removed, or you don't have access.</div></main>;
  return <RelatedPage crumbs={[{ to: '/experts', label: 'Experts' }, { to: `/experts/${expert.id}`, label: expert.display_name }]} title={title} sub={sub}>{children}</RelatedPage>;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function ExpertEngagementsPage() {
  const { id } = useParams();
  const expert = useExpert(id);
  const { data, isLoading, error } = useEngagements(id);
  const columns = useEngagementColumns();
  const [params, setParams] = useSearchParams();
  const type = params.get('type') ?? 'all';
  const q = params.get('q') ?? '';
  const set = (key: string, value: string) => setParams((p) => { if (value && value !== 'all') p.set(key, value); else p.delete(key); return p; }, { replace: true });
  const filtered = useMemo(() => data?.filter((e) => (type === 'all' || e.type === type)
    && (!q || e.event?.name.toLowerCase().includes(q.toLowerCase()))), [data, type, q]);
  const { rows, sort, setSort } = useTableSort(filtered, columns, { columnId: 'date', dir: 'desc' });
  const count = (t: string) => data?.filter((e) => e.type === t).length ?? 0;

  return (
    <Frame expert={expert.data} loading={expert.isLoading} title="Engagements" sub={data && plural(rows?.length ?? 0, 'event')}>
      <Toolbar label="Filter engagements">
        <SearchInput value={q} onChange={(v) => set('q', v)} placeholder="Search events" />
        <Segmented label="Which engagements" value={type} onChange={(v) => set('type', v)}
          options={[{ value: 'all', label: `All${data ? ` ${data.length}` : ''}` }, { value: 'expert', label: `Expert ${count('expert')}` }, { value: 'attendee', label: `Attendee ${count('attendee')}` }]} />
      </Toolbar>
      <DataTable label="Engagements" columns={columns} rows={rows} rowKey={(e) => e.id} sort={sort} onSortChange={setSort}
        loading={isLoading} error={error} empty={data?.length ? 'No engagements match these filters.' : 'No engagements yet.'} />
    </Frame>
  );
}

export function ExpertContractsPage() {
  const { id } = useParams();
  const expert = useExpert(id);
  const { data, isLoading, error } = useExpertContracts(id);
  const columns = useContractColumns();
  const { rows, sort, setSort } = useTableSort(data, columns, null);
  return (
    <Frame expert={expert.data} loading={expert.isLoading} title="Contracts" sub={data && plural(data.length, 'contract')}>
      <DataTable label="Contracts" columns={columns} rows={rows} rowKey={(c) => c.id} sort={sort} onSortChange={setSort}
        loading={isLoading} error={error} empty="No contracts yet." />
    </Frame>
  );
}

export function ExpertFmvPage() {
  const { id } = useParams();
  const expert = useExpert(id);
  const { me } = useAuth();
  return (
    <Frame expert={expert.data} loading={expert.isLoading} title="FMV rates" sub={expert.data && plural(expert.data.fmv_rate.length, 'rate')}>
      {expert.data && <FmvCard expert={expert.data} canEdit={can(me, 'fmv_rate', 'edit') && can(me, 'fmv_rate', 'create')} full />}
    </Frame>
  );
}
