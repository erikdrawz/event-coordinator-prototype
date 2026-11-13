import { useQuery } from '@tanstack/react-query';
import { UsersRound } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Avatar } from './Avatar';
import { formatDate } from '../ui/DateInput';
import { ViaEmail } from '../ui/ViaEmail';
import './approval.css';

interface Who { display_name: string; initials: string | null; avatar_color: string | null }
interface Task {
  id: string; step_number: number; step_name: string; approver_type: 'manager' | 'group' | 'user'; status: TaskStatus;
  decided_at: string | null; decided_via: string | null; comment: string | null;
  approver: Who | null; decider: Who | null; group: { name: string } | null;
}
type TaskStatus = 'waiting' | 'pending' | 'approved' | 'rejected' | 'cancelled';
interface Approval {
  id: string; process_name: string; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; submitted_at: string;
  submitter: { display_name: string } | null;
  approval_task: Task[];
}

const WHO = 'display_name,initials,avatar_color';
const TASK_PILL: Record<TaskStatus, [string, string]> = {
  waiting: ['Not started', 'pill-grey'], pending: ['To decide', 'pill-yellow'], approved: ['Approved', 'pill-green'],
  rejected: ['Rejected', 'pill-red'], cancelled: ['Cancelled', 'pill-grey'],
};
const APPROVAL_PILL: Record<Approval['status'], [string, string]> = {
  pending: ['In progress', 'pill-yellow'], approved: ['Approved', 'pill-green'], rejected: ['Rejected', 'pill-red'], cancelled: ['Withdrawn', 'pill-grey'],
};

/**
 * The latest approval of a request or an event: its process, who submitted it, and each step's
 * approvers with what they decided. Nothing until it's first submitted.
 */
export function ApprovalCard({ recordType, recordId }: { recordType: 'request' | 'event'; recordId: string }) {
  const { data } = useQuery({
    queryKey: [recordType, recordId, 'approval'],
    queryFn: async () => {
      const { data, error } = await supabase.from('approval')
        .select(`id,process_name,status,submitted_at,submitter:app_user!approval_submitted_by_fkey(display_name),` +
                `approval_task(id,step_number,step_name,approver_type,status,decided_at,decided_via,comment,` +
                `approver:app_user!approval_task_approver_id_fkey(${WHO}),decider:app_user!approval_task_decided_by_fkey(${WHO}),group:user_group(name))`)
        .eq('record_type', recordType).eq('record_id', recordId).order('submitted_at', { ascending: false }).limit(1);
      if (error) throw error;
      return (data as unknown as Approval[])[0] ?? null;
    },
  });
  if (!data) return null;

  const steps = [...new Set(data.approval_task.map((t) => t.step_number))].sort((a, b) => a - b);
  const [label, tone] = APPROVAL_PILL[data.status];
  const submitter = data.submitter?.display_name ?? null;
  return (
    <section className="card approval-card" aria-labelledby="approval-title">
      <div className="ov-head">
        <div className="ov-title-row">
          <h2 id="approval-title" className="ov-title">Approval</h2>
          <span className={`pill ${tone}`}>{label}</span>
        </div>
      </div>
      <p className="team-intro">{data.process_name} · submitted {submitter ? `by ${submitter} ` : ''}on {formatDate(data.submitted_at.slice(0, 10))}</p>
      <ol className="approval-steps">
        {steps.map((n, i) => {
          const tasks = data.approval_task.filter((t) => t.step_number === n).sort((a, b) => a.step_name.localeCompare(b.step_name));
          return (
            <li key={n} className="approval-step">
              <div className="approval-step-head">Step {i + 1}{tasks.length > 1 && <span className="text-muted"> · in parallel</span>}</div>
              <ul className="team-list">
                {tasks.map((t) => <TaskRow key={t.id} t={t} submitter={submitter} />)}
              </ul>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function TaskRow({ t, submitter }: { t: Task; submitter: string | null }) {
  const [label, tone] = TASK_PILL[t.status];
  const name = t.approver?.display_name ?? t.group?.name ?? 'Former approver';
  const role = t.approver_type === 'manager'
    ? (t.approver ? `${submitter ?? 'The submitter'}'s manager` : 'No manager: their fallback group')
    : t.group ? 'Any one member decides' : null;
  const decided = t.status === 'approved' || t.status === 'rejected';
  return (
    <li className="team-member approval-task">
      {t.approver
        ? <Avatar size={32} initials={t.approver.initials} color={t.approver.avatar_color} />
        : <span className="team-group-icon" aria-hidden><UsersRound size={17} /></span>}
      <div className="team-who">
        <span className="team-name"><span className="team-name-text">{name}</span></span>
        <span className="team-sub">{[t.step_name, role].filter(Boolean).join(' · ')}</span>
        {decided && (
          <span className="approval-decision">
            {t.status === 'approved' ? 'Approved' : 'Rejected'}{t.decider && t.decider.display_name !== name ? ` by ${t.decider.display_name}` : ''}
            {t.decided_at && ` · ${formatDate(t.decided_at.slice(0, 10))}`}
            {t.decided_via === 'email' && <ViaEmail tip="Decided by replying to the approval request email" />}
          </span>
        )}
        {t.comment && <span className="approval-comment">{t.comment}</span>}
      </div>
      <div className="team-role"><span className={`pill ${tone}`}>{label}</span></div>
    </li>
  );
}
