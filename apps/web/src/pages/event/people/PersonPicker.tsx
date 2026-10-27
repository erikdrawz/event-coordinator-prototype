import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Database, Search } from 'lucide-react';
import { usePopover } from '../../../ui/usePopover';
import { Select } from '../../../ui/Select';
import { Avatar } from '../../../components/Avatar';
import { avatarColorFor } from '../../../lib/avatar';
import { initials, type SpeakerOption } from '../agenda/agendaData';
import { importCrmHcp, useCrmFilterOptions, useCrmSearch, type CrmHcp, type CrmSearch } from './crmData';
import '../../../ui/select.css';

type Group = SpeakerOption['group'];

interface Props {
  /** The button that opens the picker (same contract as Menu's trigger). */
  trigger: (props: { ref: (el: HTMLButtonElement | null) => void; onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'dialog' }) => ReactNode;
  label: string;
  /** People already in EC who can be picked here (taken ones left out). */
  options: SpeakerOption[];
  /** Which groups to show, in order, with their headings. */
  groups: { group: Group; label: string }[];
  /** Offer "Search CRM" when no one in EC fits. */
  canSearchCrm: boolean;
  onPick: (o: SpeakerOption) => void;
  /** Open as soon as it mounts (e.g. a new add-row). */
  autoOpen?: boolean;
}

type Row =
  | { kind: 'local'; key: string; option: SpeakerOption }
  | { kind: 'crm-search'; key: string }
  | { kind: 'crm'; key: string; hit: CrmHcp; option?: SpeakerOption };

const matches = (text: string, q: string) => q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => text.toLowerCase().includes(w));
const place = (h: { city: string | null; country_code: string | null }) => [h.city, h.country_code].filter(Boolean).join(', ');

/**
 * Pick a person: people already in EC first; if they aren't there, search the CRMs as a second step.
 * A CRM pick is copied into EC (crm_import_hcp) and then handed back like any other HCP.
 */
export function PersonPicker({ trigger, label, options, groups, canSearchCrm, onPick, autoOpen }: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(Boolean(autoOpen));
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [filters, setFilters] = useState<Omit<CrmSearch, 'q'>>({});
  const [crm, setCrm] = useState<CrmSearch | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { triggerRef, popRef, style } = usePopover<HTMLButtonElement>(open, () => close(false), { width: 460, maxHeight: 460 });
  const search = useCrmSearch(crm);
  const filterOptions = useCrmFilterOptions(Boolean(crm));

  const close = (refocus = true) => {
    setOpen(false); setQuery(''); setCrm(null); setActive(0); importing.reset();
    if (refocus) triggerRef.current?.focus();
  };
  const choose = (o: SpeakerOption) => { close(); onPick(o); };

  const importing = useMutation({
    mutationFn: importCrmHcp,
    onSuccess: (h, hit) => {
      qc.invalidateQueries({ queryKey: ['hcps'] });
      qc.invalidateQueries({ predicate: (q) => q.queryKey[2] === 'speaker-options' });
      qc.invalidateQueries({ queryKey: ['crm-search'] });
      choose({ key: `h:${h.id}`, hcp_id: h.id, name: h.display_name, group: 'hcp', initials: initials(h.display_name), color: null,
        sub: [hit.specialty, place(hit)].filter(Boolean).join(' · ') });
    },
  });

  // People already in EC, filtered by what's typed
  const local = useMemo(() => options.filter((o) => !query || matches(`${o.name} ${o.sub}`, query)), [options, query]);
  // CRM results for the search that was run; typing something new goes back to EC results first
  const crmShown = crm && crm.q === query.trim();
  const rows: Row[] = useMemo(() => {
    const list: Row[] = groups.flatMap(({ group }) => local.filter((o) => o.group === group).map((o) => ({ kind: 'local' as const, key: o.key, option: o })));
    if (canSearchCrm && query.trim().length >= 2 && !crmShown) list.push({ kind: 'crm-search', key: 'crm-search' });
    if (crmShown) {
      for (const hit of search.data?.results ?? []) {
        const option = hit.hcp_id ? options.find((o) => o.hcp_id === hit.hcp_id) : undefined;
        if (hit.hcp_id && !option) continue;   // in EC and already chosen here
        list.push({ kind: 'crm', key: `${hit.crm_connection_id}:${hit.external_id}`, hit, option });
      }
    }
    return list;
  }, [groups, local, canSearchCrm, query, crmShown, search.data, options]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { if (open && style) inputRef.current?.focus(); }, [open, Boolean(style)]);

  const runCrm = (f = filters) => { setCrm({ q: query.trim(), ...f }); setActive(0); };
  const setFilter = (k: keyof typeof filters, v: string) => {
    const f = { ...filters, [k]: v || undefined };
    setFilters(f);
    if (crmShown) runCrm(f);
  };
  const act = (r: Row | undefined) => {
    if (!r) return;
    if (r.kind === 'local') choose(r.option);
    else if (r.kind === 'crm-search') runCrm();
    else if (r.option) choose(r.option);
    else if (!importing.isPending) importing.mutate(r.hit);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.target !== inputRef.current) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((x) => Math.min(rows.length - 1, x + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((x) => Math.max(0, x - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); act(rows[active]); }
    else if (e.key === 'Tab') close(false);
  };
  useEffect(() => { popRef.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const rowProps = (i: number, r: Row) => ({
    'data-row': i, role: 'option', 'aria-selected': i === active,
    className: `sel-option person-option${i === active ? ' active' : ''}`,
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(), onMouseMove: () => setActive(i), onClick: () => act(r),
  });
  let n = -1;   // running index into rows, in render order

  const connections = search.data?.connections ?? [];
  return (
    <>
      {trigger({ ref: (el) => { triggerRef.current = el; }, onClick: () => (open ? close() : setOpen(true)), 'aria-expanded': open, 'aria-haspopup': 'dialog' })}
      {open && style && (
        <div ref={popRef} className="sel-pop person-pop" style={style} onKeyDown={onKey} role="dialog" aria-label={label}>
          <div className="sel-search"><Search size={14} aria-hidden />
            <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name"
              aria-label={label} role="combobox" aria-expanded aria-autocomplete="list" /></div>
          <div className="person-scroll" role="listbox" aria-label={label}>
            {groups.map(({ group, label: heading }) => {
              const items = rows.filter((r) => r.kind === 'local' && r.option.group === group);
              if (!items.length) return null;
              return (
                <div key={group} role="group" aria-label={heading}>
                  <div className="person-heading">{heading}</div>
                  {items.map((r) => { n++; const o = (r as Extract<Row, { kind: 'local' }>).option; return (
                    <div key={r.key} {...rowProps(n, r)}>
                      <Avatar size={24} initials={o.initials} color={o.color ?? avatarColorFor(o.name)} />
                      <span className="person-text"><span className="person-name">{o.name}</span><span className="person-sub">{o.sub}</span></span>
                    </div>
                  ); })}
                </div>
              );
            })}
            {local.length === 0 && (
              <div className="sel-none">{query ? <>No one in Event Coordinator matches “{query.trim()}”.</> : 'No one to add yet.'}</div>
            )}
            {rows.some((r) => r.kind === 'crm-search') && (() => { n++; const r = rows.find((x) => x.kind === 'crm-search')!; return (
              <div {...rowProps(n, r)} className={`${rowProps(n, r).className} person-crm-action`}>
                <Database size={15} aria-hidden /><span>Search CRM for “{query.trim()}”</span>
              </div>
            ); })()}

            {crmShown && (
              <div className="person-crm" role="group" aria-label="CRM results">
                <div className="person-crm-head">
                  <span className="person-heading">In CRM</span>
                  <div className="person-crm-filters">
                    <Select variant="filter" label="CRM" value={filters.crm_connection_id ?? ''} onChange={(v) => setFilter('crm_connection_id', v)}
                      emptyLabel="All" options={(filterOptions.data?.connections ?? []).map((c) => ({ value: c.id, label: c.name }))} />
                    <Select variant="filter" label="Country" value={filters.country_code ?? ''} onChange={(v) => setFilter('country_code', v)} searchable
                      emptyLabel="Any" options={(filterOptions.data?.countries ?? []).map((c) => ({ value: c.code, label: c.name }))} />
                    <Select variant="filter" label="Specialty" value={filters.specialty ?? ''} onChange={(v) => setFilter('specialty', v)}
                      emptyLabel="Any" options={(filterOptions.data?.specialties ?? []).map((s) => ({ value: s, label: s }))} />
                  </div>
                </div>
                {search.isLoading && <div className="sel-none">Searching the CRMs…</div>}
                {search.error && <div className="form-error person-error" role="alert">{search.error.message}</div>}
                {connections.map((c) => {
                  const hits = rows.filter((r): r is Extract<Row, { kind: 'crm' }> => r.kind === 'crm' && r.hit.crm_connection_id === c.id);
                  return (
                    <div key={c.id} role="group" aria-label={c.name}>
                      <div className="person-conn"><Database size={13} aria-hidden />{c.name}
                        {c.status === 'unavailable' ? <span className="person-conn-note">not responding</span>
                          : hits.length === 0 ? <span className="person-conn-note">no matches</span> : null}
                      </div>
                      {hits.map((r) => { n++; const h = r.hit; const busy = importing.isPending && importing.variables === h; return (
                        <div key={r.key} {...rowProps(n, r)} aria-busy={busy || undefined}>
                          <Avatar size={24} initials={initials(h.display_name)} color={avatarColorFor(h.display_name)} />
                          <span className="person-text">
                            <span className="person-name">{h.display_name}</span>
                            <span className="person-sub">{[h.specialty, h.organisation, place(h)].filter(Boolean).join(' · ')} · <span className="person-id">{h.external_id}</span></span>
                          </span>
                          <span className={`person-tag${r.option ? ' in-ec' : ''}`}>{busy ? 'Adding…' : r.option ? 'In EC' : 'Add from CRM'}</span>
                        </div>
                      ); })}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {importing.error && <div className="form-error person-error" role="alert">{importing.error.message}</div>}
        </div>
      )}
    </>
  );
}
