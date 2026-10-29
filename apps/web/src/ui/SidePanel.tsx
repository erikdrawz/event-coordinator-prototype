import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import './side-panel.css';

interface Props {
  /** Shown in the header; also names the panel for screen readers */
  title: ReactNode;
  /** A line under the title, e.g. specialty and city */
  subtitle?: ReactNode;
  /** Something beside the title, e.g. an avatar */
  leading?: ReactNode;
  /** Changes when another record is shown, so focus moves to the new title */
  recordKey: string;
  onClose: () => void;
  children: ReactNode;
  /** Actions pinned to the bottom, e.g. Remove */
  footer?: ReactNode;
}

/**
 * A panel on the right for one related record (an attendee, an expert): the fields that don't fit
 * the list, editable in place. It isn't modal: the list stays usable beside it, and clicking another
 * row shows that record. On wide screens the page makes room for it; on phones it fills the screen.
 * Esc (when no menu or dialog is open) and the close button close it; focus goes back where it was.
 */
export function SidePanel({ title, subtitle, leading, recordKey, onClose, children, footer }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null;
    document.body.classList.add('sp-open');
    return () => {
      document.body.classList.remove('sp-open');
      if (returnTo.current?.isConnected) returnTo.current.focus();
    };
  }, []);

  useEffect(() => { titleRef.current?.focus(); }, [recordKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('dialog[open], .sel-pop')) return;   // a menu or dialog closes first
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <aside className="sp" aria-labelledby="sp-title">
      <header className="sp-head">
        {leading}
        <div className="sp-head-text">
          <h2 id="sp-title" className="sp-title" tabIndex={-1} ref={titleRef}>{title}</h2>
          {subtitle && <div className="sp-subtitle">{subtitle}</div>}
        </div>
        <button type="button" className="icon-button sp-close" aria-label="Close panel" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="sp-body">{children}</div>
      {footer && <footer className="sp-foot">{footer}</footer>}
    </aside>,
    document.body,
  );
}

/** A titled group of fields in a SidePanel: label beside value. */
export function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sp-section">
      <h3 className="sp-section-title">{title}</h3>
      <dl className="sp-fields">{children}</dl>
    </section>
  );
}
export function PanelField({ label, children }: { label: string; children: ReactNode }) {
  return <div className="sp-field"><dt>{label}</dt><dd>{children}</dd></div>;
}
