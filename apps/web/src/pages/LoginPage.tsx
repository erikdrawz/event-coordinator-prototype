import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { isDemoMode, supabase } from '../lib/supabase';
import { Avatar } from '../components/Avatar';
import './login.css';

const TENANT_SLUG = (import.meta.env.VITE_TENANT_SLUG as string | undefined) ?? 'alera';
const DEMO_PASSWORD = 'EC-demo-2026!';
const DEMO_ACCOUNTS = [
  { email: 'paul.taylor@alera.example', name: 'Paul Taylor', role: 'Event Coordinator · HQ Events', initials: 'PT', color: '#2d3b45' },
  { email: 'lisa.anderson@alera.example', name: 'Lisa Anderson', role: 'Event Coordinator · Logistics', initials: 'LA', color: '#e8731a' },
  { email: 'sarah.mitchell@alera.example', name: 'Sarah Mitchell', role: 'Collaborator · Medical lead', initials: 'SM', color: '#2f9e5f' },
  { email: 'daniel.novak@alera.example', name: 'Daniel Novak', role: 'Account Manager · Nordics', initials: 'DN', color: '#b45309' },
  { email: 'alex.morgan@alera.example', name: 'Alex Morgan', role: 'System Admin', initials: 'AM', color: '#5c6670' },
  { email: 'maria.castillo@alera.example', name: 'Maria Castillo', role: 'Business Admin', initials: 'MA', color: '#0f766e' },
];

export function LoginPage() {
  const { session, signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: brand } = useQuery({
    queryKey: ['tenant_branding', TENANT_SLUG],
    queryFn: async () => {
      const { data } = await supabase.rpc('tenant_branding', { p_slug: TENANT_SLUG });
      return (data as { brand_name: string; brand_color: string }[] | null)?.[0] ?? null;
    },
  });

  if (session) return <Navigate to="/" replace />;

  async function submit(e: FormEvent, creds?: { email: string; password: string }) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await signIn(creds?.email ?? email, creds?.password ?? password);
    if (err) setError(err);
    setBusy(false);
  }

  return (
    <main className="login">
      <div className="login-column">
        <div className="login-brand">
          <span className="brand-name" style={brand ? { color: brand.brand_color } : undefined}>{brand?.brand_name ?? 'Event Center'}</span>
          <span className="brand-divider" />
          <span className="brand-product">Event Center</span>
        </div>

        <form className="card login-card" onSubmit={submit}>
          <h1 className="login-title">Sign in</h1>
          <p className="login-sub">Strategic events, across every country, in one place.</p>
          {error && <div className="form-error" role="alert">{error}</div>}
          <label className="field">
            <span className="field-label">Work email</span>
            <input className="input" type="email" autoComplete="username" required value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            <input className="input" type="password" autoComplete="current-password" required value={password}
              onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="login-sso">Single sign-on is configured per organisation.</p>
        </form>

        {isDemoMode && (
          <section className="card login-demo" aria-label="Demo accounts">
            <div className="login-demo-head">
              <span className="card-title" style={{ fontSize: 'var(--text-lg)' }}>Demo accounts</span>
              <span className="card-sub">One click to sign in</span>
            </div>
            <ul>
              {DEMO_ACCOUNTS.map((a) => (
                <li key={a.email}>
                  <button type="button" className="login-demo-row" disabled={busy}
                    onClick={(e) => submit(e, { email: a.email, password: DEMO_PASSWORD })}>
                    <Avatar initials={a.initials} color={a.color} size={34} />
                    <span className="login-demo-text"><strong>{a.name}</strong><span>{a.role}</span></span>
                    <ArrowRight size={16} className="text-muted" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="login-foot">Prototype environment · all data is fictional</p>
      </div>
    </main>
  );
}
