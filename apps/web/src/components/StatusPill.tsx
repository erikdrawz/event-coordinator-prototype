import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import type { EventStatus, Tone } from '../lib/types';

interface StatusRow { code: EventStatus; label: string; home_label: string; tone: Tone; sort: number }

/** Lifecycle labels and tones come from the database (event_status), not from UI code. */
export function useEventStatuses() {
  return useQuery({
    queryKey: ['event_status'],
    staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.from('event_status').select('code,label,home_label,tone,sort').order('sort');
      if (error) throw error;
      return data as StatusRow[];
    },
  });
}

/** Allowed lifecycle moves (event_status_transition), so actions only offer valid next steps. */
export function useStatusTransitions() {
  return useQuery({
    queryKey: ['event_status_transition'],
    staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.from('event_status_transition').select('from_status,to_status');
      if (error) throw error;
      return data as { from_status: EventStatus; to_status: EventStatus }[];
    },
  });
}

export function StatusPill({ status, variant = 'stage' }: { status: EventStatus; variant?: 'stage' | 'home' }) {
  const { data } = useEventStatuses();
  const row = data?.find((s) => s.code === status);
  if (!row) return null;
  return <span className={`pill pill-${row.tone}`}>{variant === 'home' ? row.home_label : row.label}</span>;
}
