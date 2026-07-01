require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const multer = require('multer');

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

        const contacts = value.contacts || [];

        // Status de entrega (delivered/read)
        const statuses = value.statuses || [];
        for (const st of statuses) {
          if (st.status && st.id) {
            await supabase.from('messages')
              .update({ status: st.status })
              .eq('wa_message_id', st.id);
            console.log(`[Webhook] Status ${st.id} → ${st.status}`);
          }
        }

        for (const msg of messages) {
          const phone = msg.from;
          const referral = msg.referral;
          const ctwa_clid = referral?.ctwa_clid || null;
          const profileName = contacts.find(c => c.wa_id === phone)?.profile?.name || null;
          const body = extractMessageBody(msg);
          const nowIso = new Date().toISOString();

          console.log(`[Webhook] Mensagem de ${phone}, ctwa_clid: ${ctwa_clid}`);

          const { data: existing } = await supabase
            .from('leads')
            .select('id, ctwa_clid, nome')
            .eq('phone', phone)
            .single();

          if (!existing) {
            await supabase.from('leads').insert({
              phone,
              ctwa_clid,
              nome: profileName,
              status: 'novo',
              last_message_at: nowIso,
            });
            console.log(`[DB] Novo lead salvo: ${phone}`);
          } else {
            const updates = { last_message_at: nowIso };
            if (ctwa_clid && !existing.ctwa_clid) updates.ctwa_clid = ctwa_clid;
            if (profileName && !existing.nome) updates.nome = profileName;
            await supabase.from('leads').update(updates).eq('id', existing.id);
          }

          // Salva a mensagem recebida no histórico
          await supabase.from('messages').insert({
            phone,
            direction: 'in',
            type: msg.type || 'text',
            body,
            wa_message_id: msg.id || null,
            timestamp: nowIso,
          });
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Erro:', err.message);
  }
});

function extractMessageBody(msg) {
  switch (msg.type) {
    case 'text': return msg.text?.body || '';
    case 'image': return msg.image?.caption || '[Imagem]';
    case 'video': return msg.video?.caption || '[Vídeo]';
    case 'audio': return '[Áudio]';
    case 'document': return msg.document?.caption || `[Documento] ${msg.document?.filename || ''}`;
    case 'sticker': return '[Figurinha]';
    case 'location': return '[Localização]';
    case 'button': return msg.button?.text || '[Botão]';
    case 'interactive':
      return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '[Interação]';
    default: return `[${msg.type}]`;
  }
}

// ─── API: Conversas (lista estilo WhatsApp Web) ───────────────────────────────

app.get('/api/conversations', async (req, res) => {
  const { data, error } = await supabase.rpc('get_conversations');
  if (error) return res.status(500).json({ error: error.message });

  const conversations = (data || []).map(row => ({
    id: row.id, phone: row.phone, nome: row.nome, ctwa_clid: row.ctwa_clid,
    status: row.status, valor: row.valor, created_at: row.created_at,
    updated_at: row.updated_at, purchase_sent_at: row.purchase_sent_at,
    last_message_at: row.last_message_at,
    profile_pic_url: row.profile_pic_url || null,
    tags: row.tags || [],
    notas: row.notas || null,
    lastMessage: row.last_msg_body != null ? {
      body: row.last_msg_body,
      direction: row.last_msg_direction,
      timestamp: row.last_msg_timestamp,
    } : null,
  }));

  res.json(conversations);
});

// ─── API: Histórico de mensagens de um contato ────────────────────────────────

app.get('/api/messages/:phone', async (req, res) => {
  const { phone } = req.params;
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('phone', phone)
    .order('timestamp', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── API: Enviar mensagem via Cloud API ───────────────────────────────────────

app.post('/api/messages/:phone/send', async (req, res) => {
  const { phone } = req.params;
  const { body } = req.body;

  if (!body || !body.trim()) {
    return res.status(400).json({ error: 'Mensagem vazia' });
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/v25.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone,
          type: 'text',
          text: { body },
        }),
      }
    );
    const result = await response.json();

    if (!response.ok) {
      console.error('[WhatsApp Send] Erro:', JSON.stringify(result));
      return res.status(502).json({ error: result.error?.message || 'Falha ao enviar mensagem' });
    }

    const nowIso = new Date().toISOString();
    await supabase.from('messages').insert({
      phone,
      direction: 'out',
      type: 'text',
      body,
      wa_message_id: result.messages?.[0]?.id || null,
      timestamp: nowIso,
      status: 'sent',
    });
    await supabase.from('leads').update({ last_message_at: nowIso }).eq('phone', phone);

    res.json({ ok: true, result });
  } catch (err) {
    console.error('[WhatsApp Send] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Atualizar status do lead ────────────────────────────────────────────

const VALID_STATUSES = ['novo', 'em_atendimento', 'aguardando_pix', 'comprou', 'nao_comprou'];

app.patch('/api/leads/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Status inválido' });
  }

  const { error } = await supabase.from('leads').update({ status }).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ ok: true });
});

// ─── CRM ────────────────────────────────────────────────────────────────────

app.get('/crm', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'crm.html'));
});

app.get('/crm/config', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'crm-config.html'));
});

// ─── API: Quick Replies ───────────────────────────────────────────────────────

app.get('/api/quick-replies', async (req, res) => {
  const { data, error } = await supabase
    .from('quick_replies')
    .select('*')
    .order('position', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/quick-replies', async (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Texto vazio' });
  const { data: existing } = await supabase.from('quick_replies').select('position').order('position', { ascending: false }).limit(1);
  const position = (existing?.[0]?.position ?? -1) + 1;
  const { data, error } = await supabase.from('quick_replies').insert({ body: body.trim(), position }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/quick-replies/:id', async (req, res) => {
  const { id } = req.params;
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Texto vazio' });
  const { error } = await supabase.from('quick_replies').update({ body: body.trim() }).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete('/api/quick-replies/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('quick_replies').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── API: Tags e Notas ───────────────────────────────────────────────────────

app.patch('/api/leads/:id/tags', async (req, res) => {
  const { id } = req.params;
  const { tags } = req.body;
  if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags deve ser array' });
  const { error } = await supabase.from('leads').update({ tags }).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.patch('/api/leads/:id/notas', async (req, res) => {
  const { id } = req.params;
  const { notas } = req.body;
  const { error } = await supabase.from('leads').update({ notas: notas ?? null }).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── API: Atualizar nome do lead ──────────────────────────────────────────────

app.patch('/api/leads/:id/nome', async (req, res) => {
  const { id } = req.params;
  const { nome } = req.body;
  const { error } = await supabase
    .from('leads')
    .update({ nome: nome?.trim() || null })
    .eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

// ─── API: Foto de perfil do contato ──────────────────────────────────────────

app.get('/api/contacts/:phone/profile-photo', async (req, res) => {
  const { phone } = req.params;
  const { data: lead } = await supabase.from('leads').select('profile_pic_url').eq('phone', phone).single();
  if (lead?.profile_pic_url) return res.json({ url: lead.profile_pic_url });

  try {
    const r = await fetch(
      `https://graph.facebook.com/v25.0/${process.env.PHONE_NUMBER_ID}/contacts`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocking: 'wait', contacts: [`+${phone}`], force_check: false }),
      }
    );
    const data = await r.json();
    const pic = data.contacts?.[0]?.profile?.picture || null;
    if (pic) await supabase.from('leads').update({ profile_pic_url: pic }).eq('phone', phone);
    res.json({ url: pic });
  } catch {
    res.json({ url: null });
  }
});

// ─── API: Enviar imagem por URL (quick replies com imagem) ────────────────────
// Estratégia: baixa a imagem do Supabase Storage, faz upload pro WhatsApp
// media endpoint (obtém media_id) e envia com o id — mais confiável que link direto.

app.post('/api/messages/:phone/send-image-url', async (req, res) => {
  const { phone } = req.params;
  const { image_url, caption } = req.body;
  if (!image_url) return res.status(400).json({ error: 'URL da imagem ausente' });

  try {
    // Extrai o filename e gera uma signed URL válida por 1h (bucket pode ser privado)
    const filename = image_url.split('/quick-reply-images/').pop();
    const { data: signed, error: signErr } = await supabase.storage
      .from('quick-reply-images')
      .createSignedUrl(filename, 3600);
    if (signErr || !signed?.signedUrl) {
      console.error('[QR Image Signed URL]', signErr?.message);
      return res.status(502).json({ error: 'Falha ao gerar URL de acesso à imagem' });
    }

    const msgPayload = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'image',
      image: { link: signed.signedUrl, ...(caption ? { caption } : {}) },
    };
    const sendRes = await fetch(`https://graph.facebook.com/v25.0/${process.env.PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(msgPayload),
    });
    const sendData = await sendRes.json();
    if (!sendRes.ok) {
      console.error('[QR Image Send]', JSON.stringify(sendData));
      return res.status(502).json({ error: sendData.error?.message || 'Falha ao enviar imagem' });
    }

    const nowIso = new Date().toISOString();
    const label = caption ? `[Imagem] ${caption}` : '[Imagem]';
    await supabase.from('messages').insert({
      phone, direction: 'out', type: 'image', body: label,
      wa_message_id: sendData.messages?.[0]?.id || null, timestamp: nowIso, status: 'sent',
    });
    await supabase.from('leads').update({ last_message_at: nowIso }).eq('phone', phone);
    res.json({ ok: true });
  } catch (err) {
    console.error('[QR Image]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Imagem nas respostas rápidas (Supabase Storage) ────────────────────

app.post('/api/quick-replies/:id/image', upload.single('image'), async (req, res) => {
  const { id } = req.params;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  const ext = (file.originalname.split('.').pop() || 'jpg').toLowerCase();
  const filename = `${id}-${Date.now()}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from('quick-reply-images')
    .upload(filename, file.buffer, { contentType: file.mimetype, upsert: true });

  if (upErr) return res.status(500).json({ error: upErr.message });

  const { data: urlData } = supabase.storage.from('quick-reply-images').getPublicUrl(filename);
  const image_url = urlData.publicUrl;

  await supabase.from('quick_replies').update({ image_url }).eq('id', id);
  res.json({ ok: true, image_url });
});

app.delete('/api/quick-replies/:id/image', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('quick_replies').update({ image_url: null }).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── API: Enviar mídia (imagem / áudio) via Cloud API ────────────────────────

app.post('/api/messages/:phone/media', upload.single('file'), async (req, res) => {
  const { phone } = req.params;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  const isAudio = file.mimetype.startsWith('audio/');
  const isImage = file.mimetype.startsWith('image/');
  const msgType = isImage ? 'image' : isAudio ? 'audio' : 'document';

  try {
    // 1. Upload da mídia para o WhatsApp
    const { FormData, Blob } = await import('node:buffer').then(() => globalThis);
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname);

    const uploadRes = await fetch(
      `https://graph.facebook.com/v25.0/${process.env.PHONE_NUMBER_ID}/media`,
      { method: 'POST', headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }, body: form }
    );
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) {
      console.error('[Media Upload]', JSON.stringify(uploadData));
      return res.status(502).json({ error: uploadData.error?.message || 'Falha no upload de mídia' });
    }

    const mediaId = uploadData.id;

    // 2. Envia a mensagem com a mídia
    const msgPayload = {
      messaging_product: 'whatsapp',
      to: phone,
      type: msgType,
      [msgType]: { id: mediaId },
    };
    const sendRes = await fetch(
      `https://graph.facebook.com/v25.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(msgPayload),
      }
    );
    const sendData = await sendRes.json();
    if (!sendRes.ok) {
      console.error('[Media Send]', JSON.stringify(sendData));
      return res.status(502).json({ error: sendData.error?.message || 'Falha ao enviar mídia' });
    }

    // 3. Salva no Supabase
    const nowIso = new Date().toISOString();
    const label = isImage ? `[Imagem: ${file.originalname}]` : isAudio ? `[Áudio: ${file.originalname}]` : `[Arquivo: ${file.originalname}]`;
    await supabase.from('messages').insert({
      phone, direction: 'out', type: msgType, body: label,
      wa_message_id: sendData.messages?.[0]?.id || null, timestamp: nowIso,
    });
    await supabase.from('leads').update({ last_message_at: nowIso }).eq('phone', phone);

    res.json({ ok: true });
  } catch (err) {
    console.error('[Media]', err.message);
    res.status(500).json({ error: err.message });
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
  const { valor, nome, tipo_leitura } = req.body;

  if (!valor || isNaN(parseFloat(valor))) {
    return res.status(400).json({ error: 'Valor inválido' });
  }

  const { data: lead, error: fetchErr } = await supabase
    .from('leads')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchErr || !lead) return res.status(404).json({ error: 'Lead não encontrado' });

  const updateData = { status: 'comprou', valor: parseFloat(valor) };
  if (nome?.trim()) updateData.nome = nome.trim();

  await supabase.from('leads').update(updateData).eq('id', id);

  // Dispara evento para Meta Conversions API
  let metaResult = null;
  if (lead.ctwa_clid && process.env.META_PIXEL_ID && process.env.META_ACCESS_TOKEN) {
    metaResult = await sendMetaPurchaseEvent(lead, parseFloat(valor));
  }

  // Notificação WhatsApp para número pessoal
  try {
    const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    const nomeCliente = nome?.trim() || lead.nome || 'Sem nome';
    const valorFmt = parseFloat(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const tipoInfo = tipo_leitura ? ` | Tipo: ${tipo_leitura}` : '';
    const notifMsg = `💰 Venda registrada!\nCliente: ${nomeCliente}\nValor: ${valorFmt}${tipoInfo}\nHorário: ${hora}`;

    await fetch(`https://graph.facebook.com/v25.0/${process.env.PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: '5531975073396',
        type: 'text',
        text: { body: notifMsg },
      }),
    });
    console.log(`[Notif] Venda notificada para número pessoal`);
  } catch (e) {
    console.error('[Notif] Erro ao enviar notificação:', e.message);
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
