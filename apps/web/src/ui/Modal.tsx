import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import './modal.css';

interface Props {
  open: boolean;
  title: string;
  /** Called on Cancel, Esc, the close button and a backdrop click. */
  onClose: () => void;
  children: ReactNode;
  /** Buttons, right-aligned at the bottom. */
  footer?: ReactNode;
  /** Shown left of the footer buttons, e.g. "* Required". */
  footerNote?: ReactNode;
  /** Ask before closing, e.g. when a form has unsaved changes. */
  confirmClose?: string | false;
  size?: 'md' | 'lg';
}

/**
 * A dialog on the native <dialog> element: focus trap, Esc and backdrop come from the browser.
 * The body scrolls; header and footer stay put.
 */
export function Modal({ open, title, onClose, children, footer, footerNote, confirmClose, size = 'md' }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // showModal() focuses the first focusable element (the Close button); start in the first field instead
      d.querySelector<HTMLElement>('.modal-body :is(input, textarea, button.input, [role="combobox"]):not(:disabled):not([aria-disabled="true"])')?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  const requestClose = () => {
    if (confirmClose && !window.confirm(confirmClose)) return;
    onClose();
  };

  return (
    <dialog ref={ref} className={`modal modal-${size}`} aria-labelledby="modal-title"
      onCancel={(e) => { e.preventDefault(); requestClose(); }}
      onMouseDown={(e) => { if (e.target === ref.current) requestClose(); }}>
      {open && (
        <div className="modal-frame">
          <header className="modal-head">
            <h2 id="modal-title" className="modal-title">{title}</h2>
            <button type="button" className="icon-button" aria-label="Close" onClick={requestClose}><X size={18} /></button>
          </header>
          <div className="modal-body">{children}</div>
          {(footer || footerNote) && (
            <footer className="modal-foot">
              <span className="modal-foot-note">{footerNote}</span>
              <div className="modal-foot-actions">{footer}</div>
            </footer>
          )}
        </div>
      )}
    </dialog>
  );
}
