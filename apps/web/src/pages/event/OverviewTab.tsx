import { AgendaSection } from './agenda/AgendaSection';

interface EventLite { id: string; timezone: string; starts_at: string | null; ends_at: string | null }

/** Overview, in event-page.png order: agenda, speakers, content. */
export function OverviewTab({ event }: { event: EventLite }) {
  return (
    <div className="overview">
      <AgendaSection event={event} />
      <section className="card ov-card ov-coming">
        <div className="ov-title-row"><h2 className="ov-title">Speakers</h2><span className="card-sub">Coming next: honorarium grid, checks and contracts</span></div>
      </section>
      <section className="card ov-card ov-coming">
        <div className="ov-title-row"><h2 className="ov-title">Content</h2><span className="card-sub">Coming after Speakers: presentations and their review status</span></div>
      </section>
    </div>
  );
}
