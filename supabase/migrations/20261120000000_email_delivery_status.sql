-- Track SMTP acceptance and safe recovery state for service request notifications.
alter table public.service_requests
    add column if not exists email_status text not null default 'pending',
    add column if not exists email_attempted_at timestamptz,
    add column if not exists email_sent_at timestamptz,
    add column if not exists email_message_id text,
    add column if not exists email_error_code text;

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'service_requests_email_status_check'
          and conrelid = 'public.service_requests'::regclass
    ) then
        alter table public.service_requests
            add constraint service_requests_email_status_check
            check (email_status in ('pending', 'sending', 'accepted', 'failed', 'unknown'));
    end if;
end $$;
