import type { Me } from './types';

type Action = 'read' | 'create' | 'edit' | 'delete';

/**
 * Whether to offer an action in the UI. Mirrors app.has_perm(): System Admins can do everything,
 * everyone else needs a permission row. The database enforces it either way.
 */
export function can(me: Me | null | undefined, object: string, action: Action): boolean {
  if (!me) return false;
  return me.profile.is_admin || Boolean(me.permissions[object]?.[action]);
}

/** Whether this user may create events at all: allowed somewhere, or an admin. */
export function canCreateEvents(me: Me | null | undefined): boolean {
  return can(me, 'event', 'create') && (Boolean(me?.profile.is_admin) || (me?.event_countries.length ?? 0) > 0);
}
