import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase';

export type TovCategory = 'fees_for_service' | 'travel_accommodation' | 'registration_fees' | 'hospitality' | 'sponsorship' | 'not_reportable';
export interface TovCategoryRow { code: TovCategory; label: string; reportable: boolean; sort: number }
export interface SpendTypeRow { code: string; label: string; tov_category: TovCategory; sort: number }

export interface Attribution {
  id: string; event_attendee_id: string | null; hcp_id: string | null; user_id: string | null; recipient_name: string; amount: number;
}
/** One invoice or receipt line, for one person or a group; `event_spend_attribution` says who received it. */
export interface Spend {
  id: string; event_id: string; spend_type: string; tov_category: TovCategory; spend_date: string;
  description: string; vendor: string | null; invoice_number: string | null; amount: number; currency: string;
  document_path: string | null; document_name: string | null; source: 'manual' | 'scan';
  drafted_by: string | null; drafter: { display_name: string } | null;
  created_at: string; creator: { display_name: string } | null;
  event_spend_attribution: Attribution[];
}
/** A Transfer of Value line (event_tov): an HCP's share of reportable spend, or a signed contract's honorarium. */
export interface TovLine {
  event_id: string; source: 'spend' | 'contract'; source_id: string; line_id: string; hcp_id: string; hcp_name: string;
  onekey_id: string | null; crm_external_id: string | null; country_code: string | null;
  tov_category: TovCategory; amount: number; currency: string; tov_date: string | null;
  description: string; vendor: string | null; invoice_number: string | null;
}

export const spendKey = (eventId: string) => ['event', eventId, 'spend'];

export function useSpend(eventId: string) {
  return useQuery({
    queryKey: spendKey(eventId),
    queryFn: async () => {
      const { data, error } = await supabase.from('event_spend')
        .select('id,event_id,spend_type,tov_category,spend_date,description,vendor,invoice_number,amount,currency,document_path,document_name,source,drafted_by,created_at,' +
                'drafter:app_user!event_spend_drafted_by_fkey(display_name),creator:app_user!event_spend_created_by_fkey(display_name),' +
                'event_spend_attribution(id,event_attendee_id,hcp_id,user_id,recipient_name,amount)')
        .eq('event_id', eventId).order('spend_date', { ascending: false }).order('created_at', { ascending: false });
      if (error) throw error;
      return (data as unknown as Spend[]).map((s) => ({
        ...s, amount: Number(s.amount),
        event_spend_attribution: s.event_spend_attribution.map((a) => ({ ...a, amount: Number(a.amount) })).sort((a, b) => a.recipient_name.localeCompare(b.recipient_name)),
      }));
    },
  });
}

export function useTov(eventId: string) {
  return useQuery({
    queryKey: [...spendKey(eventId), 'tov'],
    queryFn: async () => {
      const { data, error } = await supabase.from('event_tov').select('*').eq('event_id', eventId);
      if (error) throw error;
      return (data as TovLine[]).map((t) => ({ ...t, amount: Number(t.amount) }));
    },
  });
}

export function useTovCategories() {
  return useQuery({
    queryKey: ['tov_category'], staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.from('tov_category').select('code,label,reportable,sort').order('sort');
      if (error) throw error;
      return data as TovCategoryRow[];
    },
  });
}
export function useSpendTypes() {
  return useQuery({
    queryKey: ['spend_type'], staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.from('spend_type').select('code,label,tov_category,sort').order('sort');
      if (error) throw error;
      return data as SpendTypeRow[];
    },
  });
}

export type SpendInput = Partial<Pick<Spend, 'spend_type' | 'tov_category' | 'spend_date' | 'description' | 'vendor' | 'invoice_number' | 'amount' | 'currency' | 'document_path' | 'document_name' | 'source' | 'drafted_by'>>;

export async function createSpend(eventId: string, input: SpendInput) {
  const { data, error } = await supabase.from('event_spend').insert({ event_id: eventId, ...input }).select('id').single();
  if (error) throw new Error(error.message);
  return data.id as string;
}
export async function updateSpend(id: string, patch: SpendInput) {
  const { error } = await supabase.from('event_spend').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
}
export async function deleteSpend(id: string) {
  const { error } = await supabase.from('event_spend').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
/** Who received it: even shares across these attendees (none clears it). */
export async function splitSpend(id: string, attendeeIds: string[]) {
  const { error } = await supabase.rpc('split_spend', { p_spend_id: id, p_attendee_ids: attendeeIds });
  if (error) throw new Error(error.message);
}

/** Stores an invoice with the event: spend/<event>/<uuid>/<file>. */
export async function uploadInvoice(eventId: string, file: File) {
  const path = `${eventId}/${crypto.randomUUID()}/${file.name.replace(/[^\w.\-]+/g, '_')}`;
  const { error } = await supabase.storage.from('spend').upload(path, file, { contentType: file.type || undefined });
  if (error) throw new Error(error.message);
  return path;
}
export async function invoiceUrl(path: string) {
  const { data, error } = await supabase.storage.from('spend').createSignedUrl(path, 600);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

/** What the Invoice Agent read from an invoice (extract_invoice): a draft line and who it suggests received it. */
export interface Extraction {
  found: boolean; agent: { id: string | null; name: string | null };
  vendor?: string; invoice_number?: string; description: string; spend_type: string; tov_category: TovCategory;
  amount?: number; currency: string; spend_date: string; recipient: 'none' | 'one' | 'attended'; guest_name?: string;
  attendee_ids?: string[]; lines?: { desc: string; qty: number; unit: number; total: number }[];
}
export async function extractInvoice(eventId: string, fileName: string) {
  const { data, error } = await supabase.rpc('extract_invoice', { p_event_id: eventId, p_file_name: fileName });
  if (error) throw new Error(error.message);
  return data as Extraction;
}

export const money = (n: number, currency = 'EUR') =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

/** The demo invoices bundled with the app (public/demo-invoices), for trying the scanner. */
export const DEMO_INVOICES = ['dinner-kokkeriet-KK-2026-0418.png', 'hotel-marriott-MCPH-55102.png', 'av-rental-nordic-stage-NSAV-2291.png', 'taxi-receipt-T-4471-0926.jpg'];
export async function loadDemoInvoices() {
  return Promise.all(DEMO_INVOICES.map(async (name) => {
    const res = await fetch(`/demo-invoices/${name}`);
    const blob = await res.blob();
    return new File([blob], name, { type: blob.type || (name.endsWith('.jpg') ? 'image/jpeg' : 'image/png') });
  }));
}
