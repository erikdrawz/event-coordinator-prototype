# Event Center: AI approach

Status: v0.2 (29 Oct 2026). v0.2 adds AI-assisted configuration (section 4). Discussion outcome between Erik and Claude, not built yet. Companion to [ARCHITECTURE.md](ARCHITECTURE.md) and [BUILD-PLAN.md](BUILD-PLAN.md).

## In one paragraph

Event Center doesn't get a chatbot. It gets two things:

- **An MCP server**, so each customer's own approved AI (Claude, Copilot, ChatGPT, Gemini) can work with Event Center as the signed-in user.
- **A small set of agents** that run inside Event Center on documents people already handle: an invoice scanner, a contract consistency checker, and a business rules engine that warns rather than blocks.

All of them go through the same API and the same database security as the UI. Every AI output is a **proposal with provenance** that a human confirms or overrides, and all of it is audited.

## Principles

1. **Bring your own AI.** Pharma companies approve AI tools centrally: data processing agreements, privacy assessments, model approvals. Event Center plugs into the AI they've already approved instead of adding another one to their data chain. This also holds for built-in agents: the model provider is a per-tenant setting, and the target is the customer's own AWS, Azure or Google Cloud AI account.
2. **One door.** The UI, the MCP server and the agents all call the same database functions under the same row-level security. The AI can never do more than the user it acts for, and everything it does an agent could also do through the plain API.
3. **The assistant acts *as* you; an agent acts *for* you.**
   - **Assistant mode (MCP):** a person typed the instruction, so that person is the actor. The audit records "Paul Taylor, via Claude".
   - **Agent mode (scanner, rules engine):** no one typed anything, so a named agent user (`app_user.user_type = 'agent'`) is the actor, recorded as acting on behalf of a human. The UI shows the robot avatar.
4. **Propose, then confirm.** AI output lands as a draft or pending item with its sources, never as a silent commit. Humans confirm, edit or override. Overrides need a reason.
5. **Numbers are never generated.** Rates, hours, amounts, dates and counts come from data and are computed deterministically. AI is for reading unstructured input, judging fuzzy rules, and writing narrative text.
6. **Explainability over accuracy claims.** Every AI result stores:
   - the reasoning
   - the cited fields or document snippets
   - the model and prompt version
   - the rule version, where one applies

   Trust comes from being able to check, not from being told it's right.

---

## 1. Assistant mode: the Event Center MCP server

### What users can do
- "Create an advisory board in Copenhagen on 31 Jan, Dr Muir chairing, about 14 people." The result is a draft event plus a link.
- "Add Dr Griffiths as a speaker on the treatment-landscape session, 30 minutes."
- "Submit SMA Board for approval." The AI asks for confirmation first.
- "What's waiting for me?" / "Summarise spend on my events for the last two months."
- "Find Dr Solberg in the Nordics CRM and add her to Neurology Meet."

### Tool design
Expose **tasks, not tables**. A short list of well-described verbs, each wrapping an existing or new database function, so the security rules, lifecycle rules and audit apply unchanged.

| Tool | Wraps | Kind | Notes |
|---|---|---|---|
| `whoami` | `me()` | read | profile, countries, permissions |
| `find_events` | `event` + filters | read | date range, status, country, "mine", text |
| `get_event` | event + agenda + speakers + team | read | returns a compact summary, not raw rows |
| `create_event` | `create_event()` | draft write | always creates in Draft; returns a link |
| `update_event` | `update_event()` | draft write | |
| `save_agenda` | `save_agenda()` / `save_event_session()` | draft write | |
| `search_hcp` / `import_hcp` | `crm_search_hcp()` / `crm_import_hcp()` | read / write | goes through the (mock) CRM, never invents HCPs |
| `add_speaker` | speaker functions | draft write | rate comes from FMV / rate policy, not the model |
| `my_actions` | approvals + tasks + unassigned requests | read | the "Needs my action" list |
| `create_request` / `save_request` | `save_request()` | draft write | |
| `submit_for_approval` | approval workflow (Phase 2) | **consequential** | confirm with the user first |
| `change_event_status` | `change_event_status()` | **consequential** | confirm; transitions are data |
| `spend_summary` | new summary function (Phase 5) | read | aggregated server-side by event, category, currency, month |
| `run_checks` | rules engine | read + trigger | returns findings with reasoning |

Rules for tools:
- **Return links.** Every write returns the deep link (`https://<app>/events/<id>`).
- **Aggregate in the database.** Summaries and analytics are database functions that return totals. The model never pulls hundreds of rows to add them up.
- **Use MCP tool annotations** (`readOnlyHint`, `destructiveHint`) so AI clients can ask for confirmation on the right tools. Consequential tools' descriptions also tell the model to confirm with the user first.
- **Keep responses compact.** Shape results for a model to read (names, statuses, dates in the event's time zone), not raw table rows.

### Identity and audit
- **Per-user sign-in.** Each person connects their AI to Event Center as themselves, using the MCP standard's OAuth flow. The MCP server calls the API with that user's token, so team access, profiles and country rules apply exactly as in the UI.
- **No shared service key, ever.** Agents have their own login.
- **Record which channel a change came from.** Add `via` to `audit_log` (`ui`, `mcp:<client>`, `agent`, `api`). The MCP server sends an `X-EC-Channel` header, and the audit trigger records it next to the actor.
- **Prototype shortcut.** A local MCP server in Claude Desktop, configured with the demo user's login, is enough to demo. The remote server with OAuth is the product version. Check how far Supabase Auth's OAuth server support has come before building our own authorisation layer.

### Guardrails
- **Prompt injection.** Event Center holds text written by others: posts, uploaded documents, speaker-supplied content. Treat it as data:
  - Consequential tools are narrow and need confirmation.
  - Nothing in a document can trigger an action on its own.
  - Tool results label user-generated text as such.
- **Data minimisation.** A per-tenant `ai_exposure` policy says which tools, and which HCP fields (email, address, phone), are available through MCP. The MCP server enforces it. Default: event and HCP names and roles yes, contact details no.
- **Rate limits** per user on the MCP server.

---

## 2. Agent mode: the shared runtime

Build once, then reuse for every agent:

- **Job queue** (`agent_job`):
  - kind, subject record, status (queued, running, done, failed), requested_by, the acting agent user
  - attempts, timing, error
  - created by a button click or a trigger, picked up by a small worker
- **Proposals** stay where the domain data lives:
  - pending expense lines, rule findings, contract check results
  - each with `source_job_id`, `confidence`, `evidence` (snippet, page, field), `model`, `prompt_version`
- **Per-tenant AI settings** (`tenant_ai_settings`):
  - provider and endpoint (customer's cloud or the Claude API)
  - which agents are on
  - the data exposure policy
- **Agents are users.** Each runs as its agent user, with its own profile and permissions. It acts on behalf of the person who triggered it, and the person is recorded too.
- **Agents are triggered by simple actions** ("Upload invoice", "Run checks"), never by typing a prompt into Event Center.

### 2a. Invoice scanner

**Flow.** Upload an invoice or receipt on the event's Spend tab. The Invoice Agent:
1. extracts the header and lines
2. maps each line to an expense type, budget and currency
3. creates `actual_expense` lines with status **pending review**, each with confidence and a link to the source spot in the document
4. waits for a human to confirm, edit or reject each line

**The differentiator is transfer of value, not reading the invoice.** Every expense tool can read invoices. Event Center knows who attended, so it can propose how a dinner line splits per HCP, flag which amounts are reportable (EFPIA Disclosure Code by country, Sunshine Act for US HCPs), and catch per-head limits. That's the part an expense tool can't do.

**Demo.** Drop the Copenhagen Marriott invoice on SMA Board. Lines appear as pending, with the per-HCP split for the 5 accepted HCPs and a warning that Dr Holm declined but appears on the seating list.

### 2b. Contracts: template merge + consistency checker

**Generation is deterministic.** An approved Word template (in `content`, linked from `contract.template_content_id`) is filled from event data:
- parties
- payee (HCP or institution, via Contracting Org)
- services, rate, hours, dates
- event name and venue

No model writes these values. The model is optional, and only for narrative parts such as a service description.

**"Based on an example" is a one-off setup step.** Turn an example contract into a reviewed template once. Never generate each contract from an example, because that drifts and legal will reject it.

**The bigger win is the consistency checker.** The BMS issue analysis found that agenda errors, honorarium-grid (H.Grid) errors and HCO/contracting mismatches cause roughly half of all issues. The root cause is several documents that must state the same facts independently. The checker compares:
- agenda ↔ speakers grid: who speaks, how long, prep and service hours
- speakers grid ↔ contract: rate, hours, payee, dates, service type
- contract ↔ actual attendance and spend after the event

It raises findings like "Dr Griffiths' work order says 1.0 service hours; the agenda gives him 60 minutes across two sessions". This positions Event Center as the **origination layer** that sends clean, consistent contract requests into the CLM (e.g. Icertis). Legal doesn't need to trust AI-written clauses.

---

## 3. Business rules engine ("guardian angel")

### Rule model
- `compliance_rule`: title, **text** (the policy as compliance wrote it), scope (country, event type, participant role, stage), effective_from/to, owner, status (draft, approved, retired).
- `compliance_rule_version`: every wording change is a new version. Results always point at the version that ran.

### Two kinds of evaluation
The text is always the source of truth. How it's evaluated depends on the rule:

| Kind | Examples | How it runs |
|---|---|---|
| **Computed** | annual engagement caps, FMV maximums, meal limit per head, lead times, required documents present, speaking-time caps | The system proposes a structured check from the text; compliance approves that interpretation once; from then on it runs deterministically in the database. Same answer every time. |
| **Judgement** | "venue must not be chosen for its leisure facilities", "hospitality must be secondary to the scientific purpose" | An AI reads the rule text against an event snapshot and returns a verdict with reasoning and cited fields |

Why the split: an AI counting engagements across a year can be wrong, and can be wrong differently tomorrow. An auditor asking "why did this pass last week and fail today?" needs a deterministic answer for anything that can be computed.

**Rules already in the code.** The speaking-time cap and expert rate policy are deterministic rules hard-coded today. They should become the first *computed rules*: same logic, but owned by the rule text and its approved interpretation.

### Results and overrides
`rule_check` stores one row per rule per evaluation:
- event, rule version, verdict (pass, warning, fail, not applicable), reasoning, cited fields
- model and prompt version, for judgement rules
- snapshot hash, timestamp, the acting agent

`rule_check_override` stores who accepted a warning or fail, and why. The record of checks and overrides *is* the compliance audit trail.

### When checks run
- **On meaningful change:** speaker added or changed, venue or date changed, moved to Review, contract created. Changes are batched, so ten edits make one run and at most one notification.
- **On demand:** the existing "Run checks" button.
- **Before submitting for approval**, showing the findings to the submitter.

Findings **warn, they never block**. A fail shows as a notification and a badge on the event or speaker row, and can be overridden with a reason.

### Test set
`rule_test_case`: a few dozen seeded events with the expected verdict per rule. It re-runs whenever a rule's wording, its interpretation or the model changes, and reports any changed verdict before the change goes live. Regulated customers will ask how a rule edit can't silently change outcomes; this is the answer.

---

## 4. AI-assisted configuration

Admins can configure Event Center through their AI client:
- profiles and permissions, team roles
- approval processes
- event types per country, custom fields and layouts
- contract templates
- compliance rules

This is possible because configuration in Event Center is data, behind the same database functions and security as everything else.

### Ground rules (decided)

1. **Admins only.** Configuration tools exist only for users whose profile can access Admin, and only within what that admin may already change; the Business Admin vs System Admin limits are enforced in the database. On top of that:
   - Configuration through AI is a separate, explicitly granted permission (an admin scope at sign-in).
   - It's off by default per tenant.
2. **AI configures the test environment only, never production.**
   - The configuration functions refuse calls from MCP or agent channels in an environment marked `production`. This check is enforced in the database, not in the MCP server.
   - In production the AI can still *read and explain* configuration, e.g. "why can't Lisa see BioForum?".
3. **Production changes only by deployment.** A tested configuration moves from test to production as a **configuration package**, applied deterministically. The change is never replayed through AI in production. What runs in production is exactly what was tested.

### In the test environment
- **Translating intent.** The AI turns requests into configuration: "Sarah should edit attendees but not speakers, Nordic events only"; "UK speaker meetings need Medical then Compliance sign-off above £2,000 honoraria".
- **Versioned and reversible.** Every change is versioned and can be undone. Changes are grouped into a named **change set** (what, why, requested by, via which AI client), which later becomes the content of a package.
- **Impact preview.** Admin functions accept `p_dry_run`: the change runs inside a transaction, the impact is measured, and the transaction rolls back. Examples:
  - "14 users gain edit access to 230 events in DE"
  - "these 37 open events would route differently"
- **Simulation.** Approval flows and rules are tested against sample events before packaging: "these 5 events would route like this".
- **The AI authors, the system runs.**
  - Approval routing conditions are a structured, deterministic model, evaluated by the database. A model never decides routing at runtime.
  - Contract templates map an example's details to data-model merge fields once, then legal approves the template.
  - It's the same compile-then-approve pattern as the rules engine.
- **Avoid sprawl.** Before proposing something new, the AI checks for an existing match ("a profile with these rights already exists: use it?").

### Promotion: test → production
- **Configuration as a document.** `export_config()` produces a readable, versioned package (profiles, permissions, roles, event types and countries, custom fields and layouts, approval processes, templates, rules) with a content hash.
- **Stable keys, not UUIDs.**
  - Every configuration record carries an environment-independent `key` (custom fields already have `api_name`).
  - Packages match by key, so the same profile or approval process is recognised across environments.
  - **Add this to every config table now**; retrofitting it later is painful.
- **Deployment in production**, in this order:
  1. Diff the package against production's current configuration.
  2. Run an impact preview against production data (dry run).
  3. Get approval. High-risk content (permissions, team roles, approval routing, compliance rules) needs a **second approver**. Tiers below.
  4. Apply in one transaction.
  5. Record the deployment: package hash, diff, approvers, timestamp.
- **Rollback** means deploying the previous package.
- **In-flight records stay on their version.** Approvals already in progress and rule checks already run keep the version they started with.
- **Drift detection.** Production configuration changed outside a deployment (e.g. a manual hotfix in the Admin UI) is flagged against the last deployed package. Optional per tenant: a production configuration lock, where configuration changes come *only* through deployment.

### Risk tiers (deployment approval)

| Tier | Examples | Deployment approval |
|---|---|---|
| Low | product list, therapeutic areas, picklist values, labels | one admin |
| Medium | custom fields and layouts, event types per country, contract templates | one admin, impact preview shown |
| High | profiles and permissions, team roles, approval routing, compliance rules | two approvers, impact preview required |

### Test environments and data
- **The test environment needs realistic data without real HCP personal data.** Use synthetic or masked HCP records, never an unmasked copy of production.
- **The prototype already has the shape for a demo.** The free tier allows two Supabase projects: one becomes "test" (AI configures), the other "production" (deploy only). Demo: "Add a Medical review step for UK speaker meetings" in Claude against test → preview → package → deploy to production → the next UK event routes through Medical.

---

## Proposed data model additions

| Table / change | For |
|---|---|
| `audit_log.via` | channel attribution (ui, mcp, agent, api) |
| `tenant_ai_settings` | model provider, enabled agents, exposure policy |
| `ai_exposure` (or a jsonb policy in settings) | which MCP tools and HCP fields are allowed |
| `agent_job` | queue and run history for agents |
| evidence/provenance columns on proposals (`source_job_id`, `confidence`, `evidence jsonb`, `model`, `prompt_version`) | pending expenses, findings |
| `compliance_rule`, `compliance_rule_version` | rule text, scope, versions |
| `rule_check`, `rule_check_override` | results, audit |
| `rule_test_case` | regression set |
| `contract_check` (or findings generalised: `finding` with kind) | consistency checker output |
| `key` column on every configuration table | environment-independent identity for promotion |
| `environment` setting (`test` / `production`) | blocks AI-originated configuration changes in production |
| `config_change_set` | grouped, described configuration changes in test |
| `config_package`, `config_deployment` | exported packages (content + hash) and their deployment record (diff, impact, approvers) |
| `p_dry_run` on every admin function | impact preview before applying |

## Build order

1. **MCP server**, read tools plus draft writes. Cheapest given the API-first design, and the clearest "AI-friendly" story.
   - Demo: create SMA-style event from a prompt → link → open in Event Center.
2. **Rules engine.** Start with the computed rules already in code, plus two judgement rules for one country (Denmark or the UK/ABPI). This is the main differentiator, and the BMS evidence backs it.
3. **Invoice scanner**, with the transfer-of-value split. Depends on Phase 5 (Spend).
4. **Contract consistency checker.** Depends on Phase 3 contracts. Template merge alongside it.
5. **Consequential MCP tools** (submit for approval, status changes) and `spend_summary`, once the approval workflow and spend exist.
6. **AI-assisted configuration.** Most of the cost is groundwork, which belongs in the Admin build now:
   - stable `key` columns on config tables
   - admin changes only through database functions, with `p_dry_run`
   - the environment flag

   Then the configuration export, a second Supabase project as "test", and the deployment flow. AI configuration tools come last.

## Open questions

1. **Which AI clients to target first** besides Claude: Microsoft Copilot is the likeliest enterprise default in pharma. This affects the authentication and testing work.
2. **The first rules country** for the engine demo: UK (ABPI, which is well known to BMS) or Denmark (matching the SMA Board demo data)?
3. Whether the contract template merge belongs in the prototype at all, or the consistency checker alone is the stronger demo.
4. **Manual configuration in production.** Allow it with drift detection, or lock production so configuration comes only through deployment? Possibly a per-tenant choice.
5. **Product name.** "Event Center" is generic, so it's hard to trademark and to find in search. Decide whether it's always "Brightside Event Center". The docs and code still say Event Coordinator (EC) in places.
