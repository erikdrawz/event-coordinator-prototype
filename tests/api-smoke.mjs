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

// Event capture as coordinator: owner + team are set automatically
const types = await api(paul, 'event_type?name=eq.Advisory%20board&select=id');
const created = await api(paul, 'event', { method: 'POST', body: { name: 'Smoke Test Board', event_type_id: types.data[0].id, timezone: 'Europe/Paris', country_code: 'FR', city: 'Paris' } });
const ev = created.data?.[0];
ok(created.status === 201 && ev?.owner_id === me.data.id && ev?.status === 'draft', 'coordinator creates an event; owner defaults to creator');
const team = await api(paul, `event_team_member?event_id=eq.${ev.id}&select=team_role`);
ok(team.data?.[0]?.team_role === 'owner', 'creator joins the team as owner');

// Collaborator: can post, cannot create events
const sarahEvent = await api(sarah, 'event', { method: 'POST', body: { name: 'Not allowed', event_type_id: types.data[0].id } });
ok(sarahEvent.status >= 400, 'collaborator cannot create events');
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
