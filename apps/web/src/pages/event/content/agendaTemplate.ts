import { useQuery } from '@tanstack/react-query';
import type { PDFDocument, PDFFont } from 'pdf-lib';
import { supabase } from '../../../lib/supabase';
import { localParts } from '../agenda/agendaData';

/**
 * Agenda templates: approved fillable PDFs from the Library. Admin maps each form field to event data
 * (content.template_fields); the event fills them, flattens the form and downloads the result.
 */

/** A form field in the PDF, in reading order. */
export interface TemplateField {
  name: string; kind: 'text' | 'choice' | 'other'; value: string;
  /** Choice fields: the approved options, and whether other text is allowed too. */
  options: string[]; editable: boolean;
}
export interface FieldMapping { source: string; row?: number; label?: string }
export type TemplateFields = Record<string, FieldMapping>;
export interface FieldSource { code: string; label: string; grp: 'event' | 'contact' | 'session' | 'other'; sort: number }

export function useFieldSources() {
  return useQuery({
    queryKey: ['template_field_source'], staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.from('template_field_source').select('*').order('sort');
      if (error) throw error;
      return data as FieldSource[];
    },
  });
}

/** The form fields of a PDF, top to bottom and left to right, page by page. */
export async function readTemplateFields(bytes: ArrayBuffer): Promise<TemplateField[]> {
  // pdf-lib is large, so it loads only when a template is used
  const { PDFDocument, PDFDropdown, PDFTextField } = await import('pdf-lib');
  let doc: PDFDocument;
  try { doc = await PDFDocument.load(bytes); } catch { throw new Error("This file couldn't be read as a PDF"); }
  const pages = doc.getPages();
  const annots = pages.map((p) => p.node.Annots()?.asArray() ?? []);
  const placed = doc.getForm().getFields().map((f) => {
    const w = f.acroField.getWidgets()[0];
    const ref = w ? doc.context.getObjectRef(w.dict) : undefined;
    const page = Math.max(0, annots.findIndex((a) => ref && a.includes(ref)));
    const r = w?.getRectangle() ?? { x: 0, y: 0, width: 0, height: 0 };
    const field: TemplateField = f instanceof PDFTextField ? { name: f.getName(), kind: 'text', value: f.getText() ?? '', options: [], editable: true }
      : f instanceof PDFDropdown ? { name: f.getName(), kind: 'choice', value: f.getSelected()[0] ?? '', options: f.getOptions().filter((o) => o.trim()), editable: f.isEditable() }
      : { name: f.getName(), kind: 'other', value: '', options: [], editable: false };
    return { field, page, top: Math.round(pages[page].getHeight() - r.y - r.height), left: r.x };
  });
  if (!placed.length) throw new Error('This PDF has no fillable fields, so there is nothing for an event to fill in');
  // Fields on one line (within a few points) read left to right
  placed.sort((a, b) => a.page - b.page || (Math.abs(a.top - b.top) > 4 ? a.top - b.top : a.left - b.left));
  return placed.map((p) => p.field);
}

/** A first guess at what fills each field, from its name. Rows count fields of a kind top to bottom. */
export function suggestMapping(fields: TemplateField[]): TemplateFields {
  const out: TemplateFields = {};
  const rows: Record<string, number> = {};
  const row = (source: string) => (rows[source] = (rows[source] ?? 0) + 1);
  for (const f of fields) {
    const n = f.name.toLowerCase().replace(/[_\-.]+/g, ' ');
    const m: FieldMapping | null =
      /job|prep|code/.test(n) ? null
      : /speaker|presenter/.test(n) ? { source: 'session.speakers', row: row('session.speakers') }
      : /time ?row|time \d|session time/.test(n) ? { source: 'session.time', row: row('session.time') }
      : /^(meeting|event) (title|name)|^title\b/.test(n) ? { source: 'event.name' }
      : f.kind === 'choice' || /session|agenda item|topic/.test(n) ? { source: 'session.title', row: row('session.title') }
      : /^date$|meeting date|event date/.test(n) ? { source: 'event.date' }
      : /^time$|meeting time|event time/.test(n) ? { source: 'event.time' }
      : /address|venue detail/.test(n) ? { source: 'event.address' }
      : /venue|location/.test(n) ? { source: 'event.venue' }
      : /city/.test(n) ? { source: 'event.city' }
      : /chair/.test(n) ? { source: 'chair.name' }
      : /e ?mail/.test(n) ? { source: 'contact.email' }
      : /phone|number|mobile/.test(n) ? { source: 'ask', label: 'Contact number' }
      : /contact|^name$/.test(n) ? { source: 'contact.name' }
      : null;
    if (m) out[f.name] = m;
  }
  return out;
}

export interface AgendaContext {
  name: string; event_number: string | null; venue_name: string | null; venue_address: string | null; city: string | null;
  starts_at: string | null; ends_at: string | null; timezone: string;
  owner: { display_name: string; email: string | null } | null;
  chairs: string[];
  sessions: { starts_at: string; ends_at: string; title: string; speakers: string[] }[];
}

const dateFmt = (tz: string, withDay: boolean) => new Intl.DateTimeFormat('en-GB', {
  timeZone: tz, day: 'numeric', month: 'long', year: 'numeric', ...(withDay ? { weekday: 'long' } : {}),
});

/** What each mapped field says for this event. "Ask" fields start empty; unmapped fields aren't listed. */
export function agendaValues(mapping: TemplateFields, ev: AgendaContext): Record<string, string> {
  const tz = ev.timezone;
  const start = ev.starts_at ?? ev.sessions[0]?.starts_at ?? null;
  const end = ev.ends_at ?? ev.sessions[ev.sessions.length - 1]?.ends_at ?? null;
  const sameDay = start && end && localParts(start, tz).date === localParts(end, tz).date;
  const date = !start ? '' : !end || sameDay ? dateFmt(tz, true).format(new Date(start)).replace(',', '') : dateFmt(tz, false).formatRange(new Date(start), new Date(end));
  const time = start && end && sameDay ? `${localParts(start, tz).time}–${localParts(end, tz).time}` : start ? localParts(start, tz).time : '';
  const fixed: Record<string, string> = {
    'event.name': ev.name, 'event.number': ev.event_number ?? '', 'event.date': date, 'event.time': time,
    'event.venue': ev.venue_name ?? ev.city ?? '', 'event.address': ev.venue_address ?? '', 'event.city': ev.city ?? '',
    'contact.name': ev.owner?.display_name ?? '', 'contact.email': ev.owner?.email ?? '', 'chair.name': ev.chairs.join(', '),
  };
  const out: Record<string, string> = {};
  for (const [field, m] of Object.entries(mapping)) {
    const s = m.row ? ev.sessions[m.row - 1] : undefined;
    out[field] = m.source === 'session.time' ? (s ? localParts(s.starts_at, tz).time : '')
      : m.source === 'session.title' ? s?.title ?? ''
      : m.source === 'session.speakers' ? s?.speakers.join(', ') ?? ''
      : fixed[m.source] ?? '';
  }
  return out;
}

/** How many agenda rows the template has room for. */
export const templateRows = (mapping: TemplateFields) =>
  Math.max(0, ...Object.values(mapping).filter((m) => m.source.startsWith('session.')).map((m) => m.row ?? 0));

/** Text the standard font can draw: accents dropped where it must, anything else left out. */
function drawable(font: PDFFont, s: string) {
  const ok = (c: string) => { try { font.widthOfTextAtSize(c, 10); return true; } catch { return false; } };
  return [...s].map((c) => (ok(c) ? c : [...c.normalize('NFD').replace(/\p{M}/gu, '')].filter(ok).join(''))).join('');
}

/**
 * Fills the template's fields and flattens the form, so what's shared can't be edited. Fields that
 * aren't in `values` keep the template's own text and look. Bold fields stay bold.
 */
export async function fillTemplate(bytes: ArrayBuffer, values: Record<string, string>): Promise<Uint8Array> {
  const { PDFDocument, PDFDropdown, PDFTextField, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes);
  const form = doc.getForm();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const [name, raw] of Object.entries(values)) {
    const f = form.getFieldMaybe(name);
    if (!(f instanceof PDFTextField || f instanceof PDFDropdown)) continue;
    const font = /bo|bold|black|heavy/i.test(f.acroField.getDefaultAppearance() ?? '') ? bold : regular;
    const text = drawable(font, raw.trim());
    if (f instanceof PDFTextField) f.setText(text || undefined);
    else if (text) f.select(text);
    else f.clear();
    f.updateAppearances(font);
  }
  form.flatten({ updateFieldAppearances: false });
  return doc.save();
}
