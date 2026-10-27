import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { eventDateTime } from '../lib/format';
import { Avatar } from '../components/Avatar';
import { StatusPill, useEventStatuses } from '../components/StatusPill';
import { DataTable, useTableSort, type Column } from '../ui/DataTable';
import { ClearFilters, FilterSelect, SearchInput, Segmented, Toolbar } from '../ui/Toolbar';
import { useEventForm } from './event/EventFormProvider';
import { can, canCreateEvents } from '../lib/permissions';
import type { EventStatus } from '../lib/types';

interface EventRow {
  id: string; event_number: string; name: string; status: EventStatus; starts_at: string | null; timezone: string;
  city: string | null; country_code: string | null;
  country: { name: string } | null;
  event_type: { name: string } | null;
  owner: { display_name: string; initials: string | null; avatar_color: string | null; user_type: 'human' | 'agent' } | null;
  /** Only the current user's team row, if any. */
  my_team: { team_role: string }[];
}

type Scope = 'all' | 'mine';
type When = 'upcoming' | 'past' | 'any';
const DEFAULTS = { scope: 'all', when: 'upcoming', status: '', country: '', q: '' } as const;

function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); }

/**
 * Every event the user can see (RLS decides), filtered and sorted in the browser.
 * Filters live in the URL so a filtered list can be bookmarked or shared.
 * Move filtering and sorting into the query once lists get large.
 */
export function EventsPage() {
  const { me } = useAuth();
  const [params, setParams] = useSearchParams();
  const { openNewEvent } = useEventForm();
  const get = <K extends keyof typeof DEFAULTS>(k: K) => params.get(k) ?? DEFAULTS[k];
  const scope = get('scope') as Scope;
  const when = get('when') as When;
  const status = get('status');
  const country = get('country');
  const q = get('q');

  // Functional update: URL changes run as transitions, so `params` from this render can be stale
  const set = (k: keyof typeof DEFAULTS, v: string) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (v === DEFAULTS[k]) next.delete(k); else next.set(k, v);
    return next;
  }, { replace: true });

  const { data, isLoading, error } = useQuery({
    queryKey: ['events', me?.id],
    enabled: Boolean(me),
    queryFn: async () => {
      const { data, error } = await supabase.from('event')
        .select('id,event_number,name,status,starts_at,timezone,city,country_code,country(name),event_type(name),' +
                'owner:app_user!event_owner_id_fkey(display_name,initials,avatar_color,user_type),my_team:event_team_member(team_role)')
        .eq('my_team.user_id', me!.id)
        .order('starts_at', { ascending: true, nullsFirst: false });
      if (error) throw error;
      return data as unknown as EventRow[];
    },
  });
  const { data: statuses } = useEventStatuses();

  const filtered = useMemo(() => {
    const today = startOfToday();
    const needle = q.trim().toLowerCase();
    return data?.filter((e) =>
      (scope === 'all' || e.my_team.length > 0)
      && (when === 'any' || (when === 'upcoming' ? (e.starts_at ?? '9999') >= today : (e.starts_at ?? '') < today && e.starts_at !== null))
      && (!status || e.status === status)
      && (!country || e.country_code === country)
      && (!needle || [e.name, e.event_number, e.city, e.event_type?.name, e.owner?.display_name]
        .some((v) => v?.toLowerCase().includes(needle))));
  }, [data, scope, when, status, country, q]);

  const columns = useMemo<Column<EventRow>[]>(() => [
    {
      id: 'name', header: 'Event', width: '34%', sortValue: (e) => e.name,
      cell: (e) => (
        <>
          <Link to={`/events/${e.id}`} className="dt-primary">{e.name}</Link>
          <div className="dt-sub">{[e.event_number, e.event_type?.name].filter(Boolean).join(' · ')}</div>
        </>
      ),
    },
    {
      id: 'status', header: 'Status', width: '12%',
      sortValue: (e) => statuses?.find((s) => s.code === e.status)?.sort ?? null,
      cell: (e) => <StatusPill status={e.status} />,
    },
    {
      id: 'starts_at', header: 'Start', width: '22%', sortValue: (e) => e.starts_at,
      cell: (e) => e.starts_at ? <span className="dt-nowrap">{eventDateTime(e.starts_at, e.timezone)}</span> : <span className="text-muted">Not scheduled</span>,
    },
    {
      id: 'country', header: 'Country', width: '14%', sortValue: (e) => e.country?.name,
      cell: (e) => e.country ? <>{e.country.name}{e.city && <div className="dt-sub">{e.city}</div>}</> : <span className="text-muted">—</span>,
    },
    {
      id: 'owner', header: 'Owner', width: '18%', sortValue: (e) => e.owner?.display_name,
      cell: (e) => e.owner
        ? <span className="dt-person"><Avatar size={24} initials={e.owner.initials} color={e.owner.avatar_color} isAgent={e.owner.user_type === 'agent'} />{e.owner.display_name}</span>
        : <span className="text-muted">Unassigned</span>,
    },
  ], [statuses]);

  const { rows, sort, setSort } = useTableSort(filtered, columns, { columnId: 'starts_at', dir: 'asc' });

  const countryOptions = useMemo(() => {
    const seen = new Map<string, string>();
    data?.forEach((e) => e.country_code && e.country && seen.set(e.country_code, e.country.name));
    return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [data]);

  const filtersActive = scope !== DEFAULTS.scope || when !== DEFAULTS.when || status || country || q;
  const clear = () => setParams(new URLSearchParams(), { replace: true });
  const pickWhen = (w: When) => {
    set('when', w);
    // Past reads best newest first; upcoming soonest first
    if (sort?.columnId === 'starts_at') setSort({ columnId: 'starts_at', dir: w === 'past' ? 'desc' : 'asc' });
  };

  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Events</h1>
          {rows && <div className="card-sub">{rows.length} {rows.length === 1 ? 'event' : 'events'}</div>}
        </div>
        {can(me, 'event', 'create') && <button className="btn btn-primary" onClick={openNewEvent} disabled={!canCreateEvents(me)}
          title={canCreateEvents(me) ? undefined : "You don't create events in any country yet. Ask an admin to add your countries."}>
          <Plus size={15} strokeWidth={2.6} />New event…</button>}
      </div>

      <Toolbar label="Filter events">
        <SearchInput value={q} onChange={(v) => set('q', v)} placeholder="Search events" />
        <Segmented label="Whose events" value={scope} onChange={(v) => set('scope', v)}
          options={[{ value: 'all', label: 'All' }, { value: 'mine', label: 'My events' }]} />
        <Segmented label="Time range" value={when} onChange={pickWhen}
          options={[{ value: 'upcoming', label: 'Upcoming' }, { value: 'past', label: 'Past' }, { value: 'any', label: 'Any date' }]} />
        <FilterSelect label="Status" value={status} onChange={(v) => set('status', v)}
          options={(statuses ?? []).map((s) => ({ value: s.code, label: s.label }))} />
        <FilterSelect label="Country" value={country} onChange={(v) => set('country', v)} options={countryOptions} />
        {filtersActive && <ClearFilters onClick={clear} />}
      </Toolbar>

      <DataTable label="Events" columns={columns} rows={rows} rowKey={(e) => e.id}
        sort={sort} onSortChange={setSort} loading={isLoading} error={error}
        empty={data?.length
          ? <>No events match these filters. <button className="link" onClick={clear}>Clear filters</button></>
          : 'No events yet. New events appear here as soon as they are created.'} />
    </main>
  );
}
