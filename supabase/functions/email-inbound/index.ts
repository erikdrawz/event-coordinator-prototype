// Replies to Event Center emails, from Resend's email.received webhook.
// Checks the webhook's signature (Svix: RESEND_WEBHOOK_SECRET), fetches the email's content from
// Resend (the webhook carries metadata only) and hands it to receive_email() as the Email Agent,
// which posts it or decides the request as the person who replied, or logs why it couldn't.
import { emailAgent, json, resend } from '../_shared/email.ts';

const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

/** Svix signature: HMAC-SHA256 of "<id>.<timestamp>.<body>" with the secret after "whsec_", base64. */
async function verified(headers: Headers, body: string) {
  const id = headers.get('svix-id'), ts = headers.get('svix-timestamp'), sigs = headers.get('svix-signature');
  if (!id || !ts || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 5 * 60) return false;   // replayed or clock off
  const secret = Uint8Array.from(atob(Deno.env.get('RESEND_WEBHOOK_SECRET')!.replace(/^whsec_/, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = b64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  return sigs.split(' ').some((s) => s.split(',')[1] === expected);
}

/** Plain text from an HTML-only email: line breaks kept, quoted blocks marked with ">". */
function htmlToText(html: string) {
  return html
    .replace(/<blockquote[^>]*>/gi, '\n> ').replace(/<\/blockquote>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!Deno.env.get('RESEND_WEBHOOK_SECRET')) return json({ error: "RESEND_WEBHOOK_SECRET isn't set" }, 503);
  const raw = await req.text();
  if (!(await verified(req.headers, raw))) return json({ error: 'Signature check failed' }, 401);

  const event = JSON.parse(raw);
  if (event.type !== 'email.received') return json({ ignored: event.type });

  const res = await fetch(`${resend.api()}/emails/receiving/${event.data.email_id}`, {
    headers: { Authorization: `Bearer ${resend.key()}` },
  });
  if (!res.ok) return json({ error: `Resend: couldn't fetch the email (${res.status})` }, 502);   // Resend retries
  const m = await res.json();

  // SPF / DKIM results as plain words; passed on only when Resend gave both
  const word = (v: unknown) => (typeof v === 'string' ? v : (v as { result?: string; status?: string } | null)?.result ?? (v as { status?: string } | null)?.status);
  const spf = word(m.authentication?.spf), dkim = word(m.authentication?.dkim);
  const authentication = spf && dkim ? { spf, dkim } : null;

  const addresses: string[] = [...(m.to ?? []), ...(m.received_for ?? [])];
  const to = addresses.find((a) => /reply[+-][a-z0-9]+@/i.test(a)) ?? addresses[0] ?? '';
  const sb = await emailAgent();
  const { data, error } = await sb.rpc('receive_email', {
    p: {
      id: m.id ?? event.data.email_id,
      from: m.headers?.from ?? m.from,
      to,
      subject: m.subject,
      text: m.text ?? (m.html ? htmlToText(m.html) : ''),
      ...(authentication ? { authentication } : {}),
    },
  });
  if (error) return json({ error: error.message }, 500);
  return json({ status: data.status, note: data.status_note });
});
