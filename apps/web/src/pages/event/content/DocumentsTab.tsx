import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Download, FileText, MoreVertical, Paperclip, Plus, Trash2, X } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { can } from '../../../lib/permissions';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { formatDate } from '../../../ui/DateInput';
import { Menu } from '../../../ui/Menu';
import { Select } from '../../../ui/Select';
import { useEventAccess } from '../eventAccess';
import { addEventFile, contentKey, formatOf, openFile, removeEventFile, sizeOf, titleOf, useDocumentCategories, useEventFiles, type EventFile } from './contentData';
import { LibraryList } from './LibraryList';
import './content.css';

function AddDocumentRow({ categories, saving, onSave, onCancel }: {
  categories: { code: string; label: string }[]; saving: boolean; onSave: (v: { file: File | null; title: string; category: string }) => void; onCancel: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('other');
  const fileRef = useRef<HTMLInputElement>(null);
  const save = () => onSave({ file, title: title.trim(), category });
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); save(); }
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onCancel(); }
  };
  return (
    <tr className="agenda-inline" onKeyDown={onKey}>
      <td>
        <input className="input" aria-label="Title" placeholder="Title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
      </td>
      <td><Select aria-label="Category" value={category} onChange={setCategory} options={categories.map((c) => ({ value: c.code, label: c.label }))} /></td>
      <td colSpan={2}>
        <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}><Paperclip size={14} />{file ? 'Change file' : 'Choose file'}</button>
        <input ref={fileRef} type="file" hidden aria-label="File"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setTitle((t) => t || titleOf(f.name)); } e.target.value = ''; }} />
        {file && <span className="content-file">{file.name}</span>}
      </td>
      <td className="agenda-inline-actions">
        <button type="button" className="icon-btn ok" aria-label="Save document" title="Save (Enter)" disabled={saving} onClick={save}><Check size={16} /></button>
        <button type="button" className="icon-btn" aria-label="Cancel" title="Cancel (Esc)" onClick={onCancel}><X size={16} /></button>
      </td>
    </tr>
  );
}

/**
 * The event's files: the Library items it could use as content, and any other document kept with
 * the event (agendas, venue contracts, budgets, …).
 */
export function DocumentsTab({ event }: { event: { id: string; name: string } }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const { canEdit: canEditEvent } = useEventAccess();
  const files = useEventFiles(event.id);
  const categories = useDocumentCategories().data ?? [];
  const canAdd = canEditEvent && can(me, 'event_content', 'create');
  const canDelete = canEditEvent && can(me, 'event_content', 'delete');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<EventFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: contentKey(event.id) });
  const save = useMutation({
    mutationFn: async ({ file, title, category }: { file: File | null; title: string; category: string }) => {
      if (!file) throw new Error('Choose the file');
      if (!title) throw new Error('Give it a title');
      return addEventFile(event.id, 'document', file, { title, category });
    },
    onSuccess: () => { setAdding(false); setError(null); refresh(); },
    onError: (e) => setError(e.message),
  });
  const remove = useMutation({
    mutationFn: removeEventFile,
    onSuccess: () => { setRemoving(null); refresh(); },
  });
  const docs = files.data?.filter((f) => f.usage === 'document') ?? [];
  const categoryLabel = (code: string | null) => categories.find((c) => c.code === code)?.label ?? '—';

  return (
    <div className="overview">
      <section className="card ov-card" aria-labelledby="library-title">
        <div className="ov-head">
          <div className="ov-title-row">
            <h2 id="library-title" className="ov-title">Available from the Library</h2>
            <span className="card-sub">Pre-approved for this event's type and country</span>
          </div>
        </div>
        <LibraryList eventId={event.id} canAdd={canAdd} />
      </section>

      <section className="card ov-card" aria-labelledby="documents-title">
        <div className="ov-head">
          <div className="ov-title-row">
            <h2 id="documents-title" className="ov-title">Documents</h2>
            <span className="card-sub">{docs.length ? `${docs.length} document${docs.length === 1 ? '' : 's'}` : 'Anything else to keep with the event'}</span>
          </div>
          {canAdd && !adding && <div className="ov-actions"><button className="btn btn-outline btn-sm" onClick={() => { setError(null); setAdding(true); }}><Plus size={14} strokeWidth={2.6} />Upload document</button></div>}
        </div>
        {files.error && <div className="form-error" role="alert">{files.error.message}</div>}
        {files.isLoading ? <div className="ov-empty text-muted">Loading…</div> : docs.length === 0 && !adding ? (
          <div className="ov-empty"><span><strong>No documents yet.</strong> Keep agendas, venue contracts, budgets or anything else here.</span></div>
        ) : (
          <div className="table-scroll">
            <table className="agenda-table content-table" aria-label="Documents">
              <thead><tr><th>Document</th><th>Category</th><th>Added by</th><th>Added</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {adding && <AddDocumentRow categories={categories} saving={save.isPending} onSave={(v) => save.mutate(v)} onCancel={() => { setAdding(false); setError(null); }} />}
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <span className="content-name"><FileText size={16} aria-hidden /><span>
                        <button type="button" className="agenda-title as-button" onClick={() => openFile(d.content).catch((e) => setError(e.message))}>{d.content.title}</button>
                        <div className="dt-sub">{[formatOf(d.content.file_name), sizeOf(d.content.size_bytes)].filter(Boolean).join(' · ')}</div>
                      </span></span>
                    </td>
                    <td>{categoryLabel(d.category)}</td>
                    <td>{d.content.owner?.display_name ?? <span className="text-muted">—</span>}</td>
                    <td className="dt-nowrap">{formatDate(d.created_at.slice(0, 10))}</td>
                    <td className="agenda-menu">
                      <Menu label={`Actions for ${d.content.title}`} width={180}
                        items={[
                          { key: 'download', label: 'Download', icon: <Download size={14} />, onSelect: () => openFile(d.content).catch((e) => setError(e.message)) },
                          ...(canDelete ? [{ key: 'remove', label: 'Remove', icon: <Trash2 size={14} />, danger: true, onSelect: () => setRemoving(d) }] : []),
                        ]}
                        trigger={(t) => <button type="button" className="icon-btn" aria-label={`Actions for ${d.content.title}`} {...t}><MoreVertical size={16} /></button>} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
      </section>

      {removing && (
        <ConfirmDialog title="Remove this document?" confirmLabel="Remove" pending={remove.isPending} error={remove.error?.message}
          onConfirm={() => remove.mutate(removing)} onCancel={() => { setRemoving(null); remove.reset(); }}>
          <strong>{removing.content.title}</strong> and its file are deleted from this event.
        </ConfirmDialog>
      )}
    </div>
  );
}
