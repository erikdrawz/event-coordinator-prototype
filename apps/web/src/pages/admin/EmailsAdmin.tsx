import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { timeAgo } from '../../lib/format';
import { Avatar } from '../../components/Avatar';
import { DataTable, useTableSort, type Column } from '../../ui/DataTable';
import { FilterSelect, SearchInput, Segmented, Toolbar } from '../../ui/Toolbar';
import { PanelField, PanelSection, SidePanel } from '../../ui/SidePanel';
import { AdminPage } from './AdminLayout';

interface Lookup { code: string; label: string; tone?: string }
interface Email {
  id: string; direction: 'outbound' | 'inbound'; kind: string; status: string;
  from_address: string; to_address: string; reply_to: string | null; subject: string; body: string;
  record_type: 'event' | 'request' | null; record_id: string | null; post_id: string | null;
  in_reply_to: string | null; status_note: string | null; created_at: string; sent_at: string | null; processed_at: string | null;
  person: { display_name: string; initials: string | null; avatar_color: string | null; email: string | null } | null;
}
type Dir = 'all' | 'outbound' | 'inbound';

function useEmails() {
  return useQuery({
    queryKey: ['admin', 'emails'],
    queryFn: async () => {
      const [emails, kinds, statuses] = await Promise.all([
        supabase.from('email_message').select('*,person:app_user!email_message_user_id_fkey(display_name,initials,avatar_color,email)')
          .order('created_at', { ascending: false }).limit(500),
        supabase.from('email_kind').select('code,label').order('sort'),
        supabase.from('email_status').select('code,label,tone').order('sort'),
      ]);
      if (emails.error) throw emails.error;
      const rows = emails.data as unknown as Email[];
      // What each email is about, by name
      const ids = (t: string) => [...new Set(rows.filter((e) => e.record_type === t && e.record_id).map((e) => e.record_id!))];
      const [events, requests] = await Promise.all([
        ids('event').length ? supabase.from('event').select('id,name').in('id', ids('event')) : { data: [], error: null },
        ids('request').length ? supabase.from('event_request').select('id,title').in('id', ids('request')) : { data: [], error: null },
      ]);
      const names = new Map<string, string>([
        ...((events.data ?? []) as { id: string; name: string }[]).map((e) => [e.id, e.name] as [string, string]),
        ...((requests.data ?? []) as { id: string; title: string }[]).map((r) => [r.id, r.title] as [string, string]),
      ]);
      return { rows, names, kinds: (kinds.data ?? []) as Lookup[], statuses: (statuses.data ?? []) as Lookup[] };
    },
  });
}

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const recordLink = (e: Pick<Email, 'record_type' | 'record_id'>) =>
  e.record_type === 'event' ? `/events/${e.record_id}?tab=team` : `/requests/${e.record_id}`;

/** The email's text as a mail client shows it: our reply line set apart, quoted lines indented by depth. */
function EmailBody({ body }: { body: string }) {
  return (
    <div className="em-body">
      {body.split(/\r?\n/).map((line, i) => {
        const depth = /^(\s*>)+/.exec(line)?.[0].replace(/\s/g, '').length ?? 0;
        const text = depth ? line.replace(/^(\s*>\s?)+/, '') : line;
        const marker = /reply above this line/i.test(text);
        return <div key={i} className={`em-line${marker ? ' em-marker' : ''}${depth ? ` em-quote em-q${Math.min(depth, 3)}` : ''}`}>{text || ' '}</div>;
      })}
    </div>
  );
}

/**
 * Every email Event Center sends (mentions, approval requests) and every reply that comes back,
 * with what each reply did. Nothing is sent yet: new emails wait as Queued until an email
 * service is connected.
 */
export function EmailsAdmin() {
  const { data, isLoading, error } = useEmails();
  const [params, setParams] = useSearchParams();
  const dir = (params.get('dir') ?? 'all') as Dir;
  const status = params.get('status') ?? '';
  const q = params.get('q') ?? '';
  const [openId, setOpenId] = useState<string | null>(null);
  const setParam = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v && v !== 'all') n.set(k, v); else n.delete(k); return n; }, { replace: true });

  const kindLabel = (c: string) => data?.kinds.find((k) => k.code === c)?.label ?? c;
  const statusOf = (c: string) => data?.statuses.find((s) => s.code === c);
  const statusPill = (e: Email) => {
    const s = statusOf(e.status);
    return <span className={`pill pill-${s?.tone ?? 'grey'}`} data-tip={e.status === 'queued' ? "Waiting to be sent: Event Center isn't connected to an email service yet" : e.status_note ?? undefined}>{s?.label ?? e.status}</span>;
  };
  const about = (e: Email) => e.record_id
    ? <Link className="link" to={recordLink(e)}>{data?.names.get(e.record_id) ?? (e.record_type === 'event' ? 'Event' : 'Request')}</Link>
    : <span className="text-muted">—</span>;

  const columns = useMemo<Column<Email>[]>(() => [
    { id: 'when', header: 'When', width: '13%', sortValue: (e) => e.created_at,
      cell: (e) => <><div className="dt-nowrap">{when(e.created_at)}</div><div className="dt-sub">{timeAgo(e.created_at)}</div></> },
    { id: 'subject', header: 'Email', width: '37%', sortValue: (e) => e.subject,
      cell: (e) => (
        <span className="em-subject">
          {e.direction === 'outbound' ? <ArrowUpRight size={15} className="em-dir out" aria-label="Sent" /> : <ArrowDownLeft size={15} className="em-dir in" aria-label="Received" />}
          <span>
            <button className="dt-primary as-button" onClick={() => setOpenId(e.id)}>{e.subject}</button>
            <div className="dt-sub">{kindLabel(e.kind)}{e.direction === 'outbound' ? ' · sent' : ' · received'}</div>
          </span>
        </span>
      ) },
    { id: 'person', header: 'To / from', width: '20%', sortValue: (e) => e.person?.display_name ?? e.from_address,
      cell: (e) => e.person
        ? <span className="dt-person"><Avatar size={24} initials={e.person.initials} color={e.person.avatar_color} />
            <span>{e.person.display_name}<div className="dt-sub">{e.direction === 'outbound' ? e.to_address : 'Replied'}</div></span></span>
        : <span className="dt-sub">{e.direction === 'outbound' ? e.to_address : e.from_address}</span> },
    { id: 'about', header: 'About', width: '18%', sortValue: (e) => (e.record_id && data?.names.get(e.record_id)) || null, cell: about },
    { id: 'status', header: 'Status', width: '12%', sortValue: (e) => statusOf(e.status)?.label, cell: statusPill },
  ], [data]);

  const filtered = useMemo(() => data?.rows.filter((e) => (dir === 'all' || e.direction === dir) && (!status || e.status === status)
    && (!q || [e.subject, e.person?.display_name, e.from_address, e.to_address, e.record_id && data.names.get(e.record_id)]
      .some((v) => v?.toLowerCase().includes(q.toLowerCase())))), [data, dir, status, q]);
  const { rows, sort, setSort } = useTableSort(filtered, columns, { columnId: 'when', dir: 'desc' });

  const open = data?.rows.find((e) => e.id === openId) ?? null;
  const original = open?.in_reply_to ? data?.rows.find((e) => e.id === open.in_reply_to) : null;
  const replies = open ? (data?.rows ?? []).filter((e) => e.in_reply_to === open.id).sort((a, b) => a.created_at.localeCompare(b.created_at)) : [];

  return (
    <AdminPage title="Emails"
      sub="What Event Center emails people (mentions and approval requests) and the replies that come back. A reply is posted, or decides the request, as the person who sent it.">
      <p className="em-note">Event Center isn't connected to an email service yet, so new emails wait as Queued. The ones here from the demo data show how it works once it is.</p>
      <Toolbar label="Filter emails">
        <SearchInput value={q} onChange={(v) => setParam('q', v)} placeholder="Search subject, person or record" />
        <Segmented label="Direction" value={dir} onChange={(v) => setParam('dir', v)}
          options={[{ value: 'all', label: 'All' }, { value: 'outbound', label: 'Sent' }, { value: 'inbound', label: 'Replies' }]} />
        <FilterSelect label="Status" value={status} onChange={(v) => setParam('status', v)}
          options={(data?.statuses ?? []).map((s) => ({ value: s.code, label: s.label }))} />
      </Toolbar>
      <DataTable label="Emails" columns={columns} rows={rows} rowKey={(e) => e.id} sort={sort} onSortChange={setSort}
        loading={isLoading} error={error} empty={q || status || dir !== 'all' ? 'No emails match these filters.' : 'No emails yet.'} />

      {open && (
        <SidePanel recordKey={open.id} title={open.subject} onClose={() => setOpenId(null)}
          subtitle={<>{open.direction === 'outbound' ? `Sent to ${open.person?.display_name ?? open.to_address}` : `Reply from ${open.person?.display_name ?? open.from_address}`} · {when(open.created_at)}</>}>
          <PanelSection title={open.direction === 'outbound' ? kindLabel(open.kind) : 'Reply'}>
            <PanelField label="Status">
              <span className="em-status">{statusPill(open)}
                {open.status === 'queued' && <span className="dt-sub">Not sent: no email service is connected yet</span>}
                {open.sent_at && open.status === 'sent' && <span className="dt-sub">{when(open.sent_at)}</span>}
              </span>
            </PanelField>
            {open.direction === 'inbound' && open.status_note && (
              <PanelField label={open.status === 'failed' ? 'Why' : 'What it did'}>
                <span className={open.status === 'failed' ? 'em-failed' : undefined}>{open.status_note}</span>
                {open.status === 'processed' && open.record_id && <div><Link className="link" to={recordLink(open)}>Open {open.record_type === 'event' ? 'the discussion' : 'the request'}</Link></div>}
              </PanelField>
            )}
            <PanelField label="About">{about(open)}</PanelField>
            {original && <PanelField label="Replying to"><button className="link as-button" onClick={() => setOpenId(original.id)}>{original.subject}</button></PanelField>}
            {replies.length > 0 && (
              <PanelField label={replies.length === 1 ? 'Reply' : 'Replies'}>
                {replies.map((r) => (
                  <div key={r.id} className="em-reply">
                    <button className="link as-button" onClick={() => setOpenId(r.id)}>{when(r.created_at)}</button> {statusPill(r)}
                  </div>
                ))}
              </PanelField>
            )}
          </PanelSection>
          <section className="sp-section">
            <h3 className="sp-section-title">Message</h3>
            <div className="em-headers">
              <div><span>From</span><div>{open.from_address}</div></div>
              <div><span>To</span><div>{open.to_address}</div></div>
              {open.reply_to && <div><span>Reply-To</span><div>{open.reply_to}</div></div>}
              <div><span>Subject</span><div>{open.subject}</div></div>
            </div>
            <EmailBody body={open.body} />
          </section>
        </SidePanel>
      )}
    </AdminPage>
  );
}
