import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { DataTable, useTableSort, type Column } from '../../ui/DataTable';
import { SearchInput, Segmented, Toolbar } from '../../ui/Toolbar';
import { Modal } from '../../ui/Modal';
import { CheckboxField, Field, FormSection } from '../../ui/Form';
import { Select } from '../../ui/Select';
import { AdminPage } from './AdminLayout';
import { ADMIN_KEY, must, useAreas, useEventTypes, useProducts, type Product, type TherapeuticArea } from './adminData';

type Show = 'active' | 'all';
const activePill = (on: boolean) => <span className={`pill ${on ? 'pill-green' : 'pill-grey'}`}>{on ? 'Active' : 'Inactive'}</span>;

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export function ProductsAdmin() {
  const { me } = useAuth();
  const products = useProducts();
  const areas = useAreas();
  const types = useEventTypes();
  const [q, setQ] = useState('');
  const [show, setShow] = useState<Show>('active');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);

  const areaName = useMemo(() => new Map(areas.data?.map((a) => [a.id, a.name])), [areas.data]);
  const typesFor = (id: string) => types.data?.filter((t) => t.event_type_product.some((p) => p.product_id === id)).map((t) => t.name) ?? [];

  const columns = useMemo<Column<Product>[]>(() => [
    { id: 'name', header: 'Product', width: '30%', sortValue: (p) => p.name,
      cell: (p) => <button className="dt-primary as-button" onClick={() => setEditing(p)}>{p.name}</button> },
    { id: 'area', header: 'Therapeutic area', width: '24%', sortValue: (p) => areaName.get(p.therapeutic_area_id ?? ''),
      cell: (p) => areaName.get(p.therapeutic_area_id ?? '') ?? <span className="text-muted">—</span> },
    { id: 'types', header: 'Limited to event types', width: '32%',
      cell: (p) => { const t = typesFor(p.id); return <span className="dt-sub">{t.length ? t.join(', ') : 'Types without a product list'}</span>; } },
    { id: 'active', header: 'Status', width: '14%', sortValue: (p) => (p.is_active ? 0 : 1), cell: (p) => activePill(p.is_active) },
  ], [areaName, types.data]); // typesFor reads types.data

  const filtered = useMemo(() => products.data?.filter((p) => (show === 'all' || p.is_active)
    && (!q || p.name.toLowerCase().includes(q.toLowerCase()))), [products.data, q, show]);
  const { rows, sort, setSort } = useTableSort(filtered, columns, { columnId: 'name', dir: 'asc' });

  return (
    <AdminPage title="Products" sub="The master list of products events can be about. Switch a product off instead of deleting it, so past events keep it."
      action={can(me, 'product', 'create') && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} strokeWidth={2.6} />New product</button>}>
      <Toolbar label="Filter products">
        <SearchInput value={q} onChange={setQ} placeholder="Search products" />
        <Segmented label="Show" value={show} onChange={setShow} options={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All' }]} />
      </Toolbar>
      <DataTable label="Products" columns={columns} rows={rows} rowKey={(p) => p.id} sort={sort} onSortChange={setSort}
        loading={products.isLoading} error={products.error} empty="No products match." />
      {editing && <ProductEditor product={editing === 'new' ? null : editing} areas={areas.data ?? []} onClose={() => setEditing(null)} />}
    </AdminPage>
  );
}

function ProductEditor({ product, areas, onClose }: { product: Product | null; areas: TherapeuticArea[]; onClose: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState(product?.name ?? '');
  const [areaId, setAreaId] = useState(product?.therapeutic_area_id ?? '');
  const [active, setActive] = useState(product?.is_active ?? true);
  const [nameError, setNameError] = useState<string | null>(null);
  const editable = can(me, 'product', product ? 'edit' : 'create');

  const save = useMutation({
    mutationFn: async () => {
      const row = { name: name.trim(), therapeutic_area_id: areaId || null, is_active: active };
      if (product) await must(supabase.from('product').update(row).eq('id', product.id));
      else await must(supabase.from('product').insert(row));
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: [ADMIN_KEY] }); qc.invalidateQueries({ queryKey: ['event-form-options'] }); onClose(); },
  });

  return (
    <SimpleEditor id="product-form" title={product ? product.name : 'New product'} onClose={onClose} pending={save.isPending}
      error={save.error?.message} editable={editable}
      onSubmit={() => { if (!name.trim()) { setNameError('Give the product a name'); return; } save.mutate(); }}>
      <Field label="Name" required error={nameError} wide>
        {(id, d) => <input id={id} aria-describedby={d} aria-invalid={Boolean(nameError) || undefined} className="input" value={name}
          disabled={!editable} autoFocus={!product} onChange={(e) => { setName(e.target.value); setNameError(null); }} />}
      </Field>
      <Field label="Therapeutic area">
        {(id) => <Select id={id} value={areaId} onChange={setAreaId} emptyLabel="None" disabled={!editable}
          options={areas.filter((a) => a.is_active || a.id === areaId).map((a) => ({ value: a.id, label: a.name }))} />}
      </Field>
      <CheckboxField label="Active" checked={active} onChange={setActive} disabled={!editable}
        hint="Inactive products can't be added to events." />
    </SimpleEditor>
  );
}

// ---------------------------------------------------------------------------
// Therapeutic areas
// ---------------------------------------------------------------------------

export function TherapeuticAreasAdmin() {
  const { me } = useAuth();
  const areas = useAreas();
  const products = useProducts();
  const [q, setQ] = useState('');
  const [show, setShow] = useState<Show>('active');
  const [editing, setEditing] = useState<TherapeuticArea | 'new' | null>(null);

  const columns = useMemo<Column<TherapeuticArea>[]>(() => [
    { id: 'name', header: 'Therapeutic area', width: '40%', sortValue: (a) => a.name,
      cell: (a) => <button className="dt-primary as-button" onClick={() => setEditing(a)}>{a.name}</button> },
    { id: 'products', header: 'Products', width: '46%',
      cell: (a) => { const p = products.data?.filter((x) => x.therapeutic_area_id === a.id).map((x) => x.name) ?? [];
        return <span className="dt-sub">{p.length ? p.join(', ') : 'None'}</span>; } },
    { id: 'active', header: 'Status', width: '14%', sortValue: (a) => (a.is_active ? 0 : 1), cell: (a) => activePill(a.is_active) },
  ], [products.data]);

  const filtered = useMemo(() => areas.data?.filter((a) => (show === 'all' || a.is_active)
    && (!q || a.name.toLowerCase().includes(q.toLowerCase()))), [areas.data, q, show]);
  const { rows, sort, setSort } = useTableSort(filtered, columns, { columnId: 'name', dir: 'asc' });

  return (
    <AdminPage title="Therapeutic areas" sub="Used to group products and to tag events. Switch an area off instead of deleting it."
      action={can(me, 'therapeutic_area', 'create') && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} strokeWidth={2.6} />New therapeutic area</button>}>
      <Toolbar label="Filter therapeutic areas">
        <SearchInput value={q} onChange={setQ} placeholder="Search areas" />
        <Segmented label="Show" value={show} onChange={setShow} options={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All' }]} />
      </Toolbar>
      <DataTable label="Therapeutic areas" columns={columns} rows={rows} rowKey={(a) => a.id} sort={sort} onSortChange={setSort}
        loading={areas.isLoading} error={areas.error} empty="No therapeutic areas match." />
      {editing && <AreaEditor area={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </AdminPage>
  );
}

function AreaEditor({ area, onClose }: { area: TherapeuticArea | null; onClose: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState(area?.name ?? '');
  const [active, setActive] = useState(area?.is_active ?? true);
  const [nameError, setNameError] = useState<string | null>(null);
  const editable = can(me, 'therapeutic_area', area ? 'edit' : 'create');

  const save = useMutation({
    mutationFn: async () => {
      const row = { name: name.trim(), is_active: active };
      if (area) await must(supabase.from('therapeutic_area').update(row).eq('id', area.id));
      else await must(supabase.from('therapeutic_area').insert(row));
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: [ADMIN_KEY] }); qc.invalidateQueries({ queryKey: ['event-form-options'] }); onClose(); },
  });

  return (
    <SimpleEditor id="area-form" title={area ? area.name : 'New therapeutic area'} onClose={onClose} pending={save.isPending}
      error={save.error?.message} editable={editable}
      onSubmit={() => { if (!name.trim()) { setNameError('Give the area a name'); return; } save.mutate(); }}>
      <Field label="Name" required error={nameError} wide>
        {(id, d) => <input id={id} aria-describedby={d} aria-invalid={Boolean(nameError) || undefined} className="input" value={name}
          disabled={!editable} autoFocus={!area} onChange={(e) => { setName(e.target.value); setNameError(null); }} />}
      </Field>
      <CheckboxField label="Active" checked={active} onChange={setActive} disabled={!editable}
        hint="Inactive areas can't be chosen for new events or products." />
    </SimpleEditor>
  );
}

/** A small modal form shared by the master-data editors. */
function SimpleEditor({ id, title, onClose, onSubmit, pending, error, editable, children }: {
  id: string; title: string; onClose: () => void; onSubmit: () => void; pending: boolean; error?: string; editable: boolean; children: React.ReactNode;
}) {
  return (
    <Modal open title={title} onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>{editable ? 'Cancel' : 'Close'}</button>
        {editable && <button type="submit" form={id} className="btn btn-primary" disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>}
      </>}>
      <form id={id} className="form" noValidate onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        {error && <div className="form-error" role="alert" style={{ marginBottom: 16 }}>{error}</div>}
        <FormSection>{children}</FormSection>
      </form>
    </Modal>
  );
}
