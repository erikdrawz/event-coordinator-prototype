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
  hcp: { display_name: string; city: string | null; specialty: { name: string } | null } | null;
  event_expert_contract: { contract: { contract_number: string; contract_type: string; status: string } | null }[];
  event_session_speaker: { id: string }[];
}

export interface HcpOption { id: string; display_name: string; city: string | null; country_code: string | null; specialty: { name: string } | null }

export const expertsKey = (eventId: string) => ['event', eventId, 'experts'];

/** The event's speakers (HCP experts) with honorarium figures, contracts and how many sessions they're in. */
export function useExperts(eventId: string) {
  return useQuery({
    queryKey: expertsKey(eventId),
    queryFn: async () => {
      const { data, error } = await supabase.from('event_expert')
        .select('id,hcp_id,role,created_at,eligibility,check_status,check_notes,hourly_rate,currency,prep_hours,service_hours,travel_hours,total_payable,' +
                'hcp(display_name,city,specialty(name)),event_expert_contract(contract(contract_number,contract_type,status)),event_session_speaker(id)')
        .eq('event_id', eventId)
        .order('created_at');
      if (error) throw error;
      // numeric columns arrive as strings from some drivers; normalise once here.
      // Stable order: when they were added, then chairs first, then name (seeded speakers share a timestamp)
      const rank = (r: string) => ROLES.indexOf(r as ExpertRole);
      return (data as unknown as (Expert & { created_at: string })[]).sort((a, b) =>
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

export interface RatePolicy { mode: 'negotiable' | 'fixed'; default: number; min: number; max: number; currency: string }

/** How speaker rates may be set (expert_rate_policy): today EUR 100, negotiable 80–120; later per HCP from FMV. */
export function useRatePolicy() {
  return useQuery({
    queryKey: ['expert-rate-policy'], staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('expert_rate_policy');
      if (error) throw error;
      return data as RatePolicy;
    },
  });
}
export const rateRange = (p: RatePolicy) => (p.mode === 'fixed' ? `Fixed at ${money(p.default, p.currency)}` : `Negotiable: ${money(p.min, p.currency)}–${money(p.max, p.currency)}`);
export const currencySymbol = (c = 'EUR') => new Intl.NumberFormat('en-GB', { style: 'currency', currency: c }).formatToParts(0).find((x) => x.type === 'currency')?.value ?? c;

/** Mirrors app.expert_keeps_without_sessions(): a sent or executed contract keeps a speaker without sessions. */
export const keepsWithoutSessions = (x: Pick<Expert, 'event_expert_contract'>) =>
  x.event_expert_contract.some((c) => c.contract?.status === 'sent' || c.contract?.status === 'executed');
