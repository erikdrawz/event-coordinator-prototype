import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { ConfirmDialog } from '../ui/ConfirmDialog';

export type Decision = 'approved' | 'rejected';

/**
 * Decides the caller's step of a request's or an event's approval (decide_request / decide_event);
 * rejecting requires a reason.
 */
export function DecideDialog({ kind, record, decision, onDone, onClose }: {
  kind: 'request' | 'event';
  /** owner: who's told the outcome (the requester, or the event's owner) */
  record: { id: string; title: string; owner: string | null }; decision: Decision; onDone: () => void; onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);
  const approving = decision === 'approved';
  const noun = kind === 'event' ? 'event' : 'request';

  const decide = useMutation({
    mutationFn: async () => {
      const { error } = kind === 'event'
        ? await supabase.rpc('decide_event', { p_event_id: record.id, p_decision: decision, p_note: note.trim() || null })
        : await supabase.rpc('decide_request', { p_request_id: record.id, p_decision: decision, p_note: note.trim() || null });
      if (error) throw new Error(error.message);
    },
    onSuccess: onDone,
  });

  const confirm = () => {
    if (!approving && !note.trim()) { setMissing(true); document.getElementById('decision-note')?.focus(); return; }
    decide.mutate();
  };
  const who = record.owner ?? (kind === 'event' ? 'the owner' : 'the requester');
  const outcome = kind === 'event' ? `the event moves to Contract and ${who} is notified` : `the request is approved and ${who} is notified`;

  return (
    <ConfirmDialog title={approving ? `Approve this ${noun}?` : `Reject this ${noun}?`} confirmLabel={approving ? `Approve ${noun}` : `Reject ${noun}`}
      danger={!approving} pending={decide.isPending} error={decide.error?.message} onConfirm={confirm} onCancel={onClose}>
      <p className="cancel-event-text">
        {approving
          ? <>You approve your step of <strong>{record.title}</strong>. When every step is approved, {outcome}.</>
          : <><strong>{record.title}</strong> {kind === 'event' ? 'goes back to Draft' : 'is rejected'}, and any steps still open are cancelled. {who.replace(/^./, (c) => c.toUpperCase())} is notified with your reason.</>} This can't be undone.
      </p>
      <label className="field-label" htmlFor="decision-note">
        {approving ? <>Note <span className="text-muted">(optional)</span></> : <>Reason <span className="field-required">*</span></>}
      </label>
      <textarea id="decision-note" className="input cancel-event-reason" rows={3} value={note}
        placeholder={approving ? 'e.g. Go ahead; keep the budget under €20k' : kind === 'event' ? 'e.g. Add the agenda and the speakers first' : 'e.g. Already covered by the Q4 advisory board'}
        aria-invalid={missing || undefined} aria-describedby={missing ? 'decision-note-error' : undefined}
        onChange={(e) => { setNote(e.target.value); if (missing) setMissing(false); }} />
      {missing && <span id="decision-note-error" className="field-error">Add a reason so {kind === 'event' ? 'the team knows what to change' : 'the requester knows why'}</span>}
    </ConfirmDialog>
  );
}
