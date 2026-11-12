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
const lisaT = await login('lisa.anderson@alera.example');    // another coordinator

// Emails this run makes go to Resend's test sink, never to a real demo inbox (restored at the end)
const SINK = 'delivered@resend.dev';
const me0 = await api(alex, 'rpc/me', { method: 'POST' });
const tenantId = me0.data?.tenant?.id;
const savedInbox = (await api(alex, `tenant?id=eq.${tenantId}&select=demo_inbox`)).data?.[0]?.demo_inbox ?? null;
await api(alex, `tenant?id=eq.${tenantId}`, { method: 'PATCH', body: { demo_inbox: SINK } });

// Anonymous callers see nothing
const anon = await api(null, 'event?select=id');
ok(anon.status >= 400 || (Array.isArray(anon.data) && anon.data.length === 0), 'anonymous caller cannot read events');

// me()
const me = await api(paul, 'rpc/me', { method: 'POST', body: {} });
ok(me.data?.display_name === 'Paul Taylor' && me.data?.profile?.name === 'Event Coordinator', 'me() returns Paul + profile');
ok(me.data?.tenant?.brand_name === 'Alera Pharma', 'me() returns tenant branding');

// Reads
const events = await api(paul, 'event?select=name,status,starts_at&order=starts_at');
ok(Array.isArray(events.data) && events.data.length === 8, `Paul sees every event: HQ Events, his group, follows them all (got ${events.data?.length})`);
ok((await api(maria, 'event?select=id')).data?.length === 8, 'Business Admin sees every event');
const sma = await api(paul, `event?name=eq.SMA%20Board&select=id,status,event_expert(role,total_payable,hcp(display_name)),event_session(title)`);
const s = sma.data?.[0];
ok(s && s.event_session.length === 7, 'SMA Board has 7 agenda sessions');
const total = s?.event_expert.reduce((a, e) => a + Number(e.total_payable), 0);
ok(Math.round(total * 100) === 144760, `SMA Board honoraria total €1,447.60 at the experts' FMV rates (got ${total})`);

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
const virt = await api(maria, 'event?custom_fields->>meeting_format__c=eq.virtual&select=name');
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
ok(lind && lind.role === 'speaker' && Number(lind.hourly_rate) === 250 && Number(lind.service_hours) === 0.5,
   "an HCP added to a session joins the speakers at their FMV rate, with the session as service hours");
await saveSession(paul, { id: sess.data.id, ends_local: '2026-12-01T10:00' });
lind = (await expertOf()).data?.[0];
ok(Number(lind.service_hours) === 1, 'lengthening the session updates service hours');
await api(paul, `event_expert?id=eq.${lind.id}`, { method: 'PATCH', body: { service_hours: 99, prep_hours: 1.5 } });
lind = (await expertOf()).data?.[0];
ok(Number(lind.service_hours) === 1 && Number(lind.total_payable) === 625, 'service hours cannot be typed in; total = (prep + service + travel) × rate');
// Negotiable rate: from the expert's FMV record valid on the event's date (€250, €200–€300 for Lind); fixed at €0 without one
const policy = await api(paul, 'rpc/expert_rate_policy', { method: 'POST', body: {} });
ok(policy.data?.source === 'none' && policy.data.mode === 'fixed' && policy.data.default === 0 && policy.data.max === 0, 'without an FMV record the rate is fixed at €0');
const lindPolicy = await api(paul, 'rpc/expert_rate_policy', { method: 'POST', body: { p_hcp_id: lindHcp.data[0].id, p_event_id: ev.id } });
ok(lindPolicy.data?.source === 'fmv' && lindPolicy.data.default === 250 && lindPolicy.data.min === 200 && lindPolicy.data.max === 300, "the rate policy comes from the expert's FMV record");
const setRate = (rate) => api(paul, `event_expert?id=eq.${lind.id}`, { method: 'PATCH', body: { hourly_rate: rate } });
ok((await setRate(301)).status >= 400 && (await setRate(199)).status >= 400, 'a rate outside the FMV range is refused');
await setRate(300);
lind = (await expertOf()).data?.[0];
ok(Number(lind.hourly_rate) === 300 && Number(lind.total_payable) === 750, 'a negotiated rate is used in the total');
await setRate(250);
const policies = await api(paul, 'rpc/event_rate_policies', { method: 'POST', body: { p_event_id: ev.id } });
ok(policies.data?.[lindHcp.data[0].id]?.max === 300, 'event_rate_policies gives each expert on the event their own range');
const lindFmvDelete = await api(paul, `fmv_rate?id=eq.${lindPolicy.data?.fmv_rate_id}`, { method: 'DELETE' });
ok(lindFmvDelete.status >= 400 && /stays on record/.test(lindFmvDelete.data?.message ?? ''), 'an FMV rate that priced an engagement cannot be deleted');
// Experts: eligibility follows the expert onto an event; FMV periods don't overlap
const holmHcp = await api(paul, 'hcp?last_name=eq.Holm&select=id,eligibility,eligibility_note');
const holmOnEv = await api(paul, 'event_expert', { method: 'POST', body: { event_id: ev.id, hcp_id: holmHcp.data[0].id, role: 'advisor' } });
ok(holmHcp.data[0].eligibility === 'ineligible' && holmOnEv.data?.[0]?.eligibility === 'ineligible' && Number(holmOnEv.data[0].hourly_rate) === 250,
   "an expert joins an event with their own eligibility and FMV rate");
const fmvOverlap = await api(paul, 'fmv_rate', { method: 'POST', body: { hcp_id: lindHcp.data[0].id, rate: 260, min_rate: 210, max_rate: 310, currency: 'EUR', effective_date: new Date().toISOString().slice(0, 10) } });
ok(fmvOverlap.status >= 400, "an expert's FMV periods can't overlap");
ok((await api(paul, 'fmv_rate', { method: 'POST', body: { hcp_id: lindHcp.data[0].id, rate: 100, min_rate: 120, max_rate: 140, currency: 'EUR', effective_date: '2040-01-01' } })).status >= 400,
   'an FMV rate must lie within its own range');
ok((await api(sarah, 'expert_eligibility?select=code')).data?.length === 3 && (await api(sarah, 'hcp?eligibility=eq.eligible&select=id')).data?.length === 12,
   'everyone can list eligible experts (12)');
const holmEdit = await api(paul, `hcp?id=eq.${holmHcp.data[0].id}`, { method: 'PATCH', body: { eligibility: 'pending', eligibility_note: 'Smoke test' } });
ok(holmEdit.data?.[0]?.eligibility === 'pending', 'an Event Coordinator can edit an expert');
const holmEvElig = async () => (await api(paul, `event_expert?id=eq.${holmOnEv.data?.[0]?.id}&select=eligibility`)).data?.[0]?.eligibility;
ok(await holmEvElig() === 'pending', "an expert's new eligibility carries to their open engagements");
await api(paul, `event_expert?id=eq.${holmOnEv.data?.[0]?.id}`, { method: 'PATCH', body: { eligibility: 'eligible' } });
const sarahHcpEdit = await api(sarah, `hcp?id=eq.${holmHcp.data[0].id}`, { method: 'PATCH', body: { eligibility: 'eligible' } });
ok(Array.isArray(sarahHcpEdit.data) && sarahHcpEdit.data.length === 0, "a collaborator can't edit an expert");
ok((await api(paul, `hcp?id=eq.${holmHcp.data[0].id}`, { method: 'PATCH', body: { eligibility: 'unknown' } })).status >= 400,
   'eligibility must be one of the known values');
await api(paul, `hcp?id=eq.${holmHcp.data[0].id}`, { method: 'PATCH', body: { eligibility: holmHcp.data[0].eligibility, eligibility_note: holmHcp.data[0].eligibility_note } });
ok(await holmEvElig() === 'eligible', 'an engagement set differently on purpose keeps its own eligibility');
await api(paul, `event_expert?id=eq.${holmOnEv.data?.[0]?.id}`, { method: 'DELETE' });
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
// Contracting: a Single-event Contract for Lind (no MSA), sent with its PDF and signed
const createContract = (who, p) => api(who, 'rpc/create_contract', { method: 'POST', body: { p } });
const storage = (token, path, { method = 'GET', body, type } = {}) => fetch(`${URL_}/storage/v1/object/${path}`, { method, body,
  headers: { apikey: KEY, authorization: `Bearer ${token}`, ...(type ? { 'content-type': type, 'x-upsert': 'true' } : {}) } });
const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
ok((await createContract(paul, { contract_type: 'event_contract', event_expert_id: lind.id })).status >= 400, 'an expert must be eligible to be contracted');
await api(paul, `event_expert?id=eq.${lind.id}`, { method: 'PATCH', body: { eligibility: 'eligible' } });
const noMsa = await createContract(paul, { contract_type: 'work_order', event_expert_id: lind.id });
ok(noMsa.status >= 400 && /Master Service Agreement/.test(noMsa.data?.message), 'a Work Order needs a signed MSA that covers the event');
const opts = (await api(paul, 'rpc/contract_options', { method: 'POST', body: { p_event_expert_id: lind.id } })).data;
ok(opts?.eligible === true && opts?.msa === null && opts?.templates?.event_contract?.length === 1 && opts?.templates?.work_order?.length === 1,
   'contract_options: no MSA, one template per type for an advisory board in France');
const sec = await createContract(paul, { contract_type: 'event_contract', event_expert_id: lind.id });
const lindPay = (await api(paul, `event_expert?id=eq.${lind.id}&select=total_payable`)).data?.[0];
ok(sec.status === 200 && /^SEC-\d{4}-\d{4}$/.test(sec.data?.contract_number) && sec.data?.status === 'draft' && sec.data?.event_id === ev.id,
   'a Single-event Contract is created as a draft with its own number');
const secTpl = opts?.templates?.event_contract?.[0];
ok(sec.data?.template_version_id === secTpl?.version_id && secTpl?.effective_from <= '2026-12-01',
   "the contract uses the template version in effect on the event's date");
ok(Number(sec.data?.honorarium?.total) === Number(lindPay.total_payable) && sec.data?.body?.includes('Smoke Test Board') && sec.data?.body?.includes('| Preparation |'),
   'the contract text carries the event and the agreed honorarium (prep, service, travel)');
ok((await createContract(paul, { contract_type: 'event_contract', event_expert_id: lind.id })).status >= 400, 'one open contract per expert on an event');
const add1 = await createContract(paul, { contract_type: 'addendum', event_expert_id: lind.id });
ok(add1.status === 200 && add1.data?.parent_contract_id === sec.data?.id && /^ADD-/.test(add1.data?.contract_number), 'an Addendum attaches to the open contract');
ok((await api(paul, `contract?id=eq.${sec.data?.id}`, { method: 'PATCH', body: { status: 'executed' } })).status >= 400, "a draft can't jump to signed");
ok((await api(paul, 'rpc/send_contract', { method: 'POST', body: { p_id: sec.data?.id, p_file: { path: `${sec.data?.id}/missing.pdf` } } })).status >= 400,
   "a contract can't be sent without its PDF");
ok((await storage(sarah, `contracts/${sec.data?.id}/x.pdf`, { method: 'POST', body: pdf, type: 'application/pdf' })).status >= 400,
   "someone who can't edit the event can't upload the contract's PDF");
const filePath = `${sec.data?.id}/${sec.data?.contract_number}.pdf`;
const up = await storage(paul, `contracts/${filePath}`, { method: 'POST', body: pdf, type: 'application/pdf' });
const sent = await api(paul, 'rpc/send_contract', { method: 'POST', body: { p_id: sec.data?.id, p_file: { path: filePath, file_name: `${sec.data?.contract_number}.pdf`, size_bytes: pdf.length } } });
ok(up.ok && sent.data?.status === 'sent' && sent.data?.document_content_id && /^ICX-/.test(sent.data?.clm_reference ?? ''), 'sending stores the PDF and hands it to the contracting tool');
ok((await storage(paul, `authenticated/contracts/${filePath}`)).ok, 'the stored PDF can be downloaded');
ok((await api(paul, `contract?id=eq.${sec.data?.id}`, { method: 'PATCH', body: { body: 'Changed' } })).status >= 400, "a sent contract's text can't change");
ok((await api(sarah, `contract?id=eq.${sec.data?.id}&select=id`)).data?.length === 0, "an event's contracts are only visible to those who see the event");
ok((await api(paul, 'rpc/mark_contract_signed', { method: 'POST', body: { p_id: sec.data?.id } })).data?.status === 'executed', 'a sent contract is marked as signed');
ok((await api(paul, `event_expert?id=eq.${lind.id}`, { method: 'DELETE' })).status >= 400, "an expert with a signed contract can't be removed from the event");
ok((await api(alex, `contract_template_version?id=eq.${secTpl?.version_id}`, { method: 'PATCH', body: { body: '# Changed {{expert.name}}' } })).status >= 400
   && (await api(alex, `contract_template_version?id=eq.${secTpl?.version_id}`, { method: 'DELETE' })).status >= 400,
   "a template version used for a sent contract can't be changed or deleted");
// MSAs belong to the expert; a direct insert is always a draft; templates are checked
const lindMsa = await createContract(paul, { contract_type: 'msa', hcp_id: lindHcp.data[0].id });
ok(lindMsa.status === 200 && lindMsa.data?.event_id === null && lindMsa.data?.end_date > lindMsa.data?.start_date, 'an MSA is created on the expert, for two years');
const msaSpoof = await api(paul, 'contract', { method: 'POST', body: { contract_type: 'msa', counterparty_hcp_id: lindHcp.data[0].id, status: 'executed' } });
ok(msaSpoof.data?.[0]?.status === 'draft', 'a contract created through the API starts as a draft');
await api(paul, `contract?id=in.(${lindMsa.data?.id},${msaSpoof.data?.[0]?.id})`, { method: 'DELETE' });
const tplType = (await api(paul, 'event_type?name=eq.Advisory%20board&select=id')).data?.[0]?.id;
ok((await api(paul, 'contract_template', { method: 'POST', body: { name: 'Smoke template', contract_type: 'msa' } })).status >= 400,
   "a coordinator can't add contract templates");
const bizTpl = await api(maria, 'contract_template', { method: 'POST', body: { name: 'Smoke BA template', contract_type: 'msa', is_active: false } });
ok(bizTpl.status === 201 && (await api(maria, `contract_template?id=eq.${bizTpl.data?.[0]?.id}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } })).data?.length === 1,
   'a Business Admin manages contract templates with the Content library');
// Template versions: numbered, checked, in effect from their date
const smokeTpl = (await api(alex, 'contract_template', { method: 'POST', body: { name: 'Smoke template', contract_type: 'msa' } })).data?.[0];
const nextYear = `${new Date().getFullYear() + 1}-01-01`;
const addVersion = (body, effective_from) => api(alex, 'contract_template_version', { method: 'POST', body: { contract_template_id: smokeTpl?.id, body, effective_from } });
ok((await addVersion('Dear {{expert.nmae}}', nextYear)).status >= 400, 'a template version with an unknown merge field is refused');
const tv1 = (await addVersion('# Smoke MSA for {{expert.name}}', nextYear)).data?.[0];
ok(tv1?.version === 1, 'versions are numbered');
const msaTpls = async (on) => (await api(paul, 'rpc/contract_templates_for', { method: 'POST', body: { p_contract_type: 'msa', p_hcp_id: lindHcp.data[0].id, ...(on ? { p_on: on } : {}) } })).data ?? [];
ok(!(await msaTpls()).some((t) => t.id === smokeTpl?.id) && (await msaTpls(nextYear)).some((t) => t.id === smokeTpl?.id && t.version === 1),
   "a template whose first version starts next year isn't offered before then");
const tv2 = (await addVersion('# Smoke MSA v2 for {{expert.name}}', `${new Date().getFullYear() + 1}-07-01`)).data?.[0];
ok(tv2?.version === 2 && (await msaTpls(`${new Date().getFullYear() + 1}-08-01`)).find((t) => t.id === smokeTpl?.id)?.version === 2,
   'the version in effect on the date is served');
ok((await api(alex, `contract_template_version?id=eq.${tv1?.id}`, { method: 'PATCH', body: { notes: 'Edited before use' } })).data?.[0]?.notes === 'Edited before use',
   'an unused version can still be edited');
await api(alex, `contract_template?id=eq.${smokeTpl?.id}`, { method: 'DELETE' });
ok((await api(alex, 'event_type_contract_template', { method: 'POST', body: { event_type_id: tplType, contract_template_id: (await api(alex, 'contract_template?contract_type=eq.msa&select=id')).data?.[0]?.id } })).status >= 400,
   "MSA templates don't belong to event types");
await saveSession(paul, { id: sess.data.id, speakers: [] });
ok((await expertOf()).data?.length === 1, 'a speaker with a signed contract stays without sessions');
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
const sarahMe = await api(sarah, 'rpc/me', { method: 'POST', body: {} });
const mariaMe = await api(maria, 'rpc/me', { method: 'POST', body: {} });
ok((await api(sarah, 'event_post', { method: 'POST', body: { event_id: ev.id, body: 'Not on the team' } })).status >= 400, 'people off the team cannot post');
await api(paul, 'event_team_member', { method: 'POST', body: { event_id: ev.id, user_id: sarahMe.data.id, team_role: 'viewer' } });
const post = await api(sarah, 'event_post', { method: 'POST', body: { event_id: ev.id, body: 'Smoke test post' } });
ok(post.status === 201 && post.data[0].author_id !== null, 'a viewer on the team can post to the board');

// @mentions: only people on the team, each notified once; mentioning yourself doesn't notify you
const mentionsOf = async (who, recordId) => (await api(who, `notification?kind=eq.mention&record_id=eq.${recordId}&select=id,title,body,record_type`)).data ?? [];
const mPost = await api(sarah, 'event_post', { method: 'POST', body: { event_id: ev.id, body: '@Paul Taylor can you check the venue?', mentions: [me.data.id, me.data.id] } });
const paulMentions = await mentionsOf(paul, ev.id);
ok(mPost.status === 201 && mPost.data[0].mentions.length === 1 && paulMentions.length === 1 && paulMentions[0].title === 'Sarah Mitchell'
   && paulMentions[0].record_type === 'event' && paulMentions[0].body.includes('can you check the venue'), 'a mention on the event board notifies the person mentioned, once');
const lisaId = (await api(paul, 'app_user?email=eq.lisa.anderson@alera.example&select=id')).data[0].id;
const offTeam = await api(sarah, 'event_post', { method: 'POST', body: { event_id: ev.id, body: '@Lisa Anderson have a look', mentions: [lisaId] } });
ok(offTeam.status >= 400 && /isn't on the team/.test(offTeam.data?.message ?? ''), "people off the team can't be mentioned");
await api(sarah, 'event_post', { method: 'POST', body: { event_id: ev.id, body: 'Note to self', mentions: [sarahMe.data.id] } });
ok((await mentionsOf(sarah, ev.id)).length === 0, "mentioning yourself doesn't notify you");
// Editing posts: the author only, text and mentions only; people already mentioned aren't told again
const mPostId = mPost.data?.[0]?.id;
const edited = await api(sarah, `event_post?id=eq.${mPostId}`, { method: 'PATCH', body: { body: '@Paul Taylor can you check the venue? It holds 40.', mentions: [me.data.id] } });
ok(edited.data?.[0]?.edited_at && edited.data[0].body.endsWith('holds 40.') && (await mentionsOf(paul, ev.id)).length === 1
   && (await api(paul, `email_message?post_id=eq.${mPostId}&direction=eq.outbound&select=id`)).data?.length === 1,
   "the author edits a post, marked edited; people already mentioned aren't notified or emailed again");
ok((await api(paul, `event_post?id=eq.${mPostId}`, { method: 'PATCH', body: { body: 'Rewritten by the owner' } })).data?.length === 0,
   "an event's owner can't edit other people's posts");
ok((await api(sarah, `event_post?id=eq.${mPostId}`, { method: 'PATCH', body: { event_id: ev.id, parent_id: null } })).status >= 400, 'only the text and mentions of a post change');
ok((await api(sarah, `event_post?id=eq.${mPostId}`, { method: 'PATCH', body: { body: '  ' } })).status >= 400, "a post can't be edited to nothing");

// Working by email: a mention also queues an email; the reply comes back through the Email Agent
const emailAgent = await login('email-agent@agents.alera.example');
const receive = (who, p) => api(who, 'rpc/receive_email', { method: 'POST', body: { p } });
const paulEmail = (await api(paul, `email_message?record_id=eq.${ev.id}&kind=eq.mention&select=id,status,to_address,reply_to,body,post_id`)).data?.[0];
ok(['queued', 'sending', 'sent', 'failed'].includes(paulEmail?.status) && paulEmail.to_address === 'paul.taylor@alera.example' && paulEmail.body.includes('can you check the venue')
   && paulEmail.post_id === mPost.data?.[0]?.id, "a mention also queues an email with the post's text");
ok((await api(sarah, `email_message?id=eq.${paulEmail?.id}&select=id`)).data?.length === 0, "people can't read other people's emails");
ok((await api(paul, 'email_message', { method: 'POST', body: { direction: 'inbound', kind: 'reply', status: 'processed', from_address: 'x', to_address: 'y', subject: 's', body: 'b' } })).status >= 400,
   "emails can't be written through the API");
ok((await receive(paul, { from: 'paul.taylor@alera.example', to: paulEmail?.reply_to, text: 'Hi' })).status >= 400, 'only the email service delivers replies');
ok((await receive(emailAgent, { from: 'Sarah Mitchell <sarah.mitchell@alera.example>', to: paulEmail?.reply_to, text: 'Spoofed' })).data?.status === 'failed',
   "a reply from someone other than the recipient isn't used");
const viaEmail = await receive(emailAgent, { from: 'Paul Taylor <PAUL.TAYLOR@alera.example>', to: paulEmail?.reply_to, subject: 'Re: mention',
  text: 'Booked, see you there.\n\nOn Mon 2 Nov 2026 at 09:00, Event Center <notifications@eventcenter.example> wrote:\n> @Paul Taylor can you check the venue?' });
const emailPost = (await api(paul, `event_post?id=eq.${viaEmail.data?.post_id}&select=body,channel,author_id,parent_id`)).data?.[0];
ok(viaEmail.data?.status === 'processed' && emailPost?.channel === 'email' && emailPost.body === 'Booked, see you there.'
   && emailPost.author_id === me.data.id && emailPost.parent_id === mPost.data?.[0]?.id, 'a reply to a mention email is posted in the thread as the person, marked as email');
const emailLog = await api(paul, `event_history?record_id=eq.${viaEmail.data?.post_id}&select=actor_type,on_behalf_of_name`);
ok(emailLog.data?.[0]?.actor_type === 'agent' && emailLog.data[0].on_behalf_of_name === 'Paul Taylor', 'history shows the Email Agent acting for the person who replied');
ok((await api(sarah, 'event_post', { method: 'POST', body: { event_id: ev.id, body: 'Pretend email', channel: 'email', author_id: me.data.id } })).data?.[0]?.channel === 'app',
   "a post can't claim to come from email or from someone else");
// Sending: only the Email Agent picks up and records emails
ok((await api(paul, 'rpc/claim_outbound_emails', { method: 'POST', body: { p_limit: 1 } })).status >= 400, 'only the email service picks up emails to send');
ok((await api(paul, 'rpc/email_sent', { method: 'POST', body: { p: { id: paulEmail?.id, ok: true } } })).status >= 400, 'only the email service records what was sent');
// Demo inbox: a reply from it counts as the person the email was for; each reply is taken once
ok((await api(maria, `tenant?id=eq.${tenantId}`, { method: 'PATCH', body: { demo_inbox: 'maria@example.com' } })).data?.length === 0, 'only System Admins set the demo inbox');
const replyId = `smoke-${Date.now()}`;
const fromInbox = await receive(emailAgent, { id: replyId, from: `Demo <${SINK}>`, to: paulEmail?.reply_to, text: 'Smoke: via the demo inbox' });
const inboxPost = (await api(paul, `event_post?id=eq.${fromInbox.data?.post_id}&select=author_id,channel`)).data?.[0];
ok(fromInbox.data?.status === 'processed' && inboxPost?.author_id === me.data.id && inboxPost.channel === 'email', 'a reply from the demo inbox is posted as the person the email was for');
const again = await receive(emailAgent, { id: replyId, from: `Demo <${SINK}>`, to: paulEmail?.reply_to, text: 'Smoke: via the demo inbox' });
ok(again.data?.id === fromInbox.data?.id && (await api(paul, `event_post?event_id=eq.${ev.id}&body=eq.Smoke: via the demo inbox&select=id`)).data?.length === 1,
   'a reply delivered twice is posted once');
ok((await receive(emailAgent, { from: 'paul.taylor@alera.example', to: paulEmail?.reply_to, text: 'Forged', authentication: { spf: 'fail', dkim: 'fail' } })).data?.status === 'failed',
   "a reply that fails the mail server's SPF and DKIM checks isn't used");
await api(paul, `notification?kind=eq.mention&record_id=eq.${ev.id}`, { method: 'DELETE' });

// The Team decides access: off the team you don't see the event; viewers see it; organizers edit it
const lisaMe = await api(lisaT, 'rpc/me', { method: 'POST', body: {} });
const lisaSees = async () => (await api(lisaT, `event?id=eq.${ev.id}&select=id`)).data?.length === 1;
const lisaEdits = async (city) => (await api(lisaT, 'rpc/update_event', { method: 'POST', body: { p_event_id: ev.id, p: { city } } })).status === 200;
ok(!(await lisaSees()), "a coordinator off the team cannot see another coordinator's event");
const lisaRow = await api(paul, 'event_team_member', { method: 'POST', body: { event_id: ev.id, user_id: lisaMe.data.id, team_role: 'viewer', role_label: 'Logistics' } });
ok(lisaRow.status === 201 && await lisaSees() && !(await lisaEdits('Nice')), 'a viewer sees the event but cannot edit it');
ok((await api(lisaT, 'event_team_member', { method: 'POST', body: { event_id: ev.id, user_id: mariaMe.data.id, team_role: 'organizer' } })).status >= 400,
   'a viewer cannot manage the team');
await api(paul, `event_team_member?id=eq.${lisaRow.data?.[0]?.id}`, { method: 'PATCH', body: { team_role: 'organizer' } });
ok(await lisaEdits('Lyon'), 'an organizer can edit the event');
const access = await api(lisaT, 'rpc/my_event_access', { method: 'POST', body: { p_event_id: ev.id } });
ok(access.data?.access === 'edit' && access.data?.team_role === 'organizer', 'my_event_access reports the caller\'s access');
const ownerRow = await api(paul, `event_team_member?event_id=eq.${ev.id}&user_id=eq.${me.data.id}&select=id,team_role`);
ok(ownerRow.data?.[0]?.team_role === 'owner' && (await api(lisaT, `event_team_member?id=eq.${ownerRow.data[0].id}`, { method: 'DELETE' })).status >= 400,
   'the owner is on the team and cannot be removed');
ok((await api(paul, `event_team_member?id=eq.${lisaRow.data?.[0]?.id}`, { method: 'PATCH', body: { team_role: 'owner' } })).status >= 400,
   'nobody else can be given the Owner role');
await api(paul, `event_team_member?id=eq.${lisaRow.data?.[0]?.id}`, { method: 'DELETE' });
ok(!(await lisaSees()), 'removing someone from the team removes their access');

// Agent acting on behalf of Paul: allowed edit is audited with both identities
const holm = await api(agent, `event_expert?event_id=eq.${s.id}&role=eq.chair&select=id`, { headers: { 'x-on-behalf-of': me.data.id } });
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
// No FMV, no rate: Karin joins at €0 and can't be given one until an FMV rate is recorded, which then fills it in
const karinOnEv = await api(paul, 'event_expert', { method: 'POST', body: { event_id: ev.id, hcp_id: imported.data?.id, role: 'advisor' } });
ok(karinOnEv.status === 201 && Number(karinOnEv.data?.[0]?.hourly_rate) === 0, 'an expert without an FMV rate joins at €0');
ok((await api(paul, `event_expert?id=eq.${karinOnEv.data?.[0]?.id}`, { method: 'PATCH', body: { hourly_rate: 150 } })).status >= 400,
   'an expert without an FMV rate cannot be given a rate');
await api(paul, 'fmv_rate', { method: 'POST', body: { hcp_id: imported.data?.id, rate: 180, min_rate: 150, max_rate: 210, currency: 'EUR', effective_date: '2026-01-01' } });
const karinRate = await api(paul, `event_expert?id=eq.${karinOnEv.data?.[0]?.id}&select=hourly_rate,fmv_rate_id`);
ok(Number(karinRate.data?.[0]?.hourly_rate) === 180 && karinRate.data[0].fmv_rate_id, 'recording an FMV rate fills in the €0 rate');
// Every expert is an attendee: adding one adds their row, which stays until they've left the experts
const karinRow = () => api(paul, `event_attendee?event_id=eq.${ev.id}&hcp_id=eq.${imported.data?.id}&select=id,rsvp,organisation,crm_status,owner_id`);
const karinAuto = (await karinRow()).data?.[0];
ok(karinAuto?.rsvp === 'invited' && karinAuto?.organisation === 'Uppsala University Hospital' && karinAuto?.crm_status === 'reconciled' && karinAuto?.owner_id === me.data.id,
   'an expert joins the attendees, invited, with their organisation, owned by whoever added them');
const keepExpert = await api(paul, `event_attendee?id=eq.${karinAuto?.id}`, { method: 'DELETE' });
ok(keepExpert.status >= 400 && /experts first/.test(keepExpert.data?.message ?? ''), "an attendee can't be removed while they're an expert");
await api(paul, `event_expert?id=eq.${karinOnEv.data?.[0]?.id}`, { method: 'DELETE' });
ok((await karinRow()).data?.length === 1, 'someone removed from the experts stays an attendee');
ok((await api(paul, `event_attendee?id=eq.${karinAuto?.id}`, { method: 'DELETE' })).status < 300 && (await karinRow()).data?.length === 0, 'an attendee who is no longer an expert can be removed');
await api(paul, `event_attendee?event_id=eq.${ev.id}&hcp_id=eq.${holmHcp.data[0].id}`, { method: 'DELETE' });

// Cancelling: a reason is required, collaborators can't, and there's no way back
const setStatus = (who, status, reason) => api(who, 'rpc/change_event_status', { method: 'POST', body: { p_event_id: ev.id, p_status: status, p_reason: reason } });
ok((await setStatus(paul, 'cancelled', ' ')).status >= 400, 'cancelling needs a reason');
ok((await setStatus(sarah, 'cancelled', 'Not mine to cancel')).status >= 400, 'collaborator cannot cancel an event');
const cancelledEv = await setStatus(paul, 'cancelled', 'Smoke test: merged into another meeting');
ok(cancelledEv.status === 200 && cancelledEv.data?.status === 'cancelled' && cancelledEv.data?.cancel_reason === 'Smoke test: merged into another meeting',
   'event owner can cancel with a reason');
ok((await setStatus(paul, 'draft')).status >= 400, 'a cancelled event cannot be reopened');

// Requests: drafts are private to their team; submitting locks them and shows them to home office
const saveReq = (who, p) => api(who, 'rpc/save_request', { method: 'POST', body: { p } });
ok((await api(paul, 'event_request?select=id')).data?.length === 16, 'coordinator sees submitted requests and their own drafts (16)');
ok((await api(maria, 'event_request?select=id')).data?.length === 14, 'Business Admin sees every submitted request, no drafts (14)');
ok((await api(sarah, 'event_request?select=id')).data?.length === 4, "a requester sees only their teams' requests (4)");
const req = await saveReq(sarah, { title: 'Smoke request', event_type_id: types.data[0].id, event_date: '2027-03-04' });
const reqId = req.data?.id;
ok(req.status === 200 && req.data.status === 'draft' && req.data.requested_by === sarahMe.data.id && Number(req.data.request_number.split('-')[2]) > 76,
   'saving a new request creates a draft owned by its creator, numbered after the seeded ones');
const reqTeam = await api(sarah, `request_team_member?request_id=eq.${reqId}&select=user_id,team_role`);
ok(reqTeam.data?.length === 1 && reqTeam.data[0].team_role === 'owner', 'the creator is on the team as owner');
ok((await api(paul, `event_request?id=eq.${reqId}&select=id`)).data?.length === 0, "home office can't see someone else's draft");
ok((await api(sarah, 'event_request', { method: 'POST', body: { title: 'Spoof', event_type_id: types.data[0].id, requested_by: lisa.data[0].id, status: 'approved' } })).data?.[0]?.status === 'draft',
   'a new request always starts as draft and belongs to whoever creates it');
await api(sarah, 'event_request?title=eq.Spoof', { method: 'DELETE' });
const submitReq = () => api(sarah, `event_request?id=eq.${reqId}`, { method: 'PATCH', body: { status: 'review' } });
ok((await submitReq()).status >= 400, 'a request needs a date, duration and business justification to be submitted');
ok((await saveReq(sarah, { id: reqId, duration: 'half_day', rationale: 'Smoke test justification' })).status === 200, 'requester can change their draft');
const submitted = await submitReq();
ok(submitted.status === 200 && submitted.data?.[0]?.status === 'review' && submitted.data[0].submitted_at, 'requester can submit a complete draft for approval');
ok((await api(paul, `event_request?id=eq.${reqId}&select=id`)).data?.length === 1, 'once submitted, home office sees the request');
ok((await saveReq(sarah, { id: reqId, title: 'Changed after submit' })).status >= 400, "a submitted request can't be changed");
ok((await api(sarah, `event_request?id=eq.${reqId}`, { method: 'PATCH', body: { status: 'approved' } })).status >= 400, "a request can't be approved by setting its status");
ok((await api(sarah, `event_request?id=eq.${reqId}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } })).data?.length === 0, "a submitted request can't be deleted");
const reqPost = await api(paul, 'request_post', { method: 'POST', body: { request_id: reqId, body: 'Smoke question from home office for @Sarah Mitchell', mentions: [sarahMe.data.id] } });
ok(reqPost.status === 201 && (await api(sarah, `request_post?request_id=eq.${reqId}&select=id`)).data?.length === 1, 'home office and the requester discuss on the request board');
ok((await mentionsOf(sarah, reqId))[0]?.record_type === 'request', 'a mention on the request board notifies the requester');
await api(sarah, `notification?kind=eq.mention&record_id=eq.${reqId}`, { method: 'DELETE' });
ok((await api(lisaT, `request_post?request_id=eq.${reqId}&select=id`)).data?.length === 1 && (await api(sarah, `request_team_member?request_id=eq.${reqId}&user_id=eq.${sarahMe.data.id}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } })).status >= 400,
   "the requester can't be removed from the team");
const draft2 = await saveReq(sarah, { title: 'Smoke draft', event_type_id: types.data[0].id });
ok((await saveReq(sarah, { id: draft2.data?.id, duration: 'a_week' })).status >= 400, 'duration must be one of the listed ones');
ok((await api(sarah, `request_team_member`, { method: 'POST', body: { request_id: draft2.data?.id, user_id: lisa.data[0].id, team_role: 'viewer' } })).status === 201
   && (await api(lisaT, `event_request?id=eq.${draft2.data?.id}&select=id`)).data?.length === 1, 'a requester shares a draft by adding people to its team');
ok((await api(lisaT, `event_request?id=eq.${draft2.data?.id}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } })).data?.length === 0, "a viewer can't delete the draft");
ok((await api(sarah, `event_request?id=eq.${draft2.data?.id}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } })).data?.length === 1, 'the requester can delete their draft');
const reqAccess = await api(sarah, 'rpc/my_request_access', { method: 'POST', body: { p_request_id: reqId } });
ok(reqAccess.data?.access === 'edit' && reqAccess.data?.team_role === 'owner', 'my_request_access reports the requester as owner with edit access');
// Deciding: the approval process decides who approves (the standard one: the requester's manager)
const michaelT = await login('michael.chen@alera.example');
const michaelId = (await api(michaelT, 'rpc/me', { method: 'POST', body: {} })).data?.id;
const mariaId = (await api(maria, 'rpc/me', { method: 'POST', body: {} })).data?.id;
const approvalOf = async (id) => (await api(paul, `approval?record_id=eq.${id}&select=id,process_name,status,current_step,approval_task(step_number,step_name,approver_type,approver_id,approver_group_id,status,decided_by,comment)&order=submitted_at.desc`)).data?.[0];
const smokeApproval = await approvalOf(reqId);
ok(smokeApproval?.process_name === 'Event request — standard' && smokeApproval.approval_task.length === 1
   && smokeApproval.approval_task[0].approver_id === michaelId && smokeApproval.approval_task[0].status === 'pending',
   "submitting starts the matching process: the standard one sends it to the requester's manager");
const decide = (who, decision, note, id = reqId) => api(who, 'rpc/decide_request', { method: 'POST', body: { p_request_id: id, p_decision: decision, p_note: note } });
ok(reqAccess.data?.can_decide === false && (await decide(sarah, 'approved')).status >= 400, "the requester can't approve their own request");
ok((await api(paul, 'rpc/my_request_access', { method: 'POST', body: { p_request_id: reqId } })).data?.can_decide === false
   && (await decide(paul, 'approved')).status >= 400, "home office doesn't decide unless the process names them");
const michaelAccess = (await api(michaelT, 'rpc/my_request_access', { method: 'POST', body: { p_request_id: reqId } })).data;
ok(michaelAccess?.can_decide === true && michaelAccess.access === 'view' && michaelAccess.team_role === 'approver',
   'the approver sees the request as its Approver and may decide');
ok((await api(michaelT, 'rpc/my_pending_approvals', { method: 'POST', body: {} })).data?.some((x) => x.record_id === reqId),
   'the request waits in the approver\'s approvals');
ok((await api(michaelT, `notification?record_id=eq.${reqId}&kind=eq.approval_required&read_at=is.null&select=id`)).data?.length === 1, 'the approver is notified');
ok((await decide(michaelT, 'rejected', '  ')).status >= 400, 'rejecting needs a reason');
ok((await decide(michaelT, 'maybe')).status >= 400, 'a decision is approved or rejected');
const approved = await decide(michaelT, 'approved', 'Smoke: go ahead');
const paulId = (await api(paul, 'app_user?email=eq.paul.taylor@alera.example&select=id')).data?.[0]?.id;
ok(approved.status === 200 && approved.data?.status === 'approved' && approved.data.decided_by === michaelId && approved.data.decision_note === 'Smoke: go ahead' && approved.data.decided_at,
   'the manager approves the request, with who, when and a note');
ok((await approvalOf(reqId))?.status === 'approved', 'the approval is complete');
const reqNote = await api(sarah, `notification?record_id=eq.${reqId}&kind=eq.approved&select=id,title`);
ok(reqNote.data?.[0]?.title === 'Request approved: Smoke request', 'the requester is notified of the decision');
ok((await api(michaelT, `notification?record_id=eq.${reqId}&kind=eq.approval_required&read_at=is.null&select=id`)).data?.length === 0, "the approver's request to approve is done");
ok((await decide(michaelT, 'rejected', 'Too late')).status >= 400, 'a decided request stays decided');
ok((await api(sarah, `event_request?id=eq.${reqId}`, { method: 'PATCH', body: { decision_note: 'Edited' } })).status >= 400, "a decision can't be edited");

// Tiering requests: an expert and a business justification; named after the expert
ok((await saveReq(sarah, { request_type: 'tiering', rationale: 'Needed' })).status >= 400, 'a tiering request needs an expert');
ok((await saveReq(sarah, { request_type: 'tiering', hcp_id: holmHcp.data[0].id, related_event_id: crypto.randomUUID() })).status >= 400,
   "a tiering request can't name an event the requester can't see");
const tier = await saveReq(sarah, { request_type: 'tiering', hcp_id: holmHcp.data[0].id, event_type_id: types.data[0].id, event_date: '2027-01-01' });
ok(tier.status === 200 && tier.data?.request_type === 'tiering' && tier.data?.title === 'Tiering: Dr Mette Holm' && tier.data?.event_type_id === null && tier.data?.event_date === null,
   'a tiering request is named after the expert and carries no event details');
ok((await api(sarah, `event_request?id=eq.${tier.data?.id}`, { method: 'PATCH', body: { status: 'review' } })).status >= 400,
   'a tiering request needs a business justification to be submitted');
ok((await api(sarah, `event_request?id=eq.${tier.data?.id}`, { method: 'PATCH', body: { request_type: 'event' } })).status >= 400, "a request's type can't change");
await saveReq(sarah, { id: tier.data?.id, rationale: 'Smoke: please review her cap' });
ok((await api(sarah, `event_request?id=eq.${tier.data?.id}`, { method: 'PATCH', body: { status: 'review' } })).data?.[0]?.status === 'review'
   && (await api(paul, `event_request?id=eq.${tier.data?.id}&select=id`)).data?.length === 1, 'a submitted tiering request reaches home office');
ok((await approvalOf(tier.data?.id))?.process_name === 'Expert tiering', 'a tiering request goes through the tiering process (Compliance)');
ok((await api(maria, `notification?record_id=eq.${tier.data?.id}&kind=eq.approval_required&select=id`)).data?.length === 1
   && (await api(alex, `notification?record_id=eq.${tier.data?.id}&kind=eq.approval_required&select=id`)).data?.length === 1, "every member of an approving group is notified");
ok((await api(paul, `event_request?request_type=eq.tiering&coordinator_id=is.null&status=eq.review&select=id`)).data?.length === 2,
   'tiering requests wait in the unassigned requests');

// Approving by email: the approval email has the details; the reply starts with Approve or Reject
const mariaApproval = (await api(maria, `email_message?record_id=eq.${tier.data?.id}&kind=eq.approval&user_id=eq.${mariaId}&select=reply_to,body,subject`)).data?.[0];
ok(mariaApproval?.subject.startsWith('Approval needed: Tiering') && mariaApproval.body.includes('Smoke: please review her cap'), "submitting emails the approvers the request's details");
const alexApproval = (await api(alex, `email_message?record_id=eq.${tier.data?.id}&kind=eq.approval&user_id=eq.${me0.data?.id}&select=reply_to`)).data?.[0];
const mariaFrom = 'Maria Castillo <maria.castillo@alera.example>';
ok((await receive(emailAgent, { from: mariaFrom, to: mariaApproval?.reply_to, text: 'Sounds good' })).data?.status === 'failed', 'an approval reply starts with Approve or Reject');
const noReason = await receive(emailAgent, { from: mariaFrom, to: mariaApproval?.reply_to, text: 'Reject\n\n> Approval needed' });
ok(noReason.data?.status === 'failed' && /reason/.test(noReason.data?.status_note ?? ''), 'rejecting by email needs a reason too');
const byEmail = await receive(emailAgent, { from: mariaFrom, to: mariaApproval?.reply_to, text: 'Approve - Smoke: fine by email\n\nOn Mon, Event Center wrote:\n> Approval needed' });
const tierNow = (await api(paul, `event_request?id=eq.${tier.data?.id}&select=status,decided_by,decided_via,decision_note`)).data?.[0];
ok(byEmail.data?.status === 'processed' && tierNow?.status === 'approved' && tierNow.decided_via === 'email' && tierNow.decided_by === mariaId
   && tierNow.decision_note === 'Smoke: fine by email', 'an approver approves by replying Approve, with a comment');
ok((await receive(emailAgent, { from: 'Alex Morgan <alex.morgan@alera.example>', to: alexApproval?.reply_to, text: 'Reject: changed my mind' })).data?.status === 'failed',
   'one member decides for the group: the others can no longer');
ok((await api(paul, `event_request?id=eq.${reqId}&select=decided_via`)).data?.[0]?.decided_via === 'app', 'decisions made in Event Center say so');
ok((await api(sarah, `event_request?id=eq.${tier.data?.id}`, { method: 'PATCH', body: { decided_via: 'app' } })).status >= 400, "where a decision was made can't be edited");

// Approval processes: entry criteria pick the process; same step number runs in parallel, the next waits
const procName = `Smoke process ${Date.now()}`;
const compliance = (await api(paul, 'user_group?name=eq.Compliance&select=id')).data?.[0]?.id;
ok((await api(paul, 'approval_process', { method: 'POST', body: { name: procName } })).status >= 400, "a coordinator can't create approval processes");
ok((await api(maria, 'approval_process', { method: 'POST', body: { name: `${procName} x`, criteria: [{ field: 'secret', op: 'in', values: ['x'] }] } })).status >= 400
   && (await api(maria, 'approval_process', { method: 'POST', body: { name: `${procName} y`, criteria: [{ field: 'country_code', op: 'gt', value: 3 }] } })).status >= 400,
   'entry criteria use known fields with fitting conditions');
const proc = (await api(maria, 'approval_process', { method: 'POST', body: { name: procName, priority: 1,
  criteria: [{ field: 'request_type', op: 'in', values: ['event'] }, { field: 'country_code', op: 'in', values: ['NL'] }] } })).data?.[0];
const addStep = (body) => api(maria, 'approval_process_step', { method: 'POST', body: { process_id: proc?.id, ...body } });
ok((await addStep({ step_number: 1, name: 'Bad', approver_type: 'group' })).status >= 400, 'a group step names its group');
ok((await addStep({ step_number: 1, name: 'HQ', approver_type: 'user', approver_user_id: paulId })).status === 201
   && (await addStep({ step_number: 1, name: 'Compliance', approver_type: 'group', approver_group_id: compliance })).status === 201
   && (await addStep({ step_number: 2, name: 'Manager', approver_type: 'manager' })).status === 201,
   'a Business Admin sets up a process: two steps in parallel, then the manager');
const nlReq = (await saveReq(sarah, { title: 'Smoke NL request', event_type_id: types.data[0].id, event_date: '2027-06-01', duration: 'hours',
                                     country_code: 'NL', rationale: 'Smoke' })).data;
await api(sarah, `event_request?id=eq.${nlReq?.id}`, { method: 'PATCH', body: { status: 'review' } });
const nlTasks = async () => (await approvalOf(nlReq?.id))?.approval_task ?? [];
const t1 = await nlTasks();
ok((await approvalOf(nlReq?.id))?.process_name === procName && t1.filter((t) => t.status === 'pending').length === 2
   && t1.find((t) => t.step_number === 2)?.status === 'waiting' && t1.find((t) => t.step_number === 2)?.approver_id === michaelId,
   'the matching process applies: step 1 waits on both approvers, step 2 on the manager fixed at submit');
ok((await api(michaelT, 'rpc/my_request_access', { method: 'POST', body: { p_request_id: nlReq?.id } })).data?.can_decide === false, "a later step's approver can't decide yet");
await decide(paul, 'approved', null, nlReq?.id);
ok((await nlTasks()).find((t) => t.step_number === 2)?.status === 'waiting', 'a step is done only when all its parallel approvers approve');
await decide(maria, 'approved', 'Smoke: compliant', nlReq?.id);
ok((await nlTasks()).find((t) => t.step_number === 2)?.status === 'pending'
   && (await api(michaelT, `notification?record_id=eq.${nlReq?.id}&kind=eq.approval_required&select=id`)).data?.length === 1,
   'then the next step starts and its approver is notified');
ok((await decide(alex, 'approved', null, nlReq?.id)).status >= 400, 'once a member decided for the group, the others have nothing to decide');
const nlRejected = await decide(michaelT, 'rejected', 'Smoke: not this quarter', nlReq?.id);
ok(nlRejected.data?.status === 'rejected' && nlRejected.data.decision_note === 'Smoke: not this quarter', 'a rejection at any step rejects the request');
// Refusals: no manager and no fallback; no process at all
const paulNl = (await saveReq(michaelT, { title: 'Smoke NL by Michael', event_type_id: types.data[0].id, event_date: '2027-06-01', duration: 'hours',
                                     country_code: 'NL', rationale: 'Smoke' })).data;
const paulSubmit = await api(michaelT, `event_request?id=eq.${paulNl?.id}`, { method: 'PATCH', body: { status: 'review' } });
ok(paulSubmit.status >= 400 && /manager/.test(paulSubmit.data?.message ?? ''), "submitting is refused when a manager step has no manager and no fallback");
const standard = (await api(maria, "approval_process?name=eq.Event%20request%20%E2%80%94%20standard&select=id")).data?.[0]?.id;
await api(maria, `approval_process?id=eq.${standard}`, { method: 'PATCH', body: { is_active: false } });
const dkReq = (await saveReq(sarah, { title: 'Smoke DK request', event_type_id: types.data[0].id, event_date: '2027-06-01', duration: 'hours', rationale: 'Smoke' })).data;
const dkSubmit = await api(sarah, `event_request?id=eq.${dkReq?.id}`, { method: 'PATCH', body: { status: 'review' } });
await api(maria, `approval_process?id=eq.${standard}`, { method: 'PATCH', body: { is_active: true } });
ok(dkSubmit.status >= 400 && /No approval process/.test(dkSubmit.data?.message ?? ''), 'submitting is refused when no process applies');
await api(maria, `approval_process?id=eq.${proc?.id}`, { method: 'DELETE' });
await api(alex, `event_request?id=in.(${nlReq?.id},${paulNl?.id},${dkReq?.id})`, { method: 'DELETE' });
await api(alex, `email_message?record_id=eq.${nlReq?.id}`, { method: 'DELETE' });

// Attendees: HCPs added in bulk from EC or straight from a CRM; each person once
const addAtt = (who, people) => api(who, 'rpc/add_event_attendees', { method: 'POST', body: { p_event_id: ev.id, p_people: people } });
const people = [{ hcp_id: holmHcp.data[0].id }, { hcp_id: holmHcp.data[0].id },
                { crm_connection_id: karin?.crm_connection_id, external_id: karin?.external_id }];
ok((await addAtt(lisaT, people)).status >= 400, "someone without edit access can't add attendees");
ok((await addAtt(paul, [{ name: 'Walk-in' }])).status >= 400, 'an attendee needs an hcp_id or a CRM record');
const addedAtt = await addAtt(paul, people);
ok(addedAtt.status === 200 && addedAtt.data?.added === 2 && addedAtt.data?.skipped === 0, 'attendees are added from EC and from the CRM in one call');
ok((await addAtt(paul, people)).data?.skipped === 2, 'people already attending are skipped');
const atts = await api(paul, `event_attendee?event_id=eq.${ev.id}&select=id,hcp_id,rsvp,organisation,crm_status,attended,owner_id`);
const holmAtt = atts.data?.find((a) => a.hcp_id === holmHcp.data[0].id);
const karinAtt = atts.data?.find((a) => a.hcp_id === imported.data?.id);
ok(holmAtt?.rsvp === 'invited' && holmAtt?.organisation === 'Odense University Hospital' && holmAtt?.crm_status === 'reconciled',
   'a new attendee is invited, with their organisation, and reconciled when they are a CRM account');
ok(karinAtt?.organisation === 'Uppsala University Hospital', 'a CRM attendee arrives with their organisation');

// Custom fields on other objects: attendees (by the event's type), experts everywhere, requests until submitted
const cfOn = (object_name, api_name, extra = {}) => api(alex, 'custom_field', { method: 'POST', body: { object_name, api_name, label: api_name, field_type: 'picklist',
  options: [{ value: 'veg', label: 'Vegetarian' }, { value: 'none', label: 'None' }], ...extra } });
ok((await cfOn('venue', 'smoke_x__c')).status >= 400, 'custom fields go on the listed objects only');
ok((await cfOn('event_attendee', 'smoke_req__c', { is_required: true })).status >= 400, 'only event and request fields can be required');
const dietF = (await cfOn('event_attendee', 'smoke_diet__c')).data?.[0];
await api(alex, 'custom_field_layout', { method: 'POST', body: { custom_field_id: dietF?.id, event_type_id: null } });
const setDiet = (v) => api(paul, `event_attendee?id=eq.${holmAtt?.id}`, { method: 'PATCH', body: { custom_fields: { smoke_diet__c: v } } });
ok((await setDiet('steak')).status >= 400, "an attendee's custom field takes only its options");
ok((await setDiet('veg')).data?.[0]?.custom_fields?.smoke_diet__c === 'veg', 'an editor fills in a custom field on an attendee');
const hcpF = (await cfOn('hcp', 'smoke_pref__c')).data?.[0];
const hcpLayouts = (await api(alex, `custom_field_layout?custom_field_id=eq.${hcpF?.id}&select=event_type_id`)).data ?? [];
ok(hcpLayouts.length === 1 && hcpLayouts[0].event_type_id === null
   && (await api(alex, 'custom_field_layout', { method: 'POST', body: { custom_field_id: hcpF?.id, event_type_id: types.data[0].id } })).status >= 400,
   'expert fields apply to every event type');
const reqF = (await cfOn('event_request', 'smoke_budget__c')).data?.[0];
await api(alex, 'custom_field_layout', { method: 'POST', body: { custom_field_id: reqF?.id, event_type_id: null } });
const cfDraft = await saveReq(sarah, { title: 'Smoke custom draft', event_type_id: types.data[0].id, custom_fields: { smoke_budget__c: 'none' } });
ok(cfDraft.data?.custom_fields?.smoke_budget__c === 'none', 'a request takes its custom fields in save_request');
await api(sarah, `event_request?id=eq.${cfDraft.data?.id}`, { method: 'DELETE' });
ok((await api(sarah, `event_request?id=eq.${reqId}`, { method: 'PATCH', body: { custom_fields: { smoke_budget__c: 'veg' } } })).status >= 400,
   "a submitted request's custom fields are fixed");
ok((await api(paul, `event_attendee?id=eq.${holmAtt?.id}`, { method: 'PATCH', body: { rsvp: 'maybe' } })).status >= 400, 'RSVP takes only known answers');
ok((await api(paul, `event_attendee?id=eq.${holmAtt?.id}`, { method: 'PATCH', body: { rsvp: 'accepted' } })).data?.[0]?.rsvp === 'accepted', 'an editor records an RSVP');
ok(holmAtt?.attended === false && holmAtt?.owner_id === me.data.id, 'an attendee starts as not attended, owned by whoever added them');
ok((await api(paul, `event_attendee?id=eq.${holmAtt?.id}`, { method: 'PATCH', body: { attended: true } })).data?.[0]?.attended === true, 'an editor records attendance');
ok((await api(paul, `event_attendee?id=eq.${holmAtt?.id}`, { method: 'PATCH', body: { owner_id: lisa.data[0].id } })).data?.[0]?.owner_id === lisa.data[0].id,
   'an editor hands an attendee to another owner');
const agentUser = await api(paul, 'app_user?email=eq.compliance-agent@agents.alera.example&select=id');
ok((await api(paul, `event_attendee?id=eq.${holmAtt?.id}`, { method: 'PATCH', body: { owner_id: agentUser.data?.[0]?.id } })).status >= 400, 'an attendee is owned by a person, not an agent');
// Bulk changes from the list: one call for the ticked rows; rows the caller can't edit are left out
const bothAtt = `event_attendee?id=in.(${holmAtt?.id},${karinAtt?.id})`;
ok((await api(paul, bothAtt, { method: 'PATCH', body: { rsvp: 'tentative', attended: false } })).data?.length === 2, 'an editor changes several attendees in one call');
ok((await api(lisaT, bothAtt, { method: 'PATCH', body: { rsvp: 'declined' } })).data?.length === 0
   && (await api(paul, `${bothAtt}&select=rsvp`)).data?.every((a) => a.rsvp === 'tentative'), "a bulk change skips attendees the caller can't edit");
const holmBack = await api(paul, 'event_expert', { method: 'POST', body: { event_id: ev.id, hcp_id: holmHcp.data[0].id, role: 'advisor' } });
const holmNow = await api(paul, `event_attendee?event_id=eq.${ev.id}&hcp_id=eq.${holmHcp.data[0].id}&select=id,rsvp`);
ok(holmBack.status === 201 && holmNow.data?.length === 1 && holmNow.data[0].id === holmAtt?.id && holmNow.data[0].rsvp === 'tentative', 'an attendee who becomes an expert keeps their row and RSVP');
await api(paul, `event_expert?id=eq.${holmBack.data?.[0]?.id}`, { method: 'DELETE' });

// Spend: what was paid and who received it; an even split adds up to the cent; ToV reports HCP shares
ok((await api(lisaT, 'event_spend', { method: 'POST', body: { event_id: ev.id, spend_type: 'meals', spend_date: '2026-12-01', description: 'Smoke dinner', amount: 100 } })).status >= 400,
   "someone without edit access can't record spend");
const dinner = await api(paul, 'event_spend', { method: 'POST', body: { event_id: ev.id, spend_type: 'meals', spend_date: '2026-12-01', description: 'Smoke dinner', amount: 100.01 } });
ok(dinner.status === 201 && dinner.data?.[0]?.tov_category === 'hospitality', 'a new expense takes the usual ToV category of its type');
const dinnerId = dinner.data?.[0]?.id;
const split = (ids) => api(paul, 'rpc/split_spend', { method: 'POST', body: { p_spend_id: dinnerId, p_attendee_ids: ids } });
ok((await split([holmAtt?.id, crypto.randomUUID()])).status >= 400, 'a spend line is split only across attendees of its event');
ok((await api(lisaT, 'rpc/split_spend', { method: 'POST', body: { p_spend_id: dinnerId, p_attendee_ids: [holmAtt?.id] } })).status >= 400,
   "someone without edit access can't change who received spend");
await split([holmAtt?.id, karinAtt?.id]);
const shares = async () => (await api(paul, `event_spend_attribution?spend_id=eq.${dinnerId}&select=amount`)).data?.map((a) => Number(a.amount)).sort() ?? [];
ok(JSON.stringify(await shares()) === JSON.stringify([50, 50.01]), 'an even split hands the leftover cent to one person, so it adds up');
const tovLines = async () => (await api(paul, `event_tov?event_id=eq.${ev.id}&source=eq.spend&select=hcp_id,amount`)).data ?? [];
ok((await tovLines()).length === 2, "each HCP's share is a ToV line");
await api(paul, `event_spend?id=eq.${dinnerId}`, { method: 'PATCH', body: { amount: 90 } });
ok(JSON.stringify(await shares()) === JSON.stringify([45, 45]), 'changing the amount re-spreads it across the same people');
await api(paul, `event_spend?id=eq.${dinnerId}`, { method: 'PATCH', body: { tov_category: 'not_reportable' } });
ok((await tovLines()).length === 0, 'a not-reportable expense leaves the ToV report');
const read = (name) => api(paul, 'rpc/extract_invoice', { method: 'POST', body: { p_event_id: ev.id, p_file_name: name } });
const readDinner = await read('dinner-kokkeriet-KK-2026-0418.png');
ok(readDinner.data?.found === true && readDinner.data.spend_type === 'meals' && readDinner.data.agent?.name === 'Invoice Agent', 'the Invoice Agent reads a known invoice into a draft line');
const readUnknown = await read('scan-0001.pdf');
ok(readUnknown.data?.found === false && (await api(lisaT, 'rpc/extract_invoice', { method: 'POST', body: { p_event_id: ev.id, p_file_name: 'x.pdf' } })).status >= 400,
   "an unknown invoice comes back empty, and only editors of the event can have invoices read");
await api(paul, `event_spend?id=eq.${dinnerId}`, { method: 'DELETE' });
ok((await api(paul, `event_spend_attribution?spend_id=eq.${dinnerId}&select=id`)).data?.length === 0, 'deleting an expense removes who received it');
const derm = await api(paul, 'event?name=eq.Derm%20Roundtable&select=id');
const dermTov = await api(paul, `event_tov?event_id=eq.${derm.data?.[0]?.id}&source=eq.contract&select=amount`);
ok(dermTov.data?.length === 2, 'signed speaker fees join the ToV report from their contracts');

// Account Manager: field reps create their own events and add experts to them, but don't edit experts
// and see only their own requests
const daniel = await login('daniel.novak@alera.example');
const danielMe = await api(daniel, 'rpc/me', { method: 'POST', body: {} });
ok(danielMe.data?.profile?.name === 'Account Manager' && danielMe.data.permissions.hcp?.read && !danielMe.data.permissions.hcp?.edit
   && danielMe.data.permissions.event_request?.view_all === false && me.data.permissions.event_request?.view_all === true,
   "me() tells an Account Manager (reads experts, own requests only) from home office (all requests)");
const amHcpEdit = await api(daniel, `hcp?id=eq.${holmHcp.data[0].id}`, { method: 'PATCH', body: { eligibility: 'eligible' } });
ok(Array.isArray(amHcpEdit.data) && amHcpEdit.data.length === 0, "an Account Manager can't edit an expert");
ok((await api(daniel, 'fmv_rate', { method: 'POST', body: { hcp_id: holmHcp.data[0].id, rate: 200, min_rate: 180, max_rate: 220, currency: 'EUR', effective_date: '2041-01-01' } })).status >= 400,
   "an Account Manager can't record FMV rates");
ok((await crmImport(daniel, karin?.crm_connection_id, karin?.external_id)).status >= 400, "an Account Manager can't import experts from a CRM");
ok((await api(daniel, 'rpc/create_contract', { method: 'POST', body: { p: { contract_type: 'msa', hcp_id: holmHcp.data[0].id } } })).status >= 400,
   "an Account Manager can't add a Master Service Agreement");
ok((await api(daniel, 'event_request?select=id')).data?.length === 0, "an Account Manager doesn't see other people's requests");
const amReq = await saveReq(daniel, { title: 'AM smoke request', event_type_id: types.data[0].id });
ok(amReq.status === 200 && (await api(daniel, 'event_request?select=id')).data?.length === 1, 'an Account Manager creates and sees their own requests');
const amEv = await api(daniel, 'rpc/create_event', { method: 'POST', body: { p: { ...base, name: 'AM Smoke Dinner', country_code: 'DK', city: 'Copenhagen' } } });
const amExpert = await api(daniel, 'event_expert', { method: 'POST', body: { event_id: amEv.data?.id, hcp_id: lindHcp.data[0].id, role: 'speaker' } });
ok(amEv.status === 200 && amExpert.status === 201, 'an Account Manager creates an event and adds an expert to it');

// The Library: managed by Admins and Business Admins; event type and country decide who can use an item
const eventId = async (name) => (await api(maria, `event?name=eq.${encodeURIComponent(name)}&select=id`)).data?.[0]?.id;
const smaId = await eventId('SMA Board'), dermId = await eventId('Derm Roundtable');
const libOptions = async (id, who = paul) => (await api(who, 'rpc/event_library_options', { method: 'POST', body: { p_event_id: id } })).data ?? [];
const itemTitles = (list) => list.map((c) => c.title);
const smaOptions = await libOptions(smaId);
ok(itemTitles(smaOptions).includes('Telia: Nordic registry data') && !itemTitles(smaOptions).includes('Dermalux: Überblick für Fachkreise'), 'a Library item limited to countries shows only for those countries');
ok(itemTitles(await libOptions(dermId)).includes('Dermalux: Überblick für Fachkreise'), "a Library item shows for an event of its type in its country");
ok(!itemTitles(await libOptions(dermId)).includes('Dermalux launch deck 2025'), "an inactive Library item isn't offered");
ok(!itemTitles(await libOptions(dermId)).includes('SMA disease overview'), "a Library item isn't offered to event types it isn't linked to");
ok((await libOptions(smaId, sarah)).length === 0 || (await api(sarah, `event?id=eq.${smaId}&select=id`)).data?.length === 1, 'Library options follow access to the event');
const libraryRow = { title: 'Smoke deck', content_kind: 'presentation', is_library: true, file_name: 'smoke.pptx', storage_path: 'demo/smoke.pptx' };
ok((await api(paul, 'content', { method: 'POST', body: libraryRow })).status >= 400, "a coordinator can't add to the Library");
const smokeItem = await api(maria, 'content', { method: 'POST', body: libraryRow });
ok(smokeItem.status === 201, 'a Business Admin adds to the Library');
const smokeItemId = smokeItem.data?.[0]?.id;
const advisory = (await api(maria, 'event_type?name=eq.Advisory%20board&select=id')).data?.[0]?.id ?? (await api(maria, `event?id=eq.${smaId}&select=event_type_id`)).data?.[0]?.event_type_id;
ok((await api(paul, `content?id=eq.${smokeItemId}`, { method: 'PATCH', body: { title: 'Changed' } })).data?.length === 0, "a coordinator can't change a Library item");
ok(!itemTitles(await libOptions(smaId)).includes('Smoke deck'), "a new Library item isn't offered until it's linked to an event type");
ok((await api(paul, 'event_type_content', { method: 'POST', body: { event_type_id: advisory, content_id: smokeItemId } })).status >= 400, "a coordinator can't link Library items to event types");
await api(maria, 'event_type_content', { method: 'POST', body: { event_type_id: advisory, content_id: smokeItemId } });
ok(itemTitles(await libOptions(smaId)).includes('Smoke deck'), 'linking a Library item offers it to events of that type');

// Event content: from the Library it's approved as it is; bespoke goes Draft → Pending → Approved
const fromLibrary = await api(paul, 'event_content', { method: 'POST', body: { event_id: smaId, content_id: smokeItemId, usage: 'presentation', review_status: 'draft' } });
ok(fromLibrary.status === 201 && fromLibrary.data?.[0]?.review_status === 'approved', 'content from the Library is approved as it is');
ok((await api(paul, 'event_content', { method: 'POST', body: { event_id: dermId, content_id: smokeItemId, usage: 'presentation' } })).status >= 400, "a Library item can't go on an event it isn't available for");
ok((await api(sarah, 'event_content', { method: 'POST', body: { event_id: smaId, content_id: (await api(maria, `content?title=eq.Telia:%20Nordic%20registry%20data&select=id`)).data?.[0]?.id, usage: 'presentation' } })).status >= 400, "someone without edit access can't add content");
const setContent = (who, id, status) => api(who, 'rpc/set_event_content_status', { method: 'POST', body: { p_id: id, p_status: status } });
ok((await setContent(paul, fromLibrary.data?.[0]?.id, 'draft')).status >= 400, "a Library item's status doesn't change");
ok((await api(maria, `content?id=eq.${smokeItemId}`, { method: 'DELETE' })).status >= 400, "a Library item used on an event can't be deleted");
const contentPath = `${smaId}/${crypto.randomUUID()}/smoke.pdf`;
ok((await storage(sarah, `content/${contentPath}`, { method: 'POST', body: pdf, type: 'application/pdf' })).status >= 400, "someone without edit access can't upload to the event");
ok((await storage(paul, `content/${contentPath}`, { method: 'POST', body: pdf, type: 'application/pdf' })).ok, 'an editor uploads a file to the event');
ok((await storage(paul, `content/library/${me.data.tenant.id}/x/smoke.pdf`, { method: 'POST', body: pdf, type: 'application/pdf' })).status >= 400, "a coordinator can't upload to the Library");
const libraryPath = `library/${me.data.tenant.id}/${crypto.randomUUID()}/smoke.pdf`;
ok((await storage(maria, `content/${libraryPath}`, { method: 'POST', body: pdf, type: 'application/pdf' })).ok, 'a Business Admin uploads to the Library');
ok((await storage(daniel, `content/${libraryPath}`)).ok, 'everyone can read a Library file');
const addFile = (who, usage, path, extra = {}) => api(who, 'rpc/add_event_file', { method: 'POST', body: { p_event_id: smaId, p_usage: usage, p_title: 'Smoke file', p_description: 'Dr Someone', p_category: null, p_file_name: 'smoke.pdf', p_mime_type: 'application/pdf', p_size_bytes: pdf.length, p_storage_path: path, ...extra } });
ok((await addFile(paul, 'presentation', `${dermId}/x/smoke.pdf`)).status >= 400, "a file has to be in the event's folder");
ok((await addFile(sarah, 'presentation', contentPath)).status >= 400, "someone without edit access can't add a file");
const bespokeId = (await addFile(paul, 'presentation', contentPath)).data;
const bespoke = async () => (await api(paul, `event_content?id=eq.${bespokeId}&select=*,content(id,title,is_library)`)).data?.[0];
ok((await bespoke())?.review_status === 'draft' && (await bespoke())?.description === 'Dr Someone', 'bespoke content starts as a draft');
ok((await api(paul, `event_content?id=eq.${bespokeId}`, { method: 'PATCH', body: { review_status: 'approved' } })).status >= 400, "the status can't be set directly");
ok((await setContent(paul, bespokeId, 'approved')).status >= 400, "a draft can't jump to approved");
ok((await setContent(sarah, bespokeId, 'pending')).status >= 400, "someone without edit access can't submit content");
const contentSubmitted = await setContent(paul, bespokeId, 'pending');
ok(contentSubmitted.data?.review_status === 'pending' && /^VV-/.test(contentSubmitted.data?.dms_reference ?? '') && contentSubmitted.data?.submitted_by === me.data.id, 'submitting makes it pending, with a document-system reference');
ok((await setContent(paul, bespokeId, 'draft')).data?.dms_reference === null, 'pending content can go back to draft');
await setContent(paul, bespokeId, 'pending');
ok((await setContent(paul, bespokeId, 'approved')).data?.decided_by === me.data.id, 'pending content can be approved');
ok((await setContent(paul, bespokeId, 'draft')).status >= 400, "approved content doesn't go back");
const docPath = `${smaId}/${crypto.randomUUID()}/note.pdf`;
await storage(paul, `content/${docPath}`, { method: 'POST', body: pdf, type: 'application/pdf' });
const docId = (await addFile(paul, 'document', docPath, { p_category: 'finance' })).data;
const doc = (await api(paul, `event_content?id=eq.${docId}&select=review_status,category,content_id`)).data?.[0];
ok(doc?.review_status === null && doc?.category === 'finance', "documents have a category and no approval");
ok((await setContent(paul, docId, 'pending')).status >= 400, "documents don't go through approval");
const bespokeContent = (await bespoke())?.content?.id;
for (const id of [bespokeId, docId]) await api(paul, `event_content?id=eq.${id}`, { method: 'DELETE' });
ok((await api(paul, `content?id=eq.${bespokeContent}&select=id`)).data?.length === 0, 'removing bespoke content deletes its record');
await api(paul, `event_content?id=eq.${fromLibrary.data?.[0]?.id}`, { method: 'DELETE' });
ok((await api(paul, `content?id=eq.${smokeItemId}&select=id`)).data?.length === 1, 'removing a Library item from an event leaves it in the Library');
await storage(paul, `content/${contentPath}`, { method: 'DELETE' });
await storage(paul, `content/${docPath}`, { method: 'DELETE' });
await storage(maria, `content/${libraryPath}`, { method: 'DELETE' });
await api(maria, `content?id=eq.${smokeItemId}`, { method: 'DELETE' });

// Agenda templates: Library items of kind template, offered by event type and country, never event content
const agendaTemplates = async (id, who = paul) => (await api(who, 'rpc/event_agenda_templates', { method: 'POST', body: { p_event_id: id } })).data ?? [];
const smaTemplates = await agendaTemplates(smaId);
ok(itemTitles(smaTemplates).includes('Advisory board invitation (Nordics)') && !itemTitles(smaTemplates).includes('Meeting invitation (UK)'), 'agenda templates are offered by event type and country');
ok(smaTemplates.every((t) => t.content_kind === 'template' && t.template_fields?.Date?.source === 'event.date'), 'an agenda template comes with what fills its fields');
ok(!(await libOptions(smaId)).some((c) => c.content_kind === 'template'), "agenda templates aren't offered as content");
const nordicTemplateId = smaTemplates[0]?.id;
ok((await api(paul, 'event_content', { method: 'POST', body: { event_id: smaId, content_id: nordicTemplateId, usage: 'presentation' } })).status >= 400, "an agenda template can't be added as event content");
ok((await api(paul, `content?id=eq.${nordicTemplateId}`, { method: 'PATCH', body: { template_fields: {} } })).data?.length === 0, "a coordinator can't change a template's fields");
const tmplRow = { title: 'Smoke template', content_kind: 'template', is_library: true, file_name: 'smoke.pdf', storage_path: 'demo/smoke.pdf' };
ok((await api(maria, 'content', { method: 'POST', body: { ...tmplRow, template_fields: { Date: { source: 'event.when' } } } })).status >= 400, 'a template field needs a known source');
ok((await api(maria, 'content', { method: 'POST', body: { ...tmplRow, template_fields: { 'Time 1': { source: 'session.time' } } } })).status >= 400, 'a session field needs its agenda row');
ok((await api(maria, 'content', { method: 'POST', body: { ...tmplRow, template_fields: { Phone: { source: 'ask' } } } })).status >= 400, 'an asked field needs a question');
ok((await api(maria, 'content', { method: 'POST', body: { ...tmplRow, is_library: false } })).status >= 400, 'agenda templates live in the Library');
ok((await api(maria, 'content', { method: 'POST', body: { ...libraryRow, template_fields: { Date: { source: 'event.date' } } } })).status >= 400, 'only templates have field mappings');
const smokeTemplate = await api(maria, 'content', { method: 'POST', body: { ...tmplRow, template_fields: { Date: { source: 'event.date' }, 'Time 1': { source: 'session.time', row: 1 }, Phone: { source: 'ask', label: 'Contact number' } } } });
ok(smokeTemplate.status === 201, 'a Business Admin adds an agenda template with its fields mapped');
await api(maria, `content?id=eq.${smokeTemplate.data?.[0]?.id}`, { method: 'DELETE' });

// Groups are plain sets of people; access rules put them on teams by country and event type, and
// their members get the rule's access for as long as they're in the group
const groupName = `Smoke group ${Date.now()}`;
ok((await api(paul, 'user_group', { method: 'POST', body: { name: groupName } })).status >= 400, "a coordinator can't create groups");
const grp = await api(maria, 'user_group', { method: 'POST', body: { name: groupName } });
const grpId = grp.data?.[0]?.id;
const agentMe = await api(agent, 'rpc/me', { method: 'POST', body: {} });
ok(grp.status === 201 && (await api(maria, 'user_group_member', { method: 'POST', body: { group_id: grpId, user_id: lisaMe.data.id } })).status === 201,
   'a Business Admin creates a group with members');
ok((await api(maria, 'user_group_member', { method: 'POST', body: { group_id: grpId, user_id: agentMe.data.id } })).status >= 400, 'agents are not group members');
const addRule = (who, body) => api(who, 'access_rule', { method: 'POST', body: { group_id: grpId, ...body } });
ok((await addRule(paul, { country_codes: ['NL'] })).status >= 400, "a coordinator can't create access rules");
ok((await addRule(maria, { team_role: 'approver' })).status >= 400 && (await addRule(maria, { team_role: 'owner' })).status >= 400,
   'a rule gives Organizer or Viewer access, nothing else');
ok((await addRule(maria, { country_codes: [] })).status >= 400 && (await addRule(maria, { country_codes: ['XX'] })).status >= 400,
   'a rule names real countries, or none for every country');
const rule = (await addRule(maria, { applies_to: 'all', country_codes: ['NL'], event_type_ids: [types.data[0].id], team_role: 'viewer' })).data?.[0];
ok(rule?.id, 'a Business Admin adds an access rule for a group: these countries, these event types');
const grpEv = (await capture({ ...base, name: 'Smoke group event', country_code: 'NL', city: 'Amsterdam' })).data;
const grpRow = async (evId = grpEv?.id) => (await api(paul, `event_team_group?event_id=eq.${evId}&group_id=eq.${grpId}&select=id,team_role,is_auto`)).data?.[0];
const lisaSeesG = async () => (await api(lisaT, `event?id=eq.${grpEv?.id}&select=id`)).data?.length === 1;
const lisaEditsG = async () => (await api(lisaT, 'rpc/update_event', { method: 'POST', body: { p_event_id: grpEv?.id, p: { city: 'Utrecht' } } })).status === 200;
const autoRow = await grpRow();
ok(autoRow?.is_auto === true && autoRow.team_role === 'viewer', "a new event that matches a rule gets the rule's group on its team, with the rule's access");
const lisaAccess = (await api(lisaT, 'rpc/my_event_access', { method: 'POST', body: { p_event_id: grpEv?.id } })).data;
ok(await lisaSeesG() && !(await lisaEditsG()) && lisaAccess?.access === 'view' && lisaAccess.via_group === groupName,
   'a group member sees the event with the group\'s access, and knows which group gave it');
ok((await api(paul, `event_team_group?id=eq.${autoRow?.id}`, { method: 'PATCH', body: { team_role: 'organizer' } })).data?.length !== 1
   && (await api(paul, `event_team_group?id=eq.${autoRow?.id}`, { method: 'DELETE' })).status >= 400 && await grpRow(),
   "the event's editors can't change or remove a group a rule added");
await api(maria, `access_rule?id=eq.${rule?.id}`, { method: 'PATCH', body: { team_role: 'organizer' } });
ok((await grpRow())?.team_role === 'organizer' && await lisaEditsG(), "changing the rule's access changes it on open events, and members edit");
const second = (await addRule(maria, { applies_to: 'events', team_role: 'viewer' })).data?.[0];
ok((await grpRow())?.team_role === 'organizer', 'when several rules match, the group gets the strongest access');
await api(maria, `access_rule?id=eq.${second?.id}`, { method: 'DELETE' });
const grpPost = await api(paul, 'event_post', { method: 'POST', body: { event_id: grpEv?.id, body: '@Lisa Anderson smoke: via your group', mentions: [lisaMe.data.id] } });
ok(grpPost.status === 201, 'people on the team through a group can be mentioned');
await api(maria, `user_group?id=eq.${grpId}`, { method: 'PATCH', body: { is_active: false } });
ok(!(await lisaSeesG()) && !(await grpRow()), "an inactive group gives nobody access, and rules don't apply to it");
await api(maria, `user_group?id=eq.${grpId}`, { method: 'PATCH', body: { is_active: true } });
ok(await grpRow() && await lisaSeesG(), 'reactivated, the group is back on the team of open events its rules match');
await api(maria, `user_group_member?group_id=eq.${grpId}&user_id=eq.${lisaMe.data.id}`, { method: 'DELETE' });
ok(!(await lisaSeesG()), 'leaving the group ends the access it gave');
await api(maria, 'user_group_member', { method: 'POST', body: { group_id: grpId, user_id: lisaMe.data.id } });
const seminar = (await api(paul, 'event_type?name=eq.Seminar&select=id')).data?.[0]?.id;
await api(paul, 'rpc/update_event', { method: 'POST', body: { p_event_id: grpEv?.id, p: { event_type_id: seminar } } });
ok(!(await grpRow()), "an event changed to an event type the rule doesn't cover loses the group");
await api(paul, 'rpc/update_event', { method: 'POST', body: { p_event_id: grpEv?.id, p: { event_type_id: types.data[0].id, country_code: 'DE', city: 'Berlin' } } });
ok(!(await grpRow()) && !(await lisaSeesG()), "an event moved out of the rule's countries loses the group");
await api(maria, `access_rule?id=eq.${rule?.id}`, { method: 'PATCH', body: { country_codes: ['NL', 'DE'] } });
ok((await grpRow())?.is_auto === true, "a country added to the rule brings the group onto that country's open events");
const uki = (await api(paul, 'user_group?name=eq.UKI%20Medical&select=id')).data?.[0];
const ukiRow = await api(paul, 'event_team_group', { method: 'POST', body: { event_id: grpEv?.id, group_id: uki?.id, team_role: 'viewer' } });
ok(ukiRow.status === 201 && ukiRow.data?.[0]?.is_auto === false, "an event's editors add another group by hand");
ok((await api(paul, 'event_team_group', { method: 'POST', body: { event_id: grpEv?.id, group_id: grpId, team_role: 'viewer', is_auto: true } })).status >= 400,
   'only rules add groups as automatic');
ok((await api(paul, `event_team_group?id=eq.${ukiRow.data?.[0]?.id}`, { method: 'PATCH', body: { team_role: 'organizer' } })).data?.[0]?.team_role === 'organizer'
   && (await api(paul, `event_team_group?id=eq.${ukiRow.data?.[0]?.id}`, { method: 'PATCH', body: { team_role: 'owner' } })).status >= 400,
   "editors change the access of a group they added, to Organizer or Viewer");
ok((await api(sarah, 'event_team_group', { method: 'POST', body: { event_id: smaId, group_id: uki?.id } })).status >= 400, "people who can't edit the event can't add groups");
// Requests: rules apply once the request is submitted, by the request's country and event type
const grpReq = await saveReq(sarah, { title: 'Smoke group request', event_type_id: types.data[0].id, event_date: '2027-05-04', duration: 'full_day',
                                      country_code: 'DE', rationale: 'Smoke test' });
const reqGroups = async () => (await api(sarah, `request_team_group?request_id=eq.${grpReq.data?.id}&select=group_id,is_auto`)).data ?? [];
ok(grpReq.data?.country_code === 'DE' && (await reqGroups()).length === 0, 'a draft request has no groups: drafts stay private');
await api(sarah, `event_request?id=eq.${grpReq.data?.id}`, { method: 'PATCH', body: { status: 'review' } });
ok((await reqGroups()).some((g) => g.group_id === grpId && g.is_auto), "submitting a request brings in the groups its rules give");
ok((await api(lisaT, `rpc/my_request_access`, { method: 'POST', body: { p_request_id: grpReq.data?.id } })).data?.via_group === groupName,
   'a group member sees the submitted request through their group');
await api(maria, `access_rule?id=eq.${rule?.id}`, { method: 'PATCH', body: { applies_to: 'events' } });
ok(!(await reqGroups()).some((g) => g.group_id === grpId) && await grpRow(), 'a rule for events only leaves requests alone');
const holmExpert = (await api(paul, `event_expert?id=eq.${holm.data[0].id}&select=hcp(id,country_code)`)).data?.[0]?.hcp;
const tierCountry = (await saveReq(sarah, { request_type: 'tiering', hcp_id: holmExpert?.id, rationale: "Smoke" })).data;
ok(tierCountry?.country_code && tierCountry.country_code === holmExpert?.country_code,
   "a tiering request is in the expert's country");

// Managers: set by people who manage users; never yourself or someone who reports to you
const sarahManager = (await api(maria, `app_user?id=eq.${sarahMe.data.id}&select=manager_id`)).data?.[0]?.manager_id ?? null;
const setManager = (who, userId, managerId) => api(who, `app_user?id=eq.${userId}`, { method: 'PATCH', body: { manager_id: managerId } });
ok((await setManager(maria, sarahMe.data.id, me.data.id)).data?.[0]?.manager_id === me.data.id, "a Business Admin sets someone's manager");
ok((await setManager(sarah, sarahMe.data.id, lisaMe.data.id)).status >= 400, "people can't choose their own manager");
ok((await setManager(maria, me.data.id, me.data.id)).status >= 400, "someone can't be their own manager");
ok((await setManager(maria, me.data.id, sarahMe.data.id)).status >= 400, "someone can't manage their own manager");
ok((await setManager(maria, sarahMe.data.id, agentMe.data.id)).status >= 400, 'an agent is never a manager');
await setManager(maria, sarahMe.data.id, sarahManager);

// Tenant settings: System Admins switch the profile badge; me() reports it
const badgeOf = async (who) => (await api(who, 'rpc/me', { method: 'POST', body: {} })).data?.tenant;
const tenantNow = await badgeOf(paul);
const setBadge = (who, v) => api(who, `tenant?id=eq.${tenantNow?.id}`, { method: 'PATCH', body: { show_profile_badge: v } });
ok(typeof tenantNow?.show_profile_badge === 'boolean', "me() says whether to show people's profile");
ok((await setBadge(maria, !tenantNow?.show_profile_badge)).data?.length === 0 && (await setBadge(paul, !tenantNow?.show_profile_badge)).data?.length === 0,
   "only System Admins change the organisation's settings");
ok((await setBadge(alex, !tenantNow?.show_profile_badge)).data?.[0]?.show_profile_badge === !tenantNow?.show_profile_badge
   && (await badgeOf(paul))?.show_profile_badge === !tenantNow?.show_profile_badge, 'a System Admin switches the profile badge for everyone');
await setBadge(alex, tenantNow?.show_profile_badge);
ok((await api(alex, `tenant?id=eq.${tenantNow?.id}`, { method: 'PATCH', body: { name: 'Renamed' } })).status >= 400, "the organisation's name isn't a setting");

// Cleanup
await api(paul, `event?id=eq.${grpEv?.id}`, { method: 'DELETE' });
await api(alex, `event_request?id=in.(${grpReq.data?.id},${tierCountry?.id})`, { method: 'DELETE' });
await api(lisaT, `notification?record_id=eq.${grpEv?.id}`, { method: 'DELETE' });
await api(maria, `user_group?id=eq.${grpId}`, { method: 'DELETE' });
await api(alex, `email_message?record_id=in.(${grpEv?.id},${grpReq.data?.id})`, { method: 'DELETE' });
await api(daniel, `event_request?id=eq.${amReq.data?.id}`, { method: 'DELETE' });
await api(alex, `event?id=eq.${amEv.data?.id}`, { method: 'DELETE' });
await api(alex, `event_request?id=eq.${tier.data?.id}`, { method: 'DELETE' });
await api(alex, `custom_field?id=in.(${linkF.data?.[0]?.id},${scoreF.data?.[0]?.id})`, { method: 'DELETE' });
await api(maria, `product?id=eq.${mProd.data?.[0]?.id}`, { method: 'DELETE' });
await api(maria, `app_user?id=eq.${lisa.data[0].id}`, { method: 'PATCH', body: { job_title: lisa.data[0].job_title } });
await storage(alex, `contracts/${filePath}`, { method: 'DELETE' });
await api(paul, `event?id=eq.${ev.id}`, { method: 'DELETE' });
await api(alex, `event_request?id=eq.${reqId}`, { method: 'DELETE' });
await api(sarah, `notification?record_id=eq.${reqId}`, { method: 'DELETE' });
await api(lisaT, `notification?record_id=eq.${tier.data?.id}`, { method: 'DELETE' });
await api(paul, `notification?record_id=eq.${tier.data?.id}`, { method: 'DELETE' });
await api(alex, `email_message?record_id=in.(${ev.id},${reqId},${tier.data?.id})`, { method: 'DELETE' });
await api(paul, `hcp?id=eq.${imported.data?.id}`, { method: 'DELETE' });
await api(paul, `hco?id=eq.${karinHcp.data?.[0]?.primary_hco?.id}`, { method: 'DELETE' });
await api(alex, `content?id=eq.${sent.data?.document_content_id}`, { method: 'DELETE' });
await api(paul, `event_expert?id=eq.${holm.data[0].id}`, { method: 'PATCH', body: { check_status: 'pending', check_notes: null } });

await api(alex, `custom_field?id=in.(${dietF?.id},${hcpF?.id},${reqF?.id})`, { method: 'DELETE' });
await api(alex, `tenant?id=eq.${tenantId}`, { method: 'PATCH', body: { demo_inbox: savedInbox } });

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
