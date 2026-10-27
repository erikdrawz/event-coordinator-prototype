import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { ConfirmDialog } from '../../ui/ConfirmDialog';

/** Cancels an event through change_event_status(), which requires a reason. */
export function CancelEventDialog({ event, onClose }: { event: { id: string; name: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);

  const cancel = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('change_event_status', { p_event_id: event.id, p_status: 'cancelled', p_reason: reason.trim() });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['event', event.id] });
      qc.invalidateQueries({ queryKey: ['events'] });
      qc.invalidateQueries({ queryKey: ['home'] });
      onClose();
    },
  });

  const confirm = () => {
    if (!reason.trim()) { setMissing(true); document.getElementById('cancel-reason')?.focus(); return; }
    cancel.mutate();
  };

  return (
    <ConfirmDialog title={`Cancel ${event.name}?`} confirmLabel="Cancel event" cancelLabel="Keep event"
      pending={cancel.isPending} error={cancel.error?.message} onConfirm={confirm} onCancel={onClose}>
      <p className="cancel-event-text">
        The event stays on record with its agenda, speakers and history, marked as cancelled. This can't be undone.
      </p>
      <label className="field-label" htmlFor="cancel-reason">Reason <span className="field-required">*</span></label>
      <textarea id="cancel-reason" className="input cancel-event-reason" rows={3} value={reason}
        placeholder="e.g. Merged into the BioForum satellite programme"
        aria-invalid={missing || undefined} aria-describedby={missing ? 'cancel-reason-error' : undefined}
        onChange={(e) => { setReason(e.target.value); if (missing) setMissing(false); }} />
      {missing && <span id="cancel-reason-error" className="field-error">Add a reason so the team knows why</span>}
    </ConfirmDialog>
  );
}
