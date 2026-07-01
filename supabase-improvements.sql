-- Execute no Supabase SQL Editor (melhorias 2026-07)
-- 1. Status de entrega nas mensagens (sent/delivered/read)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS status text DEFAULT 'sent';

-- 2. Foto de perfil nos leads
ALTER TABLE leads ADD COLUMN IF NOT EXISTS profile_pic_url text;

-- 3. Imagem nas respostas rápidas
ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS image_url text;

-- 4. Atualiza a função get_conversations para incluir profile_pic_url
create or replace function get_conversations()
returns table (
  id uuid, phone text, nome text, ctwa_clid text, status text,
  valor numeric, created_at timestamptz, updated_at timestamptz,
  purchase_sent_at timestamptz, last_message_at timestamptz,
  profile_pic_url text,
  last_msg_body text, last_msg_direction text, last_msg_timestamp timestamptz
) as $$
  select
    l.id, l.phone, l.nome, l.ctwa_clid, l.status,
    l.valor, l.created_at, l.updated_at,
    l.purchase_sent_at, l.last_message_at,
    l.profile_pic_url,
    m.body, m.direction, m.timestamp
  from leads l
  left join lateral (
    select body, direction, timestamp
    from messages
    where phone = l.phone
    order by timestamp desc
    limit 1
  ) m on true
  order by coalesce(l.last_message_at, l.created_at) desc nulls last
$$ language sql stable;
