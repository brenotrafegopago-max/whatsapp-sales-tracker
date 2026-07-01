-- Execute no Supabase SQL Editor
alter table messages add column if not exists type text not null default 'text';
