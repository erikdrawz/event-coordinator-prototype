import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { avatarColorFor } from '../../lib/avatar';
import { Avatar } from '../../components/Avatar';
import { DataTable, useTableSort, type Column } from '../../ui/DataTable';
import { ClearFilters, FilterSelect, SearchInput, Segmented, Toolbar } from '../../ui/Toolbar';
import { money } from '../event/speakers/speakersData';
import { EligibilityPill } from './EligibilityPill';
import { fmvOn, initialsOf, useEligibilities, useExpertDirectory, type ExpertRow } from './expertsData';

type Show = 'eligible' | 'all';
const DEFAULTS = { show: 'eligible', country: '', specialty: '', q: '' } as const;

/**
 * Experts: the HCPs Event Center works with. Eligible ones by default, since those are the
 * ones you can engage; "All experts" adds those pending or not eligible. Filters live in the URL.
 */
export function ExpertsPage() {
  const [params, setParams] = useSearchParams();
  const get = <K extends keyof typeof DEFAULTS>(k: K) => params.get(k) ?? DEFAULTS[k];
  const show = get('show') as Show;
  const country = get('country');
  const specialty = get('specialty');
  const q = get('q');
  const set = (k: keyof typeof DEFAULTS, v: string) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (v === DEFAULTS[k]) next.delete(k); else next.set(k, v);
    return next;
  }, { replace: true });

  const { data, isLoading, error } = useExpertDirectory();
  const { data: eligibilities } = useEligibilities();

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data?.filter((x) => (show === 'all' || x.eligibility === 'eligible')
      && (!country || x.country_code === country)
      && (!specialty || x.specialty?.name === specialty)
      && (!needle || [x.display_name, x.primary_hco?.name, x.city, x.specialty?.name, x.onekey_id, x.crm_external_id]
        .some((v) => v?.toLowerCase().includes(needle))));
  }, [data, show, country, specialty, q]);

  const columns = useMemo<Column<ExpertRow>[]>(() => [
    {
      id: 'name', header: 'Expert', width: '27%', sortValue: (x) => `${x.last_name} ${x.first_name}`,
      cell: (x) => (
        <span className="dt-person">
          <Avatar size={30} initials={initialsOf(x)} color={avatarColorFor(x.display_name)} />
          <span>
            <Link to={`/experts/${x.id}`} className="dt-primary">{x.display_name}</Link>
            <div className="dt-sub">{x.specialty?.name ?? 'No specialty'}</div>
          </span>
        </span>
      ),
    },
    {
      id: 'eligibility', header: 'Eligibility', width: '12%',
      sortValue: (x) => eligibilities?.find((e) => e.code === x.eligibility)?.sort ?? null,
      cell: (x) => <EligibilityPill value={x.eligibility} note={x.eligibility_note} />,
    },
    {
      id: 'organisation', header: 'Organisation', width: '25%', sortValue: (x) => x.primary_hco?.name,
      cell: (x) => x.primary_hco ? <>{x.primary_hco.name}<div className="dt-sub">{[x.city, x.country?.name].filter(Boolean).join(', ')}</div></>
        : <span className="text-muted">{[x.city, x.country?.name].filter(Boolean).join(', ') || '—'}</span>,
    },
    { id: 'tier', header: 'Tier', width: '8%', sortValue: (x) => x.tier, cell: (x) => x.tier ?? <span className="text-muted">—</span> },
    {
      id: 'fmv', header: 'FMV rate', width: '16%', align: 'right', sortValue: (x) => fmvOn(x.fmv_rate)?.rate ?? null,
      cell: (x) => {
        const f = fmvOn(x.fmv_rate);
        return f ? <>{money(f.rate, f.currency)} / h<div className="dt-sub">{money(f.min_rate, f.currency)}–{money(f.max_rate, f.currency)}</div></>
          : <span className="text-muted">No current rate</span>;
      },
    },
    {
      id: 'engagements', header: 'Engagements', width: '12%', align: 'right', sortValue: (x) => x.event_expert[0]?.count ?? 0,
      cell: (x) => x.event_expert[0]?.count || <span className="text-muted">0</span>,
    },
  ], [eligibilities]);

  const { rows, sort, setSort } = useTableSort(filtered, columns, { columnId: 'name', dir: 'asc' });

  const countryOptions = useMemo(() => {
    const seen = new Map<string, string>();
    data?.forEach((x) => x.country_code && x.country && seen.set(x.country_code, x.country.name));
    return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [data]);
  const specialtyOptions = useMemo(() => [...new Set(data?.map((x) => x.specialty?.name).filter(Boolean) as string[])].sort()
    .map((s) => ({ value: s, label: s })), [data]);
  const eligibleCount = data?.filter((x) => x.eligibility === 'eligible').length;

  const filtersActive = show !== DEFAULTS.show || country || specialty || q;
  const clear = () => setParams(new URLSearchParams(), { replace: true });

  return (
    <main className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Experts</h1>
          {rows && <div className="card-sub">{rows.length} {show === 'eligible' ? 'eligible ' : ''}{rows.length === 1 ? 'expert' : 'experts'}</div>}
        </div>
      </div>

      <Toolbar label="Filter experts">
        <SearchInput value={q} onChange={(v) => set('q', v)} placeholder="Search name, organisation, ID" />
        <Segmented label="Which experts" value={show} onChange={(v) => set('show', v)}
          options={[{ value: 'eligible', label: `Eligible${eligibleCount != null ? ` ${eligibleCount}` : ''}` },
            { value: 'all', label: `All experts${data ? ` ${data.length}` : ''}` }]} />
        <FilterSelect label="Country" value={country} onChange={(v) => set('country', v)} options={countryOptions} />
        <FilterSelect label="Specialty" value={specialty} onChange={(v) => set('specialty', v)} options={specialtyOptions} />
        {filtersActive && <ClearFilters onClick={clear} />}
      </Toolbar>

      <DataTable label="Experts" columns={columns} rows={rows} rowKey={(x) => x.id}
        sort={sort} onSortChange={setSort} loading={isLoading} error={error}
        empty={data?.length
          ? <>No experts match these filters. <button className="link" onClick={clear}>Clear filters</button></>
          : 'No experts yet. Experts join when you add them to an event, from Event Center or a CRM.'} />
    </main>
  );
}
