-- =====================================================================
-- Event Coordinator — status pills follow the lifecycle
-- Home shows the lifecycle step itself (no separate Planning / In approval / Approved
-- wording), one tone per step: draft grey, review yellow, contract blue, execution purple,
-- closed green; cancelled grey.
-- =====================================================================

update public.event_status s set home_label = s.label, tone = v.tone
  from (values ('draft', 'grey'), ('review', 'yellow'), ('contract', 'blue'), ('execution', 'purple'),
               ('closed', 'green'), ('cancelled', 'grey')) as v(code, tone)
 where s.code = v.code;

comment on column public.event_status.tone is 'grey | yellow | blue | purple | green | red';
