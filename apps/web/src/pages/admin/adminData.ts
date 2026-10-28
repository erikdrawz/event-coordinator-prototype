import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';

async function rows<T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>) {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data as T[];
}

export interface Country { code: string; name: string }
export interface TherapeuticArea { id: string; name: string; is_active: boolean }
export interface Product { id: string; name: string; is_active: boolean; therapeutic_area_id: string | null }
export interface EventTypeRow {
  id: string; name: string; description: string | null; default_duration_minutes: number | null; is_active: boolean;
  event_type_country: { country_code: string }[];
  event_type_contract_template: { contract_template_id: string }[];
}
export interface ContractTemplateRow {
  id: string; name: string; contract_type: string; body: string; file_name: string | null;
  country_codes: string[] | null; is_active: boolean; updated_at: string;
  event_type_contract_template: { event_type_id: string }[];
}
export interface Profile { id: string; name: string; is_admin: boolean }
export interface UserRow {
  id: string; user_type: 'human' | 'agent'; first_name: string | null; last_name: string | null; display_name: string;
  email: string | null; job_title: string | null; initials: string | null; avatar_color: string | null;
  status: 'active' | 'inactive'; country_code: string | null; profile_id: string; auth_user_id: string | null;
  last_login_at: string | null;
  profile: { name: string; is_admin: boolean } | null;
  app_user_country: { country_code: string }[];
}

export type CustomFieldType = 'text' | 'long_text' | 'number' | 'currency' | 'date' | 'checkbox' | 'picklist' | 'multi_picklist' | 'lookup_user' | 'url';
export interface CustomFieldRow {
  id: string; api_name: string; label: string; field_type: CustomFieldType; help_text: string | null;
  options: { value: string; label: string }[]; decimals: number | null; is_required: boolean; is_active: boolean; created_at: string;
  custom_field_layout: { event_type_id: string | null }[];
}

/** Admin lists share one query key prefix, so a save can refresh them all at once. */
export const ADMIN_KEY = 'admin';

export function useCountries() {
  return useQuery({
    queryKey: ['countries'], staleTime: Infinity,
    queryFn: () => rows<Country>(supabase.from('country').select('code,name').order('name')),
  });
}
export function useAreas() {
  return useQuery({
    queryKey: [ADMIN_KEY, 'areas'],
    queryFn: () => rows<TherapeuticArea>(supabase.from('therapeutic_area').select('id,name,is_active').order('name')),
  });
}
export function useProducts() {
  return useQuery({
    queryKey: [ADMIN_KEY, 'products'],
    queryFn: () => rows<Product>(supabase.from('product').select('id,name,is_active,therapeutic_area_id').order('name')),
  });
}
export function useEventTypes() {
  return useQuery({
    queryKey: [ADMIN_KEY, 'event-types'],
    queryFn: () => rows<EventTypeRow>(supabase.from('event_type')
      .select('id,name,description,default_duration_minutes,is_active,event_type_country(country_code),event_type_contract_template(contract_template_id)')
      .order('name')),
  });
}
/** Contract templates with the event types that use them. */
export function useContractTemplates() {
  return useQuery({
    queryKey: [ADMIN_KEY, 'contract-templates'],
    queryFn: () => rows<ContractTemplateRow>(supabase.from('contract_template')
      .select('id,name,contract_type,body,file_name,country_codes,is_active,updated_at,event_type_contract_template(event_type_id)')
      .order('name')),
  });
}
/** The {{merge fields}} templates can use. */
export function useMergeFields() {
  return useQuery({
    queryKey: ['contract-merge-fields'], staleTime: Infinity,
    queryFn: () => rows<{ field: string; description: string }>(supabase.rpc('contract_merge_fields')),
  });
}
/** Event custom fields, oldest first (the order they're shown in). */
export function useCustomFields() {
  return useQuery({
    queryKey: [ADMIN_KEY, 'custom-fields'],
    queryFn: () => rows<CustomFieldRow>(supabase.from('custom_field')
      .select('id,api_name,label,field_type,help_text,options,decimals,is_required,is_active,created_at,custom_field_layout(event_type_id)')
      .eq('object_name', 'event').order('created_at')),
  });
}
export function useProfiles() {
  return useQuery({
    queryKey: [ADMIN_KEY, 'profiles'],
    queryFn: () => rows<Profile>(supabase.from('profile').select('id,name,is_admin').order('name')),
  });
}
export function useUsers() {
  return useQuery({
    queryKey: [ADMIN_KEY, 'users'],
    queryFn: () => rows<UserRow>(supabase.from('app_user')
      .select('id,user_type,first_name,last_name,display_name,email,job_title,initials,avatar_color,status,country_code,profile_id,auth_user_id,last_login_at,profile(name,is_admin),app_user_country!app_user_country_user_id_fkey(country_code)')
      .order('display_name')),
  });
}

/**
 * Brings a link table in line with a chosen set: deletes rows no longer chosen, inserts new ones.
 * Plain API calls, so row-level security decides what this user may change.
 */
export async function syncLinks(table: string, ownerCol: string, ownerId: string, linkCol: string, before: string[], after: string[]) {
  const removed = before.filter((v) => !after.includes(v));
  const added = after.filter((v) => !before.includes(v));
  if (removed.length) {
    const { error } = await supabase.from(table).delete().eq(ownerCol, ownerId).in(linkCol, removed);
    if (error) throw new Error(friendly(error.message));
  }
  if (added.length) {
    const { error } = await supabase.from(table).insert(added.map((v) => ({ [ownerCol]: ownerId, [linkCol]: v })));
    if (error) throw new Error(friendly(error.message));
  }
}

/** Throws the API error message, which the database writes for people. */
export async function must<T>(q: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await q;
  if (error) throw new Error(friendly(error.message));
  return data;
}

/** A few raw database messages, rephrased. */
export function friendly(msg: string) {
  if (/custom_field_tenant_id_object_name_api_name_key/.test(msg)) return 'Another custom field already has that name.';
  if (/duplicate key value.*_name_key/.test(msg) || /duplicate key value.*\(tenant_id, name\)/.test(msg)) return 'That name is already in use.';
  if (/row-level security/.test(msg)) return "You don't have permission to make this change.";
  return msg;
}
