import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';

export interface EventAccess { access: 'edit' | 'view' | null; team_role: string | null }

/** My access to this event (my_event_access): the Team decides it, the database enforces it. */
export function useMyEventAccess(eventId: string | undefined) {
  return useQuery({
    queryKey: ['event', eventId, 'access'],
    enabled: Boolean(eventId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('my_event_access', { p_event_id: eventId });
      if (error) throw error;
      return data as EventAccess;
    },
  });
}

/** Shared with the event's tabs: whether I may edit this event, and my role on its team. */
export const EventAccessContext = createContext<{ canEdit: boolean; teamRole: string | null }>({ canEdit: false, teamRole: null });
export const useEventAccess = () => useContext(EventAccessContext);
