import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { timeAgo } from '../lib/format';
import type { AppNotification, NotificationKind } from '../lib/types';
import { useDismiss } from './useDismiss';

const KIND_LABEL: Record<NotificationKind, string> = {
  approval_required: 'Approval required',
  mention: 'Mention',
  new_request: 'New request',
  approved: 'Approved',
  rejected: 'Rejected',
  event_update: 'Event update',
  task_assigned: 'Task assigned',
};

export function NotificationsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data = [] } = useQuery({
    queryKey: ['notifications'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('notification')
        .select('id,kind,title,body,record_type,record_id,read_at,created_at')
        .order('created_at', { ascending: false }).limit(20);
      if (error) throw error;
      return data as AppNotification[];
    },
  });
  const unread = data.filter((n) => !n.read_at).length;

  const markRead = useMutation({
    mutationFn: async (ids: string[] | null) => {
      const { error } = await supabase.rpc('mark_notifications_read', { p_ids: ids });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  function openNotification(n: AppNotification) {
    if (!n.read_at) markRead.mutate([n.id]);
    setOpen(false);
    if (n.record_type === 'event' && n.record_id) navigate(`/events/${n.record_id}`);
    else if (n.record_type === 'request') navigate('/requests');
  }

  return (
    <div className="menu-anchor" ref={ref}>
      <button className="icon-button" aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}
        aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Bell size={18} />
        {unread > 0 && <span className="unread-dot" />}
      </button>
      {open && (
        <div className="menu" role="dialog" aria-label="Notifications" style={{ width: 380 }}>
          <div className="menu-header">
            <span className="menu-title">Notifications</span>
            {unread > 0 && (
              <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 'var(--text-base)', color: 'var(--color-accent)' }}
                onClick={() => markRead.mutate(null)}>Mark all read</button>
            )}
          </div>
          {data.length === 0 ? (
            <div className="empty-state"><div className="empty-state-title">You're all caught up</div>Approvals, mentions and new requests land here.</div>
          ) : (
            <ul className="notif-list">
              {data.map((n) => (
                <li key={n.id} className={`notif${n.read_at ? '' : ' unread'}`} onClick={() => openNotification(n)}>
                  <span className="notif-dot" />
                  <div>
                    <div className="notif-kind">{KIND_LABEL[n.kind]}</div>
                    <div className="notif-text"><strong>{n.title}</strong> {n.body}</div>
                    <div className="notif-when">{timeAgo(n.created_at)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
