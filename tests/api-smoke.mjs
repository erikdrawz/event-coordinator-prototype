// API smoke + security test. Runs against any Supabase-compatible endpoint.
// Usage: SUPABASE_URL=... SUPABASE_ANON_KEY=... node tests/api-smoke.mjs
// Uses only the public API, exactly as a customer-built UI or an agent would.
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
const PASSWORD = process.env.DEMO_PASSWORD || 'EC-demo-2026!';
if (!URL_ || !KEY) { console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY'); process.exit(2); }
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };

async function login(email) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }) });
  const j = await r.json(); if (!j.access_token) throw new Error(`login failed for ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
async function api(token, path, { method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { method, body: body && JSON.stringify(body),
    headers: { apikey: KEY, authorization: `Bearer ${token ?? KEY}`, 'content-type': 'application/json',
               prefer: 'return=representation', ...headers } });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

const paul = await login('paul.taylor@alera.example');
const sarah = await login('sarah.mitchell@alera.example');
const agent = await login('compliance-agent@agents.alera.example');
const maria = await login('maria.castillo@alera.example');   // Business Admin
const alex = await login('alex.morgan@alera.example');       // System Admin

// Anonymous callers see nothing
const anon = await api(null, 'event?select=id');
ok(anon.status >= 400 || (Array.isArray(anon.data) && anon.data.length === 0), 'anonymous caller cannot read events');

// me()
const me = await api(paul, 'rpc/me', { method: 'POST', body: {} });
ok(me.data?.display_name === 'Paul Taylor' && me.data?.profile?.name === 'Event Coordinator', 'me() returns Paul + profile');
ok(me.data?.tenant?.brand_name === 'Alera Pharma', 'me() returns tenant branding');

// Reads
const events = await api(paul, 'event?select=name,status,starts_at&order=starts_at');
ok(Array.isArray(events.data) && events.data.length === 8, `Paul sees 8 events (got ${events.data?.length})`);
const sma = await api(paul, `event?name=eq.SMA%20Board&select=id,status,event_expert(role,total_payable,hcp(display_name)),event_session(title)`);
const s = sma.data?.[0];
ok(s && s.event_session.length === 7, 'SMA Board has 7 agenda sessions');
const total = s?.event_expert.reduce((a, e) => a + Number(e.total_payable), 0);
ok(total === 517, `SMA Board honoraria total €517 at the temporary €100/h rate (got ${total})`);

// Lifecycle rules
const bad = await api(paul, 'rpc/change_event_status', { method: 'POST', body: { p_event_id: s.id, p_status: 'closed' } });
ok(bad.status >= 400, 'illegal transition contract → closed is rejected');
const direct = await api(paul, `event?id=eq.${s.id}`, { method: 'PATCH', body: { status: 'draft' } });
ok(direct.status >= 400, 'direct status PATCH that skips the rules is rejected');

// Event capture as coordinator, through create_event(): owner + team are set automatically
const types = await api(paul, 'event_type?name=eq.Advisory%20board&select=id');
const telia = await api(paul, 'product?name=eq.Telia&select=id');
const capture = (body) => api(paul, 'rpc/create_event', { method: 'POST', body: { p: body } });
const base = { name: 'Smoke Test Board', event_type_id: types.data[0].id, country_code: 'FR', city: 'Paris',
               starts_local: '2026-12-01T09:00', custom_fields: { meeting_format__c: 'hybrid', cme_credits__c: 2 } };
const created = await capture({ ...base, product_ids: [telia.data[0].id] });
const ev = created.data;
ok(created.status === 200 && ev?.owner_id === me.data.id && ev?.status === 'draft', 'coordinator creates an event; owner defaults to creator');
ok(ev?.timezone === 'Europe/Paris' && ev?.starts_at?.startsWith('2026-12-01T08:00'), 'zone defaults from country; local start time is converted');
const team = await api(paul, `event_team_member?event_id=eq.${ev.id}&select=team_role`);
ok(team.data?.[0]?.team_role === 'owner', 'creator joins the team as owner');
const prods = await api(paul, `event_product?event_id=eq.${ev.id}&select=product_id`);
ok(prods.data?.length === 1, 'products are saved with the event');

// Custom fields: validated in the database, whichever client writes them
ok((await capture({ ...base, custom_fields: {} })).status >= 400, 'missing required custom field is rejected');
ok((await capture({ ...base, custom_fields: { meeting_format__c: 'online' } })).status >= 400, 'value outside a picklist is rejected');
ok((await capture({ ...base, custom_fields: { meeting_format__c: 'virtual', secret__c: 1 } })).status >= 400, 'unknown custom field is rejected');
ok((await capture({ ...base, status: 'closed' })).status >= 400, 'create_event refuses read-only keys such as status');
const plain = await api(paul, 'event', { method: 'POST', body: { name: 'Plain insert', event_type_id: types.data[0].id } });
ok(plain.status >= 400, 'a plain insert still has to satisfy required custom fields');

// Partial update: untouched values stay, custom_fields merge, null removes a value
const upd1 = await api(paul, 'rpc/update_event', { method: 'POST', body: { p_event_id: ev.id, p: { city: 'Lyon', custom_fields: { cme_credits__c: null } } } });
ok(upd1.status === 200 && upd1.data.city === 'Lyon' && upd1.data.name === 'Smoke Test Board'
   && upd1.data.custom_fields.meeting_format__c === 'hybrid' && !('cme_credits__c' in upd1.data.custom_fields),
   'update_event changes only the keys sent and merges custom fields');
const virt = await api(paul, 'event?custom_fields->>meeting_format__c=eq.virtual&select=name');
ok(virt.data?.length === 1 && virt.data[0].name === 'Immunology Webinar Series', 'events can be filtered on a custom field through the API');
const defs = await api(sarah, 'custom_field?object_name=eq.event&select=api_name,custom_field_layout(section)');
ok(defs.data?.length === 6, `collaborator can read custom field definitions (got ${defs.data?.length})`);
const newDef = await api(paul, 'custom_field', { method: 'POST', body: { object_name: 'event', api_name: 'sneaky__c', label: 'Sneaky', field_type: 'text' } });
ok(newDef.status >= 400, 'only admins can define custom fields');

// Country rules: the event type must be enabled in the country, and the user allowed to create there
ok(me.data?.country_code === 'DK' && me.data?.event_countries?.includes('FR') && !me.data?.event_countries?.includes('ES'),
   "me() returns Paul's home country and event countries");
ok((await capture({ ...base, country_code: 'ES' })).status >= 400, 'creating an event outside my countries is rejected');
const investigator = await api(paul, 'event_type?name=eq.Investigator%20meeting&select=id');
ok((await capture({ ...base, event_type_id: investigator.data[0].id })).status >= 400, 'an event type not enabled in the country is rejected');
const moved = await api(paul, 'rpc/update_event', { method: 'POST', body: { p_event_id: ev.id, p: { country_code: 'ES' } } });
ok(moved.status >= 400, "moving an event into a country I don't manage is rejected");

// Admin config: Business Admin maintains master data and users, not event types or System Admins
const mProd = await api(maria, 'product', { method: 'POST', body: { name: 'Smoke Product', is_active: false } });
ok(mProd.status === 201, 'business admin can add a product');
ok((await capture({ ...base, product_ids: [mProd.data[0].id] })).status >= 400, 'a switched-off product cannot be added to an event');
const mType = await api(maria, 'event_type', { method: 'POST', body: { name: 'Smoke Type' } });
ok(mType.status >= 400, 'business admin cannot add event types');
const lisa = await api(maria, 'app_user?email=eq.lisa.anderson@alera.example&select=id,job_title');
const lisaUpd = await api(maria, `app_user?id=eq.${lisa.data[0].id}`, { method: 'PATCH', body: { job_title: 'Smoke title' } });
ok(lisaUpd.status === 200 && lisaUpd.data[0]?.job_title === 'Smoke title', 'business admin can edit a user');
const adminProfile = await api(maria, 'profile?name=eq.System%20Admin&select=id');
const promote = await api(maria, `app_user?id=eq.${lisa.data[0].id}`, { method: 'PATCH', body: { profile_id: adminProfile.data[0].id } });
ok(promote.status >= 400 || promote.data?.length === 0, 'business admin cannot make someone a System Admin');
const alexEdit = await api(maria, 'app_user?email=eq.alex.morgan@alera.example', { method: 'PATCH', body: { job_title: 'Hijacked' } });
ok(Array.isArray(alexEdit.data) && alexEdit.data.length === 0, 'business admin cannot edit System Admin accounts');
const sarahLogin = await api(sarah, 'rpc/create_user_login', { method: 'POST', body: { p_user_id: lisa.data[0].id, p_password: 'Long-enough-1' } });
ok(sarahLogin.status >= 400, 'only user managers can create logins');
const dupLogin = await api(maria, 'rpc/create_user_login', { method: 'POST', body: { p_user_id: lisa.data[0].id, p_password: 'Long-enough-1' } });
ok(dupLogin.status >= 400 && /already has a login/.test(dupLogin.data?.message), 'a user with a login cannot get a second one');

// Custom fields from Admin: a System Admin defines and assigns them; the database checks values
const mkField = (body) => api(alex, 'custom_field', { method: 'POST', body: { object_name: 'event', ...body } });
const linkF = await mkField({ api_name: 'smoke_link__c', label: 'Smoke link', field_type: 'url' });
const scoreF = await mkField({ api_name: 'smoke_score__c', label: 'Smoke score', field_type: 'number', decimals: 2 });
ok(linkF.status === 201 && scoreF.status === 201, 'system admin can create url and number custom fields');
const layout = await api(alex, 'custom_field_layout', { method: 'POST', body: [
  { custom_field_id: linkF.data[0].id, event_type_id: types.data[0].id }, { custom_field_id: scoreF.data[0].id, event_type_id: types.data[0].id }] });
ok(layout.status === 201, 'system admin can assign custom fields to an event type');
const setCf = (cf) => api(paul, 'rpc/update_event', { method: 'POST', body: { p_event_id: ev.id, p: { custom_fields: cf } } });
ok((await setCf({ smoke_link__c: 'not a link' })).status >= 400, 'a url custom field rejects text that is not a link');
ok((await setCf({ smoke_score__c: 1.234 })).status >= 400, 'a number custom field rejects more decimals than allowed');
const goodCf = await setCf({ smoke_link__c: 'https://congress.example/2026', smoke_score__c: 1.25 });
ok(goodCf.status === 200 && goodCf.data.custom_fields.smoke_score__c === 1.25, 'valid url and number values are saved');
const rename = await api(alex, `custom_field?id=eq.${linkF.data[0].id}`, { method: 'PATCH', body: { api_name: 'renamed__c' } });
ok(rename.status >= 400, "a custom field's name can't change once created");
const relabel = await api(alex, `custom_field?id=eq.${linkF.data[0].id}`, { method: 'PATCH', body: { label: 'Smoke website' } });
ok(relabel.status === 200, "a custom field's label can change");
await api(alex, `custom_field?id=eq.${scoreF.data[0].id}`, { method: 'PATCH', body: { is_active: false } });
const keepOld = await api(paul, 'rpc/update_event', { method: 'POST', body: { p_event_id: ev.id, p: { city: 'Lyon' } } });
ok(keepOld.status === 200 && keepOld.data.custom_fields.smoke_score__c === 1.25, 'switching a field off keeps existing values and edits still save');
ok((await setCf({ smoke_score__c: 2 })).status >= 400, 'a switched-off field takes no new values');
ok((await api(maria, 'custom_field', { method: 'POST', body: { object_name: 'event', api_name: 'maria__c', label: 'Maria', field_type: 'text' } })).status >= 400,
   'business admin cannot define custom fields');

// Agenda: sessions with local times and speakers, in one call
const saveSession = (who, p) => api(who, 'rpc/save_event_session', { method: 'POST', body: { p } });
const sess = await saveSession(paul, { event_id: ev.id, title: 'Smoke session', session_kind: 'Presentation',
  starts_local: '2026-12-01T09:00', ends_local: '2026-12-01T09:30', speakers: [{ user_id: me.data.id, minutes: 30 }] });
ok(sess.status === 200 && sess.data.starts_at?.startsWith('2026-12-01T08:00'), 'a session is saved with local times converted in the event zone');
const sessSpk = await api(paul, `event_session_speaker?session_id=eq.${sess.data?.id}&select=user_id,minutes,event_id`);
ok(sessSpk.data?.length === 1 && sessSpk.data[0].event_id === ev.id, 'its speakers are saved with it');
const otherExpert = await api(paul, `event_expert?event_id=eq.${s.id}&select=id&limit=1`);
ok((await saveSession(paul, { id: sess.data.id, speakers: [{ event_expert_id: otherExpert.data[0].id }] })).status >= 400,
   "another event's expert can't speak at this event");
ok((await saveSession(paul, { id: sess.data.id, starts_local: '2026-12-01T10:00' })).status >= 400, 'a session cannot end before it starts');
const renamed = await saveSession(paul, { id: sess.data.id, title: 'Smoke session (renamed)', speakers: [] });
const spkAfter = await api(paul, `event_session_speaker?session_id=eq.${sess.data.id}&select=id`);
ok(renamed.status === 200 && renamed.data.title === 'Smoke session (renamed)' && spkAfter.data?.length === 0, 'editing a session can replace its speakers');

// Speakers follow the agenda: adding an HCP to a session adds them to the speakers, with service hours from the session
const lindHcp = await api(paul, 'hcp?last_name=eq.Lind&select=id');
await saveSession(paul, { id: sess.data.id, speakers: [{ hcp_id: lindHcp.data[0].id }] });
const expertOf = () => api(paul, `event_expert?event_id=eq.${ev.id}&hcp_id=eq.${lindHcp.data[0].id}&select=id,role,hourly_rate,service_hours,prep_hours,total_payable`);
let lind = (await expertOf()).data?.[0];
ok(lind && lind.role === 'speaker' && Number(lind.hourly_rate) === 100 && Number(lind.service_hours) === 0.5,
   'an HCP added to a session joins the speakers at the flat rate, with the session as service hours');
await saveSession(paul, { id: sess.data.id, ends_local: '2026-12-01T10:00' });
lind = (await expertOf()).data?.[0];
ok(Number(lind.service_hours) === 1, 'lengthening the session updates service hours');
await api(paul, `event_expert?id=eq.${lind.id}`, { method: 'PATCH', body: { service_hours: 99, prep_hours: 1.5 } });
lind = (await expertOf()).data?.[0];
ok(Number(lind.service_hours) === 1 && Number(lind.total_payable) === 250, 'service hours cannot be typed in; total = (prep + service + travel) × rate');
await saveSession(paul, { id: sess.data.id, speakers: [{ event_expert_id: lind.id }] });
ok((await expertOf()).data?.length === 1, 're-saving a session keeps its speakers');
await saveSession(paul, { id: sess.data.id, speakers: [] });
ok((await expertOf()).data?.length === 0, 'a speaker taken off their last session leaves the speakers');
await saveSession(paul, { id: sess.data.id, speakers: [{ hcp_id: lindHcp.data[0].id }] });
lind = (await expertOf()).data?.[0];
await api(paul, `event_expert?id=eq.${lind.id}`, { method: 'DELETE' });
const leftOnSession = await api(paul, `event_session_speaker?session_id=eq.${sess.data.id}&select=id`);
ok(leftOnSession.data?.length === 0, 'removing a speaker removes them from the sessions');
// …unless a contract is out for signature or signed
await saveSession(paul, { id: sess.data.id, speakers: [{ hcp_id: lindHcp.data[0].id }] });
lind = (await expertOf()).data?.[0];
const lindContract = await api(paul, 'contract', { method: 'POST', body: { contract_number: `SMOKE-${Date.now()}`, contract_type: 'work_order', status: 'sent', counterparty_hcp_id: lindHcp.data[0].id } });
await api(paul, 'event_expert_contract', { method: 'POST', body: { event_expert_id: lind.id, contract_id: lindContract.data?.[0]?.id, event_id: ev.id } });
await saveSession(paul, { id: sess.data.id, speakers: [] });
ok((await expertOf()).data?.length === 1, 'a speaker with a sent contract stays without sessions');
// Deleting a session takes its only speakers with it
const evaHcp = await api(paul, 'hcp?last_name=eq.Sørensen&select=id');
const evaSess = await saveSession(paul, { event_id: ev.id, title: 'Smoke panel', starts_local: '2026-12-01T11:00', ends_local: '2026-12-01T11:30', speakers: [{ hcp_id: evaHcp.data[0].id }] });
await api(paul, `event_session?id=eq.${evaSess.data.id}`, { method: 'DELETE' });
ok((await api(paul, `event_expert?event_id=eq.${ev.id}&hcp_id=eq.${evaHcp.data[0].id}&select=id`)).data?.length === 0, 'deleting a session removes speakers who had no other session');

// The agenda saved as a whole: one transaction, speakers settled on the final agenda, stale saves refused
const saveAgenda = (who, p) => api(who, 'rpc/save_agenda', { method: 'POST', body: { p } });
const agendaVersion = async () => (await api(paul, 'rpc/agenda_version', { method: 'POST', body: { p_event_id: ev.id } })).data;
const v0 = await agendaVersion();
const slotA = { id: sess.data.id, title: 'Smoke session (renamed)', starts_local: '2026-12-01T09:00', ends_local: '2026-12-01T09:30' };
const slotB = { title: 'Smoke panel', starts_local: '2026-12-01T11:00', ends_local: '2026-12-01T11:30' };
const ag1 = await saveAgenda(paul, { event_id: ev.id, version: v0, sessions: [{ ...slotA, speakers: [{ hcp_id: evaHcp.data[0].id }] }, { ...slotB, speakers: [] }] });
const evaOf = () => api(paul, `event_expert?event_id=eq.${ev.id}&hcp_id=eq.${evaHcp.data[0].id}&select=id,prep_hours,service_hours`);
let eva = (await evaOf()).data?.[0];
const sessionsNow = async () => (await api(paul, `event_session?event_id=eq.${ev.id}&select=id,title&order=starts_at`)).data ?? [];
let now = await sessionsNow();
ok(ag1.status === 200 && now.length === 2 && now[0].id === sess.data.id && eva, 'save_agenda updates and adds sessions in one call, keeping session ids');
await api(paul, `event_expert?id=eq.${eva.id}`, { method: 'PATCH', body: { prep_hours: 2 } });
const ag2 = await saveAgenda(paul, { event_id: ev.id, version: ag1.data?.version, sessions: [
  { ...slotA, speakers: [] }, { ...slotB, id: now[1].id, speakers: [{ event_expert_id: eva.id }] }] });
eva = (await evaOf()).data?.[0];
ok(ag2.status === 200 && eva && Number(eva.prep_hours) === 2 && Number(eva.service_hours) === 0.5, 'moving a speaker between sessions keeps their record and entered hours');
const stale = await saveAgenda(paul, { event_id: ev.id, version: v0, sessions: [] });
ok(stale.status === 409 && (await sessionsNow()).length === 2, 'a save started from an older agenda is refused (409)');
const otherSession = await api(paul, `event_session?event_id=eq.${s.id}&select=id&limit=1`);
ok((await saveAgenda(paul, { event_id: ev.id, sessions: [{ ...slotA }, { id: otherSession.data[0].id, title: 'Hijack' }] })).status >= 400,
   "another event's session can't be saved into this agenda");
ok((await saveAgenda(sarah, { event_id: ev.id, sessions: [] })).status >= 400 && (await sessionsNow()).length === 2, 'collaborator cannot save the agenda');
const ag3 = await saveAgenda(paul, { event_id: ev.id, version: ag2.data?.version, sessions: [{ ...slotA, speakers: [] }] });
ok(ag3.status === 200 && (await sessionsNow()).length === 1 && (await evaOf()).data?.length === 0,
   'sessions left out of the agenda are deleted, and speakers with no session left leave');
const lindNow = (await expertOf()).data?.[0];
await saveAgenda(paul, { event_id: ev.id, sessions: [{ ...slotA, speakers: [{ event_expert_id: lindNow?.id, minutes: 120 }] }] });
ok(Number((await expertOf()).data?.[0]?.service_hours) === 0.5, 'speaking time counts up to the session length');
ok((await saveSession(sarah, { event_id: ev.id, title: 'Not allowed', starts_local: '2026-12-01T11:00', ends_local: '2026-12-01T11:30' })).status >= 400,
   'collaborator cannot add sessions');

// Collaborator: can post, cannot create events
const sarahEvent = await api(sarah, 'rpc/create_event', { method: 'POST', body: { p: base } });
ok(sarahEvent.status >= 400, 'collaborator cannot create events');
const sarahEdit = await api(sarah, 'rpc/update_event', { method: 'POST', body: { p_event_id: ev.id, p: { city: 'Nice' } } });
ok(sarahEdit.status >= 400, 'collaborator cannot edit events');
const post = await api(sarah, 'event_post', { method: 'POST', body: { event_id: ev.id, body: 'Smoke test post' } });
ok(post.status === 201 && post.data[0].author_id !== null, 'collaborator can post to the team board');

// Agent acting on behalf of Paul: allowed edit is audited with both identities
const holm = await api(agent, `event_expert?event_id=eq.${s.id}&role=eq.chair&select=id`);
const upd = await api(agent, `event_expert?id=eq.${holm.data[0].id}`, { method: 'PATCH', body: { check_status: 'passed', check_notes: 'Smoke test check' }, headers: { 'x-on-behalf-of': me.data.id } });
ok(upd.status === 200 && upd.data.length === 1, 'agent can record an expert check');
const hist = await api(paul, `event_history?event_id=eq.${s.id}&table_name=eq.event_expert&order=at.desc&limit=1&select=actor_name,actor_type,on_behalf_of_name`);
ok(hist.data?.[0]?.actor_type === 'agent' && hist.data?.[0]?.on_behalf_of_name === 'Paul Taylor', 'history shows agent acting on behalf of Paul');
const agentEvent = await api(agent, `event?id=eq.${s.id}`, { method: 'PATCH', body: { name: 'Hijacked' } });
ok(Array.isArray(agentEvent.data) && agentEvent.data.length === 0, 'agent cannot edit events (no permission → 0 rows)');

// A human cannot claim to act on behalf of someone else
const spoof = await api(sarah, 'event_post', { method: 'POST', body: { event_id: ev.id, body: 'Spoof attempt' }, headers: { 'x-on-behalf-of': me.data.id } });
const spoofLog = await api(paul, `event_history?record_id=eq.${spoof.data?.[0]?.id}&select=on_behalf_of_name`);
ok(spoofLog.data?.[0] && spoofLog.data[0].on_behalf_of_name === null, 'on-behalf-of header is ignored for human callers');

// CRM search and import (mock CRMs behind a real interface)
const crmSearch = (who, p) => api(who, 'rpc/crm_search_hcp', { method: 'POST', body: { p } });
const crmImport = (who, conn, ext) => api(who, 'rpc/crm_import_hcp', { method: 'POST', body: { p_crm_connection_id: conn, p_external_id: ext } });
ok((await crmSearch(sarah, { q: 'lind' })).status >= 400, 'collaborator cannot search the CRM');
const lindCrm = await crmSearch(paul, { q: 'lind' });
const lindRows = lindCrm.data?.results ?? [];
ok(lindCrm.status === 200 && lindCrm.data.connections?.length === 3 && new Set(lindRows.map((r) => r.connection_name)).size === 3,
   'CRM search covers every connection and says where each result was found');
ok(lindRows.filter((r) => r.display_name === 'Dr Jonas Lind').every((r) => r.hcp_id === lindHcp.data[0].id),
   'a CRM result already in EC points at the EC record (by CRM ID or OneKey ID)');
const karin = lindRows.find((r) => r.display_name === 'Dr Karin Lindgren');
ok(karin && !karin.hcp_id && karin.connection_name === 'Vault CRM – Nordics', 'people only in the CRM have no EC record yet');
const nordicOnly = await crmSearch(paul, { q: 'lind', crm_connection_id: karin?.crm_connection_id });
ok((nordicOnly.data?.results ?? []).every((r) => r.crm_connection_id === karin?.crm_connection_id), 'CRM search can be limited to one connection');
const imported = await crmImport(paul, karin?.crm_connection_id, karin?.external_id);
const karinHcp = await api(paul, `hcp?id=eq.${imported.data?.id}&select=id,source,crm_external_id,onekey_id,specialty(name),primary_hco:hco(id,name,crm_external_id)`);
ok(imported.status === 200 && karinHcp.data?.[0]?.source === 'crm' && karinHcp.data[0].specialty?.name === 'Neurology'
   && karinHcp.data[0].primary_hco?.name === 'Uppsala University Hospital', 'importing a CRM HCP creates the HCP and their organisation');
ok((await crmImport(paul, karin?.crm_connection_id, karin?.external_id)).data?.id === imported.data?.id, 'importing the same CRM record again reuses it');
const lindVeeva = lindRows.find((r) => r.display_name === 'Dr Jonas Lind' && r.connection_name === 'Veeva CRM – EU');
ok((await crmImport(paul, lindVeeva?.crm_connection_id, lindVeeva?.external_id)).data?.id === lindHcp.data[0].id,
   'the same person from another CRM (same OneKey ID) is not duplicated');

// Cancelling: a reason is required, collaborators can't, and there's no way back
const setStatus = (who, status, reason) => api(who, 'rpc/change_event_status', { method: 'POST', body: { p_event_id: ev.id, p_status: status, p_reason: reason } });
ok((await setStatus(paul, 'cancelled', ' ')).status >= 400, 'cancelling needs a reason');
ok((await setStatus(sarah, 'cancelled', 'Not mine to cancel')).status >= 400, 'collaborator cannot cancel an event');
const cancelledEv = await setStatus(paul, 'cancelled', 'Smoke test: merged into another meeting');
ok(cancelledEv.status === 200 && cancelledEv.data?.status === 'cancelled' && cancelledEv.data?.cancel_reason === 'Smoke test: merged into another meeting',
   'event owner can cancel with a reason');
ok((await setStatus(paul, 'draft')).status >= 400, 'a cancelled event cannot be reopened');

// Cleanup
await api(alex, `custom_field?id=in.(${linkF.data?.[0]?.id},${scoreF.data?.[0]?.id})`, { method: 'DELETE' });
await api(maria, `product?id=eq.${mProd.data?.[0]?.id}`, { method: 'DELETE' });
await api(maria, `app_user?id=eq.${lisa.data[0].id}`, { method: 'PATCH', body: { job_title: lisa.data[0].job_title } });
await api(paul, `event?id=eq.${ev.id}`, { method: 'DELETE' });
await api(paul, `hcp?id=eq.${imported.data?.id}`, { method: 'DELETE' });
await api(paul, `hco?id=eq.${karinHcp.data?.[0]?.primary_hco?.id}`, { method: 'DELETE' });
await api(paul, `contract?id=eq.${lindContract.data?.[0]?.id}`, { method: 'DELETE' });
await api(paul, `event_expert?id=eq.${holm.data[0].id}`, { method: 'PATCH', body: { check_status: 'pending', check_notes: null } });

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
