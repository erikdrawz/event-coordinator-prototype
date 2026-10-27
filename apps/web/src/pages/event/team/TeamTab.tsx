import { useAuth } from '../../../lib/auth';
import { can } from '../../../lib/permissions';
import { useEventAccess } from '../eventAccess';
import { Discussion } from './Discussion';
import { TeamPanel } from './TeamPanel';

/** Team tab: the discussion board (two thirds) and who's on the team (one third). */
export function TeamTab({ event }: { event: { id: string; name: string } }) {
  const { me } = useAuth();
  const { canEdit } = useEventAccess();
  return (
    <div className="team-tab">
      <Discussion eventId={event.id} eventName={event.name} canEditEvent={canEdit && can(me, 'event_post', 'delete')} />
      <TeamPanel eventId={event.id} canEditEvent={canEdit} />
    </div>
  );
}
