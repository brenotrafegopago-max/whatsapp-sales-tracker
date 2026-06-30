-- Execute no Supabase SQL Editor

create table if not exists quick_replies (
  id uuid primary key default gen_random_uuid(),
  body text not null,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

insert into quick_replies (body, position) values
  ('Oii, tudo bem? Como eu posso te ajudar?', 0),
  ('Eu trabalho respondendo perguntas, fazendo previsões e interpretando mapas astrais', 1),
  ('Perfeito! O pagamento é via pix, o pix está no nome do meu marido, pois ele cuida do meu financeiro! Após a transferência, me envie o comprovante, seu nome completo, sua data de nascimento e o que você deseja saber, por gentileza.', 2)
on conflict do nothing;
