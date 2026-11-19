alter table public.service_requests
    add column if not exists mileage integer check (mileage is null or mileage between 0 and 9999999);
