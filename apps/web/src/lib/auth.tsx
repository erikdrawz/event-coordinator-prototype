import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from './supabase';
import type { Me } from './types';

/**
 * The single place the UI touches the identity provider.
 * Swapping Supabase Auth for Cognito or customer SSO means changing this file
 * (and app.current_user_id() in the database), nothing else.
 */
interface AuthState {
  session: Session | null;
  me: Me | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const qc = useQueryClient();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      qc.invalidateQueries();
    });
    return () => sub.subscription.unsubscribe();
  }, [qc]);

  const meQuery = useQuery({
    queryKey: ['me', session?.user.id],
    enabled: Boolean(session),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('me');
      if (error) throw error;
      return data as Me | null;
    },
  });

  // Apply the tenant's brand colour
  const brand = meQuery.data?.tenant.brand_color;
  useEffect(() => {
    if (brand) document.documentElement.style.setProperty('--color-brand', brand);
  }, [brand]);

  const value = useMemo<AuthState>(() => ({
    session,
    me: meQuery.data ?? null,
    loading: sessionLoading || (Boolean(session) && meQuery.isLoading),
    async signIn(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return error.message === 'Invalid login credentials' ? 'Email or password is incorrect.' : error.message;
      await supabase.rpc('touch_last_login');
      return null;
    },
    async signOut() {
      await supabase.auth.signOut();
      qc.clear();
    },
  }), [session, sessionLoading, meQuery.data, meQuery.isLoading, qc]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
