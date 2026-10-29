# Event Center — Prototype

A demo-real prototype of **Event Center (EC)**, Brightside's application for strategic, cross-border pharma events. Real database, real security rules, a public API, and a UI that is just one client of that API.

- **Why it's built this way:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **What gets built, in which order:** [docs/BUILD-PLAN.md](docs/BUILD-PLAN.md)
- **The data model:** [docs/DATA-MODEL.md](docs/DATA-MODEL.md)
- **Visual source of truth:** [docs/design/](docs/design) (Home 4a + Event page)

## Repository layout

```
supabase/migrations/   schema, security (RLS), API functions — plain SQL, applied in order
supabase/seed/         demo scenarios (Alera Pharma); dates are relative to today
apps/web/              UI: Vite + React + TypeScript
tests/api-smoke.mjs    API + security checks, run against any environment
.github/workflows/     deploy migrations, reset demo data, build the UI
```

## Run it locally

Needs Node 22+, Docker and the [Supabase CLI](https://supabase.com/docs/guides/local-development).

```bash
supabase start                 # local Postgres + Auth + API; applies migrations and seed
npm install
cp apps/web/.env.example apps/web/.env.local
#   set VITE_SUPABASE_URL=http://localhost:54321 and the anon key printed by `supabase start`
npm run dev                    # http://localhost:5173
```

`supabase db reset` rebuilds the local database from migrations + seed at any time.

## Demo accounts

All demo logins use the password `EC-demo-2026!`. Change it before showing the environment to anyone outside the team.

| Who | Login | Profile |
|---|---|---|
| Paul Taylor | paul.taylor@alera.example | Event Coordinator (demo lead) |
| Lisa Anderson | lisa.anderson@alera.example | Event Coordinator |
| Sarah Mitchell | sarah.mitchell@alera.example | Collaborator (medical lead) |
| Michael Chen | michael.chen@alera.example | Collaborator |
| Daniel Novak | daniel.novak@alera.example | Account Manager (field rep) |
| Alex Morgan | alex.morgan@alera.example | System Admin |
| Maria Castillo | maria.castillo@alera.example | Business Admin |
| Compliance Agent | compliance-agent@agents.alera.example | Agent (owned by Paul) |
| Invoice Agent | invoice-agent@agents.alera.example | Agent (owned by Lisa) |

## Hosted environment (Supabase `jwydbztvfqmosjtkwkmx`)

One-time setup:

1. **Repository secrets** (Settings → Secrets and variables → Actions): `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`, `SUPABASE_ACCESS_TOKEN`.
2. Run the **Database — reset demo data** workflow (type `RESET`). It applies all migrations and the demo seed.
3. In the Supabase dashboard, turn off public sign-ups: **Authentication → Sign In / Providers → Allow new users to sign up = off**.

After that:

- Merging migration changes to `main` deploys them automatically (**Database — deploy migrations**).
- **Database — reset demo data** restores the demo to a clean state whenever you need it.

## Using the API directly (agents, scripts, customer UIs)

Everything the UI does goes through the same public API:

```bash
# sign in (human or agent) → access token
curl -s "$SUPABASE_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON_KEY" \
  -H 'content-type: application/json' -d '{"email":"compliance-agent@agents.alera.example","password":"EC-demo-2026!"}'

# read events (row-level security applies)
curl -s "$SUPABASE_URL/rest/v1/event?select=name,status,starts_at" -H "apikey: $ANON_KEY" -H "authorization: Bearer $TOKEN"

# an agent acting for a person: add X-On-Behalf-Of so history shows both
curl -s -X PATCH "$SUPABASE_URL/rest/v1/event_expert?id=eq.$ID" -H "apikey: $ANON_KEY" -H "authorization: Bearer $TOKEN" \
  -H "x-on-behalf-of: $PAUL_USER_ID" -H 'content-type: application/json' -d '{"check_status":"passed"}'
```

The API description (OpenAPI) is served at `$SUPABASE_URL/rest/v1/` with the anon key.

Check an environment end to end:

```bash
SUPABASE_URL=... SUPABASE_ANON_KEY=... npm run test:api
```
