import { Bot } from 'lucide-react';

interface Props {
  initials?: string | null;
  color?: string | null;
  size?: number;
  /** Agents get a robot glyph, so it's always clear when an AI acted. */
  isAgent?: boolean;
  title?: string;
}

export function Avatar({ initials, color, size = 32, isAgent, title }: Props) {
  return (
    <span className="avatar" title={title}
      style={{ width: size, height: size, background: color ?? 'var(--color-nav-active)', fontSize: Math.round(size * 0.34) }}>
      {isAgent ? <Bot size={Math.round(size * 0.55)} aria-label="Agent" /> : (initials ?? '?')}
    </span>
  );
}
