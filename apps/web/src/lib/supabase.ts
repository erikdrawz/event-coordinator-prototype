import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** True when the app has the two public values it needs to reach the API. */
export const isConfigured = Boolean(url && anonKey);

/**
 * The one client for the EC API. It only ever carries the public anon key plus the
 * signed-in user's token, so it can do exactly what row-level security allows: the
 * same as any customer-built UI or agent.
 */
export const supabase = createClient(url ?? 'http://localhost:54321', anonKey ?? 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true },
});

export const isDemoMode = import.meta.env.VITE_DEMO_MODE === 'true';
