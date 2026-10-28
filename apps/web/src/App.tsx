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
import { RequestsPage } from './pages/requests/RequestsPage';
import { RequestPage } from './pages/requests/RequestPage';
import { ExpertsPage } from './pages/experts/ExpertsPage';
import { ExpertPage } from './pages/experts/ExpertPage';
import { ContractPage } from './pages/contracts/ContractPage';
import { AdminLayout } from './pages/admin/AdminLayout';
import { EventTypesAdmin } from './pages/admin/EventTypesAdmin';
import { ProductsAdmin, TherapeuticAreasAdmin } from './pages/admin/MasterDataAdmin';
import { UsersAdmin } from './pages/admin/UsersAdmin';
import { CustomFieldsAdmin } from './pages/admin/CustomFieldsAdmin';
import { ContractTemplatePage, ContractTemplatesAdmin } from './pages/admin/ContractTemplatesAdmin';

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="loading-screen">Loading…</div>;
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />;
  if (!me) return <div className="loading-screen">Your login isn't linked to an Event Center user yet.</div>;
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
        <Route path="requests" element={<RequestsPage />} />
        <Route path="requests/:id" element={<RequestPage />} />
        <Route path="experts" element={<ExpertsPage />} />
        <Route path="experts/:id" element={<ExpertPage />} />
        <Route path="contracts/:id" element={<ContractPage />} />
        <Route path="admin" element={<AdminLayout />}>
          <Route index element={<Navigate to="event-types" replace />} />
          <Route path="event-types" element={<EventTypesAdmin />} />
          <Route path="products" element={<ProductsAdmin />} />
          <Route path="therapeutic-areas" element={<TherapeuticAreasAdmin />} />
          <Route path="custom-fields" element={<CustomFieldsAdmin />} />
          <Route path="contract-templates" element={<ContractTemplatesAdmin />} />
          <Route path="contract-templates/:id" element={<ContractTemplatePage />} />
          <Route path="users" element={<UsersAdmin />} />
        </Route>
        <Route path="*" element={<PlaceholderPage title="Page not found" phase="no phase — check the address" />} />
      </Route>
    </Routes>
  );
}
