# Event Center: Prototype Build Plan (v0.2)

Status: 26 Oct 2026. Supersedes v0.1 (Next.js/Vercel/Supabase). See [ARCHITECTURE.md](ARCHITECTURE.md) for the principles behind these choices.

## Decisions made

| Topic | Decision |
|---|---|
| Platform | Supabase free tier (Postgres, Auth, Storage, auto REST API), avoiding Supabase-only logic so the AWS move stays cheap |
| UI | Vite + React + TS single-page app; static hosting (Cloudflare Pages or Netlify, not Vercel's free plan, whose terms rule out commercial use) |
| Visual source of truth | Home **4a** + **Event page** (Figtree, cool grey ground, blue accent, Alera red brand). Modernist design system dropped |
| New screens (login, events list, event capture) | Designed in the 4a/Event style; content taken from old mockups 05/03 |
| Event lifecycle | Event page stepper: **Draft → Review → Contract → Execution → Closed**, with **Cancelled** as a side exit. Status pills (Home, events list) show the step itself: Draft grey, Review yellow, Contract blue, Execution purple, Closed green, Cancelled grey. A cancelled event's stepper is greyed out, with a Cancelled pill by the countdown |
| HCP / HCO | Two separate tables (matching OneKey/OpenData feeds) |
| Expert vs Attendee | Separate records off the same HCP: Expert = paid engagement (role, rate, hours, contract); Attendee = who's in the room (HCP, internal user, or walk-in) |
| Content | File metadata table (like Salesforce ContentDocument). Event Content links files to events; contracts can link a Word template |
| Users | `app_user` with `user_type` human/agent; agents have an owner and their own profile; changes audit actor + on-behalf-of |
| Custom fields | Admin-defined, Salesforce/Vault style. Definitions in `custom_field` (object, API name `x__c`, type, options, required); layout assignment in `custom_field_layout` (object, event type or all, UI section, order). Values live in a `custom_fields jsonb` column on each customisable table, validated by a trigger against the definitions. Reporting gets generated typed views (`report.<object>`), rebuilt when fields change. Chosen over a value table (too awkward to query and report on) and over runtime `alter table` (breaks tenant sharing and the migration history) |
| Event capture | **New event** opens a modal with base + custom fields; Save goes through `create_event()` (one call, one transaction) and lands on the Event page; **Edit event** reopens the same modal via `update_event()` |
| Adding speakers and attendees | Speakers: one inline picker (`PersonPicker`) wherever a speaker is added (agenda "+ Speaker", Speakers "Add speaker"). It searches EC first; **CRM search** is a second step on request ("Search CRM for …"), across all CRM connections or one, with results grouped by connection. Picking a CRM person copies them into EC at once (`crm_import_hcp`); the agenda still saves speakers only with "Save agenda". Attendees: a bulk "Add attendees" dialog with Event Center and CRM sources (file import next): tick many people, the selection carries across sources, and everyone is added in one `add_event_attendees` call |
| Who may create events where | An event type is enabled per country (`event_type_country`); a user manages events in a set of countries (`app_user_country`). Creating an event, or moving it to another country or type, needs both. Enforced in the database; admins and seed scripts are exempt. Reading events is unchanged |
| Products and therapeutic areas | Independent master lists, switched off rather than deleted. Not tied to event types for now (revisit later) |
| Admin access | `profile.can_access_admin` opens the Admin area (System Admin, Business Admin). What can be changed there is permission rows + RLS: Business Admin maintains products, therapeutic areas and users (never System Admin accounts); event types, their countries and CRM connections stay with System Admin |
| User logins | Created from Admin with a temporary password through the **auth adapter** (`create_user_login`, `set_user_password`): the only database code that writes to the identity provider |
| Speakers and the agenda | Putting an HCP on a session adds them to the event's speakers; service hours are the sum of their session time, computed in the database. Prep and travel are entered. Honorarium = (prep + service + travel) × rate. The rate comes from the HCP's FMV record valid on the event's date, negotiable within its range (`expert_rate_policy`, enforced in the database); without an FMV record it is €0 and can't be changed until one is recorded, which then fills it in. In the grid, editable values (rate, prep, travel) sit in boxes; service hours are plain text from the agenda. Removing a speaker removes them from the sessions. A speaker taken off their last session (edited or deleted) leaves the speakers too, unless a contract is sent or executed; speakers added straight to the list stay. Contracts that are sent or signed keep the expert on the event |
| Event access | The Team decides access: an event is visible only to its team (plus Business and System Admins, who see every event). Owner and Organizer edit the event and manage the team; Approver and Viewer view it and post on the board. One owner per event (the event's owner); they can't be removed. Roles are data in `team_role`. Enforced by RLS on the event and every table hanging off it |
| Editing the agenda | The agenda is one document: read-only by default, "Edit agenda" opens every session for inline editing, and "Save agenda" saves all of it in one transaction (`save_agenda`). Speakers change only on save, so moving a speaker between sessions keeps their record; the save bar says beforehand who joins or leaves Speakers. A save started from an older agenda is refused (409) instead of overwriting someone else's changes |
| Repo | `github.com/erikdrawz/event-coordinator-prototype` (private, personal) |

## Mocked integrations (real interface, fake implementation)

| Integration | Prototype behaviour |
|---|---|
| CRM search | ✓ `crm_search_hcp(p)` searches a seeded `crm_mock` schema (one set of HCPs/HCOs per `crm_connection`; not exposed through the API). `crm_import_hcp(connection, id)` copies an HCP and their organisation into `hcp`/`hco` with CRM IDs; it never copies the same CRM record twice and reuses an EC HCP with the same OneKey ID. Connections with status `error` don't answer |
| CRM reconciliation | Matches attendees against `crm_mock`, sets `crm_status` reconciled / not found |
| CRM write-back | Writes to an `integration_outbox` table, the pattern a real connector would use |
| Contracting (CLM) | Contracts are drafted in EC from Markdown templates (merge fields filled in the database, honorarium kept on the contract). `send_contract` stores the PDF and hands it to the contracting tool (mocked: a CLM reference); signing is marked by hand until the tool reports back. Statuses: draft → sent → executed, cancelled |

## Phases

Each phase ends in something demoable.

### Phase 0: Foundation ✓
- Repo, docs, CI workflows (DB deploy, demo reset, web build)
- Schema v1: tenancy, users and security, reference data, HCP/HCO, request/event core, the Event page objects (team, session, speakers, attendees, content, posts, tasks), approvals, notifications, audit
- Row-level security + permission model; audit trigger with actor/on-behalf-of
- Seed: Alera Pharma, demo users (humans + one agent), the SMA Board / BioForum / Neurology Meet scenarios
- UI: app shell (header, nav, notifications bell, user menu) + login
- **Demo:** log in as Paul Taylor and see the real shell.

### Phase 1: Login, Home, Events list, Event page, Event capture ← *current*
- ✓ Home 4a on live data: agenda (my/all, upcoming/past), mini calendar, recently worked on, needs my action, unassigned requests, notifications
- ✓ Events list (sort/filter), on the reusable `DataTable` in `apps/web/src/ui/`
- Event capture: New/Edit event modal with base + custom fields, via `create_event()` / `update_event()`; status changes via `change_event_status()`
- ✓ Custom fields: definitions, layout assignment, jsonb values with validation, generated reporting views; Admin page to create them (dropdown, text, number with decimals, URL) and assign them to event types; shown on the Event details tab in creation order
- Event page: header + stepper, Overview (✓ agenda, ✓ speakers/honorarium grid, content), Team (posts, tasks), Attendees, Documents, ✓ Event details
- Capture of related data: sessions, speakers (experts), attendees, content
- "Add people" dialog: EC HCP table first, then **mock CRM search** (`crm_mock` schema + search/import functions), then file import
- Admin basics (pulled forward from Phase 6): event types with their countries; product and therapeutic area lists; users with profile, home country, event countries and logins
- **Demo:** create an event, build its agenda and speaker grid, post to the team board.

### Phase 2: Requests & approvals
Request list and form, submit, the approval process per event type, approval history, an approved request creates its event, notifications.
- ✓ Requests list (`/requests`): status counts for incoming volume, All / My requests, search; New request
- ✓ Request page: name, event type, date and rough duration (1–3 hours … more than 2 days), business justification, status (draft → review → approved | rejected) in the header; Actions: Submit for approval, Delete (drafts only); Team and Discussion as on events
- ✓ Access: the request's Team decides (creator = owner); drafts are private to the team, submitted requests are visible to home office (view_all on `event_request`)
- ✓ Approving and rejecting: a request in review gets Approve / Reject in its Actions for home office and its Approvers, never the requester; a rejection needs a reason; the decision (who, when, note) shows on the request and the requester is notified. Submitting notifies the request's approvers
- Next: multi-step approval processes (`approval_process`), assigning a coordinator, an approved request creates its event; an approved tiering request updates the expert

### Phase 3: Experts, FMV, tiering, contracts
Expert directory and profile, FMV rates, tier requests, contracts (service agreement / work order) with templates, **mock CRM search**, **mock contracting**, "Run checks" on speakers.
- ✓ Experts list (`/experts`): Eligible / All experts, search, country and specialty; eligibility, organisation, tier, current FMV rate, engagements
- ✓ Expert page: eligibility (with the reason), engagements (events past and upcoming), FMV rates (effective, expiration, rate, min, max), details; Contracts is a placeholder
- ✓ Edit expert (profiles that can edit `hcp`): name, title, email, specialty, tier, organisation, city, country, OneKey ID, eligibility and reason. Changes stay in EC; CRM write-back comes later
- ✓ Rates on events come from the expert's FMV record valid on the event's date (default and negotiable range)
- ✓ Contracting v1: MSA (expert level), Work Order (needs a signed MSA covering the event), Single-event Contract, Addendum. Created from the event's Experts grid (MSA from the expert page) with `create_contract`; text drafted from a template with the honorarium (prep, service, travel, total); contract page with print view, PDF, send for signature (PDF stored in the `contracts` bucket), mark as signed, cancel, delete draft
- ✓ Admin → Contract templates: upload Markdown, preview with merge fields, event types and countries; event types list their templates
- ✓ Template versions: each in effect from a date (scheduled, in effect, retired); a contract gets the version in effect on its event's date, so next year's templates can be prepared ahead; versions are fixed once used for a sent contract
- ✓ Tiering requests: a second request type (expert + business justification, optionally the event); New request asks which kind; logged from the event's Experts grid for experts who aren't eligible; listed with a Type filter and in Home's unassigned requests. Approved or rejected like any request
- Next: add/edit FMV records in the UI, what an approved tiering request changes (tier, eligibility), contracts from the expert page beyond MSA (decide), a real CLM/e-signature integration (status back from the tool), PDF made on the server (edge function) so agents get it without a browser, venue contracts in the same flow

### Phase 4: Attendees & reconciliation
- ✓ Attendees tab (name, role, organisation, RSVP, CRM status); Add attendees dialog: HCPs from Event Center (this event's experts first, select all) or the CRMs (copied into EC when added); RSVP changed from the row; remove
- ✓ Attendees and Experts: a side panel on row click with every field, and bulk actions on ticked rows (attendees: RSVP, Attended, Owner, Remove; experts: Role, Remove)
- Next: import from a file, **mock reconciliation** for attendees still to reconcile, CRM write-back via the outbox

### Phase 5: Spend
Budgets, planned/actual expenses, invoice upload + extraction (an agent-user demo).

### Phase 6: Admin (rest)
Still to come after the Phase 1 basics: business rules, approval processes, event statuses per event type, custom field ordering and sections, more field types in the Admin UI, CRM connections.
Users and profiles, event types, custom fields, approval process builder, integration settings over the mocks.

### Later / optional
- **Create a record from text:** describe an event in plain language and the system drafts it. Built as an agent user calling the same `create_event()`, so the user reviews the draft in the normal modal
- AI "guardian angel" compliance checks (plain-English rules interpreted by Claude) as a real agent user
- MCP server over the API for agent access
- A second Supabase project as the `demo` environment

## Out of scope for the prototype
Real CRM/CLM APIs, real OCR, SSO/SAML, multi-tenant activation, email delivery, reporting dashboards.
