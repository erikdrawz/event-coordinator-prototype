import type { ReactNode } from 'react';
import { Navigate, NavLink, Outlet } from 'react-router-dom';
import { Boxes, CalendarCog, FlaskConical, KeyRound, Library, LockKeyhole, Mail, Plug, Settings, ShieldCheck, SlidersHorizontal, Users, UsersRound, Workflow, type LucideIcon } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { can, seesAll } from '../../lib/permissions';
import type { Me } from '../../lib/types';
import './admin.css';

interface Section { to?: string; label: string; icon: LucideIcon; show: (me: Me) => boolean }
const admin = (me: Me) => me.profile.is_admin;

/**
 * The Admin area's sections, grouped. Each shows to the people whose rights cover it, so a System
 * Admin sees everything and a Business Admin sees what they manage (master data, the Content
 * Library, users) and the email log. Sections without `to` are on the roadmap.
 */
const GROUPS: { title: string; sections: Section[] }[] = [
  { title: 'Business admin', sections: [
    { to: 'products', label: 'Products', icon: Boxes, show: (me) => can(me, 'product', 'edit') },
    { to: 'therapeutic-areas', label: 'Therapeutic areas', icon: FlaskConical, show: (me) => can(me, 'therapeutic_area', 'edit') },
    { to: 'library', label: 'Content library', icon: Library, show: (me) => can(me, 'library_item', 'create') || can(me, 'contract_template', 'create') },
  ] },
  { title: 'Configuration', sections: [
    { to: 'event-types', label: 'Event types', icon: CalendarCog, show: (me) => can(me, 'event_type', 'edit') },
    { to: 'custom-fields', label: 'Custom fields', icon: SlidersHorizontal, show: (me) => can(me, 'custom_field', 'edit') },
    { label: 'Business rules', icon: Workflow, show: admin },
    { label: 'Approvals', icon: ShieldCheck, show: admin },
    { label: 'Connections', icon: Plug, show: admin },
  ] },
  { title: 'Users & permissions', sections: [
    { to: 'users', label: 'Users', icon: Users, show: (me) => can(me, 'app_user', 'edit') },
    { to: 'groups', label: 'Groups', icon: UsersRound, show: (me) => can(me, 'user_group', 'edit') },
    { to: 'access-rules', label: 'Access rules', icon: LockKeyhole, show: (me) => can(me, 'access_rule', 'edit') },
    { label: 'Permissions', icon: KeyRound, show: admin },
  ] },
  { title: 'Logs', sections: [
    { to: 'emails', label: 'Emails', icon: Mail, show: (me) => seesAll(me, 'email_message') },
  ] },
  { title: 'System', sections: [
    { to: 'settings', label: 'Settings', icon: Settings, show: admin },
  ] },
];

const visibleGroups = (me: Me) => GROUPS.map((g) => ({ ...g, sections: g.sections.filter((s) => s.show(me)) })).filter((g) => g.sections.length);

/** /admin opens the first section this person has. */
export function AdminIndex() {
  const { me } = useAuth();
  const first = me && visibleGroups(me).flatMap((g) => g.sections).find((s) => s.to);
  return first ? <Navigate to={first.to!} replace /> : null;
}

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
        {visibleGroups(me).map((g) => (
          <div key={g.title} className="admin-nav-group">
            <div className="admin-nav-title">{g.title}</div>
            {g.sections.map(({ to, label, icon: Icon }) => to
              ? <NavLink key={to} to={to} className={({ isActive }) => `admin-nav-link${isActive ? ' active' : ''}`}><Icon size={16} aria-hidden />{label}</NavLink>
              : <span key={label} className="admin-nav-link disabled" aria-disabled data-tip="Coming later"><Icon size={16} aria-hidden />{label}<span className="admin-nav-later">Later</span></span>)}
          </div>
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
