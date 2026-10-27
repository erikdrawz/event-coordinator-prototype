import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Agenda } from './home/Agenda';
import { MiniCalendar } from './home/MiniCalendar';
import { NeedsMyAction } from './home/NeedsMyAction';
import { UnassignedRequests } from './home/UnassignedRequests';
import { RecentlyWorkedOn } from './home/RecentlyWorkedOn';
import { useEventForm } from './event/EventFormProvider';
import { can, canCreateEvents } from '../lib/permissions';
import type { Scope, When } from './home/queries';
import './home.css';

/** Home 4a: create + calendar + recent | agenda | needs my action + unassigned requests. */
export function HomePage() {
  const { me } = useAuth();
  const [scope, setScope] = useState<Scope>('mine');
  const [when, setWhen] = useState<When>('upcoming');
  const { openNewEvent } = useEventForm();
  if (!me) return null;

  // Buttons follow object permissions for clarity; the database enforces them regardless.
  const mayCreate = can(me, 'event', 'create');       // profile allows it…
  const canCreateEvent = canCreateEvents(me);          // …and the user has a country to create in
  const canCreateRequest = can(me, 'event_request', 'create');

  return (
    <main className="home">
      <div className="home-left">
        {(mayCreate || canCreateRequest) && (
          <div className="home-create">
            {mayCreate && <button className="btn btn-primary btn-lg btn-block" onClick={openNewEvent} disabled={!canCreateEvent}
              title={canCreateEvent ? undefined : "You don't create events in any country yet. Ask an admin to add your countries."}>
              <Plus size={15} strokeWidth={2.6} />New event…</button>}
            {canCreateRequest && <Link to="/requests" className="btn btn-lg btn-block">New request…</Link>}
          </div>
        )}
        <MiniCalendar meId={me.id} scope={scope} />
        <RecentlyWorkedOn meId={me.id} />
      </div>

      <Agenda meId={me.id} scope={scope} onScope={setScope} when={when} onWhen={setWhen} canCreate={canCreateEvent} />

      <div className="home-right">
        <NeedsMyAction meId={me.id} />
        <UnassignedRequests />
      </div>
    </main>
  );
}
