-- =====================================================================
-- Event Coordinator — Core schema v1
-- Reference data, customer master (HCP/HCO), requests & events,
-- participants, contracting, content, collaboration, approvals.
-- See docs/DATA-MODEL.md for the model narrative.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Global lookups (no tenant) — readable by every signed-in user
-- ---------------------------------------------------------------------
create table public.country (
  code    char(2) primary key,
  name    text not null,
  region  text not null            -- EMEA, NA, LATAM, APAC, JP
);

create table public.event_status (
  code         text primary key,
  label        text not null,      -- Event page stepper label
  home_label   text not null,      -- Home 4a pill label
  tone         text not null,      -- grey | blue | yellow | green | red
  sort         int  not null,
  is_terminal  boolean not null default false
);
comment on table public.event_status is 'Canonical event lifecycle: draft → review → contract → execution → closed; cancelled is a side exit.';

create table public.request_status (
  code   text primary key,
  label  text not null,
  tone   text not null,
  sort   int  not null
);

-- ---------------------------------------------------------------------
-- Tenant configuration
-- ---------------------------------------------------------------------
create table public.event_type (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenant(id),
  name               text not null,
  description        text,
  default_duration_minutes int,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  created_by         uuid references public.app_user(id),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.app_user(id),
  unique (tenant_id, name)
);

create table public.therapeutic_area (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenant(id),
  name       text not null,
  unique (tenant_id, name)
);

create table public.product (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenant(id),
  name                 text not null,
  therapeutic_area_id  uuid references public.therapeutic_area(id),
  unique (tenant_id, name)
);

create table public.specialty (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenant(id),
  name       text not null,
  unique (tenant_id, name)
);

create table public.crm_connection (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenant(id),
  name          text not null,                  -- "Veeva CRM – EU"
  system        text not null check (system in ('veeva_crm','vault_crm','salesforce_lsc','other')),
  region        text,
  status        text not null default 'active' check (status in ('active','inactive','error')),
  last_sync_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.crm_connection is 'A regional CRM instance EC reads HCP/HCO data from and writes events back to. Source of every crm_external_id.';

-- ---------------------------------------------------------------------
-- Customer master — event-context only (not a full HCP master)
-- ---------------------------------------------------------------------
create table public.hco (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenant(id),
  name               text not null,
  hco_type           text,                       -- hospital, university, society, venue, agency
  country_code       char(2) references public.country(code),
  city               text,
  address            text,
  source             text not null default 'crm' check (source in ('crm','data_vendor','manual')),
  crm_connection_id  uuid references public.crm_connection(id),
  crm_external_id    text,
  onekey_id          text,
  created_at         timestamptz not null default now(),
  created_by         uuid references public.app_user(id),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.app_user(id)
);

create table public.hcp (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenant(id),
  salutation         text,                       -- Dr, Prof
  first_name         text not null,
  last_name          text not null,
  display_name       text generated always as (trim(coalesce(salutation || ' ', '') || first_name || ' ' || last_name)) stored,
  specialty_id       uuid references public.specialty(id),
  primary_hco_id     uuid references public.hco(id),
  country_code       char(2) references public.country(code),
  city               text,
  email              text,
  tier               text,                       -- Tier 1..4 (drives FMV)
  status             text not null default 'active' check (status in ('active','inactive')),
  source             text not null default 'crm' check (source in ('crm','data_vendor','manual')),
  crm_connection_id  uuid references public.crm_connection(id),
  crm_external_id    text,
  onekey_id          text,
  created_at         timestamptz not null default now(),
  created_by         uuid references public.app_user(id),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.app_user(id)
);
create index hcp_name_idx on public.hcp (tenant_id, last_name, first_name);

create table public.fmv_rate (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenant(id),
  hcp_id        uuid not null references public.hcp(id) on delete cascade,
  service_type  text not null,                   -- speaker, chair, advisory, consulting
  scope         text not null default 'national' check (scope in ('national','international')),
  tier          text,
  hourly_rate   numeric(12,2) not null,
  currency      char(3) not null,
  valid_from    date not null,
  valid_to      date,
  created_at    timestamptz not null default now(),
  created_by    uuid references public.app_user(id),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.app_user(id)
);

-- ---------------------------------------------------------------------
-- Requests & events
-- ---------------------------------------------------------------------
create sequence public.event_request_number_seq start 51;
create sequence public.event_number_seq start 101;

create table public.event_request (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenant(id),
  request_number       text not null default ('REQ-' || to_char(now(),'YYYY') || '-' || lpad(nextval('public.event_request_number_seq')::text, 4, '0')),
  title                text not null,
  event_type_id        uuid not null references public.event_type(id),
  status               text not null default 'draft' references public.request_status(code),
  requested_by         uuid references public.app_user(id),
  coordinator_id       uuid references public.app_user(id),      -- null = unassigned
  therapeutic_area_id  uuid references public.therapeutic_area(id),
  country_code         char(2) references public.country(code),
  city                 text,
  proposed_start       date,
  proposed_end         date,
  expected_attendees   int,
  estimated_spend      numeric(12,2),
  currency             char(3),
  rationale            text,
  submitted_at         timestamptz,
  event_id             uuid,                                    -- set when approved (FK added below)
  created_at           timestamptz not null default now(),
  created_by           uuid references public.app_user(id),
  updated_at           timestamptz not null default now(),
  updated_by           uuid references public.app_user(id),
  unique (tenant_id, request_number)
);

create table public.event (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenant(id),
  event_number         text not null default ('EV-' || to_char(now(),'YYYY') || '-' || lpad(nextval('public.event_number_seq')::text, 4, '0')),
  name                 text not null,
  event_type_id        uuid not null references public.event_type(id),
  status               text not null default 'draft' references public.event_status(code),
  request_id           uuid references public.event_request(id),
  owner_id             uuid references public.app_user(id),
  therapeutic_area_id  uuid references public.therapeutic_area(id),
  country_code         char(2) references public.country(code),
  city                 text,
  venue_name           text,
  venue_address        text,
  timezone             text not null default 'Europe/London',   -- IANA zone; UI renders event-local time
  starts_at            timestamptz,
  ends_at              timestamptz,
  expected_attendees   int,
  estimated_spend      numeric(12,2),
  currency             char(3),
  description          text,
  cancel_reason        text,
  crm_connection_id    uuid references public.crm_connection(id),
  crm_external_id      text,
  created_at           timestamptz not null default now(),
  created_by           uuid references public.app_user(id),
  updated_at           timestamptz not null default now(),
  updated_by           uuid references public.app_user(id),
  unique (tenant_id, event_number),
  constraint event_dates_ok check (ends_at is null or starts_at is null or ends_at >= starts_at)
);
create index event_starts_idx on public.event (tenant_id, starts_at);
create index event_owner_idx on public.event (owner_id);

alter table public.event_request
  add constraint event_request_event_fk foreign key (event_id) references public.event(id);

create table public.event_product (
  event_id    uuid not null references public.event(id) on delete cascade,
  product_id  uuid not null references public.product(id),
  tenant_id   uuid not null references public.tenant(id),
  primary key (event_id, product_id)
);

create table public.event_team_member (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenant(id),
  event_id    uuid not null references public.event(id) on delete cascade,
  user_id     uuid not null references public.app_user(id),
  team_role   text not null default 'member' check (team_role in ('owner','co_host','medical','compliance','logistics','finance','member')),
  role_label  text,                               -- free label shown in the UI, e.g. "Medical lead"
  created_at  timestamptz not null default now(),
  created_by  uuid references public.app_user(id),
  unique (event_id, user_id)
);

create table public.event_session (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenant(id),
  event_id      uuid not null references public.event(id) on delete cascade,
  title         text not null,
  session_kind  text,                             -- Housekeeping, Presentation, Break, Panel / Q&A …
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  location      text,
  sort          int not null default 0,
  created_at    timestamptz not null default now(),
  created_by    uuid references public.app_user(id),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.app_user(id),
  constraint session_dates_ok check (ends_at >= starts_at)
);
create index event_session_event_idx on public.event_session (event_id, starts_at);

-- ---------------------------------------------------------------------
-- Participants & contracting
-- ---------------------------------------------------------------------
create table public.event_expert (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenant(id),
  event_id           uuid not null references public.event(id) on delete cascade,
  hcp_id             uuid not null references public.hcp(id),
  role               text not null default 'speaker' check (role in ('chair','speaker','advisor','moderator','panelist','consultant')),
  eligibility        text not null default 'pending' check (eligibility in ('eligible','ineligible','pending')),
  check_status       text not null default 'pending' check (check_status in ('passed','pending','failed')),
  check_notes        text,
  fmv_rate_id        uuid references public.fmv_rate(id),
  hourly_rate        numeric(12,2),
  currency           char(3),
  prep_hours         numeric(5,2) not null default 0,
  service_hours      numeric(5,2) not null default 0,
  travel_hours       numeric(5,2) not null default 0,
  total_payable      numeric(12,2) generated always as (
                       case when eligibility = 'eligible'
                            then coalesce(hourly_rate,0) * (prep_hours + service_hours + travel_hours)
                            else 0 end) stored,
  crm_connection_id  uuid references public.crm_connection(id),
  crm_external_id    text,
  created_at         timestamptz not null default now(),
  created_by         uuid references public.app_user(id),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.app_user(id),
  unique (event_id, hcp_id)
);
comment on table public.event_expert is 'A paid HCP engagement on an event — one honorarium-grid row (H.Grid).';

create table public.event_session_speaker (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenant(id),
  event_id         uuid not null references public.event(id) on delete cascade,
  session_id       uuid not null references public.event_session(id) on delete cascade,
  event_expert_id  uuid references public.event_expert(id) on delete cascade,
  user_id          uuid references public.app_user(id),   -- internal speakers (e.g. medical lead housekeeping)
  minutes          int,
  sort             int not null default 0,
  created_at       timestamptz not null default now(),
  created_by       uuid references public.app_user(id),
  constraint speaker_is_someone check (num_nonnulls(event_expert_id, user_id) = 1)
);

create table public.event_attendee (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenant(id),
  event_id           uuid not null references public.event(id) on delete cascade,
  attendee_kind      text not null check (attendee_kind in ('hcp','user','other')),
  hcp_id             uuid references public.hcp(id),
  user_id            uuid references public.app_user(id),
  display_name       text,                              -- walk-ins / non-HCP guests
  organisation       text,
  role_label         text,                              -- Chair, Speaker, Advisor, Organiser …
  rsvp               text not null default 'invited' check (rsvp in ('invited','accepted','declined','tentative')),
  attended           boolean,
  crm_status         text not null default 'pending' check (crm_status in ('pending','reconciled','not_found','not_applicable')),
  crm_connection_id  uuid references public.crm_connection(id),
  crm_external_id    text,
  created_at         timestamptz not null default now(),
  created_by         uuid references public.app_user(id),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references public.app_user(id),
  constraint attendee_kind_ok check (
    (attendee_kind = 'hcp'   and hcp_id  is not null) or
    (attendee_kind = 'user'  and user_id is not null) or
    (attendee_kind = 'other' and display_name is not null))
);

create table public.event_contracting_org (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenant(id),
  event_id    uuid not null references public.event(id) on delete cascade,
  hco_id      uuid not null references public.hco(id),
  purpose     text not null default 'payee' check (purpose in ('venue','payee','sponsor','vendor','other')),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.app_user(id)
);

-- ---------------------------------------------------------------------
-- Content (file metadata — bytes live in Storage)
-- ---------------------------------------------------------------------
create table public.content (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenant(id),
  title           text not null,
  content_kind    text not null check (content_kind in ('presentation','document','template','contract','invoice','image','other')),
  file_name       text,
  mime_type       text,
  size_bytes      bigint,
  storage_path    text,                            -- bucket/key in Storage (S3 later)
  version         int not null default 1,
  owner_user_id   uuid references public.app_user(id),
  author_hcp_id   uuid references public.hcp(id),  -- e.g. speaker who owns the deck
  created_at      timestamptz not null default now(),
  created_by      uuid references public.app_user(id),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.app_user(id)
);
comment on table public.content is 'File metadata, like Salesforce ContentDocument. Used for decks, documents, contract templates and generated contracts.';

create table public.event_content (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenant(id),
  event_id        uuid not null references public.event(id) on delete cascade,
  content_id      uuid not null references public.content(id),
  usage           text not null check (usage in ('presentation','document')),
  category        text,                              -- Agenda, Contract, Compliance, Finance, Presentation
  session_id      uuid references public.event_session(id) on delete set null,
  review_status   text check (review_status in ('draft','review','approved','rejected')),
  created_at      timestamptz not null default now(),
  created_by      uuid references public.app_user(id),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.app_user(id),
  unique (event_id, content_id)
);

create table public.contract (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenant(id),
  contract_number       text not null,
  contract_type         text not null check (contract_type in ('service_agreement','work_order','event_contract','venue')),
  status                text not null default 'draft' check (status in ('draft','sent','executed','expired','terminated')),
  counterparty_hcp_id   uuid references public.hcp(id),
  counterparty_hco_id   uuid references public.hco(id),
  parent_contract_id    uuid references public.contract(id),
  start_date            date,
  end_date              date,
  template_content_id   uuid references public.content(id),   -- Word template driving the generated document
  document_content_id   uuid references public.content(id),   -- the generated / signed document
  clm_reference         text,                                  -- e.g. Icertis agreement code (mocked)
  created_at            timestamptz not null default now(),
  created_by            uuid references public.app_user(id),
  updated_at            timestamptz not null default now(),
  updated_by            uuid references public.app_user(id),
  unique (tenant_id, contract_number),
  constraint contract_counterparty check (num_nonnulls(counterparty_hcp_id, counterparty_hco_id) = 1)
);

create table public.event_expert_contract (
  event_expert_id  uuid not null references public.event_expert(id) on delete cascade,
  contract_id      uuid not null references public.contract(id),
  tenant_id        uuid not null references public.tenant(id),
  event_id         uuid not null references public.event(id) on delete cascade,
  primary key (event_expert_id, contract_id)
);

create table public.event_attendee_contract (
  event_attendee_id  uuid not null references public.event_attendee(id) on delete cascade,
  contract_id        uuid not null references public.contract(id),
  tenant_id          uuid not null references public.tenant(id),
  event_id           uuid not null references public.event(id) on delete cascade,
  primary key (event_attendee_id, contract_id)
);

create table public.org_contract (
  event_contracting_org_id  uuid not null references public.event_contracting_org(id) on delete cascade,
  contract_id               uuid not null references public.contract(id),
  tenant_id                 uuid not null references public.tenant(id),
  event_id                  uuid not null references public.event(id) on delete cascade,
  primary key (event_contracting_org_id, contract_id)
);

-- ---------------------------------------------------------------------
-- Collaboration
-- ---------------------------------------------------------------------
create table public.event_post (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenant(id),
  event_id    uuid not null references public.event(id) on delete cascade,
  parent_id   uuid references public.event_post(id) on delete cascade,
  author_id   uuid not null default app.current_user_id() references public.app_user(id),
  body        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index event_post_event_idx on public.event_post (event_id, created_at desc);

create table public.event_post_reaction (
  post_id    uuid not null references public.event_post(id) on delete cascade,
  user_id    uuid not null default app.current_user_id() references public.app_user(id),
  emoji      text not null,
  tenant_id  uuid not null references public.tenant(id),
  event_id   uuid not null references public.event(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id, emoji)
);

create table public.event_task (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenant(id),
  event_id        uuid not null references public.event(id) on delete cascade,
  title           text not null,
  assignee_id     uuid references public.app_user(id),
  due_date        date,
  done_at         timestamptz,
  source_post_id  uuid references public.event_post(id) on delete set null,
  created_at      timestamptz not null default now(),
  created_by      uuid references public.app_user(id),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.app_user(id)
);

create table public.notification (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenant(id),
  user_id      uuid not null references public.app_user(id) on delete cascade,
  kind         text not null check (kind in ('approval_required','mention','new_request','approved','rejected','event_update','task_assigned')),
  title        text not null,
  body         text,
  record_type  text,
  record_id    uuid,
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index notification_user_idx on public.notification (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- Approvals — configuration vs runtime
-- ---------------------------------------------------------------------
create table public.approval_process (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenant(id),
  name           text not null,
  record_type    text not null check (record_type in ('request','event')),
  event_type_id  uuid references public.event_type(id),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  created_by     uuid references public.app_user(id),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references public.app_user(id)
);

create table public.approval_process_step (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenant(id),
  process_id           uuid not null references public.approval_process(id) on delete cascade,
  sort                 int not null,
  name                 text not null,
  approver_user_id     uuid references public.app_user(id),
  approver_profile_id  uuid references public.profile(id),
  unique (process_id, sort)
);

create table public.approval (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenant(id),
  process_id    uuid references public.approval_process(id),
  record_type   text not null check (record_type in ('request','event')),
  record_id     uuid not null,
  event_id      uuid references public.event(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending','approved','rejected','recalled')),
  current_step  int not null default 1,
  submitted_by  uuid references public.app_user(id),
  submitted_at  timestamptz not null default now(),
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.approval_action (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenant(id),
  approval_id  uuid not null references public.approval(id) on delete cascade,
  step_id      uuid references public.approval_process_step(id),
  step_name    text not null,
  approver_id  uuid references public.app_user(id),
  decision     text check (decision in ('approved','rejected')),
  comment      text,
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);
