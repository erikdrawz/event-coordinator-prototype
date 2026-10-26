# Event Coordinator: Prototype Architecture

Status: v0.2 (26 Oct 2026). This is the companion to [BUILD-PLAN.md](BUILD-PLAN.md) and [DATA-MODEL.md](DATA-MODEL.md).

## What this prototype is

The prototype runs every demo on a real database with test data. It isn't enterprise-ready or multi-tenant-ready, but it's built so that most of its parts carry into the real product:

- the schema
- the security rules
- the API surface
- the seed scenarios
- the UI components

Integrations that we can only illustrate get real interfaces with fake implementations behind them:

- CRM search
- CRM reconciliation
- CRM write-back
- contracting/CLM

## Principles

1. **The database and security layer are the product core. The UI is one client of it.**
   - All access rules are enforced in Postgres (row-level security) and in database functions. The UI never makes a security decision.
   - The UI talks to the same HTTP API that agents and customer-built UIs would use. No privileged back door, no service key in the browser.
   - Business workflows such as submit request, change event status or add a speaker are database functions exposed as API calls (`/rpc/...`). They are not UI code.
   - The test is simple: a customer, or a vibe-coding customer, must be able to build their own UI on the API without reading our UI code.

2. **There are two user types: human and agent.**
   - Both are rows in `app_user` (`user_type = 'human' | 'agent'`). Both authenticate, and both are bound by the same security rules.
   - An agent has an owning human (`owner_user_id`) and its own profile, so its permissions can be narrower than its owner's.
   - Every change is audited with the actor. When an agent acts for a person, the person is recorded too. The agent sends an `X-On-Behalf-Of: <app_user.id>` header, and the audit trigger records it as `on_behalf_of_user_id`.
   - The UI shows what agents did ("Extracted by Invoice Agent, confirmed by Paul Taylor").

3. **The data model is CRM-shaped.** Entities follow the Veeva and Salesforce events models (Event, Attendee, Expert/Speaker, Team, Session, History, Content), so connectors can map them almost one-to-one. HCP and HCO are separate tables, matching how IQVIA OneKey and OpenData deliver them. Every record mirrored from a CRM carries `crm_connection_id` and `crm_external_id`.

4. **Use Supabase as "Postgres plus conveniences", not as a platform.**
   - Schema and policies are plain SQL migrations in the repo, so they move to RDS/Aurora unchanged.
   - The API engine is PostgREST, which is open source and can be self-hosted on AWS.
   - Auth is the one Supabase-specific piece. It is reached only through `auth.uid()` inside `app.current_user_id()`, and through one auth module in the UI. Swapping to Cognito or customer SSO touches those two places.
   - No business logic lives in Supabase-only features (dashboard-made triggers, edge-only logic).

5. **Data is tenant-ready, deployment is single-tenant.** Every business table has `tenant_id`, and row-level security filters on it. One tenant ("Alera Pharma") is seeded.

6. **Seed scenarios are the demo script.** Demo data lives in `supabase/seed/*.sql`. It uses fixed IDs and dates relative to today ("SMA Board" is always 5 days out), so the demo never goes stale. One command resets it.

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Database | Supabase Postgres (free tier) | SQL migrations in `supabase/migrations`, applied by CI |
| Security | Postgres row-level security + permission tables (`profile`, `permission`, `user_group`) | Salesforce-style object permissions, enforced in the DB |
| API | PostgREST (Supabase's auto REST API) + `rpc` functions | OpenAPI spec is generated automatically from the schema |
| Auth | Supabase Auth (email/password demo users) | Behind `app.current_user_id()` and `apps/web/src/lib/auth.ts` |
| Files | Supabase Storage, metadata in `content` | S3 later, behind the same metadata table |
| UI | Vite + React + TypeScript single-page app (`apps/web`) | Static build, hostable for free (Cloudflare Pages / Netlify) |
| UI style | Figtree, tokens from Home 4a + Event page (`apps/web/src/styles/tokens.css`) | Modernist design system is dropped |
| Icons | Lucide | Same set as the designs |
| CI | GitHub Actions | `db-deploy` (migrations), `db-reset-demo` (reseed), `web-build` |

**Why a single-page app and not Next.js.** A server-rendered UI framework tempts you to put data access and logic in UI-server code, which would break principle 1. A static app that can only call the public API keeps us honest, and it hosts for free anywhere.

## Request flow

```
Browser (apps/web)  ──JWT──▶  PostgREST /rest/v1  ──▶  Postgres (RLS + rpc functions + audit triggers)
Agent (script/MCP)  ──JWT──▶        same API
Mock integrations   ──────▶  rpc functions / seeded mock tables (crm_mock.*)
```

## Environments

| Env | Where | Purpose |
|---|---|---|
| local | `supabase start` (Docker) on a laptop | Development; `supabase db reset` applies migrations + seed |
| dev | Supabase project `jwydbztvfqmosjtkwkmx` | Shared, deployed by CI on merge to `main` |
| demo | Second free Supabase project (later) | Only deliberate deploys + resets, so a demo never runs on half-finished work |

## Repository layout

```
docs/                 architecture, plan, data model, design references
supabase/
  config.toml         local stack config
  migrations/         schema, security, functions (plain SQL, ordered)
  seed/               demo scenarios (SQL, relative dates, fixed IDs)
apps/web/             the UI (Vite + React + TS)
.github/workflows/    CI
```
