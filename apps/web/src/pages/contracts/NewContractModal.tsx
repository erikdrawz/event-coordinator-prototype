import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { Modal } from '../../ui/Modal';
import { Field, FormSection } from '../../ui/Form';
import { Select } from '../../ui/Select';
import { DateInput, formatDate } from '../../ui/DateInput';
import { hours, money } from '../event/speakers/speakersData';
import { refreshContracts, useContractOptions, useTypeLabel, type ContractRow, type ContractType, type TemplateOption } from './contractsData';

type Target =
  | { kind: 'engagement'; eventExpertId: string; eventId: string; hcpId: string; name: string; addendum?: boolean;
      honorarium: { total: number; currency: string; rate: number | null; prep: number; service: number; travel: number } }
  | { kind: 'msa'; hcpId: string; name: string };

const isoDay = (d: Date) => d.toLocaleDateString('en-CA');
const plusTwoYears = (s: string) => { const d = new Date(`${s}T12:00:00`); d.setFullYear(d.getFullYear() + 2); d.setDate(d.getDate() - 1); return isoDay(d); };

/**
 * New contract: for an expert on an event (Work Order or Single-event Contract, or an Addendum to
 * the one they have) or an MSA for the expert. What's possible comes from contract_options(); the
 * database drafts the text from the template, with the honorarium as it is now.
 */
export function NewContractModal({ target, onClose }: { target: Target; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const typeLabel = useTypeLabel();
  const options = useContractOptions(target.kind === 'msa' ? { hcpId: target.hcpId } : { eventExpertId: target.eventExpertId });
  const o = options.data;
  const choices: ContractType[] = target.kind === 'msa' ? ['msa'] : target.addendum ? ['addendum'] : ['work_order', 'event_contract'];

  /** Why a type can't be used here, or null. */
  const blocked = (t: ContractType): string | null => {
    if (!o) return null;
    if (target.kind === 'engagement' && !o.eligible) return `${target.name} isn't eligible for this event.`;
    if (t === 'work_order' && !o.msa) return `Needs a signed Master Service Agreement that covers the event. ${target.name} has none.`;
    if (t === 'addendum' && !o.main) return 'There is no contract to change yet.';
    if (!(o.templates[t]?.length)) return target.kind === 'msa' ? 'No Master Service Agreement template yet. Ask an admin to add one.'
      : "No template for this event's type and country yet. Ask an admin to add one.";
    return null;
  };
  const [type, setType] = useState<ContractType | null>(null);
  useEffect(() => { if (o && !type) setType(choices.find((t) => !blocked(t)) ?? choices[0]); }, [o]); // eslint-disable-line react-hooks/exhaustive-deps
  const templates: TemplateOption[] = (type && o?.templates[type]) || [];
  const [templateId, setTemplateId] = useState('');
  useEffect(() => { setTemplateId(templates[0]?.id ?? ''); }, [type, o]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = isoDay(new Date());
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(plusTwoYears(today));

  const create = useMutation({
    mutationFn: async () => {
      const p = target.kind === 'msa'
        ? { contract_type: 'msa', hcp_id: target.hcpId, template_id: templateId, start_date: start, end_date: end }
        : { contract_type: type, event_expert_id: target.eventExpertId, template_id: templateId };
      const { data, error } = await supabase.rpc('create_contract', { p });
      if (error) throw new Error(error.message);
      return data as ContractRow;
    },
    onSuccess: (c) => { refreshContracts(qc, c); onClose(); navigate(`/contracts/${c.id}`); },
  });

  const why = type ? blocked(type) : null;
  const title = target.kind === 'msa' ? 'New Master Service Agreement' : target.addendum ? 'New addendum' : 'New contract';
  const h = target.kind === 'engagement' ? target.honorarium : null;

  return (
    <Modal open title={title} onClose={onClose}
      footerNote={target.kind === 'msa' ? 'Created as a draft. You can print it, then send it for signature.' : 'Created as a draft from the template. You can review it before sending it for signature.'}
      footer={<>
        <button type="button" className="btn" onClick={onClose} disabled={create.isPending}>Cancel</button>
        <button type="submit" form="contract-form" className="btn btn-primary" disabled={!o || Boolean(why) || !templateId || create.isPending}>
          {create.isPending ? 'Creating…' : 'Create draft'}
        </button>
      </>}>
      <form id="contract-form" className="form" noValidate onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        {(create.error || options.error) && <div className="form-error" role="alert" style={{ marginBottom: 16 }}>{(create.error ?? options.error)!.message}</div>}
        <p className="contract-for">For <strong>{target.name}</strong>{target.kind === 'engagement' && target.addendum && o?.main && <> · changes <strong>{o.main.contract_number}</strong></>}</p>
        {options.isLoading ? <div className="text-muted">Loading…</div> : (
          <FormSection>
            {choices.length > 1 && (
              <div className="field field-wide" role="radiogroup" aria-label="Contract type">
                <span className="field-label">Contract type</span>
                <div className="type-choices">
                  {choices.map((t) => {
                    const no = blocked(t);
                    const sub = no ?? (t === 'work_order' && o?.msa
                      ? `Under ${o.msa.contract_number}${o.msa.end_date ? `, valid until ${formatDate(o.msa.end_date)}` : ''}`
                      : t === 'event_contract' ? 'A standalone contract for this event' : '');
                    return (
                      <label key={t} className={`type-choice${type === t ? ' selected' : ''}${no ? ' disabled' : ''}`}>
                        <input type="radio" name="contract-type" value={t} checked={type === t} disabled={Boolean(no)} onChange={() => setType(t)} />
                        <span><strong>{typeLabel(t)}</strong><span className={no ? 'type-choice-why' : 'dt-sub'}>{sub}</span></span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
            {choices.length === 1 && why && <p className="form-error field-wide" role="alert">{why}</p>}
            {templates.length > 0 && !why && (
              <Field label="Template" wide hint={templates.length > 1 ? undefined : 'The only template available here'}>
                {(id, d) => <Select id={id} aria-describedby={d} value={templateId} onChange={setTemplateId} options={templates.map((t) => ({ value: t.id, label: t.name }))} disabled={templates.length === 1} />}
              </Field>
            )}
            {target.kind === 'msa' && !why && <>
              <Field label="Start date">
                {(id) => <DateInput id={id} value={start} onChange={(v) => { setStart(v); if (v) setEnd(plusTwoYears(v)); }} />}
              </Field>
              <Field label="End date" hint="Two years by default">
                {(id, d) => <DateInput id={id} aria-describedby={d} value={end} min={start} onChange={setEnd} />}
              </Field>
            </>}
            {h && !why && (
              <div className="field field-wide contract-fee">
                <span className="field-label">Honorarium in the contract</span>
                <span><strong>{money(h.total, h.currency)}</strong> at {h.rate != null ? money(h.rate, h.currency) : '—'} per hour:
                  {' '}{hours(h.prep)} h preparation, {hours(h.service)} h service, {hours(h.travel)} h travel. Change it in the Experts grid first if it isn't final.</span>
              </div>
            )}
          </FormSection>
        )}
      </form>
    </Modal>
  );
}
