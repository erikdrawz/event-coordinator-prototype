import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCheck, Download, FileText, Library, MoreVertical, Paperclip, Pencil, Plus, Send, Trash2, Undo2, X } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { can } from '../../../lib/permissions';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { Menu, type MenuItem } from '../../../ui/Menu';
import { Modal } from '../../../ui/Modal';
import { useEventAccess } from '../eventAccess';
import {
  addEventFile, contentKey, formatOf, openFile, removeEventFile, saveDetails, setContentStatus, titleOf, useContentStatuses, useEventFiles,
  type ContentStatus, type EventFile,
} from './contentData';
import { LibraryList } from './LibraryList';
import './content.css';

/** A row typed straight into the table: a new upload, or the details of an existing one. */
function ContentRow({ initial, saving, onSave, onCancel }: {
  initial?: EventFile; saving: boolean; onSave: (v: { title: string; description: string; file: File | null }) => void; onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.content.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fromLibrary = initial?.content.is_library;
  const save = () => onSave({ title: title.trim(), description, file });
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };
  return (
    <tr className="agenda-inline" onKeyDown={onKey}>
      <td>
        <input className="input" aria-label="Title" placeholder="Title" autoFocus={!fromLibrary} disabled={fromLibrary} value={title} onChange={(e) => setTitle(e.target.value)} />
        <input className="input content-desc" aria-label="Description" placeholder="Description, e.g. who presents it" value={description} onChange={(e) => setDescription(e.target.value)} />
      </td>
      <td colSpan={3}>
        {initial ? <span className="text-muted">{initial.content.file_name}</span> : <>
          <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}><Paperclip size={14} />{file ? 'Change file' : 'Choose file'}</button>
          <input ref={fileRef} type="file" hidden aria-label="File"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setTitle((t) => t || titleOf(f.name)); } e.target.value = ''; }} />
          {file && <span className="content-file">{file.name}</span>}
        </>}
      </td>
      <td className="agenda-inline-actions">
        <button type="button" className="icon-btn ok" aria-label="Save" title="Save (Enter)" disabled={saving} onClick={save}><Check size={16} /></button>
        <button type="button" className="icon-btn" aria-label="Cancel" title="Cancel (Esc)" onClick={onCancel}><X size={16} /></button>
      </td>
    </tr>
  );
}

/**
 * What gets presented at the event: bespoke uploads, which go through approval from their row's
 * menu, and pre-approved items from the Library.
 */
export function ContentSection({ eventId }: { eventId: string }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const { canEdit: canEditEvent } = useEventAccess();
  const files = useEventFiles(eventId);
  const statuses = useContentStatuses();
  const canAdd = canEditEvent && can(me, 'event_content', 'create');
  const canEdit = canEditEvent && can(me, 'event_content', 'edit');
  const canDelete = canEditEvent && can(me, 'event_content', 'delete');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [picking, setPicking] = useState(false);
  const [removing, setRemoving] = useState<EventFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: contentKey(eventId) });
  const fail = (e: Error) => setError(e.message);
  const save = useMutation({
    mutationFn: async ({ row, title, description, file }: { row: EventFile | null; title: string; description: string; file: File | null }) => {
      if (!title) throw new Error('Give it a title');
      if (row) return saveDetails(row, title, description);
      if (!file) throw new Error('Choose the file');
      return addEventFile(eventId, 'presentation', file, { title, description });
    },
    onSuccess: () => { setEditing(null); setError(null); refresh(); },
    onError: fail,
  });
  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: ContentStatus }) => setContentStatus(id, status),
    onSuccess: () => { setError(null); refresh(); },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: removeEventFile,
    onSuccess: () => { setRemoving(null); refresh(); },
  });
  const cancel = () => { setEditing(null); setError(null); };

  const list = files.data?.filter((f) => f.usage === 'presentation') ?? [];
  const approved = list.filter((f) => f.review_status === 'approved').length;
  const status = (code: string | null) => statuses.data?.find((s) => s.code === code);
  const menuFor = (f: EventFile): MenuItem[] => {
    const open = editing === null;
    return [
      { key: 'download', label: 'Download', icon: <Download size={14} />, onSelect: () => openFile(f.content).catch(fail) },
      ...(canEdit && open ? [{ key: 'edit', label: 'Edit details', icon: <Pencil size={14} />, onSelect: () => { setError(null); setEditing(f.id); } }] : []),
      ...(canEdit && !f.content.is_library && f.review_status === 'draft' ? [{ key: 'submit', label: 'Submit for approval', icon: <Send size={14} />, onSelect: () => move.mutate({ id: f.id, status: 'pending' }) }] : []),
      ...(canEdit && f.review_status === 'pending' ? [
        { key: 'approve', label: 'Approve', icon: <CheckCheck size={14} />, onSelect: () => move.mutate({ id: f.id, status: 'approved' }) },
        { key: 'back', label: 'Back to draft', icon: <Undo2 size={14} />, onSelect: () => move.mutate({ id: f.id, status: 'draft' }) },
      ] : []),
      ...(canDelete ? [{ key: 'remove', label: 'Remove from event', icon: <Trash2 size={14} />, danger: true, onSelect: () => setRemoving(f) }] : []),
    ];
  };

  return (
    <section className="card ov-card" aria-labelledby="content-title">
      <div className="ov-head">
        <div className="ov-title-row">
          <h2 id="content-title" className="ov-title">Content</h2>
          <span className="card-sub">{list.length ? `${list.length} item${list.length === 1 ? '' : 's'} · ${approved} approved` : ''}</span>
        </div>
        {canAdd && editing === null && (
          <div className="ov-actions">
            <button className="btn btn-outline btn-sm" onClick={() => setPicking(true)}><Library size={14} />From Library</button>
            <button className="btn btn-outline btn-sm" onClick={() => { setError(null); setEditing('new'); }}><Plus size={14} strokeWidth={2.6} />Upload bespoke</button>
          </div>
        )}
      </div>
      {files.error && <div className="form-error" role="alert">{files.error.message}</div>}
      {files.isLoading ? <div className="ov-empty text-muted">Loading…</div> : list.length === 0 && editing !== 'new' ? (
        <div className="ov-empty"><span><strong>No content yet.</strong> Upload a bespoke presentation, or pick a pre-approved one from the Library.</span></div>
      ) : (
        <div className="table-scroll">
          <table className="agenda-table content-table" aria-label="Content">
            <thead><tr><th>Content</th><th>Source</th><th>Format</th><th>Status</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {editing === 'new' && <ContentRow saving={save.isPending} onSave={(v) => save.mutate({ row: null, ...v })} onCancel={cancel} />}
              {list.map((f) => {
                if (editing === f.id) return <ContentRow key={f.id} initial={f} saving={save.isPending} onSave={(v) => save.mutate({ row: f, ...v })} onCancel={cancel} />;
                const st = status(f.review_status);
                return (
                  <tr key={f.id}>
                    <td>
                      <span className="content-name"><FileText size={16} aria-hidden /><span>
                        <button type="button" className="agenda-title as-button" onClick={() => openFile(f.content).catch(fail)}>{f.content.title}</button>
                        {f.description && <div className="dt-sub">{f.description}</div>}
                      </span></span>
                    </td>
                    <td>{f.content.is_library ? 'Library' : 'Bespoke'}</td>
                    <td>{formatOf(f.content.file_name)}</td>
                    <td className="dt-nowrap">
                      {st && <span className={`pill pill-${st.tone}`}>{st.label}</span>}
                      {f.dms_reference && <div className="dt-sub" data-tip="Its reference in the document system" tabIndex={0}>{f.dms_reference}</div>}
                    </td>
                    <td className="agenda-menu">
                      <Menu label={`Actions for ${f.content.title}`} width={200} items={menuFor(f)}
                        trigger={(t) => <button type="button" className="icon-btn" aria-label={`Actions for ${f.content.title}`} {...t}><MoreVertical size={16} /></button>} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
      {picking && (
        <Modal open title="Add from the Library" size="lg" onClose={() => setPicking(false)}
          footer={<button className="btn" onClick={() => setPicking(false)}>Done</button>}>
          <LibraryList eventId={eventId} canAdd={canAdd} />
        </Modal>
      )}
      {removing && (
        <ConfirmDialog title="Remove from this event?" confirmLabel="Remove" pending={remove.isPending} error={remove.error?.message}
          onConfirm={() => remove.mutate(removing)} onCancel={() => { setRemoving(null); remove.reset(); }}>
          <strong>{removing.content.title}</strong> {removing.content.is_library ? 'comes off this event and stays in the Library.' : 'is removed from this event and its file is deleted.'}
        </ConfirmDialog>
      )}
    </section>
  );
}
