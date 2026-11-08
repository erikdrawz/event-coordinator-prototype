import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, Download, FileSignature, FileText, MoreVertical, Paperclip, Pencil, Plus, Presentation, Trash2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { DataTable, useTableSort, type Column } from '../../ui/DataTable';
import { FilterSelect, SearchInput, Toolbar } from '../../ui/Toolbar';
import { formatDate } from '../../ui/DateInput';
import { useTypeLabel } from '../contracts/contractsData';
import { Countries, forEvents, SettingsModal } from './ContractTemplatesAdmin';
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
import { ADMIN_KEY, must, syncLinks, useContractTemplates, useCountries, useEventTypes, versionStates, type ContractTemplateRow } from './adminData';

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

function ItemModal({ item, kind: newKind, onClose }: { item: Item | null; kind: 'presentation' | 'template'; onClose: () => void }) {
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
  const kind = item ? (item.content_kind === 'template' ? 'template' : 'presentation') : newKind;
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
    <Modal open size={isTemplate ? 'lg' : 'md'} title={item ? 'Edit Library item' : isTemplate ? 'Add an agenda template' : 'Add a presentation'} onClose={onClose}
      footerNote={save.error && <span className="form-error" role="alert">{save.error.message}</span>}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button>
      </>}>
      <FormSection title="Item">
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

type Kind = 'presentation' | 'template' | 'contract';
const KINDS: { value: Kind; label: string }[] = [
  { value: 'presentation', label: 'Presentation' }, { value: 'template', label: 'Agenda template' }, { value: 'contract', label: 'Contract template' },
];
/** One row of the Content library: a Library file (presentation, agenda template) or a contract template. */
type Row = { id: string; kind: Kind; title: string; active: boolean; item?: Item; tpl?: ContractTemplateRow };

/**
 * Everything pre-approved that events draw on: presentations and agenda templates (Library files) and
 * contract templates (with versions, on their own page). Linking one to event types and countries
 * decides which events can use it.
 */
export function LibraryAdmin() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const library = useLibrary();
  const templates = useContractTemplates();
  const types = useEventTypes();
  const typeLabel = useTypeLabel();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const kind = (params.get('type') ?? '') as Kind | '';
  const setParam = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const [editing, setEditing] = useState<{ item: Item | null; kind: 'presentation' | 'template' } | null>(null);
  const [addingTemplate, setAddingTemplate] = useState(false);
  const [deleting, setDeleting] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canEdit = can(me, 'library_item', 'edit');
  const canDelete = can(me, 'library_item', 'delete');

  const remove = useMutation({
    mutationFn: async (i: Item) => { await must(supabase.from('content').delete().eq('id', i.id)); await removeFile(i.storage_path); },
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEY }); setDeleting(null); },
  });

  const all = useMemo<Row[] | undefined>(() => library.data && templates.data && [
    ...library.data.map((i): Row => ({ id: i.id, kind: i.content_kind === 'template' ? 'template' : 'presentation', title: i.title, active: i.is_active, item: i })),
    ...templates.data.map((t): Row => ({ id: t.id, kind: 'contract', title: t.name, active: t.is_active, tpl: t })),
  ], [library.data, templates.data]);

  const typeNames = (ids: string[]) => (types.data ?? []).filter((t) => ids.includes(t.id)).map((t) => t.name);
  const columns = useMemo<Column<Row>[]>(() => [
    { id: 'title', header: 'Item', width: '33%', sortValue: (r) => r.title, cell: (r) => r.tpl
      ? <><Link to={`contract-templates/${r.id}`} className="dt-primary">{r.title}</Link><div className="dt-sub">{typeLabel(r.tpl.contract_type)}</div></>
      : <>
        <button type="button" className="dt-primary as-button" onClick={() => openFile(r.item!).catch((e) => setError(e.message))}>{r.title}</button>
        {r.item!.description && <div className="dt-sub">{r.item!.description}</div>}
      </> },
    { id: 'kind', header: 'Type', width: '15%', sortValue: (r) => KINDS.findIndex((k) => k.value === r.kind), cell: (r) => {
      if (!r.tpl) return <>{KINDS.find((k) => k.value === r.kind)?.label}<div className="dt-sub">{formatOf(r.item!.file_name)}</div></>;
      const states = versionStates(r.tpl.contract_template_version);
      const current = r.tpl.contract_template_version.find((v) => states.get(v.id)?.state === 'current');
      return <>Contract template<div className="dt-sub">{current ? `v${current.version} since ${formatDate(current.effective_from)}` : 'No version in effect yet'}</div></>;
    } },
    { id: 'types', header: 'Event types', width: '21%', cell: (r) => {
      if (r.tpl && !forEvents(r.tpl.contract_type)) return <span className="admin-all">Expert level, no event</span>;
      const names = typeNames(r.tpl ? r.tpl.event_type_contract_template.map((l) => l.event_type_id) : r.item!.event_type_content.map((l) => l.event_type_id));
      return <span className={names.length ? 'dt-sub' : 'admin-all'}>{names.length ? names.join(', ') : 'Not used by any event type yet'}</span>;
    } },
    { id: 'countries', header: 'Countries', width: '13%', cell: (r) => (r.tpl ? <Countries t={r.tpl} /> : r.item!.country_codes?.length
      ? <span className="admin-codes">{r.item!.country_codes.map((c) => <span key={c} className="admin-code">{c}</span>)}</span> : <span className="admin-all">All</span>) },
    { id: 'active', header: 'Status', width: '10%', sortValue: (r) => (r.active ? 0 : 1),
      cell: (r) => <span className={`pill ${r.active ? 'pill-green' : 'pill-grey'}`}>{r.active ? 'Active' : 'Inactive'}</span> },
    { id: 'menu', header: '', width: '5%', cell: (r) => (
      <Menu label={`Actions for ${r.title}`} width={160}
        items={r.tpl ? [{ key: 'open', label: 'Open', icon: <FileSignature size={14} />, onSelect: () => navigate(`contract-templates/${r.id}`) }] : [
          { key: 'download', label: 'Download', icon: <Download size={14} />, onSelect: () => openFile(r.item!).catch((e) => setError(e.message)) },
          ...(canEdit ? [{ key: 'edit', label: 'Edit', icon: <Pencil size={14} />, onSelect: () => setEditing({ item: r.item!, kind: r.kind as 'presentation' | 'template' }) }] : []),
          ...(canDelete ? [{ key: 'delete', label: 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(r.item!) }] : []),
        ]}
        trigger={(t) => <button type="button" className="icon-btn" aria-label={`Actions for ${r.title}`} {...t}><MoreVertical size={16} /></button>} />
    ) },
  ], [types.data, typeLabel, canEdit, canDelete]);

  const filtered = useMemo(() => all?.filter((r) => (!kind || r.kind === kind) && (!q || r.title.toLowerCase().includes(q.toLowerCase()))), [all, kind, q]);
  const { rows, sort, setSort } = useTableSort(filtered, columns, { columnId: 'title', dir: 'asc' });

  const addItems = [
    ...(can(me, 'library_item', 'create') ? [
      { key: 'presentation', label: 'Presentation', icon: <Presentation size={14} />, onSelect: () => setEditing({ item: null, kind: 'presentation' }) },
      { key: 'template', label: 'Agenda template', icon: <FileText size={14} />, onSelect: () => setEditing({ item: null, kind: 'template' }) },
    ] : []),
    ...(can(me, 'contract_template', 'create') ? [{ key: 'contract', label: 'Contract template', icon: <FileSignature size={14} />, onSelect: () => setAddingTemplate(true) }] : []),
  ];

  return (
    <AdminPage title="Content library"
      sub="Pre-approved presentations, agenda templates and contract templates. Linking one to event types and countries decides which events can use it."
      action={addItems.length > 0 && <Menu label="Add to the Content library" width={200} items={addItems}
        trigger={(t) => <button className="btn btn-primary" {...t}><Plus size={15} strokeWidth={2.6} />Add<ChevronDown size={14} /></button>} />}>
      <Toolbar label="Filter the Content library">
        <SearchInput value={q} onChange={(v) => setParam('q', v)} placeholder="Search the Content library" />
        <FilterSelect label="Type" value={kind} onChange={(v) => setParam('type', v)} options={KINDS} />
      </Toolbar>
      {error && <div className="form-error" role="alert">{error}</div>}
      <DataTable label="Content library" columns={columns} rows={rows} rowKey={(r) => r.id} sort={sort} onSortChange={setSort}
        loading={library.isLoading || templates.isLoading} error={library.error ?? templates.error}
        empty={q || kind ? 'Nothing matches these filters.' : 'The Content library is empty.'} />
      {editing && <ItemModal item={editing.item} kind={editing.kind} onClose={() => setEditing(null)} />}
      {addingTemplate && <SettingsModal template={null} onClose={(id) => { setAddingTemplate(false); if (id) navigate(`contract-templates/${id}`); }} />}
      {deleting && (
        <ConfirmDialog title="Delete this item?" confirmLabel="Delete" pending={remove.isPending} error={remove.error?.message}
          onConfirm={() => remove.mutate(deleting)} onCancel={() => { setDeleting(null); remove.reset(); }}>
          <strong>{deleting.title}</strong> and its file are deleted from the Library. An item used on events can't be deleted; make it inactive instead.
        </ConfirmDialog>
      )}
    </AdminPage>
  );
}
