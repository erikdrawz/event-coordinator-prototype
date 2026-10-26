-- =====================================================================
-- Event Coordinator — System reference data (not demo data)
-- Lifecycle statuses and countries are part of the product definition.
-- =====================================================================

insert into public.event_status (code, label, home_label, tone, sort, is_terminal) values
  ('draft',     'Draft',     'Planning',    'blue',   10, false),
  ('review',    'Review',    'In approval', 'yellow', 20, false),
  ('contract',  'Contract',  'Approved',    'green',  30, false),
  ('execution', 'Execution', 'Approved',    'green',  40, false),
  ('closed',    'Closed',    'Closed',      'grey',   50, true),
  ('cancelled', 'Cancelled', 'Cancelled',   'grey',   60, true);

insert into public.request_status (code, label, tone, sort) values
  ('draft',        'Draft',        'grey',   10),
  ('submitted',    'Submitted',    'blue',   20),
  ('under_review', 'Under review', 'yellow', 30),
  ('approved',     'Approved',     'green',  40),
  ('rejected',     'Rejected',     'red',    50);

insert into public.country (code, name, region) values
  ('AT','Austria','EMEA'), ('BE','Belgium','EMEA'), ('CH','Switzerland','EMEA'), ('CZ','Czechia','EMEA'),
  ('DE','Germany','EMEA'), ('DK','Denmark','EMEA'), ('ES','Spain','EMEA'), ('FI','Finland','EMEA'),
  ('FR','France','EMEA'), ('GB','United Kingdom','EMEA'), ('GR','Greece','EMEA'), ('HU','Hungary','EMEA'),
  ('IE','Ireland','EMEA'), ('IT','Italy','EMEA'), ('NL','Netherlands','EMEA'), ('NO','Norway','EMEA'),
  ('PL','Poland','EMEA'), ('PT','Portugal','EMEA'), ('RO','Romania','EMEA'), ('SE','Sweden','EMEA'),
  ('AE','United Arab Emirates','EMEA'), ('IL','Israel','EMEA'), ('ZA','South Africa','EMEA'),
  ('US','United States','NA'), ('CA','Canada','NA'),
  ('BR','Brazil','LATAM'), ('MX','Mexico','LATAM'), ('AR','Argentina','LATAM'),
  ('AU','Australia','APAC'), ('CN','China','APAC'), ('IN','India','APAC'), ('KR','South Korea','APAC'),
  ('SG','Singapore','APAC'), ('JP','Japan','JP');
