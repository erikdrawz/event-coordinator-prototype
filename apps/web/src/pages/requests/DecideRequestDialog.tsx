import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { ConfirmDialog } from '../../ui/ConfirmDialog';

export type Decision = 'approved' | 'rejected';

/** Decides the caller's step of a request's approval through decide_request(); rejecting requires a reason. */
export function DecideRequestDialog({ request, decision, onDone, onClose }: {
  request: { id: string; title: string; requester: string | null }; decision: Decision; onDone: () => void; onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);
  const approving = decision === 'approved';

  const decide = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('decide_request', { p_request_id: request.id, p_decision: decision, p_note: note.trim() || null });
      if (error) throw new Error(error.message);
    },
    onSuccess: onDone,
  });

  const confirm = () => {
    if (!approving && !note.trim()) { setMissing(true); document.getElementById('decision-note')?.focus(); return; }
    decide.mutate();
  };
  const who = request.requester ?? 'The requester';

  return (
    <ConfirmDialog title={approving ? 'Approve this request?' : 'Reject this request?'} confirmLabel={approving ? 'Approve request' : 'Reject request'}
      danger={!approving} pending={decide.isPending} error={decide.error?.message} onConfirm={confirm} onCancel={onClose}>
      <p className="cancel-event-text">
        {approving
          ? <>You approve your step of <strong>{request.title}</strong>. When every step is approved, the request is approved and {who} is notified.</>
          : <><strong>{request.title}</strong> is rejected, and any steps still open are cancelled. {who} is notified with your reason.</>} This can't be undone.
      </p>
      <label className="field-label" htmlFor="decision-note">
        {approving ? <>Note <span className="text-muted">(optional)</span></> : <>Reason <span className="field-required">*</span></>}
      </label>
      <textarea id="decision-note" className="input cancel-event-reason" rows={3} value={note}
        placeholder={approving ? 'e.g. Go ahead; keep the budget under €20k' : 'e.g. Already covered by the Q4 advisory board'}
        aria-invalid={missing || undefined} aria-describedby={missing ? 'decision-note-error' : undefined}
        onChange={(e) => { setNote(e.target.value); if (missing) setMissing(false); }} />
      {missing && <span id="decision-note-error" className="field-error">Add a reason so the requester knows why</span>}
    </ConfirmDialog>
  );
}
