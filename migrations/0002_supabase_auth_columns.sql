alter table users
  add column if not exists supabase_user_id text,
  add column if not exists auth_provider text not null default 'supabase';

create unique index if not exists users_supabase_user_id_idx
  on users (supabase_user_id)
  where supabase_user_id is not null;

-- Legacy password-auth columns are kept for rollback/audit purposes, but they
-- must not block Supabase-auth user creation.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'users'
      and column_name = 'password_hash'
  ) then
    alter table users alter column password_hash drop not null;
    alter table users alter column password_hash set default '';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'users'
      and column_name = 'password_salt'
  ) then
    alter table users alter column password_salt drop not null;
    alter table users alter column password_salt set default '';
  end if;
end $$;
