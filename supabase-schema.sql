-- Execute este SQL no Supabase SQL Editor

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  ctwa_clid text,
  status text not null default 'lead', -- 'lead' | 'comprou'
  valor numeric(10,2),
  nome text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  purchase_sent_at timestamptz,
  unique(phone)
);

-- Trigger para updated_at automático
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists leads_updated_at on leads;
create trigger leads_updated_at
  before update on leads
  for each row execute function update_updated_at();

-- Index para buscas por ctwa_clid
create index if not exists leads_ctwa_clid_idx on leads(ctwa_clid);
create index if not exists leads_status_idx on leads(status);
