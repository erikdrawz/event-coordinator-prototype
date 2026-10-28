# CLAUDE.md: Event Center prototype

This is a demo-real prototype of **Event Center (EC)**, Brightside Company's application for strategic, cross-border pharma events: advisory boards, congresses, investigator meetings. It runs on a real database with test data and is used for client demos. It's built so the schema, security model, API and seed data carry over into the real product.

Naming: the app is **Event Center** (it was called Event Coordinator until 28 Oct 2026; the repo, folder and Supabase project ids keep the old name). **Event Coordinator** is still the name of a user profile (Paul, Lisa), so only rename it where it means the app.

Owner: Erik (co-founder, ex-Veeva CRM/Events architect). Read these before making non-trivial changes:

- `docs/ARCHITECTURE.md`: principles and stack (the **why**)
- `docs/BUILD-PLAN.md`: phases and decisions (the **what next**)
- `docs/DATA-MODEL.md`: entities, CRM mapping, which tables exist
- `docs/AI-APPROACH.md`: MCP server, agents and the business rules engine. Read before building any AI feature
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
- Creating an event (or changing its country/type) needs the type enabled in that country (`event_type_country`) and the user allowed there (`app_user_country`); `app.check_event_rules()` enforces it.
- The agenda is saved as a whole through `save_agenda(p)`: every session in one transaction (ids kept, new ones added, omitted ones deleted), refused with 409 when `version` (from `agenda_version(event)`) is stale. The UI only uses this; `save_event_session(p)` stays for single-session API changes (local times, speakers replaced in the same call). Speakers must be the event's experts or team members; an `hcp_id` not yet on the event is added as a speaker. Session kinds come from `session_kind`.
- Speakers (`event_expert`): service hours are computed from the agenda by triggers (never written by clients); a speaker's session `minutes` is null for the whole session (it then follows the session's times) and counts at most the session's length; prep and travel are entered; total = (prep + service + travel) × rate, 0 if ineligible. Rates follow `expert_rate_policy(hcp, event)`: the expert's FMV record (`fmv_rate`: effective/expiration date, rate, min rate, max rate) valid on the event's date gives the default and the negotiable range; without one, EUR 100 negotiable 80–120 (`app.expert_rate()`). A new speaker's rate, currency and `fmv_rate_id` default from it, and a trigger keeps every rate within it; the grid reads all of an event's policies with `event_rate_policies(event)`. Removing a speaker removes them from sessions (cascade). A speaker taken off their last session leaves the speakers at commit (deferred trigger `drop_sessionless_expert`), unless a linked contract is `sent` or `executed` (`app.expert_keeps_without_sessions`).
- Experts are the HCP table (`/experts`). Eligibility belongs to the expert (`hcp.eligibility` → `expert_eligibility`: eligible, in review, not eligible; `eligibility_note` says why); an expert added to an event starts with it (`event_expert.eligibility` can then differ per event). The Event page calls its honorarium grid **Experts** (they may speak, chair, advise, consult or train); session speakers keep the word speaker.
- CRM: search with `crm_search_hcp(p)`, copy into EC with `crm_import_hcp(connection, external_id)` (idempotent; OneKey ID reuses an existing HCP). The mock CRM data lives in `crm_mock.*` (seed `04_crm_mock.sql`), never read directly by clients. In the UI, people are picked with `pages/event/people/PersonPicker` (EC first, CRM on request).
- Event access comes from the event's Team (`event_team_member`, roles in `team_role`): you see an event when you're on its team and change it when your role can edit (owner, organizer); approvers and viewers view and post. Profiles with view_all/modify_all on `event` (Business Admin, System Admin) see/change every event. `app.event_access()` decides; every table with `event_id` uses it via `app.secure_event_table()`. Agents get the access of the human they act for. The UI reads `my_event_access(event)` (shared through `EventAccessContext`) and combines it with `can()`.
- Requests (`event_request`) are saved through `save_request(p)`: name, event type, `event_date` (a date) and `duration` (`request_duration`: 1–3 hours, half day, full day, 2 days, more than 2 days), business justification; exact times are planned on the event. Statuses: draft → review → approved | rejected (`request_status`). Only drafts change or get deleted; submitting is `status = 'review'` and needs date, duration and business justification (trigger `check_request`); approving comes with approvals. Access works like events: the request's Team (`request_team_member`, creator = owner) via `app.request_access()`; drafts are private to the team, and submitted requests are visible to profiles with view_all on `event_request` (home office). Team and board UI are shared with events (`TeamPanel` / `Discussion` take a `board: {kind, id}`).
- Contracts (`contract`): Master Service Agreement (`msa`, on the expert, no event), Work Order (needs a signed MSA that covers the event's date), Single-event Contract, Addendum (changes the engagement's open Work Order or Single-event Contract); types and statuses are lookups (`contract_type`, `contract_status`). Event contracts carry `event_expert_id` + `event_id` and follow the event's access; one open Work Order or Single-event Contract per engagement; only eligible experts. Created through `create_contract(p)` (`contract_options(...)` says what's possible), which drafts `body` (Markdown) from a `contract_template` and keeps the `honorarium` (rate, prep/service/travel hours and amounts, total). Rules live in the `check_contract` trigger: draft → sent (needs the PDF) → executed; draft or sent → cancelled; only drafts change. `send_contract(id, file)` stores the PDF uploaded to the `contracts` bucket (`<contract id>/<number>.pdf`) and sets a mock CLM reference; `mark_contract_signed`, `cancel_contract`, `regenerate_contract` (drafts). The UI makes the PDF with pdfmake from the same Markdown it shows (`pages/contracts/contractDoc.ts`); prints via print CSS.
- Contract templates (`contract_template`): Markdown with `{{merge fields}}` from `contract_merge_fields()` (unknown fields are refused); linked to event types in `event_type_contract_template`, available in all the event type's countries unless `country_codes` limits them. MSA templates aren't linked to event types. Rights follow `event_type`.
- Request, event and contract numbers come from sequences; after seeding or importing explicit numbers, run `app.sync_number_sequences()`.
- Event status changes go through `change_event_status()`. Allowed moves are data in `event_status_transition`.
- Lifecycle: `draft → review → contract → execution → closed`, plus `cancelled` as an exit. Status pills show the lifecycle step with one tone per step (draft grey, review yellow, contract blue, execution purple, closed green, cancelled grey), all from `event_status`. A cancelled event keeps its stepper, greyed out, with a Cancelled pill.
- When you add a security rule or workflow, add a check for it in `tests/api-smoke.mjs`.

### Seed / demo data
- Use deterministic IDs: `app.sid('event:sma-board')`.
- Dates are **relative to today**. Use `app.seed_at(days, 'HH:MI', tz)` in `03_events.sql`, or `current_date + n`. Never hard-code dates.
- `99_history.sql` replaces seed-generated audit rows with a curated history.
- Keep the demo story coherent. SMA Board (Copenhagen, 5 days out, Contract stage) is the hero event, and its data mirrors `docs/design/event-page.png`.

### UI
- Take every colour, radius and type size from `apps/web/src/styles/tokens.css`. Never hard-code a hex in components.
- The design system lives in `apps/web/src/ui/` (see its `README.md`). Lists use `DataTable` + `useTableSort` with a `Toolbar` above them, and filters live in the URL. When a pattern appears on a second screen, move it into `ui/`.
- Shared classes are in `styles/components.css`: `.card`, `.btn(-primary|-outline|-ghost)`, `.pill-<tone>`, `.date-tile`, `.segmented`, `.link`, `.topnav`, `.menu`, and `data-tip="…"` for a hover/focus tooltip.
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
- **Phase 1, in progress.** Done: Home 4a, events list (`DataTable`), New/Edit event modal with custom fields, Admin basics (`/admin`: event types with countries and custom fields, products, therapeutic areas, custom fields, users with countries and logins), Event details tab, Team tab (discussion board with replies and reactions; team with access roles), Requests list and request page (form, submit, delete draft, team, discussion), Experts list (Eligible / All) and expert page (Edit expert, engagements, FMV rates, contracts with Add MSA), contracting v1 (templates in Admin per event type; Work Order / Single-event Contract / Addendum from the event's Experts grid; contract page with print, PDF, send for signature, mark signed), speaker picker with CRM search, Overview → Agenda (read-only by default; "Edit agenda" edits every session inline across days and saves once, with a warning on unsaved changes) and Speakers (honorarium grid; prep/travel inline; add inline; speakers from the agenda join automatically). Next:
  - Event page tabs, in `event-page.png` order:
    - Overview: agenda grid by day, speakers/honorarium grid with total, content grid
    - Team: message board with replies/reactions, tasks
    - Attendees
    - Documents
    - Event details
  - Status changes from the Event page (Actions) via `change_event_status()`. Done: Cancel event (reason required). Next: the forward moves (submit for review, approve, …).
  - Capture of sessions, speakers, attendees and content; an "Add people" dialog with EC's HCP table, mock CRM search and file import.
- Later phases: see `docs/BUILD-PLAN.md`.
- Mocked integrations (CRM search, reconciliation, write-back, contracting) need a real interface with a fake implementation. Never fake data in the UI.

## Working with Erik

- Direct and concise. No compliments or hand-holding. Flag real problems plainly.
- Incremental: make focused changes, show the result (screenshot or running app), then iterate. No big rewrites without asking.
- Product copy should be warm and direct, respectful of experienced pharma professionals. No "disruption" or tech-bro language.
- Commit in small, described steps. Push to `main` only when the build and smoke test pass.
