/** Avatar background colours for new users. Stored on the user (app_user.avatar_color), so these are data, not theme tokens. */
export const AVATAR_COLORS = ['#2d3b45', '#2f9e5f', '#e8731a', '#1a9af0', '#7c5cbf', '#12b1a4', '#c2410c', '#0f766e', '#9333ea'];

export function avatarColorFor(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function initialsFor(first: string, last: string, fallback: string) {
  const i = `${first.trim()[0] ?? ''}${last.trim()[0] ?? ''}`.toUpperCase();
  return i || fallback.trim().slice(0, 2).toUpperCase();
}
