// Shared by the email functions: the Email Agent's session and Resend settings.
// The functions act as the Email Agent, an agent user bound by the same rules as any client
// (no service-role key): it can only claim emails to send, record what happened and hand in replies.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4';

const env = (k: string, fallback?: string) => {
  const v = Deno.env.get(k) ?? fallback;
  if (!v) throw new Error(`${k} isn't set`);
  return v;
};

export const resend = {
  api: () => env('RESEND_API_URL', 'https://api.resend.com').replace(/\/$/, ''),
  key: () => env('RESEND_API_KEY'),
  from: () => env('EMAIL_FROM', 'Event Center <onboarding@resend.dev>'),
  replyDomain: () => env('EMAIL_REPLY_DOMAIN'),
};

/** Signed in as the Email Agent. */
export async function emailAgent(): Promise<SupabaseClient> {
  const sb = createClient(env('SUPABASE_URL'), env('EC_ANON_KEY', Deno.env.get('SUPABASE_ANON_KEY')), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await sb.auth.signInWithPassword({
    email: env('EMAIL_AGENT_EMAIL', 'email-agent@agents.alera.example'),
    password: env('EMAIL_AGENT_PASSWORD'),
  });
  if (error) throw new Error(`Email Agent sign-in failed: ${error.message}`);
  return sb;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
