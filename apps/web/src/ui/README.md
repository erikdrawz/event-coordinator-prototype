# EC design system (`src/ui/`)

The reusable building blocks of the Event Center UI, in the Home 4a / Event page look. It grows as screens are built: when a pattern shows up on a second screen, it moves here.

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

### Related lists (`RelatedList.tsx`)
The pattern for every list that hangs off a record (an expert's rates, contracts and engagements): the record shows the newest `RELATED_LIMIT` (5) rows, and "View all" opens the full list on a page of its own.

```tsx
<RelatedTable label="Contracts" columns={columns} rows={list} rowKey={(c) => c.id} />
<ViewAll to={`/experts/${id}/contracts`} total={list.length} />   // only shows above the limit
```

- `RelatedTable`: the compact table, taking the same `Column<T>[]` as `DataTable`, so the card and the full list can't drift apart. Pass rows newest first.
- `ViewAll`: the link to the full list, with the total.
- `RelatedPage`: the full list's page, with breadcrumbs back to the record, title and count. Inside it, use `Toolbar` + `DataTable`.
- A list with inline editing (FMV rates) slices its own rows to `RELATED_LIMIT` and uses `ViewAll` and `RelatedPage` the same way.

### Toolbar (`Toolbar.tsx`)
The controls above a list.

- `Toolbar`: the wrapping row (`role="search"`).
- `SearchInput`: text search.
- `Segmented`: mutually exclusive choices (My events / All). Uses the shared `.segmented` style.
- `FilterSelect`: a `Select` in its filter variant. The empty value means "any", and the control highlights when a filter is set.
- `ClearFilters`: resets filters. Show it only when a filter is active.

Keep list filters in the URL (`useSearchParams`) so a filtered view can be bookmarked and shared. See `pages/EventsPage.tsx`.

### `Select` (`Select.tsx`)
Use it for every dropdown instead of a native `<select>`. It's a button that opens a listbox in the app's style, the same height as text inputs (it carries `.input`).
- Keyboard: arrows, Home/End, Enter, Esc (closes the list, not a surrounding modal), type-to-jump.
- Lists longer than 12 get a search box (force it with `searchable`). `emptyLabel` adds a first "None"/"All" option.
- `variant="filter"` with a `label` is the compact toolbar version ("Status  All"); `FilterSelect` wraps it.
- The list is fixed-positioned, so a scrolling modal body doesn't clip it, and it opens upwards when there's no room below.

### `MultiSelect` (`MultiSelect.tsx`)
Choose several values: chips in the field (with remove buttons), a searchable checklist in the popup with Select all / Clear. Use `placeholder` to say what an empty choice means (e.g. "All products").

### Dates and times (`DateInput.tsx`)
- `DateInput`: a calendar popup; value `'YYYY-MM-DD'`. Keyboard: arrows move by day/week, PageUp/PageDown by month, Enter picks, Esc closes. `min` disables earlier days. Today and Clear in the footer.
- `TimeInput`: 24-hour time; type it (`930`, `9:30`, `21.15`, `9:30 pm`) or pick from 15-minute steps; value `'HH:mm'`.
- `DateTimeInput`: both side by side; value `'YYYY-MM-DDTHH:mm'`. The time waits for a date.
- Weeks start on `WEEK_STARTS_ON` (Sunday, like the Home calendar).

### `usePopover` (`usePopover.ts`)
Positions any popup under its trigger (above it when there's no room), follows scrolling, closes on outside clicks. `Select` and the date/time inputs use it. The popup is placed one render after opening, so wait for `style` before focusing inside it.

### `Menu` (`Menu.tsx`)
A button that opens a list of actions: a row's ⋮ menu, or a picker like "+ Speaker". You render the trigger (it gets `ref`, `onClick` and ARIA props to spread); items have a label, optional icon, `danger`, `disabled`. Lists over 8 get a search box.

### `SidePanel` (`SidePanel.tsx`)
One related record (an attendee, an expert) on the right: the fields that don't fit the list, editable in place. Not modal: the list stays usable and clicking another row shows that record. Wide screens make room for it (`body.sp-open` narrows `.page`); phones get it full screen. Esc (when no menu or dialog is open) and ✕ close it, and focus returns where it was. Lay out fields with `PanelSection` + `PanelField` (label beside value); pin actions in `footer`.

### Row selection and bulk actions (`BulkSelect.tsx`)
- `useRowSelection(ids)`: which rows are ticked; rows that leave the list drop out.
- `SelectAllCell` / `SelectRowCell`: the checkbox column (header ticks all; indeterminate when some).
- `BulkBar`: replaces the card header while rows are ticked: "N selected · Clear", the actions, and a short outcome notice.
- `isRowClick(e)`: true when a row click should open its panel (not on links, buttons, inputs or menus). Give such rows `row-openable`, `tabIndex={0}` and Enter to open.
Bulk writes are one call for all ticked ids (`.in('id', ids)`); RLS leaves out rows the caller can't change, so report "N updated" from what came back.

### `ConfirmDialog` (`ConfirmDialog.tsx`)
"Are you sure?" for destructive actions, in the app's style. Say what happens and what stays, e.g. "Speakers stay on the event."

### `Modal` (`Modal.tsx`)
A dialog on the native `<dialog>` element, so focus trapping, Esc and the backdrop come from the browser. Header and footer stay fixed while the body scrolls, and it goes full screen on phones. Opens with focus in the first field of the body. Pass `confirmClose="Discard your changes…?"` while a form has unsaved changes. Submit buttons in the `footer` point at the form with `form="<form id>"`.

### Form (`Form.tsx`)
- `FormSection`: a titled group laid out on a two-column grid (one column on phones).
- `Field`: label, required mark, hint and error. Children get `(id, describedBy)` so the label and messages are wired to the control. Controls use the shared `.input` class.
- `CheckboxField`: a yes/no field. `ChipPicker`: pick several values from a short list.

Validate in the browser so people see problems early, but the database is the authority: show its error messages as they are, because they're written for people. See `pages/event/EventFormModal.tsx`.

## Still in `components/` (to move here when next touched)
`Avatar`, `StatusPill`, `DateTile`, plus the shared classes in `styles/components.css` (`.card`, `.btn-*`, `.pill-*`, `.segmented`, `.link`).
