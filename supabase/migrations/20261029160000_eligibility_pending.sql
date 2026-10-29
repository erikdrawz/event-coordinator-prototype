-- Experts: the eligibility not yet decided reads "Pending" (was "In review")
update public.expert_eligibility set label = 'Pending' where code = 'pending';
comment on table public.expert_eligibility is 'Whether an expert may be engaged: eligible, pending, not eligible.';
comment on column public.hcp.eligibility is 'Whether the expert may be engaged (expert_eligibility). New and imported experts start pending.';
