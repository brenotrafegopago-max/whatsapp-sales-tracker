require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── WhatsApp Webhook Verification ───────────────────────────────────────────

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[Webhook] Verificado com sucesso');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── WhatsApp Webhook Receiver ────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde imediatamente para o WhatsApp não retentar

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        const messages = value.messages || [];

        for (const msg of messages) {
          const phone = msg.from;
          const referral = msg.referral;

          // Só processa se vier de anúncio (tem referral com ctwa_clid)
          const ctwa_clid = referral?.ctwa_clid || null;

          console.log(`[Webhook] Mensagem de ${phone}, ctwa_clid: ${ctwa_clid}`);

          // Salva ou atualiza o lead (upsert por telefone)
          // Só atualiza ctwa_clid se ainda não tiver um salvo
          const { data: existing } = await supabase
            .from('leads')
            .select('id, ctwa_clid')
            .eq('phone', phone)
            .single();

          if (!existing) {
            await supabase.from('leads').insert({
              phone,
              ctwa_clid,
            });
            console.log(`[DB] Novo lead salvo: ${phone}`);
          } else if (ctwa_clid && !existing.ctwa_clid) {
            // atualiza ctwa_clid se chegou agora (primeira msg com referral)
            await supabase
              .from('leads')
              .update({ ctwa_clid })
              .eq('id', existing.id);
            console.log(`[DB] ctwa_clid atualizado para ${phone}`);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Erro:', err.message);
  }
});

// ─── API: Listar Leads ────────────────────────────────────────────────────────

app.get('/api/leads', async (req, res) => {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── API: Marcar como Vendido ─────────────────────────────────────────────────

app.post('/api/leads/:id/venda', async (req, res) => {
  const { id } = req.params;
  const { valor, nome } = req.body;

  if (!valor || isNaN(parseFloat(valor))) {
    return res.status(400).json({ error: 'Valor inválido' });
  }

  // Busca o lead
  const { data: lead, error: fetchErr } = await supabase
    .from('leads')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchErr || !lead) return res.status(404).json({ error: 'Lead não encontrado' });

  // Atualiza status no Supabase
  await supabase
    .from('leads')
    .update({ status: 'comprou', valor: parseFloat(valor), nome })
    .eq('id', id);

  // Dispara evento para Meta Conversions API
  let metaResult = null;
  if (lead.ctwa_clid && process.env.META_PIXEL_ID && process.env.META_ACCESS_TOKEN) {
    metaResult = await sendMetaPurchaseEvent(lead, parseFloat(valor));
  }

  res.json({ ok: true, metaResult });
});

// ─── Meta Conversions API ─────────────────────────────────────────────────────

async function sendMetaPurchaseEvent(lead, valor) {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_ACCESS_TOKEN;
  const url = `https://graph.facebook.com/v19.0/${pixelId}/events`;

  const eventTime = Math.floor(Date.now() / 1000);

  // Hash do telefone (SHA256 sem +, com código de país)
  const crypto = require('crypto');
  const phoneNormalized = lead.phone.replace(/\D/g, '');
  const phoneHash = crypto.createHash('sha256').update(phoneNormalized).digest('hex');

  const payload = {
    data: [
      {
        event_name: 'Purchase',
        event_time: eventTime,
        action_source: 'other', // conversa WhatsApp = offline/other
        user_data: {
          ph: [phoneHash],
          ctwa_clid: lead.ctwa_clid,
        },
        custom_data: {
          currency: 'BRL',
          value: valor,
        },
      },
    ],
  };

  try {
    const response = await fetch(`${url}?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    console.log('[Meta CAPI] Resultado:', JSON.stringify(result));

    if (result.events_received) {
      await supabase
        .from('leads')
        .update({ purchase_sent_at: new Date().toISOString() })
        .eq('id', lead.id);
    }

    return result;
  } catch (err) {
    console.error('[Meta CAPI] Erro:', err.message);
    return { error: err.message };
  }
}

// ─── Serve o frontend ─────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📋 Dashboard: http://localhost:${PORT}`);
  console.log(`🔗 Webhook URL: http://localhost:${PORT}/webhook\n`);
});
