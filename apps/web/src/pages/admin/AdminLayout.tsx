import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Boxes, CalendarCog, FileSignature, FlaskConical, Users, Workflow, ListChecks, Plug, SlidersHorizontal } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import './admin.css';

const SECTIONS = [
  { to: 'event-types', label: 'Event types', icon: CalendarCog },
  { to: 'products', label: 'Products', icon: Boxes },
  { to: 'therapeutic-areas', label: 'Therapeutic areas', icon: FlaskConical },
  { to: 'custom-fields', label: 'Custom fields', icon: SlidersHorizontal },
  { to: 'contract-templates', label: 'Contract templates', icon: FileSignature },
  { to: 'users', label: 'Users', icon: Users },
];
// On the roadmap, shown so admins can see where configuration is heading
const LATER = [
  { label: 'Statuses per event type', icon: ListChecks },
  { label: 'Business rules and approvals', icon: Workflow },
  { label: 'CRM connections', icon: Plug },
];

/** The Admin area: open to profiles with can_access_admin. What each person can change is decided by the database. */
export function AdminLayout() {
  const { me } = useAuth();
  if (!me?.profile.can_access_admin) {
    return (
      <main className="page">
        <section className="card empty-state">
          <div className="empty-state-title">Admin is for administrators</div>
          Ask a System Admin or Business Admin if you need something changed.
        </section>
      </main>
    );
  }
  return (
    <main className="admin">
      <nav className="admin-nav" aria-label="Admin">
        <div className="admin-nav-title">Admin</div>
        {SECTIONS.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `admin-nav-link${isActive ? ' active' : ''}`}>
            <Icon size={16} aria-hidden />{label}
          </NavLink>
        ))}
        <div className="admin-nav-sub">Coming later</div>
        {LATER.map(({ label, icon: Icon }) => (
          <span key={label} className="admin-nav-link disabled" aria-disabled><Icon size={16} aria-hidden />{label}</span>
        ))}
      </nav>
      <div className="admin-main"><Outlet /></div>
    </main>
  );
}

/** Page header for an admin section: title, one-line explanation, primary action. */
export function AdminPage({ title, sub, action, readOnlyNote, children }:
  { title: string; sub: string; action?: ReactNode; readOnlyNote?: string | false; children: ReactNode }) {
  return (
    <>
      <div className="page-header admin-head">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="card-sub">{sub}</p>
        </div>
        {action}
      </div>
      {readOnlyNote && <div className="admin-note">{readOnlyNote}</div>}
      {children}
    </>
  );
}
