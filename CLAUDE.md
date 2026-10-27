# CLAUDE.md: Event Coordinator prototype

This is a demo-real prototype of **Event Coordinator (EC)**, Brightside Company's application for strategic, cross-border pharma events: advisory boards, congresses, investigator meetings. It runs on a real database with test data and is used for client demos. It's built so the schema, security model, API and seed data carry over into the real product.

Owner: Erik (co-founder, ex-Veeva CRM/Events architect). Read these before making non-trivial changes:

- `docs/ARCHITECTURE.md`: principles and stack (the **why**)
- `docs/BUILD-PLAN.md`: phases and decisions (the **what next**)
- `docs/DATA-MODEL.md`: entities, CRM mapping, which tables exist
- `docs/design/`: **visual source of truth.** `home-4a.png`, `event-page.png`, `home-4b-empty.png`, plus the source `EC Home.dc.html` / `EC Event.dc.html`. The `.dc.html` files need `support.js`, which isn't in the repo, so use the PNGs and read the HTML for exact values and copy.
- Older HTML mockups (01–12) live outside the repo in Erik's `ec-v2/design/ec-early-demo-mockup/`. Use them for **content and field lists** (events list, request form, experts, spend, admin), never for styling.

## Non-negotiable principles

1. **Security lives in the database, not the UI.**
   - Every table has row-level security. The UI uses only the public API with the user's token. Never use a service-role key in the app.
   - Business rules (status transitions, workflows) are Postgres functions exposed as `rpc`, or triggers. They are never UI-only logic.
2. **The UI is one client of the API.** Anything the UI can do, an agent or a customer-built UI must be able to do through the same API. If you're tempted to add UI-side logic that changes data, put it in a database function instead.
3. **Users are human or agent** (`app_user.user_type`).
   - Agents have an owner and their own profile.
   - Agents send `X-On-Behalf-Of: <app_user.id>`. The audit trigger records it, and only honours it for agents acting for a human in their own tenant.
   - The UI should make agent actions visible (the robot avatar in `Avatar` with `isAgent`).
4. **CRM-shaped model.**
   - HCP and HCO are separate tables.
   - CRM-mirrored records carry `crm_connection_id` + `crm_external_id`.
   - EC holds event-context data only. It is not an HCP master.
5. **Supabase = Postgres plus conveniences.**
   - No logic in dashboard-only features.
   - Everything is a SQL migration in the repo.
   - Auth is touched only by `app.current_user_id()` (DB), the auth adapter migration (`create_user_login`, `set_user_password`) and `apps/web/src/lib/auth.tsx` (UI).
6. **Single tenant seeded, tenant-ready everywhere.** Every business table has `tenant_id`; `app.stamp_row()` fills it.

## Stack & layout

```
supabase/migrations/   plain SQL, timestamp-ordered (foundation → core schema → reference data → security → api)
supabase/seed/         demo data, run in filename order (00_ … 99_)
apps/web/              Vite + React 19 + TypeScript SPA, react-router, TanStack Query, supabase-js, lucide-react, Figtree
tests/api-smoke.mjs    end-to-end API + security checks (public API only)
.github/workflows/     db-deploy (on push to main touching migrations), db-reset-demo (manual, type RESET), api-smoke, web-build
```

## Commands

```bash
supabase start                      # local stack (Docker via OrbStack): applies migrations + seed
supabase db reset                   # rebuild local DB from migrations + seed
npm install
cp apps/web/.env.example apps/web/.env.local   # local URL + anon key from `supabase start`
npm run dev                         # http://localhost:5173
npm run typecheck && npm run build
SUPABASE_URL=… SUPABASE_ANON_KEY=… npm run test:api    # smoke test any environment
```

Hosted dev environment: Supabase project `jwydbztvfqmosjtkwkmx`. Its public URL and publishable key are in `apps/web/.env.production`, which is safe to commit.

Demo password for all seeded logins: `EC-demo-2026!`. Demo lead: `paul.taylor@alera.example` (Event Coordinator). Business Admin: `maria.castillo@alera.example`. System Admin: `alex.morgan@alera.example`.

## How to change things

### Database
- **Never edit a migration that has been pushed to `main`.** The hosted DB has already applied it. Add a new file instead: `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`.
- New tenant-scoped table:
  - Include `id`, `tenant_id`, and audit columns (`created_at/by`, `updated_at/by`) where relevant.
  - Call `select app.secure_table('<table>');` to get RLS, stamping and audit.
  - Add `permission` rows for each profile in the seed (`00_tenant_security.sql`). Without them, nobody but admins can see the table.
- Status/type values go in lookup tables (like `event_status`), not enums, so clients can read labels and tones.
- Event capture goes through `create_event(p)` / `update_event(id, p)` (one call, products and custom fields included; times may be given as `starts_local` in the event's zone).
- Custom fields: definitions in `custom_field`, placement per event type and section in `custom_field_layout`, values in `<table>.custom_fields` jsonb validated by `app.validate_custom_fields()`. Reporting reads `report.<table>` views, rebuilt by `app.refresh_report_view()`. Never `alter table` for a customer field.
- Creating an event (or changing its country/type) needs the type enabled in that country (`event_type_country`) and the user allowed there (`app_user_country`); `app.check_event_rules()` enforces it. Products and therapeutic areas must be assigned to the type when it has assignments.
- Event status changes go through `change_event_status()`. Allowed moves are data in `event_status_transition`.
- Lifecycle: `draft → review → contract → execution → closed`, plus `cancelled` as an exit. Home pills use `event_status.home_label` (Planning / In approval / Approved).
- When you add a security rule or workflow, add a check for it in `tests/api-smoke.mjs`.

### Seed / demo data
- Use deterministic IDs: `app.sid('event:sma-board')`.
- Dates are **relative to today**. Use `app.seed_at(days, 'HH:MI', tz)` in `03_events.sql`, or `current_date + n`. Never hard-code dates.
- `99_history.sql` replaces seed-generated audit rows with a curated history.
- Keep the demo story coherent. SMA Board (Copenhagen, 5 days out, Contract stage) is the hero event, and its data mirrors `docs/design/event-page.png`.

### UI
- Take every colour, radius and type size from `apps/web/src/styles/tokens.css`. Never hard-code a hex in components.
- The design system lives in `apps/web/src/ui/` (see its `README.md`). Lists use `DataTable` + `useTableSort` with a `Toolbar` above them, and filters live in the URL. When a pattern appears on a second screen, move it into `ui/`.
- Shared classes are in `styles/components.css`: `.card`, `.btn(-primary|-outline|-ghost)`, `.pill-<tone>`, `.date-tile`, `.segmented`, `.link`, `.topnav`, `.menu`.
- Match the 4a/Event-page look:
  - cool grey ground `#eef1f5`, white cards with 1px `#dfe4eb` borders and 10px radius
  - blue accent `#1d6fd6`, pill nav, Lucide icons
- The **Modernist design system is dropped.** Don't use Archivo, square corners or red-on-white.
- Status labels and tones come from the DB (`useEventStatuses()` / `<StatusPill>`), not from UI constants.
- Render event times in the **event's** time zone (`eventDateParts(iso, event.timezone)`).
- Query through supabase-js with explicit FK hints when a table has several links to `app_user` (e.g. `owner:app_user!event_owner_id_fkey(...)`).
- Check desktop (1280px) first, but no horizontal scroll at 390px.

## Where we are

- **Phase 0, done:** schema, security, seed, CI, login, app shell with notifications, interim Home / events list / Event page header.
- **Phase 1, in progress.** Done: Home 4a, events list (`DataTable`), New/Edit event modal with custom fields, Admin basics (`/admin`: event types with countries/products/areas, products, therapeutic areas, users with countries and logins). Next:
  - Event page tabs, in `event-page.png` order:
    - Overview: agenda grid by day, speakers/honorarium grid with total, content grid
    - Team: message board with replies/reactions, tasks
    - Attendees
    - Documents
    - Event details
  - Status changes from the Event page (Actions) via `change_event_status()`.
  - Capture of sessions, speakers, attendees and content; an "Add people" dialog with EC's HCP table, mock CRM search and file import.
- Later phases: see `docs/BUILD-PLAN.md`.
- Mocked integrations (CRM search, reconciliation, write-back, contracting) need a real interface with a fake implementation. Never fake data in the UI.

## Working with Erik

- Direct and concise. No compliments or hand-holding. Flag real problems plainly.
- Incremental: make focused changes, show the result (screenshot or running app), then iterate. No big rewrites without asking.
- Product copy should be warm and direct, respectful of experienced pharma professionals. No "disruption" or tech-bro language.
- Commit in small, described steps. Push to `main` only when the build and smoke test pass.
