-- Private storage and request records for the ALSR Node service.
create table if not exists public.service_requests (
    id text primary key,
    received_at timestamptz not null,
    name text not null,
    phone text not null,
    email text not null,
    service text not null check (service in ('repair', 'maintenance', 'installation', 'inspection', 'other')),
    location text,
    problem text not null,
    availability text,
    photos jsonb not null default '[]'::jsonb
);

alter table public.service_requests enable row level security;
revoke all on table public.service_requests from anon, authenticated;
grant all on table public.service_requests to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'service-request-photos',
    'service-request-photos',
    false,
    15728640,
    array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic']
)
on conflict (id) do update set
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
