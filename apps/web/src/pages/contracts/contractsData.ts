import { useQuery, type QueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import type { Tone } from '../../lib/types';
import { contractPdf } from './contractPdf';

export type ContractType = 'msa' | 'work_order' | 'event_contract' | 'addendum' | 'venue';
export type ContractStatus = 'draft' | 'sent' | 'executed' | 'cancelled';

export interface Honorarium {
  currency: string; rate: number; total: number;
  prep_hours: number; service_hours: number; travel_hours: number;
  prep_amount: number; service_amount: number; travel_amount: number;
}

/** A contract in a list: the expert's contracts, an engagement's contracts. */
export interface ContractListRow {
  id: string; contract_number: string; contract_type: ContractType; status: ContractStatus; title: string | null;
  start_date: string | null; end_date: string | null; parent_contract_id: string | null; created_at: string;
  event: { id: string; name: string } | null;
  parent: { id: string; contract_number: string } | null;
}

export interface ContractRow extends ContractListRow {
  body: string | null; honorarium: Honorarium | null; rendered_at: string | null;
  sent_at: string | null; signed_at: string | null; clm_reference: string | null;
  event_id: string | null; event_expert_id: string | null; counterparty_hcp_id: string | null;
  event: { id: string; name: string; event_number: string } | null;
  hcp: { id: string; display_name: string } | null;
  hco: { id: string; name: string } | null;
  event_expert: { id: string; hourly_rate: number | null; prep_hours: number; service_hours: number; travel_hours: number; total_payable: number; currency: string | null } | null;
  parent: { id: string; contract_number: string; contract_type: ContractType } | null;
  addenda: { id: string; contract_number: string; status: ContractStatus }[];
  template: { name: string } | null;
  document: { storage_path: string | null; file_name: string | null } | null;
}

export const LIST_SELECT = 'id,contract_number,contract_type,status,title,start_date,end_date,parent_contract_id,created_at,' +
  'event:event_id(id,name),parent:parent_contract_id(id,contract_number)';
const CONTRACT_SELECT = 'id,contract_number,contract_type,status,title,start_date,end_date,parent_contract_id,created_at,' +
  'body,honorarium,rendered_at,sent_at,signed_at,clm_reference,event_id,event_expert_id,counterparty_hcp_id,' +
  'event:event_id(id,name,event_number),hcp:counterparty_hcp_id(id,display_name),hco:counterparty_hco_id(id,name),' +
  'event_expert:event_expert_id(id,hourly_rate,prep_hours,service_hours,travel_hours,total_payable,currency),' +
  'parent:parent_contract_id(id,contract_number,contract_type),addenda:contract!parent_contract_id(id,contract_number,status),' +
  'template:template_id(name),document:document_content_id(storage_path,file_name)';

export const contractKey = (id: string) => ['contract', id];

export function useContractTypes() {
  return useQuery({
    queryKey: ['contract_type'], staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.from('contract_type').select('code,label,prefix,description,sort').order('sort');
      if (error) throw error;
      return data as { code: ContractType; label: string; prefix: string; description: string | null; sort: number }[];
    },
  });
}

export function useContractStatuses() {
  return useQuery({
    queryKey: ['contract_status'], staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.from('contract_status').select('code,label,tone,sort').order('sort');
      if (error) throw error;
      return data as { code: ContractStatus; label: string; tone: Tone; sort: number }[];
    },
  });
}

/** Label of a contract type, e.g. "Work Order". */
export function useTypeLabel() {
  const { data } = useContractTypes();
  return (code: string) => data?.find((t) => t.code === code)?.label ?? code;
}

export function useContract(id: string | undefined) {
  return useQuery({
    queryKey: contractKey(id ?? ''),
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabase.from('contract').select(CONTRACT_SELECT).eq('id', id!).maybeSingle();
      if (error) throw error;
      return data as unknown as ContractRow | null;
    },
  });
}

/** All of an expert's contracts I can see: MSAs and the contracts of events I can see. Newest first. */
export function useExpertContracts(hcpId: string | undefined) {
  return useQuery({
    queryKey: ['expert', hcpId, 'contracts'],
    enabled: Boolean(hcpId),
    queryFn: async () => {
      const { data, error } = await supabase.from('contract').select(LIST_SELECT).eq('counterparty_hcp_id', hcpId!).order('created_at', { ascending: false });
      if (error) throw error;
      return data as unknown as ContractListRow[];
    },
  });
}

export interface TemplateOption { id: string; name: string }
export interface ContractOptions {
  eligible?: boolean;
  msa?: { id: string; contract_number: string; start_date: string | null; end_date: string | null } | null;
  main?: { id: string; contract_number: string; contract_type: ContractType; status: ContractStatus } | null;
  templates: Partial<Record<ContractType, TemplateOption[]>>;
}

/** What can be created for an engagement, or (hcpId) an MSA for the expert. The database decides. */
export function useContractOptions(target: { eventExpertId: string } | { hcpId: string }) {
  const key = 'eventExpertId' in target ? target.eventExpertId : target.hcpId;
  return useQuery({
    queryKey: ['contract-options', key],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('contract_options',
        'eventExpertId' in target ? { p_event_expert_id: target.eventExpertId } : { p_hcp_id: target.hcpId });
      if (error) throw error;
      return data as ContractOptions;
    },
  });
}

/** After a contract changes: its page, the expert's list, the event's experts. */
export function refreshContracts(qc: QueryClient, c?: { id?: string; event_id?: string | null; counterparty_hcp_id?: string | null }) {
  if (c?.id) qc.invalidateQueries({ queryKey: contractKey(c.id) });
  if (c?.counterparty_hcp_id) qc.invalidateQueries({ queryKey: ['expert', c.counterparty_hcp_id] });
  if (c?.event_id) qc.invalidateQueries({ queryKey: ['event', c.event_id] });
  qc.invalidateQueries({ queryKey: ['contract-options'] });
}

const fileOf = (c: Pick<ContractRow, 'contract_number'>) => `${c.contract_number}.pdf`;

/** Send for signature: make the PDF, store it with the contract, hand it to the contracting tool. */
export async function sendContract(c: ContractRow) {
  if (!c.body) throw new Error('The contract has no text yet. Draft it again from its template.');
  const blob = await contractPdf({ ...c, body: c.body, status: 'sent' });
  const path = `${c.id}/${fileOf(c)}`;
  const up = await supabase.storage.from('contracts').upload(path, blob, { upsert: true, contentType: 'application/pdf' });
  if (up.error) throw new Error(up.error.message);
  const { error } = await supabase.rpc('send_contract', { p_id: c.id, p_file: { path, file_name: fileOf(c), size_bytes: blob.size } });
  if (error) throw new Error(error.message);
}

/** The PDF: the stored one once sent; otherwise made now (with a DRAFT watermark for drafts). */
export async function contractPdfBlob(c: ContractRow): Promise<Blob> {
  const stored = c.document?.storage_path;
  if (stored?.startsWith('contracts/')) {
    const { data, error } = await supabase.storage.from('contracts').download(stored.slice('contracts/'.length));
    if (error) throw new Error(error.message);
    return data;
  }
  if (!c.body) throw new Error('This contract has no text to print.');
  return contractPdf({ ...c, body: c.body });
}

export const contractFileName = fileOf;
