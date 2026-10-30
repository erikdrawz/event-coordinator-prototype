import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Download, FileText, Plus } from 'lucide-react';
import { addFromLibrary, contentKey, formatOf, openFile, useEventFiles, useLibraryOptions } from './contentData';

/**
 * The Library items an event could use, by its event type and country. Adding one puts it in the
 * event's content, approved as it is.
 */
export function LibraryList({ eventId, canAdd }: { eventId: string; canAdd: boolean }) {
  const qc = useQueryClient();
  const options = useLibraryOptions(eventId);
  const files = useEventFiles(eventId);
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: (id: string) => addFromLibrary(eventId, id),
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: contentKey(eventId) }); },
    onError: (e) => setError(e.message),
  });
  const used = new Set(files.data?.map((f) => f.content_id));
  const list = options.data ?? [];

  if (options.error) return <div className="form-error" role="alert">{options.error.message}</div>;
  if (options.isLoading) return <div className="ov-empty text-muted">Loading…</div>;
  if (!list.length) return <div className="ov-empty"><span><strong>Nothing in the Library for this event.</strong> Items appear here when they're linked to its event type and country.</span></div>;
  return <>
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="table-scroll">
      <table className="agenda-table content-table" aria-label="Available from the Library">
        <thead><tr><th>Item</th><th>Format</th><th>Countries</th><th aria-label="Actions" /></tr></thead>
        <tbody>
          {list.map((i) => (
            <tr key={i.id}>
              <td>
                <span className="content-name"><FileText size={16} aria-hidden /><span>
                  <button type="button" className="agenda-title as-button" onClick={() => openFile(i).catch((e) => setError(e.message))}>{i.title}</button>
                  {i.description && <div className="dt-sub">{i.description}</div>}
                </span></span>
              </td>
              <td>{formatOf(i.file_name)}</td>
              <td>{i.country_codes?.length ? <span className="content-codes">{i.country_codes.join(', ')}</span> : <span className="text-muted">All</span>}</td>
              <td className="content-actions">
                <button type="button" className="icon-btn" aria-label={`Download ${i.title}`} title="Download" onClick={() => openFile(i).catch((e) => setError(e.message))}><Download size={16} /></button>
                {used.has(i.id) ? <span className="content-added"><Check size={14} aria-hidden />In content</span>
                  : canAdd && <button type="button" className="btn btn-sm" disabled={add.isPending} onClick={() => add.mutate(i.id)}><Plus size={14} strokeWidth={2.6} />Add to content</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </>;
}
