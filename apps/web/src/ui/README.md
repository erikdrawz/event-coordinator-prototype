# EC design system (`src/ui/`)

The reusable building blocks of the Event Coordinator UI, in the Home 4a / Event page look. It grows as screens are built: when a pattern shows up on a second screen, it moves here.

## Rules

- **Tokens only.** Colours, radii, type sizes and shadows come from `styles/tokens.css`. No hex values in components.
- **One component, one stylesheet.** Each component imports its own CSS file (`DataTable.tsx` → `data-table.css`). Class names use a short component prefix (`dt-`, `tb-`).
- **Presentational.** Components take data and callbacks. They never query Supabase. Pages and feature folders own the data.
- **Accessible by default.** Real buttons and labels, `aria-sort` on sortable headers, `aria-pressed` on toggles.
- **Check both widths.** 1280px first; no page-level horizontal scroll at 390px (wide tables scroll inside their card).

## Components

### `DataTable` + `useTableSort` (`DataTable.tsx`)
The standard list. A card-wrapped table with sortable headers, loading, error and empty states.

```tsx
const columns: Column<Row>[] = [
  { id: 'name', header: 'Event', width: '34%', sortValue: (r) => r.name, cell: (r) => <Link className="dt-primary" …>{r.name}</Link> },
  { id: 'status', header: 'Status', cell: (r) => <StatusPill status={r.status} /> },  // no sortValue → not sortable
];
const { rows, sort, setSort } = useTableSort(filteredRows, columns, { columnId: 'name', dir: 'asc' });
<DataTable label="Events" columns={columns} rows={rows} rowKey={(r) => r.id}
  sort={sort} onSortChange={setSort} loading={isLoading} error={error} empty="No events yet." />
```

- `DataTable` renders rows in the order given. `useTableSort` sorts in the browser; empty values always sort last. For lists too big to load whole, keep the `sort` state and pass it to the query instead.
- Cell helpers: `.dt-primary` (main link), `.dt-sub` (second line), `.dt-person` (avatar + name), `.dt-nowrap`.

### Toolbar (`Toolbar.tsx`)
The controls above a list.

- `Toolbar`: the wrapping row (`role="search"`).
- `SearchInput`: text search.
- `Segmented`: mutually exclusive choices (My events / All). Uses the shared `.segmented` style.
- `FilterSelect`: a labelled select. The empty value means "any", and the control highlights when a filter is set.
- `ClearFilters`: resets filters. Show it only when a filter is active.

Keep list filters in the URL (`useSearchParams`) so a filtered view can be bookmarked and shared. See `pages/EventsPage.tsx`.

## Still in `components/` (to move here when next touched)
`Avatar`, `StatusPill`, `DateTile`, plus the shared classes in `styles/components.css` (`.card`, `.btn-*`, `.pill-*`, `.segmented`, `.link`).
