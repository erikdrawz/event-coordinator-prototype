import type { ReactNode } from 'react';
import { Modal } from './Modal';

/** "Are you sure?" for destructive actions, in the app's style instead of window.confirm. */
export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel, pending, error, danger = true }: {
  title: string; children: ReactNode; confirmLabel: string; onConfirm: () => void; onCancel: () => void;
  pending?: boolean; error?: string | null; danger?: boolean;
}) {
  return (
    <Modal open title={title} onClose={onCancel}
      footer={<>
        <button type="button" className="btn" onClick={onCancel} disabled={pending}>Cancel</button>
        <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={pending}>
          {pending ? 'Working…' : confirmLabel}
        </button>
      </>}>
      {error && <div className="form-error" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="confirm-body">{children}</div>
    </Modal>
  );
}
