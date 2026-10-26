import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { isConfigured } from './lib/supabase';
import { AppShell } from './components/AppShell';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { EventsPage } from './pages/EventsPage';
import { EventPage } from './pages/EventPage';
import { PlaceholderPage } from './pages/PlaceholderPage';

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="loading-screen">Loading…</div>;
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />;
  if (!me) return <div className="loading-screen">Your login isn't linked to an Event Coordinator user yet.</div>;
  return <>{children}</>;
}

export function App() {
  if (!isConfigured) {
    return (
      <main className="page"><section className="card">
        <h1 className="card-title">Setup needed</h1>
        <p className="text-secondary">Copy <code>apps/web/.env.example</code> to <code>apps/web/.env.local</code> and fill in the Supabase URL and anon key.</p>
      </section></main>
    );
  }
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index element={<HomePage />} />
        <Route path="events" element={<EventsPage />} />
        <Route path="events/:id" element={<EventPage />} />
        <Route path="requests" element={<PlaceholderPage title="Requests" phase="Phase 2" />} />
        <Route path="experts" element={<PlaceholderPage title="Experts" phase="Phase 3" />} />
        <Route path="*" element={<PlaceholderPage title="Page not found" phase="no phase — check the address" />} />
      </Route>
    </Routes>
  );
}
