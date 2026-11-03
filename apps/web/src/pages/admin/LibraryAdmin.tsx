import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, MoreVertical, Paperclip, Pencil, Plus, Trash2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { DataTable, useTableSort, type Column } from '../../ui/DataTable';
import { SearchInput, Toolbar } from '../../ui/Toolbar';
import { Modal } from '../../ui/Modal';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { CheckboxField, Field, FormSection } from '../../ui/Form';
import { Menu } from '../../ui/Menu';
import { MultiSelect } from '../../ui/MultiSelect';
import { fileBytes, formatOf, openFile, removeFile, titleOf, uploadFile, type LibraryItem } from '../event/content/contentData';
import { readTemplateFields, suggestMapping, type TemplateField, type TemplateFields } from '../event/content/agendaTemplate';
import { TemplateFieldsEditor } from './TemplateFieldsEditor';
import '../event/content/content.css';
import { AdminPage } from './AdminLayout';
import { ADMIN_KEY, must, syncLinks, useCountries, useEventTypes } from './adminData';

type Item = LibraryItem & { event_type_content: { event_type_id: string }[] };
const KEY = [ADMIN_KEY, 'library'];

function useLibrary() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => must(supabase.from('content')
      .select('id,title,description,content_kind,template_fields,file_name,mime_type,size_bytes,storage_path,is_library,is_active,country_codes,event_type_content(event_type_id)')
      .eq('is_library', true).order('title')) as unknown as Promise<Item[]>,
  });
}

function ItemModal({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const types = useEventTypes();
  const countries = useCountries();
  const [title, setTitle] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [typeIds, setTypeIds] = useState(item?.event_type_content.map((l) => l.event_type_id) ?? []);
  const [codes, setCodes] = useState<string[]>(item?.country_codes ?? []);
  const [active, setActive] = useState(item?.is_active ?? true);
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<'presentation' | 'template'>(item?.content_kind === 'template' ? 'template' : 'presentation');
  const isTemplate = kind === 'template';
  // An agenda template's form fields, from the new file or the stored one, and what fills each
  const [fields, setFields] = useState<TemplateField[] | null>(null);
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<TemplateFields>(item?.template_fields ?? {});
  useEffect(() => {
    if (!isTemplate || (!file && !item?.storage_path)) { setFields(null); setFieldsError(null); return; }
    let live = true;
    (file ? file.arrayBuffer() : fileBytes(item!.storage_path!)).then(readTemplateFields).then((fs) => {
      if (!live) return;
      setFields(fs); setFieldsError(null);
      // A new file keeps the mapping of fields it still has and suggests the rest
      if (file) setMapping((m) => {
        const kept = Object.fromEntries(Object.entries(m).filter(([n]) => fs.some((f) => f.name === n)));
        return { ...suggestMapping(fs.filter((f) => !kept[f.name])), ...kept };
      });
    }).catch((e: Error) => { if (live) { setFields(null); setFieldsError(e.message); } });
    return () => { live = false; };
  }, [isTemplate, file, item]);

  const save = useMutation({
    mutationFn: async () => {
      if (!title.trim()) throw new Error('Give it a title');
      if (!item && !file) throw new Error('Choose the file');
      if (isTemplate && !fields) throw new Error(fieldsError ?? 'Choose a fillable PDF');
      const path = file ? await uploadFile(`library/${me!.tenant.id}`, file) : null;
      const row = {
        title: title.trim(), description: description.trim() || null, is_active: active, country_codes: codes.length ? codes : null,
        template_fields: isTemplate ? Object.fromEntries(Object.entries(mapping).filter(([n]) => fields!.some((f) => f.name === n))) : null,
        ...(file ? { file_name: file.name, mime_type: file.type || null, size_bytes: file.size, storage_path: path } : {}),
      };
      try {
        if (item) await must(supabase.from('content').update(row).eq('id', item.id));
        const id = item?.id ?? ((await must(supabase.from('content').insert({ ...row, content_kind: kind, is_library: true, owner_user_id: me!.id }).select('id').single())) as { id: string }).id;
        await syncLinks('event_type_content', 'content_id', id, 'event_type_id', item?.event_type_content.map((l) => l.event_type_id) ?? [], typeIds);
      } catch (e) { await removeFile(path); throw e; }
      if (item && file) await removeFile(item.storage_path);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEY }); onClose(); },
  });

  return (
    <Modal open size={isTemplate ? 'lg' : 'md'} title={item ? 'Edit Library item' : 'Add to the Library'} onClose={onClose}
      footerNote={save.error && <span className="form-error" role="alert">{save.error.message}</span>}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button>
      </>}>
      <FormSection title="Item">
        {!item && (
          <Field label="Kind" wide>
            {() => <div className="segmented" role="group" aria-label="Kind">
              <button type="button" aria-pressed={!isTemplate} onClick={() => setKind('presentation')}>Presentation</button>
              <button type="button" aria-pressed={isTemplate} onClick={() => setKind('template')}>Agenda template</button>
            </div>}
          </Field>
        )}
        <Field label="File" required={!item} wide error={isTemplate ? fieldsError : null}
          hint={isTemplate ? 'The approved, fillable PDF. Its fields are listed below so you can say what fills each one.' : 'Usually a presentation. Up to 50 MB.'}>
          {() => <div>
            <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}><Paperclip size={14} />{file || item ? 'Replace file' : 'Choose file'}</button>
            <input ref={fileRef} type="file" hidden aria-label="File" accept={isTemplate ? 'application/pdf' : undefined}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setTitle((t) => t || titleOf(f.name)); } e.target.value = ''; }} />
            <span className="content-file">{file?.name ?? item?.file_name}</span>
          </div>}
        </Field>
        <Field label="Title" required wide>{(id) => <input id={id} className="input" value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label="Description" wide>{(id) => <textarea id={id} className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      </FormSection>
      {isTemplate && fields && (
        <FormSection title="What fills each field">
          <TemplateFieldsEditor fields={fields} value={mapping} onChange={setMapping} />
        </FormSection>
      )}
      <FormSection title="Where it can be used">
        <Field label="Event types" wide hint="Events of these types can use it.">
          {(id) => <MultiSelect id={id} aria-label="Event types" value={typeIds} onChange={setTypeIds} placeholder="None yet"
            options={(types.data ?? []).map((t) => ({ value: t.id, label: t.name }))} />}
        </Field>
        <Field label="Countries" wide hint="Leave empty for every country.">
          {(id) => <MultiSelect id={id} aria-label="Countries" value={codes} onChange={setCodes} placeholder="All countries"
            options={(countries.data ?? []).map((c) => ({ value: c.code, label: c.name }))} />}
        </Field>
        <CheckboxField label="Active" wide checked={active} onChange={setActive} hint="Inactive items stop being offered and stay on events that already use them." />
      </FormSection>
    </Modal>
  );
}

/** Pre-approved files events can use as content, by event type and country. */
export function LibraryAdmin() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const library = useLibrary();
  const types = useEventTypes();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canEdit = can(me, 'library_item', 'edit');
  const canDelete = can(me, 'library_item', 'delete');

  const remove = useMutation({
    mutationFn: async (i: Item) => { await must(supabase.from('content').delete().eq('id', i.id)); await removeFile(i.storage_path); },
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEY }); setDeleting(null); },
  });

  const columns = useMemo<Column<Item>[]>(() => [
    { id: 'title', header: 'Item', width: '35%', sortValue: (i) => i.title, cell: (i) => <>
      <button type="button" className="dt-primary as-button" onClick={() => openFile(i).catch((e) => setError(e.message))}>{i.title}</button>
      {i.description && <div className="dt-sub">{i.description}</div>}
    </> },
    { id: 'kind', header: 'Kind', width: '12%', sortValue: (i) => i.content_kind,
      cell: (i) => <>{i.content_kind === 'template' ? 'Agenda template' : 'Presentation'}<div className="dt-sub">{formatOf(i.file_name)}</div></> },
    { id: 'types', header: 'Event types', width: '22%', cell: (i) => {
      const names = (types.data ?? []).filter((t) => i.event_type_content.some((l) => l.event_type_id === t.id)).map((t) => t.name);
      return <span className={names.length ? 'dt-sub' : 'admin-all'}>{names.length ? names.join(', ') : 'Not used by any event type yet'}</span>;
    } },
    { id: 'countries', header: 'Countries', width: '13%', cell: (i) => (i.country_codes?.length
      ? <span className="admin-codes">{i.country_codes.map((c) => <span key={c} className="admin-code">{c}</span>)}</span> : <span className="admin-all">All</span>) },
    { id: 'active', header: 'Status', width: '10%', sortValue: (i) => (i.is_active ? 0 : 1),
      cell: (i) => <span className={`pill ${i.is_active ? 'pill-green' : 'pill-grey'}`}>{i.is_active ? 'Active' : 'Inactive'}</span> },
    { id: 'menu', header: '', width: '5%', cell: (i) => (
      <Menu label={`Actions for ${i.title}`} width={160}
        items={[
          { key: 'download', label: 'Download', icon: <Download size={14} />, onSelect: () => openFile(i).catch((e) => setError(e.message)) },
          ...(canEdit ? [{ key: 'edit', label: 'Edit', icon: <Pencil size={14} />, onSelect: () => setEditing(i) }] : []),
          ...(canDelete ? [{ key: 'delete', label: 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(i) }] : []),
        ]}
        trigger={(t) => <button type="button" className="icon-btn" aria-label={`Actions for ${i.title}`} {...t}><MoreVertical size={16} /></button>} />
    ) },
  ], [types.data, canEdit, canDelete]);

  const filtered = useMemo(() => library.data?.filter((i) => !q || i.title.toLowerCase().includes(q.toLowerCase())), [library.data, q]);
  const { rows, sort, setSort } = useTableSort(filtered, columns, { columnId: 'title', dir: 'asc' });

  return (
    <AdminPage title="Library" sub="Pre-approved presentations and agenda templates. Linking one to event types and countries decides which events can use it."
      action={can(me, 'library_item', 'create') && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} strokeWidth={2.6} />Add to Library</button>}>
      <Toolbar label="Filter the Library"><SearchInput value={q} onChange={setQ} placeholder="Search the Library" /></Toolbar>
      {error && <div className="form-error" role="alert">{error}</div>}
      <DataTable label="Library" columns={columns} rows={rows} rowKey={(i) => i.id} sort={sort} onSortChange={setSort}
        loading={library.isLoading} error={library.error} empty="The Library is empty." />
      {editing && <ItemModal item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog title="Delete this item?" confirmLabel="Delete" pending={remove.isPending} error={remove.error?.message}
          onConfirm={() => remove.mutate(deleting)} onCancel={() => { setDeleting(null); remove.reset(); }}>
          <strong>{deleting.title}</strong> and its file are deleted from the Library. An item used on events can't be deleted; make it inactive instead.
        </ConfirmDialog>
      )}
    </AdminPage>
  );
}
