# Email: setup and how it works

Event Center emails people when they're mentioned on a discussion board or asked to approve a request.
They can reply by email. A reply to a mention is posted in the thread as them, and a reply of Approve or Reject decides the request.
This prototype uses [Resend](https://resend.com) for both directions, on Resend's own addresses (no domain to verify).

## How it works

```
post with @mention ─► email_message (outbound, queued) ─► pg_net ─► email-send ─► Resend ─► inbox
                                                                                          │ reply
Discussion ◄─ receive_email() (as the person, via the Email Agent) ◄─ email-inbound ◄─ Resend webhook (email.received)
```

**Sending**
- The database queues the email. Its trigger wakes the `email-send` edge function through pg_net, using `app.setting('email_send_url')`, which the deploy workflows set on hosted.
- The function signs in as the **Email Agent** and claims what's queued with `claim_outbound_emails()`.
- It sends each email through Resend with a Reply-To of `reply+<token>@<EMAIL_REPLY_DOMAIN>`, then records the result with `email_sent()`.

**Replies**
- Resend calls `email-inbound` with `email.received`. The function checks the Svix signature, fetches the email from Resend and calls `receive_email()`.
- `receive_email()` matches the token, checks the sender, keeps only the new text and acts as the person.
- Resend may retry a webhook. Each reply is taken once, by Resend's email id.

**Demo inbox**
- Demo users have made-up addresses, so Admin → Settings → Demo inbox sends every email to one real address.
- The subject says who each email is for, e.g. `[For Michael Chen] Paul Taylor mentioned you on SMA Board`.
- A reply from that address counts as that person's, so you can play every user from one mailbox.
- Leave it empty to email people at their own addresses.

**Links**
- The last line, e.g. "Open the SMA Board discussion: <link>", becomes a button with that label in the HTML version; plain-text clients show the address. Links go to `app.setting('app_url')` (default `http://localhost:5173`) and scroll to the post.
- If you're signed out, you sign in first and land on the post.

**Without the functions** (the local stack by default), `email_send_url` is unset and new emails stay **Queued**. Everything else works.

Admin → Emails shows every email, where it was delivered, and what each reply did.

## One-time setup (hosted)

1. **Resend account** (free plan is enough). Sign up with the address you want demo emails to arrive at. Without a verified domain, Resend only delivers to that address.
2. **API key**: Resend → API Keys → Create, with *Full access* (sending and reading received emails).
3. **Receiving address**: Resend → Emails → Receiving → ⋯ → *Receiving address*. You get something like `abc123.resend.app`. That domain is `EMAIL_REPLY_DOMAIN`.
4. **Webhook**:
   1. Resend → Webhooks → Add endpoint.
   2. URL: `https://jwydbztvfqmosjtkwkmx.supabase.co/functions/v1/email-inbound`
   3. Event: `email.received`.
   4. Copy the signing secret (`whsec_…`).
5. **Secrets**: Supabase dashboard → Edge Functions → Secrets.

   | Name | Value |
   |---|---|
   | `RESEND_API_KEY` | the key from step 2 |
   | `RESEND_WEBHOOK_SECRET` | the `whsec_…` secret from step 4 |
   | `EMAIL_REPLY_DOMAIN` | the domain from step 3, e.g. `abc123.resend.app` |
   | `EMAIL_AGENT_PASSWORD` | the demo password (CLAUDE.md) |
   | `EC_ANON_KEY` | the publishable key in `apps/web/.env.production` |
   | `EMAIL_FROM` | optional; default `Event Center <onboarding@resend.dev>` |

6. **Deploy**: pushing to `main` runs *Functions — deploy*, which deploys both functions and points the database at `email-send`. You can also run it by hand from GitHub Actions.
7. **Demo inbox**:
   1. Run the app against hosted data with `npm run dev:hosted`.
   2. Sign in as Alex Morgan.
   3. Admin → Settings → Demo inbox: your Resend account's address.
   4. A database reset clears it, so set it again after one.

## Try it

1. Sign in as Paul and open SMA Board → Collaboration.
2. Post `@Michael Chen can you confirm the venue holds 40?`.
3. Within seconds, `[For Michael Chen] Paul Taylor mentioned you on SMA Board` arrives in the demo inbox.
4. Reply above the line. A few seconds later, the reply appears in the thread as Michael, marked *via email*.
5. The email's link opens the post.
6. Approval emails work the same way: reply `Approve` or `Reject: <reason>`.

If something doesn't arrive, Admin → Emails shows each email's status and the reason for any failure. The function logs are in the Supabase dashboard → Edge Functions.

## Testing locally

`supabase functions serve --env-file <file>` runs both functions. To wake `email-send` from the local database, set the URL:

```sql
update app.setting set value = 'http://supabase_kong_event-coordinator-prototype:8000/functions/v1/email-send'
 where key = 'email_send_url';
```

Resend can't reach your machine, so test replies locally by signing a webhook yourself. `RESEND_API_URL` points the functions at a stand-in for Resend's API.
