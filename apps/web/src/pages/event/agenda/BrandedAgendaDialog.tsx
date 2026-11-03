import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Eye } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { Modal } from '../../../ui/Modal';
import { Select } from '../../../ui/Select';
import { Field, FormSection } from '../../../ui/Form';
import { addEventFile, contentKey, fileBytes, type LibraryItem } from '../content/contentData';
import {
  agendaValues, fillTemplate, readTemplateFields, templateRows, useFieldSources, type AgendaContext, type TemplateField,
} from '../content/agendaTemplate';
import { speakerName, useSessions } from './agendaData';
import './branded-agenda.css';

/** The agenda templates this event can use (Library, by event type and country). */
export function useAgendaTemplates(eventId: string) {
  return useQuery({
    queryKey: [...contentKey(eventId), 'agenda-templates'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('event_agenda_templates', { p_event_id: eventId });
      if (error) throw error;
      return data as LibraryItem[];
    },
  });
}

function useAgendaContext(eventId: string) {
  const sessions = useSessions(eventId);
  const event = useQuery({
    queryKey: ['event', eventId, 'agenda-context'],
    queryFn: async () => {
      const [ev, chairs] = await Promise.all([
        supabase.from('event').select('name,event_number,venue_name,venue_address,city,starts_at,ends_at,timezone,owner:app_user!event_owner_id_fkey(display_name,email)')
          .eq('id', eventId).single(),
        supabase.from('event_expert').select('hcp(display_name)').eq('event_id', eventId).eq('role', 'chair'),
      ]);
      if (ev.error) throw ev.error;
      if (chairs.error) throw chairs.error;
      return { ...(ev.data as unknown as Omit<AgendaContext, 'chairs' | 'sessions'>),
        chairs: (chairs.data as unknown as { hcp: { display_name: string } | null }[]).map((c) => c.hcp?.display_name ?? '').filter(Boolean) };
    },
  });
  return useMemo((): AgendaContext | undefined => event.data && sessions.data && {
    ...event.data,
    sessions: sessions.data.map((s) => ({ starts_at: s.starts_at, ends_at: s.ends_at, title: s.title, speakers: s.event_session_speaker.map(speakerName) })),
  }, [event.data, sessions.data]);
}

const fileName = (s: string) => `${s.replace(/[\\/:*?"<>|]+/g, ' ').trim()} agenda.pdf`;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Makes a branded agenda from an approved template: the template's fields are filled from the event
 * and its agenda, the person checks and adjusts them, and gets a flattened PDF to share. Session titles
 * in a template that only allows its approved titles must be one of them. Editors keep a copy in Documents.
 */
export function BrandedAgendaDialog({ eventId, templates, canSave, onClose }: {
  eventId: string; templates: LibraryItem[]; canSave: boolean; onClose: () => void;
}) {
  const qc = useQueryClient();
  const sources = useFieldSources();
  const ctx = useAgendaContext(eventId);
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const template = templates.find((t) => t.id === templateId);
  const file = useQuery({
    queryKey: ['agenda-template', template?.id, template?.storage_path], enabled: Boolean(template?.storage_path),
    queryFn: async () => { const bytes = await fileBytes(template!.storage_path!); return { bytes, fields: await readTemplateFields(bytes.slice(0)) }; },
    staleTime: Infinity,
  });
  const mapping = useMemo(() => template?.template_fields ?? {}, [template]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  // Fill in from the event once per template, so a refetch doesn't undo the person's changes
  const [filledFor, setFilledFor] = useState<string | null>(null);
  useEffect(() => {
    if (ctx && filledFor !== templateId) { setValues(agendaValues(mapping, ctx)); setFilledFor(templateId); setDone(null); }
  }, [ctx, mapping, templateId, filledFor]);

  const fieldsByName = useMemo(() => new Map((file.data?.fields ?? []).map((f) => [f.name, f])), [file.data]);
  const order = (file.data?.fields ?? []).map((f) => f.name);
  const mapped = Object.entries(mapping).filter(([name]) => fieldsByName.has(name))
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  const details = mapped.filter(([, m]) => !m.source.startsWith('session.') && m.source !== 'blank');
  const rows = templateRows(mapping);
  const cell = (row: number, source: string) => mapped.find(([, m]) => m.row === row && m.source === source)?.[0];
  const columns = (['session.time', 'session.title', 'session.speakers'] as const).filter((s) => mapped.some(([, m]) => m.source === s));
  const sourceLabel = (code: string) => sources.data?.find((s) => s.code === code)?.label ?? code;
  const extra = Math.max(0, (ctx?.sessions.length ?? 0) - rows);
  // A title the template doesn't allow: a locked choice field with text that isn't one of its options
  const notAllowed = (name: string) => {
    const f = fieldsByName.get(name);
    const v = values[name]?.trim() ?? '';
    return Boolean(f && f.kind === 'choice' && !f.editable && v && !f.options.some((o) => same(o, v)));
  };
  const blocked = mapped.filter(([name]) => notAllowed(name)).length;
  const set = (name: string) => (v: string) => setValues((x) => ({ ...x, [name]: v }));

  const make = async () => {
    const pdf = await fillTemplate(file.data!.bytes.slice(0), Object.fromEntries(mapped.map(([name]) => {
      const f = fieldsByName.get(name)!;
      const v = values[name] ?? '';
      // Use the template's own wording for an approved title typed in another case
      return [name, f.kind === 'choice' ? f.options.find((o) => same(o, v)) ?? v : v];
    })));
    return new Blob([pdf as BlobPart], { type: 'application/pdf' });
  };
  const preview = useMutation({ mutationFn: async () => window.open(URL.createObjectURL(await make()), '_blank', 'noopener') });
  const download = useMutation({
    mutationFn: async () => {
      const blob = await make();
      const name = fileName(ctx!.name);
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      if (canSave) {
        await addEventFile(eventId, 'document', new File([blob], name, { type: 'application/pdf' }),
          { title: `Branded agenda: ${template!.title}`, category: 'agenda', description: `Made from the ${template!.title} template` });
        qc.invalidateQueries({ queryKey: contentKey(eventId) });
      }
      return name;
    },
    onSuccess: (name) => setDone(name),
  });
  const error = file.error ?? preview.error ?? download.error;

  const control = (name: string, label: string) => {
    const f: TemplateField | undefined = fieldsByName.get(name);
    const v = values[name] ?? '';
    if (f?.kind === 'choice' && !f.editable) {
      const bad = notAllowed(name);
      return <>
        <Select aria-label={label} aria-invalid={bad || undefined} value={bad ? '' : f.options.find((o) => same(o, v)) ?? ''} onChange={set(name)}
          placeholder={bad ? 'Pick an approved title' : 'Empty'} emptyLabel="Empty" searchable options={f.options.map((o) => ({ value: o, label: o }))} />
        {bad && <div className="ba-flag">On the agenda: “{v}”. Not an approved title.</div>}
      </>;
    }
    return <>
      <input className="input" aria-label={label} value={v} onChange={(e) => set(name)(e.target.value)} list={f?.kind === 'choice' ? `ba-${name}` : undefined} />
      {f?.kind === 'choice' && <datalist id={`ba-${name}`}>{f.options.map((o) => <option key={o} value={o} />)}</datalist>}
    </>;
  };

  return (
    <Modal open size="lg" title="Branded agenda" onClose={onClose}
      footerNote={error ? <span className="form-error" role="alert">{error.message}</span>
        : done ? <span className="ba-done">Downloaded {done}{canSave && '. A copy is in Documents.'}</span>
        : blocked ? <span className="ba-flag">Pick an approved title for {blocked === 1 ? 'one session' : `${blocked} sessions`} first.</span>
        : canSave ? <span className="text-muted">A copy is kept in Documents.</span> : null}
      footer={<>
        <button className="btn" onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
        <button className="btn" disabled={!file.data || !ctx || Boolean(blocked) || preview.isPending} onClick={() => preview.mutate()}><Eye size={14} />Preview</button>
        <button className="btn btn-primary" disabled={!file.data || !ctx || Boolean(blocked) || download.isPending} onClick={() => download.mutate()}>
          <Download size={14} />{download.isPending ? 'Making…' : 'Download PDF'}
        </button>
      </>}>
      <FormSection>
        <Field label="Template" wide hint={template?.description}>
          {(id) => templates.length > 1
            ? <Select id={id} value={templateId} onChange={setTemplateId} options={templates.map((t) => ({ value: t.id, label: t.title }))} />
            : <div id={id} className="ba-template">{template?.title}</div>}
        </Field>
      </FormSection>
      {!file.data || !ctx ? <div className="text-muted ba-loading">{file.isError ? '' : 'Reading the template…'}</div> : <>
        {details.length > 0 && (
          <FormSection title="Details">
            {details.map(([name, m]) => {
              const label = m.source === 'ask' ? m.label ?? name : sourceLabel(m.source);
              return <Field key={name} label={label}>{() => control(name, label)}</Field>;
            })}
          </FormSection>
        )}
        {rows > 0 && (
          <FormSection title="Agenda">
            <div className="ba-agenda-wrap">
              {extra > 0 && <p className="ba-note">This template has room for {rows} sessions; the agenda has {ctx.sessions.length}. The last {extra === 1 ? 'one isn’t' : `${extra} aren’t`} included.</p>}
              <div className="table-scroll">
                <table className="ba-agenda">
                  <thead><tr>{columns.map((c) => <th key={c} className={`ba-${c.slice(8)}`}>{c === 'session.time' ? 'Time' : c === 'session.title' ? 'Session' : 'Speakers'}</th>)}</tr></thead>
                  <tbody>
                    {Array.from({ length: rows }, (_, i) => i + 1).map((r) => (
                      <tr key={r} className={r > ctx.sessions.length ? 'is-spare' : undefined}>
                        {columns.map((c) => { const name = cell(r, c); return <td key={c}>{name && control(name, `Row ${r} ${c.slice(8)}`)}</td>; })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </FormSection>
        )}
      </>}
    </Modal>
  );
}
