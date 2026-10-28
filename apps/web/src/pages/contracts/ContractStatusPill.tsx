import { useContractStatuses, type ContractStatus } from './contractsData';

export function ContractStatusPill({ status, small }: { status: ContractStatus; small?: boolean }) {
  const { data } = useContractStatuses();
  const row = data?.find((s) => s.code === status);
  return row ? <span className={`pill pill-${row.tone}${small ? ' pill-sm' : ''}`}>{row.label}</span> : null;
}
