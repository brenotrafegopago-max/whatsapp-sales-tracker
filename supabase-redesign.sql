-- Execute no Supabase SQL Editor (redesign 2026-07)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS notas text;

-- Atualiza get_conversations incluindo tags e notas
CREATE OR REPLACE FUNCTION get_conversations()
RETURNS TABLE (
  id uuid, phone text, nome text, ctwa_clid text, status text,
  valor numeric, created_at timestamptz, updated_at timestamptz,
  purchase_sent_at timestamptz, last_message_at timestamptz,
  profile_pic_url text, tags text[], notas text,
  last_msg_body text, last_msg_direction text, last_msg_timestamp timestamptz
) AS $$
  SELECT
    l.id, l.phone, l.nome, l.ctwa_clid, l.status,
    l.valor, l.created_at, l.updated_at,
    l.purchase_sent_at, l.last_message_at,
    l.profile_pic_url, l.tags, l.notas,
    m.body, m.direction, m.timestamp
  FROM leads l
  LEFT JOIN LATERAL (
    SELECT body, direction, timestamp FROM messages
    WHERE phone = l.phone ORDER BY timestamp DESC LIMIT 1
  ) m ON true
  ORDER BY COALESCE(l.last_message_at, l.created_at) DESC NULLS LAST
$$ LANGUAGE sql STABLE;
