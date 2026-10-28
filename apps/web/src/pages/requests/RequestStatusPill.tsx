import { useRequestStatuses, type RequestStatus } from './requestData';

export function RequestStatusPill({ status }: { status: RequestStatus }) {
  const { data } = useRequestStatuses();
  const row = data?.find((s) => s.code === status);
  return row ? <span className={`pill pill-${row.tone}`}>{row.label}</span> : null;
}
