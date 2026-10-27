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
ok(total === 1456, `SMA Board honoraria total €1,456 (got ${total})`);

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
ok(defs.data?.length === 5, `collaborator can read custom field definitions (got ${defs.data?.length})`);
const newDef = await api(paul, 'custom_field', { method: 'POST', body: { object_name: 'event', api_name: 'sneaky__c', label: 'Sneaky', field_type: 'text' } });
ok(newDef.status >= 400, 'only admins can define custom fields');

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

// Cleanup
await api(paul, `event?id=eq.${ev.id}`, { method: 'DELETE' });
await api(paul, `event_expert?id=eq.${holm.data[0].id}`, { method: 'PATCH', body: { check_status: 'pending', check_notes: null } });

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
