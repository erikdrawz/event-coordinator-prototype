import { AgendaSection } from './agenda/AgendaSection';
import { ContentSection } from './content/ContentSection';
import { SpeakersSection } from './speakers/SpeakersSection';

interface EventLite { id: string; name: string; timezone: string; starts_at: string | null; ends_at: string | null }

/** Overview, in event-page.png order: agenda, speakers, content. */
export function OverviewTab({ event }: { event: EventLite }) {
  return (
    <div className="overview">
      <AgendaSection event={event} />
      <SpeakersSection eventId={event.id} eventName={event.name} timezone={event.timezone} />
      <ContentSection eventId={event.id} />
    </div>
  );
}
