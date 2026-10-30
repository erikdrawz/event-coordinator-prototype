import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { daysUntil, ymdInZone } from '../../lib/format';
import { StatusPill } from '../../components/StatusPill';
import { formatDate } from '../../ui/DateInput';
import type { Column } from '../../ui/DataTable';
import { useRsvps } from '../event/attendees/attendeesData';
import { money, roleLabel } from '../event/speakers/speakersData';
import { ContractStatusPill } from '../contracts/ContractStatusPill';
import { useTypeLabel, type ContractListRow } from '../contracts/contractsData';
import type { Engagement } from './expertsData';

const empty = <span className="text-muted">—</span>;

function relative(iso: string) {
  const d = daysUntil(iso);
  return d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : d === -1 ? 'Yesterday' : d > 0 ? `In ${d} days` : `${-d} days ago`;
}

/** Events the expert was part of; shared by the card on their page and the full list. */
export function useEngagementColumns(): Column<Engagement>[] {
  const rsvps = useRsvps();
  return useMemo(() => {
    const rsvpLabel = (e: Engagement) => rsvps.data?.find((r) => r.code === e.rsvp)?.label ?? e.rsvp;
    return [
      {
        id: 'event', header: 'Event', sortValue: (e) => e.event?.name,
        cell: (e) => <>
          {e.event ? <Link to={`/events/${e.event.id}`} className="agenda-title expert-link">{e.event.name}</Link> : empty}
          <div className="dt-sub">{[e.event?.event_type?.name, e.event?.city, e.event?.country?.name].filter(Boolean).join(' · ')}</div>
        </>,
      },
      {
        id: 'date', header: 'Date', sortValue: (e) => e.event?.starts_at,
        cell: (e) => <span className="dt-nowrap">
          {e.event?.starts_at ? <>{formatDate(ymdInZone(e.event.starts_at, e.event.timezone))}<div className="dt-sub">{relative(e.event.starts_at)}</div></> : <span className="text-muted">Not scheduled</span>}
        </span>,
      },
      {
        id: 'type', header: 'Type', sortValue: (e) => e.type,
        cell: (e) => <>
          <span className={`pill ${e.type === 'expert' ? 'pill-blue' : 'pill-grey'}`}>{e.type === 'expert' ? 'Expert' : 'Attendee'}</span>
          <div className="dt-sub">{[e.role && roleLabel(e.role), e.attended ? 'Attended' : e.type === 'attendee' ? rsvpLabel(e) : null].filter(Boolean).join(' · ')}</div>
        </>,
      },
      { id: 'status', header: 'Status', cell: (e) => e.event && <StatusPill status={e.event.status} /> },
      {
        id: 'rate', header: 'Rate / h', align: 'right', sortValue: (e) => e.hourly_rate,
        cell: (e) => (e.hourly_rate != null ? money(e.hourly_rate, e.currency ?? 'EUR') : empty),
      },
      {
        id: 'honorarium', header: 'Honorarium', align: 'right', sortValue: (e) => e.total_payable,
        cell: (e) => (e.type === 'attendee' ? empty
          : e.eligibility === 'ineligible' ? <span className="text-muted" data-tip="Not eligible on this event" tabIndex={0}>—</span>
            : money(e.total_payable ?? 0, e.currency ?? 'EUR')),
      },
    ];
  }, [rsvps.data]);
}

/** The expert's contracts; shared by the card on their page and the full list. */
export function useContractColumns(): Column<ContractListRow>[] {
  const typeLabel = useTypeLabel();
  return useMemo(() => [
    { id: 'number', header: 'Contract', sortValue: (c) => c.contract_number, cell: (c) => <span className="dt-nowrap"><Link to={`/contracts/${c.id}`} className="agenda-title expert-link">{c.contract_number}</Link></span> },
    { id: 'type', header: 'Type', sortValue: (c) => typeLabel(c.contract_type), cell: (c) => typeLabel(c.contract_type) },
    { id: 'status', header: 'Status', cell: (c) => <ContractStatusPill status={c.status} /> },
    {
      id: 'term', header: 'Term', sortValue: (c) => c.start_date,
      cell: (c) => <span className="dt-nowrap">{c.start_date ? <>{formatDate(c.start_date)}{c.end_date && c.end_date !== c.start_date && <div className="dt-sub">to {formatDate(c.end_date)}</div>}</> : empty}</span>,
    },
    { id: 'event', header: 'Event', sortValue: (c) => c.event?.name, cell: (c) => (c.event ? <Link to={`/events/${c.event.id}`} className="expert-link">{c.event.name}</Link> : empty) },
    { id: 'related', header: 'Related', cell: (c) => (c.parent ? <Link to={`/contracts/${c.parent.id}`} className="expert-link">{c.parent.contract_number}</Link> : empty) },
  ], [typeLabel]);
}
