import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { eventDateTime } from '../../lib/format';
import { Avatar } from '../../components/Avatar';
import { DataTable, useTableSort, type Column } from '../../ui/DataTable';
import { ClearFilters, SearchInput, Segmented, Toolbar } from '../../ui/Toolbar';
import { RequestFormModal } from './RequestFormModal';
import { RequestStatusPill } from './RequestStatusPill';
import { useRequests, useRequestStatuses, type RequestListRow } from './requestData';
import type { Person } from '../event/team/teamData';

type Scope = 'all' | 'mine';
const DEFAULTS = { scope: 'all', status: '', q: '' } as const;

const PersonCell = ({ p, none }: { p: Person | null; none: string }) => p
  ? <span className="dt-person"><Avatar size={24} initials={p.initials} color={p.avatar_color} isAgent={p.user_type === 'agent'} />{p.display_name}</span>
  : <span className="text-muted">{none}</span>;

/**
 * Incoming event requests: every request I can see (my teams' requests, and for home office every
 * submitted one). Counts per status show the volume at a glance; filters live in the URL.
 */
export function RequestsPage() {
  const { me } = useAuth();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const get = <K extends keyof typeof DEFAULTS>(k: K) => params.get(k) ?? DEFAULTS[k];
  const scope = get('scope') as Scope;
  const status = get('status');
  const q = get('q');
  const set = (k: keyof typeof DEFAULTS, v: string) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (v === DEFAULTS[k]) next.delete(k); else next.set(k, v);
    return next;
  }, { replace: true });

  const { data, isLoading, error } = useRequests(me?.id);
  const { data: statuses } = useRequestStatuses();

  // Counts follow the search and scope, not the status filter, so they always add up to "All"
  const scoped = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data?.filter((r) => (scope === 'all' || r.my_team.length > 0)
      && (!needle || [r.title, r.request_number, r.event_type?.name, r.requester?.display_name, r.coordinator?.display_name]
        .some((v) => v?.toLowerCase().includes(needle))));
  }, [data, scope, q]);
  const filtered = useMemo(() => scoped?.filter((r) => !status || r.status === status), [scoped, status]);
  const count = (code: string) => scoped?.filter((r) => r.status === code).length ?? 0;

  const columns = useMemo<Column<RequestListRow>[]>(() => [
    {
      id: 'title', header: 'Request', width: '34%', sortValue: (r) => r.title,
      cell: (r) => (
        <>
          <Link to={`/requests/${r.id}`} className="dt-primary">{r.title}</Link>
          <div className="dt-sub">{[r.request_number, r.event_type?.name].filter(Boolean).join(' · ')}</div>
        </>
      ),
    },
    {
      id: 'status', header: 'Status', width: '11%',
      sortValue: (r) => statuses?.find((s) => s.code === r.status)?.sort ?? null,
      cell: (r) => <RequestStatusPill status={r.status} />,
    },
    {
      id: 'starts_at', header: 'Start', width: '22%', sortValue: (r) => r.starts_at,
      cell: (r) => r.starts_at ? <span className="dt-nowrap">{eventDateTime(r.starts_at, r.timezone)}</span> : <span className="text-muted">Not set</span>,
    },
    { id: 'requester', header: 'Requested by', width: '17%', sortValue: (r) => r.requester?.display_name, cell: (r) => <PersonCell p={r.requester} none="—" /> },
    {
      id: 'coordinator', header: 'Coordinator', width: '16%', sortValue: (r) => r.coordinator?.display_name,
      cell: (r) => <PersonCell p={r.coordinator} none={r.status === 'draft' ? '—' : 'Unassigned'} />,
    },
  ], [statuses]);

  // Unsorted, the list keeps the query's order: newest requests first
  const { rows, sort, setSort } = useTableSort(filtered, columns, null);
  const filtersActive = scope !== DEFAULTS.scope || status || q;
  const clear = () => setParams(new URLSearchParams(), { replace: true });

  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Requests</h1>
          {rows && <div className="card-sub">{rows.length} {rows.length === 1 ? 'request' : 'requests'}</div>}
        </div>
        {can(me, 'event_request', 'create') && (
          <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={15} strokeWidth={2.6} />New request…</button>
        )}
      </div>

      <Toolbar label="Filter requests">
        <SearchInput value={q} onChange={(v) => set('q', v)} placeholder="Search requests" />
        <Segmented label="Whose requests" value={scope} onChange={(v) => set('scope', v)}
          options={[{ value: 'all', label: 'All' }, { value: 'mine', label: 'My requests' }]} />
        <Segmented label="Status" value={status} onChange={(v) => set('status', v)}
          options={[{ value: '', label: `All ${scoped?.length ?? ''}`.trim() },
            ...(statuses ?? []).map((s) => ({ value: s.code as string, label: `${s.label} ${count(s.code)}` }))]} />
        {filtersActive && <ClearFilters onClick={clear} />}
      </Toolbar>

      <DataTable label="Requests" columns={columns} rows={rows} rowKey={(r) => r.id}
        sort={sort} onSortChange={setSort} loading={isLoading} error={error}
        empty={data?.length
          ? <>No requests match these filters. <button className="link" onClick={clear}>Clear filters</button></>
          : 'No requests yet. Requests you create, or that are shared with you, appear here.'} />

      {creating && <RequestFormModal onClose={() => setCreating(false)} />}
    </main>
  );
}
