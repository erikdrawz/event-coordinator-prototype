import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Database, Search } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { can } from '../../../lib/permissions';
import { avatarColorFor } from '../../../lib/avatar';
import { Avatar } from '../../../components/Avatar';
import { Modal } from '../../../ui/Modal';
import { Select } from '../../../ui/Select';
import { FilterSelect } from '../../../ui/Toolbar';
import { useExpertDirectory, type ExpertRow } from '../../experts/expertsData';
import { roleLabel, useExperts } from '../speakers/speakersData';
import { useCrmFilterOptions, useCrmSearch, type CrmHcp, type CrmSearch } from '../people/crmData';
import { addAttendees, attendeesKey, type Attendee, type AttendeePick } from './attendeesData';

type Source = 'ec' | 'crm';
interface Picked { key: string; name: string; pick: AttendeePick }

const initialsOf = (n: string) => n.replace(/^(Dr|Prof)\.?\s+/i, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const matches = (text: string, q: string) => q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => text.toLowerCase().includes(w));

/**
 * Add many HCPs at once: tick people in Event Center or find them in the CRMs (copied into EC when
 * added). The selection is kept across both, and everyone is added in one call.
 */
export function AddAttendeesModal({ event, attending, onClose }: { event: { id: string; name: string }; attending: Attendee[]; onClose: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const canCrm = can(me, 'hcp', 'create');
  const [source, setSource] = useState<Source>('ec');
  const [picked, setPicked] = useState<Map<string, Picked>>(new Map());
  const attendingHcps = useMemo(() => new Set(attending.map((a) => a.hcp_id).filter(Boolean) as string[]), [attending]);

  const toggle = (p: Picked, on: boolean) => setPicked((prev) => {
    const next = new Map(prev);
    if (on) next.set(p.key, p); else next.delete(p.key);
    return next;
  });
  const pickMany = (ps: Picked[], on: boolean) => setPicked((prev) => {
    const next = new Map(prev);
    ps.forEach((p) => (on ? next.set(p.key, p) : next.delete(p.key)));
    return next;
  });

  const save = useMutation({
    mutationFn: () => addAttendees(event.id, [...picked.values()].map((p) => p.pick)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: attendeesKey(event.id) });
      qc.invalidateQueries({ queryKey: ['experts'] });
      qc.invalidateQueries({ queryKey: ['hcps'] });
      qc.invalidateQueries({ queryKey: ['crm-search'] });
      onClose();
    },
  });

  const n = picked.size;
  return (
    <Modal open size="lg" title="Add attendees" onClose={onClose}
      confirmClose={n > 0 && !save.isPending ? 'Discard the people you selected?' : false}
      footerNote={n > 0
        ? <>{n} selected · <button type="button" className="link" onClick={() => setPicked(new Map())}>Clear</button></>
        : `Invite people to ${event.name}. They start as Invited.`}
      footer={<>
        <button type="button" className="btn" onClick={onClose} disabled={save.isPending}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={() => save.mutate()} disabled={n === 0 || save.isPending}>
          {save.isPending ? 'Adding…' : n === 0 ? 'Add attendees' : `Add ${n} attendee${n === 1 ? '' : 's'}`}
        </button>
      </>}>
      <div className="segmented att-sources" role="group" aria-label="Where to find people">
        <button type="button" aria-pressed={source === 'ec'} onClick={() => setSource('ec')}>Event Center</button>
        {canCrm && <button type="button" aria-pressed={source === 'crm'} onClick={() => setSource('crm')}>CRM</button>}
        <button type="button" aria-pressed={false} disabled data-tip="Import from a file comes next">Import</button>
      </div>
      {save.error && <div className="form-error" role="alert">{save.error.message}</div>}
      {/* Both stay mounted, so a CRM search survives a look back at EC */}
      <div className="att-body">
        <div hidden={source !== 'ec'}><EcPane active={source === 'ec'} eventId={event.id} attending={attendingHcps} picked={picked} toggle={toggle} pickMany={pickMany} /></div>
        {canCrm && <div hidden={source !== 'crm'}><CrmPane active={source === 'crm'} attending={attendingHcps} picked={picked} toggle={toggle} /></div>}
      </div>
    </Modal>
  );
}

interface PaneProps { active: boolean; attending: Set<string>; picked: Map<string, Picked>; toggle: (p: Picked, on: boolean) => void }

/** Focus the pane's search box whenever the pane is shown. */
function useFocusWhen(active: boolean) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (active) ref.current?.focus(); }, [active]);
  return ref;
}

function PickRow({ name, sub, tag, checked, disabled, onChange }:
  { name: string; sub: ReactNode; tag?: ReactNode; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className={`att-pick${disabled ? ' is-disabled' : ''}${checked ? ' is-checked' : ''}`}>
      <input type="checkbox" aria-label={name} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <Avatar size={28} initials={initialsOf(name)} color={avatarColorFor(name)} />
      <span className="att-pick-text"><span className="att-pick-name">{name}</span><span className="att-pick-sub">{sub}</span></span>
      {tag && <span className="att-pick-tag">{tag}</span>}
    </label>
  );
}

/** HCPs already in Event Center; this event's experts first. */
function EcPane({ active, eventId, attending, picked, toggle, pickMany }: PaneProps & { eventId: string; pickMany: (ps: Picked[], on: boolean) => void }) {
  const searchRef = useFocusWhen(active);
  const directory = useExpertDirectory();
  const experts = useExperts(eventId);
  const [q, setQ] = useState('');
  const [country, setCountry] = useState('');
  const [specialty, setSpecialty] = useState('');
  const all = directory.data ?? [];
  const roles = useMemo(() => new Map((experts.data ?? []).map((x) => [x.hcp_id, x.role])), [experts.data]);

  const shown = all.filter((h) => (!q || matches(`${h.display_name} ${h.primary_hco?.name ?? ''} ${h.city ?? ''}`, q))
    && (!country || h.country_code === country) && (!specialty || h.specialty?.name === specialty));
  const onEvent = shown.filter((h) => roles.has(h.id));
  const others = shown.filter((h) => !roles.has(h.id));
  const asPick = (h: ExpertRow): Picked => ({ key: h.id, name: h.display_name, pick: { hcp_id: h.id } });
  const openOnEvent = onEvent.filter((h) => !attending.has(h.id));
  const allOnEventPicked = openOnEvent.length > 0 && openOnEvent.every((h) => picked.has(h.id));

  const countries = [...new Map(all.filter((h) => h.country_code).map((h) => [h.country_code!, h.country?.name ?? h.country_code!])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));
  const specialties = [...new Set(all.map((h) => h.specialty?.name).filter(Boolean) as string[])].sort().map((s) => ({ value: s, label: s }));

  const row = (h: ExpertRow) => {
    const isIn = attending.has(h.id);
    const role = roles.get(h.id);
    return (
      <PickRow key={h.id} name={h.display_name} checked={isIn || picked.has(h.id)} disabled={isIn}
        sub={[h.specialty?.name, h.primary_hco?.name, h.city].filter(Boolean).join(' · ')}
        tag={isIn ? 'Attending' : role ? roleLabel(role) : undefined} onChange={(on) => toggle(asPick(h), on)} />
    );
  };

  return (
    <div className="att-pane">
      <div className="att-filters">
        <div className="att-search"><Search size={15} aria-hidden />
          <input ref={searchRef} className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, organisation or city" aria-label="Search Event Center" />
        </div>
        <FilterSelect label="Country" value={country} onChange={setCountry} options={countries} anyLabel="Any" />
        <FilterSelect label="Specialty" value={specialty} onChange={setSpecialty} options={specialties} anyLabel="Any" />
      </div>
      {directory.error && <div className="form-error" role="alert">{directory.error.message}</div>}
      {directory.isLoading ? <div className="att-empty">Loading…</div> : (
        <div className="att-list">
          {onEvent.length > 0 && (
            <div role="group" aria-label="This event's experts">
              <div className="att-heading">
                <span>This event's experts</span>
                {openOnEvent.length > 0 && (
                  <button type="button" className="link" onClick={() => pickMany(openOnEvent.map(asPick), !allOnEventPicked)}>
                    {allOnEventPicked ? 'Clear' : 'Select all'}
                  </button>
                )}
              </div>
              {onEvent.map(row)}
            </div>
          )}
          {others.length > 0 && (
            <div role="group" aria-label="Experts">
              <div className="att-heading"><span>{onEvent.length > 0 ? 'Other experts' : 'Experts'}</span></div>
              {others.map(row)}
            </div>
          )}
          {shown.length === 0 && <div className="att-empty">No one in Event Center matches. Try the CRM tab to find them there.</div>}
        </div>
      )}
    </div>
  );
}

/** Search the CRM connections; people found there are copied into EC when they're added. */
function CrmPane({ active, attending, picked, toggle }: PaneProps) {
  const searchRef = useFocusWhen(active);
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<Omit<CrmSearch, 'q'>>({});
  const [run, setRun] = useState<CrmSearch | null>(null);
  const search = useCrmSearch(run);
  const options = useCrmFilterOptions(true);
  const tooShort = q.trim().length < 2;

  const go = (f = filters) => { if (!tooShort) setRun({ q: q.trim(), ...f }); };
  const setFilter = (k: keyof typeof filters, v: string) => {
    const f = { ...filters, [k]: v || undefined };
    setFilters(f);
    if (run) go(f);
  };
  const keyOf = (h: CrmHcp) => h.hcp_id ?? `crm:${h.crm_connection_id}:${h.external_id}`;
  const asPick = (h: CrmHcp): Picked => ({
    key: keyOf(h), name: h.display_name,
    pick: h.hcp_id ? { hcp_id: h.hcp_id } : { crm_connection_id: h.crm_connection_id, external_id: h.external_id },
  });
  const results = search.data?.results ?? [];

  return (
    <div className="att-pane">
      <form className="att-filters" onSubmit={(e) => { e.preventDefault(); go(); }}>
        <div className="att-search"><Search size={15} aria-hidden />
          <input ref={searchRef} className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or CRM ID" aria-label="Search the CRMs" />
        </div>
        <button type="submit" className="btn btn-outline btn-sm" disabled={tooShort}><Database size={14} aria-hidden />Search CRM</button>
      </form>
      <div className="att-filters">
        <Select variant="filter" label="CRM" value={filters.crm_connection_id ?? ''} onChange={(v) => setFilter('crm_connection_id', v)}
          emptyLabel="All" options={(options.data?.connections ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        <Select variant="filter" label="Country" value={filters.country_code ?? ''} onChange={(v) => setFilter('country_code', v)} searchable
          emptyLabel="Any" options={(options.data?.countries ?? []).map((c) => ({ value: c.code, label: c.name }))} />
        <Select variant="filter" label="Specialty" value={filters.specialty ?? ''} onChange={(v) => setFilter('specialty', v)}
          emptyLabel="Any" options={(options.data?.specialties ?? []).map((s) => ({ value: s, label: s }))} />
      </div>
      {search.error && <div className="form-error" role="alert">{search.error.message}</div>}
      {!run ? <div className="att-empty">Search your CRMs by name or CRM ID. People who aren't in Event Center yet are copied in when you add them.</div>
        : search.isLoading ? <div className="att-empty">Searching the CRMs…</div> : (
        <div className="att-list">
          {(search.data?.connections ?? []).map((c) => {
            const hits = results.filter((h) => h.crm_connection_id === c.id);
            return (
              <div key={c.id} role="group" aria-label={c.name}>
                <div className="att-heading">
                  <span className="att-conn"><Database size={13} aria-hidden />{c.name}</span>
                  <span className="att-heading-note">{c.status === 'unavailable' ? 'not responding' : hits.length === 0 ? 'no matches' : `${hits.length} found`}</span>
                </div>
                {hits.map((h) => {
                  const isIn = Boolean(h.hcp_id && attending.has(h.hcp_id));
                  return (
                    <PickRow key={`${h.crm_connection_id}:${h.external_id}`} name={h.display_name}
                      checked={isIn || picked.has(keyOf(h))} disabled={isIn} onChange={(on) => toggle(asPick(h), on)}
                      sub={<>{[h.specialty, h.organisation, [h.city, h.country_code].filter(Boolean).join(', ')].filter(Boolean).join(' · ')} · <span className="att-pick-id">{h.external_id}</span></>}
                      tag={isIn ? 'Attending' : h.hcp_id ? 'In EC' : undefined} />
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
