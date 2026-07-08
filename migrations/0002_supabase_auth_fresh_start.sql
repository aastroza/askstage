-- Fresh auth migration for Supabase Auth.
-- This intentionally removes existing local users and cascades their owned data.
delete from users;

drop table if exists auth_sessions;

alter table users
  drop column if exists password_hash,
  drop column if exists password_salt;

alter table users
  add column if not exists supabase_user_id text,
  add column if not exists auth_provider text not null default 'supabase';

create unique index if not exists users_supabase_user_id_idx
  on users (supabase_user_id)
  where supabase_user_id is not null;
