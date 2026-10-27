import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface PopoverPos { left: number; width: number; top?: number; bottom?: number; maxHeight: number }

/**
 * Positions a fixed popup under (or, without room, above) its trigger. Fixed positioning keeps it
 * from being clipped by a scrolling modal body. While open it follows scrolling and resizing, and
 * an outside mousedown calls onOutside.
 */
export function usePopover<T extends HTMLElement>(
  open: boolean,
  onOutside: () => void,
  { minWidth = 0, width, maxHeight = 320 }: { minWidth?: number; width?: number; maxHeight?: number } = {},
) {
  const triggerRef = useRef<T>(null) as RefObject<T | null>;
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PopoverPos | null>(null);
  const outside = useRef(onOutside);
  outside.current = onOutside;

  const place = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const up = below < Math.min(maxHeight, 240) && above > below;
    const w = width ?? Math.max(r.width, minWidth);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    setPos(up ? { left, width: w, bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(maxHeight, above) }
              : { left, width: w, top: r.bottom + 4, maxHeight: Math.min(maxHeight, below) });
  };

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    place();
    const onMove = () => place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !triggerRef.current?.contains(t)) outside.current();
    };
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const style = pos ? { left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight } : undefined;
  return { triggerRef, popRef, pos, style };
}
