-- Execute este SQL no Supabase SQL Editor

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  direction text not null, -- 'in' | 'out'
  body text,
  wa_message_id text,
  timestamp timestamptz not null default now()
);

create index if not exists messages_phone_idx on messages(phone);
create index if not exists messages_timestamp_idx on messages(timestamp);

-- Amplia o campo nome do contato e o status do lead (Novo, Em atendimento, Comprou, Não comprou)
alter table leads add column if not exists last_message_at timestamptz;

-- status já existe como text livre — os valores usados pelo CRM são:
-- 'novo', 'em_atendimento', 'comprou', 'nao_comprou'
-- (não precisa migrar dados antigos: 'lead' continua válido e é tratado como 'novo' no front)
