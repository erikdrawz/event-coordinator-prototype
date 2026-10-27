# Event Coordinator: Prototype Build Plan (v0.2)

Status: 26 Oct 2026. Supersedes v0.1 (Next.js/Vercel/Supabase). See [ARCHITECTURE.md](ARCHITECTURE.md) for the principles behind these choices.

## Decisions made

| Topic | Decision |
|---|---|
| Platform | Supabase free tier (Postgres, Auth, Storage, auto REST API), avoiding Supabase-only logic so the AWS move stays cheap |
| UI | Vite + React + TS single-page app; static hosting (Cloudflare Pages or Netlify, not Vercel's free plan, whose terms rule out commercial use) |
| Visual source of truth | Home **4a** + **Event page** (Figtree, cool grey ground, blue accent, Alera red brand). Modernist design system dropped |
| New screens (login, events list, event capture) | Designed in the 4a/Event style; content taken from old mockups 05/03 |
| Event lifecycle | Event page stepper: **Draft → Review → Contract → Execution → Closed**, with **Cancelled** as a side exit. Home pills map Planning = Draft, In approval = Review, Approved = Contract/Execution |
| HCP / HCO | Two separate tables (matching OneKey/OpenData feeds) |
| Expert vs Attendee | Separate records off the same HCP: Expert = paid engagement (role, rate, hours, contract); Attendee = who's in the room (HCP, internal user, or walk-in) |
| Content | File metadata table (like Salesforce ContentDocument). Event Content links files to events; contracts can link a Word template |
| Users | `app_user` with `user_type` human/agent; agents have an owner and their own profile; changes audit actor + on-behalf-of |
| Custom fields | Admin-defined, Salesforce/Vault style. Definitions in `custom_field` (object, API name `x__c`, type, options, required); layout assignment in `custom_field_layout` (object, event type or all, UI section, order). Values live in a `custom_fields jsonb` column on each customisable table, validated by a trigger against the definitions. Reporting gets generated typed views (`report.<object>`), rebuilt when fields change. Chosen over a value table (too awkward to query and report on) and over runtime `alter table` (breaks tenant sharing and the migration history) |
| Event capture | **New event** opens a modal with base + custom fields; Save goes through `create_event()` (one call, one transaction) and lands on the Event page; **Edit event** reopens the same modal via `update_event()` |
| Adding speakers and attendees | One "Add people" dialog with three sources: EC's own HCP table, **mock CRM search** (pulled forward from Phase 3 because it matters for demos), and file import |
| Repo | `github.com/erikdrawz/event-coordinator-prototype` (private, personal) |

## Mocked integrations (real interface, fake implementation)

| Integration | Prototype behaviour |
|---|---|
| CRM search | Searches a seeded `crm_mock` schema (HCPs/HCOs "in Veeva EU" / "Salesforce US"), then imports into `hcp`/`hco` with CRM IDs |
| CRM reconciliation | Matches attendees against `crm_mock`, sets `crm_status` reconciled / not found |
| CRM write-back | Writes to an `integration_outbox` table, the pattern a real connector would use |
| Contracting (CLM) | `send_contract` moves status draft → sent → executed, with a fake CLM reference |

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
- Custom field foundation: definitions, layout assignment, jsonb values with validation, generated reporting views (admin screens come in Phase 6)
- Event page: header + stepper, Overview (agenda, speakers/honorarium grid, content), Team (posts, tasks), Attendees, Documents, Event details
- Capture of related data: sessions, speakers (experts), attendees, content
- "Add people" dialog: EC HCP table first, then **mock CRM search** (`crm_mock` schema + search/import functions), then file import
- **Demo:** create an event, build its agenda and speaker grid, post to the team board.

### Phase 2: Requests & approvals
Request list and form, submit, the approval process per event type, approval history, an approved request creates its event, notifications.

### Phase 3: Experts, FMV, tiering, contracts
Expert directory and profile, FMV rates, tier requests, contracts (service agreement / work order) with templates, **mock CRM search**, **mock contracting**, "Run checks" on speakers.

### Phase 4: Attendees & reconciliation
Invite/attend tracking, bulk actions, **mock reconciliation**, CRM write-back via the outbox.

### Phase 5: Spend
Budgets, planned/actual expenses, invoice upload + extraction (an agent-user demo).

### Phase 6: Admin
Users and profiles, event types, custom fields, approval process builder, integration settings over the mocks.

### Later / optional
- **Create a record from text:** describe an event in plain language and the system drafts it. Built as an agent user calling the same `create_event()`, so the user reviews the draft in the normal modal
- AI "guardian angel" compliance checks (plain-English rules interpreted by Claude) as a real agent user
- MCP server over the API for agent access
- A second Supabase project as the `demo` environment

## Out of scope for the prototype
Real CRM/CLM APIs, real OCR, SSO/SAML, multi-tenant activation, email delivery, reporting dashboards.
