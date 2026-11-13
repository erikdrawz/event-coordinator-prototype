// Sends queued Event Center emails through Resend.
// Woken by the database when an email is queued (pg_net, app.setting 'email_send_url'); calling it
// when nothing is queued does nothing, so it needs no key. Sends one at a time to stay within
// Resend's default rate limit, and records each result with email_sent().
import { emailAgent, json, resend } from '../_shared/email.ts';

/** reply_token is null when the email can't be answered (replies off, or an outcome email) */
interface Outgoing { id: string; to: string; subject: string; text: string; reply_token: string | null }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const linkify = (s: string) => esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:#1d6fd6">${u}</a>`);

/**
 * The same email as simple HTML: the reply line in grey, quoted lines as a quote, links clickable,
 * and a line "Open <what>: <link>" as a button saying "Open <what>".
 */
function toHtml(text: string) {
  const lines = text.split('\n').map((line) => {
    if (/reply above this line/i.test(line)) return `<div style="color:#8a94a3;font-size:12px">${esc(line)}</div>`;
    const open = /^(Open .+): (https?:\/\/\S+)$/.exec(line);
    if (open) {
      return `<div style="margin-top:8px"><a href="${esc(open[2])}" style="display:inline-block;padding:9px 16px;border-radius:8px;`
        + `background:#1d6fd6;color:#ffffff;text-decoration:none;font-weight:600">${esc(open[1])}</a></div>`;
    }
    if (/^>/.test(line)) return `<div style="border-left:3px solid #dfe4eb;padding-left:10px;color:#3a4250">${linkify(line.replace(/^>\s?/, '')) || '&nbsp;'}</div>`;
    return `<div>${linkify(line) || '&nbsp;'}</div>`;
  });
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1b2230">${lines.join('')}</div>`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async () => {
  try {
    resend.key(); resend.replyDomain();   // not set up: leave everything queued
  } catch (e) {
    return json({ error: (e as Error).message }, 503);
  }
  const sb = await emailAgent();
  let sent = 0, failed = 0;
  for (let round = 0; round < 5; round++) {
    const { data, error } = await sb.rpc('claim_outbound_emails', { p_limit: 10 });
    if (error) return json({ error: error.message, sent, failed }, 500);
    const batch = (data ?? []) as Outgoing[];
    if (!batch.length) break;
    for (const e of batch) {
      const replyTo = e.reply_token ? `reply+${e.reply_token}@${resend.replyDomain()}` : null;
      let result: Record<string, unknown>;
      try {
        const res = await fetch(`${resend.api()}/emails`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${resend.key()}`, 'Content-Type': 'application/json', 'Idempotency-Key': e.id },
          body: JSON.stringify({ from: resend.from(), to: [e.to], subject: e.subject, text: e.text, html: toHtml(e.text), ...(replyTo ? { reply_to: replyTo } : {}) }),
        });
        const body = await res.json().catch(() => ({}));
        result = res.ok
          ? { id: e.id, ok: true, provider_id: body.id, from: resend.from(), reply_to: replyTo, to: e.to }
          : { id: e.id, ok: false, error: `Resend: ${body.message ?? res.statusText} (${res.status})` };
      } catch (err) {
        result = { id: e.id, ok: false, error: `Couldn't reach Resend: ${(err as Error).message}` };
      }
      const { error: recErr } = await sb.rpc('email_sent', { p: result });
      if (recErr) console.error('email_sent', e.id, recErr.message);
      if (result.ok) sent++; else failed++;
      await sleep(550);
    }
  }
  return json({ sent, failed });
});
