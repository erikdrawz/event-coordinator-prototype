import { createContext, useContext, useState, type ReactNode } from 'react';
import { EventFormModal } from './EventFormModal';

interface Ctx { openNewEvent: () => void; openEditEvent: (id: string) => void }
const EventFormContext = createContext<Ctx | null>(null);

/** Lets any page open the New/Edit event modal on top of itself. */
export function EventFormProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ eventId?: string } | null>(null);
  return (
    <EventFormContext.Provider value={{ openNewEvent: () => setState({}), openEditEvent: (id) => setState({ eventId: id }) }}>
      {children}
      {state && <EventFormModal eventId={state.eventId} onClose={() => setState(null)} />}
    </EventFormContext.Provider>
  );
}

export function useEventForm() {
  const ctx = useContext(EventFormContext);
  if (!ctx) throw new Error('useEventForm must be used inside EventFormProvider');
  return ctx;
}
