import { ATTENDEE_TYPE_LABEL, attendeeName, type Attendee, type AttendeeType } from '../attendees/attendeesData';
import { money } from './spendData';

const GROUPS: AttendeeType[] = ['expert', 'attendee', 'user'];

/** The even share each person gets, as split_spend() will store it (leftover cents to the first). */
export function shareOf(amount: number, n: number) {
  if (!n || !amount) return null;
  const cents = Math.round(amount * 100);
  return { base: Math.floor(cents / n) / 100, extra: cents % n };
}

/**
 * Who received a spend line: tick one person (an expert's hotel) or several (a dinner, split evenly).
 * Colleagues count towards the per-head value but aren't reported.
 */
export function RecipientPicker({ attendees, selected, amount, currency, onChange }: {
  attendees: Attendee[]; selected: string[]; amount: number; currency: string; onChange: (ids: string[]) => void;
}) {
  const set = new Set(selected);
  const toggle = (id: string) => onChange(set.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const attended = attendees.filter((a) => a.attended).map((a) => a.id);
  const accepted = attendees.filter((a) => a.rsvp === 'accepted').map((a) => a.id);
  const share = shareOf(amount, selected.length);
  const quick = [
    attended.length > 0 && { label: `Everyone who attended (${attended.length})`, ids: attended },
    accepted.length > 0 && { label: `Everyone who accepted (${accepted.length})`, ids: accepted },
  ].filter(Boolean) as { label: string; ids: string[] }[];

  if (attendees.length === 0) return <p className="text-muted sp-empty">No attendees yet. Add them on the Attendees tab to record who received this.</p>;
  return (
    <div className="rp">
      <div className="rp-quick">
        {quick.map((q) => <button key={q.label} type="button" className="btn btn-sm" onClick={() => onChange(q.ids)}>{q.label}</button>)}
        {selected.length > 0 && <button type="button" className="link" onClick={() => onChange([])}>Clear</button>}
      </div>
      <div className="rp-list" role="group" aria-label="Who received it">
        {GROUPS.map((g) => {
          const rows = attendees.filter((a) => a.type === g);
          if (rows.length === 0) return null;
          return (
            <div key={g}>
              <div className="rp-group">{ATTENDEE_TYPE_LABEL[g]}s</div>
              {rows.map((a) => (
                <label key={a.id} className={`rp-row${set.has(a.id) ? ' is-on' : ''}`}>
                  <input type="checkbox" checked={set.has(a.id)} onChange={() => toggle(a.id)} aria-label={attendeeName(a)} />
                  <span className="rp-name">{attendeeName(a)}</span>
                  {a.attended && <span className="rp-tag">Attended</span>}
                </label>
              ))}
            </div>
          );
        })}
      </div>
      <p className="rp-share" aria-live="polite">
        {selected.length === 0 ? 'No one: not a transfer of value to a person (e.g. venue hire).'
          : selected.length === 1 ? `All ${money(amount, currency)} to one person.`
            : `Split evenly: ${money(share!.base, currency)} each across ${selected.length} people${share!.extra ? ` (${share!.extra} get 1 cent more)` : ''}. Colleagues count towards the share but aren't reported.`}
      </p>
    </div>
  );
}
