import { NavLink, Outlet, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { NotificationsMenu } from './NotificationsMenu';
import { UserMenu } from './UserMenu';

const NAV = [
  { to: '/', label: 'Home', end: true },
  { to: '/events', label: 'Events' },
  { to: '/requests', label: 'Requests' },
  { to: '/experts', label: 'Experts' },
];

export function AppShell() {
  const { me } = useAuth();
  return (
    <>
      <nav className="topnav" aria-label="Main">
        <Link to="/" className="brand">
          <span className="brand-name">{me?.tenant.brand_name ?? 'Event Coordinator'}</span>
          <span className="brand-divider" />
          <span className="brand-product">Event Coordinator</span>
        </Link>
        <div className="navlinks">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `navlink${isActive ? ' active' : ''}`}>
              {n.label}
            </NavLink>
          ))}
        </div>
        <div className="nav-tools">
          <NotificationsMenu />
          <UserMenu />
        </div>
      </nav>
      <Outlet />
    </>
  );
}
