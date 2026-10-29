import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase';

export type ExpertRole = 'chair' | 'speaker' | 'advisor' | 'moderator' | 'panelist' | 'consultant';
export const ROLES: ExpertRole[] = ['chair', 'speaker', 'moderator', 'panelist', 'advisor', 'consultant'];
export const roleLabel = (r: string) => r[0].toUpperCase() + r.slice(1);

export interface Expert {
  id: string; hcp_id: string; role: ExpertRole;
  eligibility: 'eligible' | 'ineligible' | 'pending'; check_status: 'passed' | 'pending' | 'failed'; check_notes: string | null;
  hourly_rate: number | null; currency: string | null;
  prep_hours: number; service_hours: number; travel_hours: number; total_payable: number;
  hcp: { display_name: string; city: string | null; specialty: { name: string } | null;
         /** The expert's own eligibility, which this engagement started from */
         eligibility: 'eligible' | 'ineligible' | 'pending'; eligibility_note: string | null; tier: string | null } | null;
  /** The engagement's contracts: Work Order or Single-event Contract, and Addenda */
  contract: { id: string; contract_number: string; contract_type: string; status: string; parent_contract_id: string | null }[];
  /** Their agenda sessions; minutes null = the whole session */
  event_session_speaker: { id: string; minutes: number | null; event_session: { id: string; title: string; starts_at: string; ends_at: string } | null }[];
  created_at: string;
}

/** The latest tiering request logged for each of this event's experts, by expert. */
export function useEventTieringRequests(eventId: string) {
  return useQuery({
    queryKey: ['tiering-requests', eventId],
    queryFn: async () => {
      const { data, error } = await supabase.from('event_request').select('id,request_number,status,hcp_id')
        .eq('request_type', 'tiering').eq('related_event_id', eventId).order('created_at', { ascending: false });
      if (error) throw error;
      const byHcp = new Map<string, { id: string; request_number: string; status: string }>();
      (data ?? []).forEach((r) => { if (r.hcp_id && !byHcp.has(r.hcp_id)) byHcp.set(r.hcp_id, r); });
      return byHcp;
    },
  });
}
/** Still waiting on a decision: draft or in review. */
export const isOpenRequest = (r: { status: string } | undefined) => r?.status === 'draft' || r?.status === 'review';

export interface HcpOption { id: string; display_name: string; city: string | null; country_code: string | null; specialty: { name: string } | null }

export const expertsKey = (eventId: string) => ['event', eventId, 'experts'];

/** The event's speakers (HCP experts) with honorarium figures, contracts and how many sessions they're in. */
export function useExperts(eventId: string) {
  return useQuery({
    queryKey: expertsKey(eventId),
    queryFn: async () => {
      const { data, error } = await supabase.from('event_expert')
        .select('id,hcp_id,role,created_at,eligibility,check_status,check_notes,hourly_rate,currency,prep_hours,service_hours,travel_hours,total_payable,' +
                'hcp(display_name,city,specialty(name),eligibility,eligibility_note,tier),contract!contract_event_expert_id_fkey(id,contract_number,contract_type,status,parent_contract_id),' +
                'event_session_speaker(id,minutes,event_session(id,title,starts_at,ends_at))')
        .eq('event_id', eventId)
        .order('created_at');
      if (error) throw error;
      // numeric columns arrive as strings from some drivers; normalise once here.
      // Stable order: when they were added, then chairs first, then name (seeded speakers share a timestamp)
      const rank = (r: string) => ROLES.indexOf(r as ExpertRole);
      return (data as unknown as Expert[]).sort((a, b) =>
        a.created_at.localeCompare(b.created_at) || rank(a.role) - rank(b.role)
        || (a.hcp?.display_name ?? '').localeCompare(b.hcp?.display_name ?? '')).map((x) => ({
        ...x, prep_hours: Number(x.prep_hours), service_hours: Number(x.service_hours), travel_hours: Number(x.travel_hours),
        total_payable: Number(x.total_payable), hourly_rate: x.hourly_rate == null ? null : Number(x.hourly_rate),
      }));
    },
  });
}

/** Active HCPs in EC's own table. Small enough to load whole for now; search moves server-side when it grows. */
export function useHcps() {
  return useQuery({
    queryKey: ['hcps'], staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('hcp')
        .select('id,display_name,city,country_code,specialty(name)').eq('status', 'active').order('last_name');
      if (error) throw error;
      return data as unknown as HcpOption[];
    },
  });
}

export const hcpSub = (h: { city: string | null; specialty: { name: string } | null } | null) =>
  [h?.specialty?.name, h?.city].filter(Boolean).join(' · ');

export const money = (n: number, currency = 'EUR') =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
/** 1.5 → "1.5", 1.17 → "1.17", 2 → "2.0" */
export const hours = (n: number) => n.toFixed(Math.round(n * 100) % 10 ? 2 : 1);

export interface RatePolicy {
  mode: 'negotiable' | 'fixed'; default: number; min: number; max: number; currency: string;
  /** fmv: from the expert's FMV record valid on the event's date; none: no FMV record, so the rate is fixed at 0 */
  source: 'fmv' | 'none';
}

/** How one expert's rate may be set on this event (expert_rate_policy): from their FMV record, or fixed at 0 without one. */
export function useRatePolicy(hcpId: string | undefined, eventId: string) {
  return useQuery({
    queryKey: ['expert-rate-policy', hcpId, eventId], enabled: Boolean(hcpId), staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('expert_rate_policy', { p_hcp_id: hcpId, p_event_id: eventId });
      if (error) throw error;
      return data as RatePolicy;
    },
  });
}

/** Every expert's rate policy on this event, keyed by hcp_id (event_rate_policies). */
export function useRatePolicies(eventId: string) {
  return useQuery({
    queryKey: [...expertsKey(eventId), 'rate-policies'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('event_rate_policies', { p_event_id: eventId });
      if (error) throw error;
      return data as Record<string, RatePolicy>;
    },
  });
}
export const rateRange = (p: RatePolicy) => {
  if (p.source === 'none') return "No FMV rate for the event's date: record one on the expert's page to set a rate";
  const range = p.mode === 'fixed' ? `Fixed at ${money(p.default, p.currency)}` : `${money(p.min, p.currency)}–${money(p.max, p.currency)}`;
  return `FMV ${money(p.default, p.currency)}, negotiable ${range}`;
};
export const currencySymbol = (c = 'EUR') => new Intl.NumberFormat('en-GB', { style: 'currency', currency: c }).formatToParts(0).find((x) => x.type === 'currency')?.value ?? c;

/** Mirrors app.expert_keeps_without_sessions(): a sent or executed contract keeps a speaker without sessions. */
export const keepsWithoutSessions = (x: Pick<Expert, 'contract'>) =>
  x.contract.some((c) => c.status === 'sent' || c.status === 'executed');

/** The engagement's open Work Order or Single-event Contract (one at most), and its open addenda. */
export function mainContract(x: Pick<Expert, 'contract'>) {
  const main = x.contract.find((c) => (c.contract_type === 'work_order' || c.contract_type === 'event_contract') && c.status !== 'cancelled') ?? null;
  return { main, addenda: main ? x.contract.filter((c) => c.parent_contract_id === main.id && c.status !== 'cancelled') : [] };
}
