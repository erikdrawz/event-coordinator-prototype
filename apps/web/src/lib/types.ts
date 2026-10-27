// Hand-written for Phase 0. Replace with `supabase gen types typescript` output as the schema grows.

export type UserType = 'human' | 'agent';

export interface Me {
  id: string;
  user_type: UserType;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  job_title: string | null;
  initials: string | null;
  avatar_color: string | null;
  /** Home country; new events default to it. */
  country_code: string | null;
  /** Countries this user may create events in. */
  event_countries: string[];
  profile: { id: string; name: string; is_admin: boolean; can_access_admin: boolean };
  tenant: { id: string; name: string; brand_name: string; brand_color: string };
  permissions: Record<string, { read: boolean; create: boolean; edit: boolean; delete: boolean }>;
}

export type NotificationKind =
  | 'approval_required' | 'mention' | 'new_request' | 'approved' | 'rejected' | 'event_update' | 'task_assigned';

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  record_type: string | null;
  record_id: string | null;
  read_at: string | null;
  created_at: string;
}

export type EventStatus = 'draft' | 'review' | 'contract' | 'execution' | 'closed' | 'cancelled';
export type Tone = 'green' | 'yellow' | 'red' | 'blue' | 'purple' | 'grey';
