import { useRef, useState } from 'react';
import { LogOut, ShieldCheck } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Avatar } from './Avatar';
import { useDismiss } from './useDismiss';

export function UserMenu() {
  const { me, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  if (!me) return null;

  return (
    <div className="menu-anchor" ref={ref}>
      <button className="user-chip" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Avatar initials={me.initials} color={me.avatar_color} />
        <span className="user-chip-name">{me.first_name ?? me.display_name}</span>
      </button>
      {open && (
        <div className="menu" style={{ width: 280 }}>
          <div className="menu-header" style={{ justifyContent: 'flex-start' }}>
            <Avatar initials={me.initials} color={me.avatar_color} size={40} />
            <div>
              <div style={{ fontWeight: 700 }}>{me.display_name}</div>
              <div className="text-muted" style={{ fontSize: 'var(--text-base)' }}>{me.job_title}</div>
            </div>
          </div>
          <div className="menu-section">
            <div className="menu-item" style={{ cursor: 'default' }}>
              <ShieldCheck size={16} className="text-muted" />
              <span>{me.profile.name} · {me.tenant.name}</span>
            </div>
          </div>
          <div className="menu-section">
            <button className="menu-item" onClick={() => signOut()}><LogOut size={16} /> Sign out</button>
          </div>
        </div>
      )}
    </div>
  );
}
