#!/usr/bin/env bash
# Tells the hosted database where the email-send function lives, so new emails wake it.
# Run after `supabase link` (which saves the pooler URL). Does nothing before the
# email-delivery migration has run; every DB and functions workflow calls it, so the last one wins.
set -euo pipefail
test -s supabase/.temp/pooler-url || { echo "No pooler URL saved by supabase link"; exit 1; }
PGPASSWORD="$SUPABASE_DB_PASSWORD" psql "$(cat supabase/.temp/pooler-url)" -v ON_ERROR_STOP=1 -c "
  do \$\$ begin
    if to_regclass('app.setting') is not null then
      update app.setting set value = 'https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/email-send' where key = 'email_send_url';
    end if;
  end \$\$;"
