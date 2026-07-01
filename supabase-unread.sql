-- Execute no Supabase SQL Editor (unread_count 2026-07)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS unread_count integer DEFAULT 0;

-- Atualiza get_conversations para retornar unread_count
CREATE OR REPLACE FUNCTION get_conversations()
RETURNS TABLE (
  id uuid, phone text, nome text, ctwa_clid text, status text,
  valor numeric, created_at timestamptz, updated_at timestamptz,
  purchase_sent_at timestamptz, last_message_at timestamptz,
  profile_pic_url text, tags text[], notas text, unread_count integer,
  last_msg_body text, last_msg_direction text, last_msg_timestamp timestamptz
) AS $$
  SELECT
    l.id, l.phone, l.nome, l.ctwa_clid, l.status,
    l.valor, l.created_at, l.updated_at,
    l.purchase_sent_at, l.last_message_at,
    l.profile_pic_url, l.tags, l.notas,
    COALESCE(l.unread_count, 0),
    m.body, m.direction, m.timestamp
  FROM leads l
  LEFT JOIN LATERAL (
    SELECT body, direction, timestamp FROM messages
    WHERE phone = l.phone ORDER BY timestamp DESC LIMIT 1
  ) m ON true
  ORDER BY COALESCE(l.last_message_at, l.created_at) DESC NULLS LAST
$$ LANGUAGE sql STABLE;
