import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase';

export type ContentStatus = 'draft' | 'pending' | 'approved';
export interface ContentFile { title: string; file_name: string | null; mime_type: string | null; size_bytes: number | null; storage_path: string | null; is_library: boolean }
export interface EventFile {
  id: string; content_id: string; usage: 'presentation' | 'document'; category: string | null; description: string | null;
  review_status: ContentStatus | null; dms_reference: string | null; created_at: string;
  content: ContentFile & { owner: { display_name: string } | null };
}
/** A Library item: the fields events and Admin both use. */
export interface LibraryItem extends ContentFile { id: string; description: string | null; is_active: boolean; country_codes: string[] | null }
interface Lookup { code: string; label: string; tone?: string; sort: number }

export const contentKey = (eventId: string) => ['event', eventId, 'content'];

/** Everything on the event: content (usage presentation) and documents, newest first. */
export function useEventFiles(eventId: string) {
  return useQuery({
    queryKey: contentKey(eventId),
    queryFn: async () => {
      const { data, error } = await supabase.from('event_content')
        .select('id,content_id,usage,category,description,review_status,dms_reference,created_at,' +
                'content(title,file_name,mime_type,size_bytes,storage_path,is_library,owner:app_user!content_owner_user_id_fkey(display_name))')
        .eq('event_id', eventId).order('created_at', { ascending: false });
      if (error) throw error;
      return data as unknown as EventFile[];
    },
  });
}

/** The Library items this event could use, by its event type and country. */
export function useLibraryOptions(eventId: string) {
  return useQuery({
    queryKey: [...contentKey(eventId), 'library'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('event_library_options', { p_event_id: eventId });
      if (error) throw error;
      return data as LibraryItem[];
    },
  });
}

function useLookup(table: string) {
  return useQuery({
    queryKey: [table], staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.from(table).select('*').order('sort');
      if (error) throw error;
      return data as Lookup[];
    },
  });
}
export const useContentStatuses = () => useLookup('content_status');
export const useDocumentCategories = () => useLookup('document_category');

const BUCKET = 'content';
const safeName = (name: string) => name.replace(/[^\w.\-]+/g, '_');
/** A title from a file name: without its extension, with separators as spaces. */
export const titleOf = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();

export async function uploadFile(folder: string, file: File) {
  const path = `${folder}/${crypto.randomUUID()}/${safeName(file.name)}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined });
  if (error) throw new Error(error.message);
  return path;
}
export const removeFile = async (path: string | null) => {
  if (path && !path.startsWith('demo/')) await supabase.storage.from(BUCKET).remove([path]);
};

/** Opens a file: demo files ship with the app, the rest through a short-lived signed link. */
export async function openFile(f: { storage_path: string | null; file_name: string | null }) {
  if (!f.storage_path) throw new Error('This item has no file');
  if (f.storage_path.startsWith('demo/')) {
    window.open(`/demo-content/${encodeURIComponent(f.storage_path.slice(5))}`, '_blank', 'noopener');
    return;
  }
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(f.storage_path, 600, { download: f.file_name ?? true });
  if (error) throw new Error(error.message);
  window.open(data.signedUrl, '_blank', 'noopener');
}

/** Uploads a file to the event and records it. */
export async function addEventFile(eventId: string, usage: EventFile['usage'], file: File, fields: { title: string; description?: string; category?: string }) {
  const path = await uploadFile(eventId, file);
  const { error } = await supabase.rpc('add_event_file', {
    p_event_id: eventId, p_usage: usage, p_title: fields.title, p_description: fields.description ?? null, p_category: fields.category ?? null,
    p_file_name: file.name, p_mime_type: file.type || null, p_size_bytes: file.size, p_storage_path: path,
  });
  if (error) { await removeFile(path); throw new Error(error.message); }
}

export async function addFromLibrary(eventId: string, contentId: string) {
  const { error } = await supabase.from('event_content').insert({ event_id: eventId, content_id: contentId, usage: 'presentation' });
  if (error) throw new Error(error.message);
}

export async function saveDetails(f: EventFile, title: string, description: string) {
  const { error } = await supabase.from('event_content').update({ description: description.trim() || null }).eq('id', f.id);
  if (error) throw new Error(error.message);
  if (!f.content.is_library && title !== f.content.title) {
    const { error: e2 } = await supabase.from('content').update({ title }).eq('id', f.content_id);
    if (e2) throw new Error(e2.message);
  }
}

export async function setContentStatus(id: string, status: ContentStatus) {
  const { error } = await supabase.rpc('set_event_content_status', { p_id: id, p_status: status });
  if (error) throw new Error(error.message);
}

/** Takes it off the event. A bespoke file goes with it; a Library item stays in the Library. */
export async function removeEventFile(f: EventFile) {
  const { error, count } = await supabase.from('event_content').delete({ count: 'exact' }).eq('id', f.id);
  if (error) throw new Error(error.message);
  if (!count) throw new Error("This couldn't be removed. You may not have permission.");
  if (!f.content.is_library) await removeFile(f.content.storage_path);
}

/** PPTX, PDF, DOCX: what kind of file it is, from its name. */
export const formatOf = (fileName: string | null) => {
  const ext = fileName?.split('.').pop();
  return ext && ext !== fileName ? ext.toUpperCase() : '—';
};
export const sizeOf = (bytes: number | null) => (bytes == null ? '' : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
