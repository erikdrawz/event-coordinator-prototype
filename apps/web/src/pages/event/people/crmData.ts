import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase';

export interface CrmConnectionStatus { id: string; name: string; status: 'ok' | 'unavailable'; matches: number }
export interface CrmHcp {
  crm_connection_id: string; connection_name: string; external_id: string;
  display_name: string; specialty: string | null; country_code: string | null; city: string | null;
  postal_code: string | null; organisation: string | null; onekey_id: string | null;
  /** Set when the person is already in EC (same CRM record, or same OneKey ID). */
  hcp_id: string | null;
}
export interface CrmSearch { q: string; crm_connection_id?: string; country_code?: string; specialty?: string }

/** Searches the CRM connections through crm_search_hcp() (mock CRMs today, real connectors later). */
export function useCrmSearch(params: CrmSearch | null) {
  return useQuery({
    queryKey: ['crm-search', params],
    enabled: Boolean(params),
    staleTime: 60_000,
    queryFn: async () => {
      const p = Object.fromEntries(Object.entries(params!).filter(([, v]) => v));
      const { data, error } = await supabase.rpc('crm_search_hcp', { p });
      if (error) throw new Error(error.message);
      return data as { connections: CrmConnectionStatus[]; results: CrmHcp[] };
    },
  });
}

/** The EC HCP for a CRM record, copied from the CRM (with their organisation) if it isn't in EC yet. */
export async function importCrmHcp(r: CrmHcp) {
  const { data, error } = await supabase.rpc('crm_import_hcp', { p_crm_connection_id: r.crm_connection_id, p_external_id: r.external_id });
  if (error) throw new Error(error.message);
  return data as { id: string; display_name: string; city: string | null };
}

/** Choices for the CRM filters: connections, countries and specialties. */
export function useCrmFilterOptions(enabled: boolean) {
  return useQuery({
    queryKey: ['crm-filter-options'],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const [conns, countries, specs] = await Promise.all([
        supabase.from('crm_connection').select('id,name').order('name'),
        supabase.from('country').select('code,name').order('name'),
        supabase.from('specialty').select('name').order('name'),
      ]);
      for (const r of [conns, countries, specs]) if (r.error) throw r.error;
      return {
        connections: conns.data as { id: string; name: string }[],
        countries: countries.data as { code: string; name: string }[],
        specialties: (specs.data as { name: string }[]).map((s) => s.name),
      };
    },
  });
}
