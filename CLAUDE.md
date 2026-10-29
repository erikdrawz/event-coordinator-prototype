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

Demo password for all seeded logins: `EC-demo-2026!`. Demo lead: `paul.taylor@alera.example` (Event Coordinator). Business Admin: `maria.castillo@alera.example`. System Admin: `alex.morgan@alera.example`. Account Manager: `daniel.novak@alera.example`.

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
- Speakers (`event_expert`): service hours are computed from the agenda by triggers (never written by clients); a speaker's session `minutes` is null for the whole session (it then follows the session's times) and counts at most the session's length; prep and travel are entered; total = (prep + service + travel) × rate, 0 if ineligible. FMV rates are added, edited and deleted inline on the expert page (`FmvCard`, for people who can edit `fmv_rate`); a rate that priced an engagement can't be deleted (`app.check_fmv_rate_delete`; expire it instead). Rates follow `expert_rate_policy(hcp, event)`: the expert's FMV record (`fmv_rate`: effective/expiration date, rate, min rate, max rate) valid on the event's date gives the default and the negotiable range; without one, the rate is fixed at 0 (source `none`), so no made-up honorarium; recording an FMV rate fills in the expert's €0 rates that have no FMV link (`app.apply_fmv_rate`, not where a contract is sent or executed). A new speaker's rate, currency and `fmv_rate_id` default from it, and a trigger keeps every rate within it; the grid reads all of an event's policies with `event_rate_policies(event)`. Removing a speaker removes them from sessions (cascade). The Experts grid opens an expert in a `SidePanel` on row click (engagement, eligibility and compliance check, honorarium with the FMV range, sessions, contracts, tiering) and offers bulk Role and Remove for ticked rows (experts with a sent or signed contract are kept). A speaker taken off their last session leaves the speakers at commit (deferred trigger `drop_sessionless_expert`), unless a linked contract is `sent` or `executed` (`app.expert_keeps_without_sessions`).
- Experts are the HCP table (`/experts`). Eligibility belongs to the expert (`hcp.eligibility` → `expert_eligibility`: eligible, pending, not eligible; `eligibility_note` says why); an expert added to an event starts with it (`event_expert.eligibility` can then differ per event); when the expert's eligibility changes it carries to engagements that still had the old value on open events without a sent or signed contract (`app.carry_expert_eligibility`). The Experts grid's Contract column shows a tiering request only while it's open (draft or review); the ⋯ menu keeps the latest one. The Event page calls its honorarium grid **Experts** (they may speak, chair, advise, consult or train); session speakers keep the word speaker.
- CRM: search with `crm_search_hcp(p)`, copy into EC with `crm_import_hcp(connection, external_id)` (idempotent; OneKey ID reuses an existing HCP). The mock CRM data lives in `crm_mock.*` (seed `04_crm_mock.sql`), never read directly by clients. In the UI, people are picked with `pages/event/people/PersonPicker` (EC first, CRM on request).
- Account Manager profile (field reps): Event Coordinator rights except experts (`hcp`, `hco`, `fmv_rate`) are read-only — they add experts to their events but can't edit them, import them from a CRM or add MSAs (`app.check_msa_creator`) — and no view_all on `event_request`, so they see only their own requests and no Unassigned requests on Home. `me().permissions[obj].view_all` and `seesAll(me, obj)` tell home office from the rest.
- Event access comes from the event's Team (`event_team_member`, roles in `team_role`): you see an event when you're on its team and change it when your role can edit (owner, organizer); approvers and viewers view and post. Profiles with view_all/modify_all on `event` (Business Admin, System Admin) see/change every event. `app.event_access()` decides; every table with `event_id` uses it via `app.secure_event_table()`. Agents get the access of the human they act for. The UI reads `my_event_access(event)` (shared through `EventAccessContext`) and combines it with `can()`.
- Requests (`event_request`) are saved through `save_request(p)`: name, event type, `event_date` (a date) and `duration` (`request_duration`: 1–3 hours, half day, full day, 2 days, more than 2 days), business justification; exact times are planned on the event. Statuses: draft → review → approved | rejected (`request_status`). Only drafts change or get deleted; submitting is `status = 'review'` and needs date, duration and business justification (trigger `check_request`) and notifies the request's approvers. A request in review is closed with `decide_request(id, 'approved'|'rejected', note)` (a rejection needs the note): home office (view_all on `event_request`), System Admins and the request's Approvers may decide (`app.can_decide_request`, also `my_request_access().can_decide`), never the requester; it records `decided_by`/`decided_at`/`decision_note` and notifies the requester. Status can't be set to approved/rejected directly. Access works like events: the request's Team (`request_team_member`, creator = owner) via `app.request_access()`; drafts are private to the team, and submitted requests are visible to profiles with view_all on `event_request` (home office). Team and board UI are shared with events (`TeamPanel` / `Discussion` take a `board: {kind, id}`).
- Requests have a type (`request_type`): event request or **tiering request**. A tiering request names the expert (`hcp_id`), optionally the event they're needed for (`related_event_id`), and a business justification; it's named "Tiering: <expert>" by `save_request` and needs the expert and justification to submit. Same lifecycle, team, board and access as event requests. The event's Experts grid offers "Log tiering request" for experts who aren't eligible, and links to an open one.
- Attendees (`event_attendee`): HCPs are added in bulk with `add_event_attendees(event, people)`, each person `{hcp_id}` or `{crm_connection_id, external_id}` (copied into EC like `crm_import_hcp`); people already attending are skipped (one row per person per event). The `fill_attendee` trigger gives a new HCP attendee their organisation, their role when they're one of the event's experts, and the CRM link (reconciled) when the HCP is a CRM account. RSVP and CRM status are lookups (`attendee_rsvp`, `attendee_crm_status`). `attended` is yes/no (no by default); `owner_id` defaults to whoever added the attendee (seeds: the event's owner) and must be an active person (`app.check_attendee_owner`). The list shows Name, Type, RSVP, Attended, Owner, CRM; editors change RSVP, Attended and Owner inline. Clicking a row opens the attendee in a `SidePanel` (organisation, role, CRM link, who added them; editable); ticking rows offers bulk RSVP, Attended, Owner and Remove. Type is worked out on load (`useAttendees`): User for colleagues, Expert for HCPs on the event's Experts list, Attendee otherwise; the list sorts experts, attendees, users. Writes need edit access to the event. The UI's Add attendees dialog has Event Center and CRM sources; file import comes next.
- Contracts (`contract`): Master Service Agreement (`msa`, on the expert, no event), Work Order (needs a signed MSA that covers the event's date), Single-event Contract, Addendum (changes the engagement's open Work Order or Single-event Contract); types and statuses are lookups (`contract_type`, `contract_status`). Event contracts carry `event_expert_id` + `event_id` and follow the event's access; one open Work Order or Single-event Contract per engagement; only eligible experts. Created through `create_contract(p)` (`contract_options(...)` says what's possible), which drafts `body` (Markdown) from a `contract_template` and keeps the `honorarium` (rate, prep/service/travel hours and amounts, total). Rules live in the `check_contract` trigger: draft → sent (needs the PDF) → executed; draft or sent → cancelled; only drafts change. `send_contract(id, file)` stores the PDF uploaded to the `contracts` bucket (`<contract id>/<number>.pdf`) and sets a mock CLM reference; `mark_contract_signed`, `cancel_contract`, `regenerate_contract` (drafts). The UI makes the PDF with pdfmake from the same Markdown it shows (`pages/contracts/contractDoc.ts`); prints via print CSS.
- Contract templates (`contract_template`: name, type, countries, active) have versions (`contract_template_version`: Markdown with `{{merge fields}}` from `contract_merge_fields()`, unknown fields refused; `effective_from`; numbered automatically). A contract gets the version in effect on its event's date (an MSA: its start date) and records it in `contract.template_version_id`; a template with no version in effect yet isn't offered, so next year's version can be scheduled ahead. A version is fixed once a contract made from it was sent (`is_locked`), and can't be deleted once any contract uses it (`contracts_using`). Templates are linked to event types in `event_type_contract_template`, available in all the event type's countries unless `country_codes` limits them. MSA templates aren't linked to event types. Rights follow `event_type`.
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
- **Phase 1, in progress.** Done: Home 4a, events list (`DataTable`), New/Edit event modal with custom fields, Admin basics (`/admin`: event types with countries and custom fields, products, therapeutic areas, custom fields, users with countries and logins), Event details tab, Team tab (discussion board with replies and reactions; team with access roles), Requests list and request page (event and tiering requests; form, submit, delete draft, team, discussion), Experts list (Eligible / All) and expert page (Edit expert, engagements, FMV rates, contracts with Add MSA), contracting v1 (templates in Admin per event type; Work Order / Single-event Contract / Addendum from the event's Experts grid; contract page with print, PDF, send for signature, mark signed), speaker picker with CRM search, Overview → Agenda (read-only by default; "Edit agenda" edits every session inline across days and saves once, with a warning on unsaved changes) and Speakers (honorarium grid; prep/travel inline; add inline; speakers from the agenda join automatically), Attendees tab (Add attendees from EC or CRM in bulk, RSVP, attended, owner, remove). Next:
  - Event page tabs, in `event-page.png` order:
    - Overview: agenda grid by day, speakers/honorarium grid with total, content grid
    - Team: message board with replies/reactions, tasks
    - Attendees
    - Documents
    - Event details
  - Status changes from the Event page (Actions) via `change_event_status()`. Done: Cancel event (reason required). Next: the forward moves (submit for review, approve, …).
  - Capture of content; attendee import from a file, attended tracking, bulk actions and reconciliation.
- Later phases: see `docs/BUILD-PLAN.md`.
- Mocked integrations (CRM search, reconciliation, write-back, contracting) need a real interface with a fake implementation. Never fake data in the UI.

## Working with Erik

- Direct and concise. No compliments or hand-holding. Flag real problems plainly.
- Incremental: make focused changes, show the result (screenshot or running app), then iterate. No big rewrites without asking.
- Product copy should be warm and direct, respectful of experienced pharma professionals. No "disruption" or tech-bro language.
- Commit in small, described steps. Push to `main` only when the build and smoke test pass.
