import { useEligibilities, type Eligibility } from './expertsData';

/** Eligibility as a pill (label and tone from expert_eligibility); the reason shows on hover or focus. */
export function EligibilityPill({ value, note }: { value: Eligibility; note?: string | null }) {
  const { data } = useEligibilities();
  const row = data?.find((e) => e.code === value);
  if (!row) return null;
  return <span className={`pill pill-${row.tone}`} data-tip={note ?? undefined} tabIndex={note ? 0 : undefined}>{row.label}</span>;
}
