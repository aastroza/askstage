create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text not null,
  password_salt text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists users_email_lower_idx on users (lower(email));

create table if not exists auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists auth_sessions_user_id_idx on auth_sessions(user_id);
create index if not exists auth_sessions_expires_at_idx on auth_sessions(expires_at);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  slug text not null unique,
  title text not null,
  date_label text not null default '',
  location_label text not null default '',
  language text not null default 'en' check (language in ('en', 'es')),
  intro_text text not null default '',
  ask_button_label text not null default '',
  footer_label text not null default '',
  footer_url text not null default '',
  accent_color text not null default '#0f8bff',
  is_published boolean not null default true,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists events_owner_id_idx on events(owner_id);
create index if not exists events_public_lookup_idx on events(slug, is_published, is_archived);

create table if not exists event_talks (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  title text not null,
  speakers text not null default '',
  role text not null default '',
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists event_talks_event_id_idx on event_talks(event_id, position);

create table if not exists questions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  talk_id uuid references event_talks(id) on delete set null,
  body text not null,
  author_name text,
  status text not null default 'open' check (status in ('open', 'answered', 'hidden')),
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists questions_event_id_idx on questions(event_id, status, pinned, created_at);
create index if not exists questions_talk_id_idx on questions(talk_id);

create table if not exists question_votes (
  question_id uuid not null references questions(id) on delete cascade,
  voter_id text not null,
  value integer not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (question_id, voter_id)
);

create index if not exists question_votes_question_id_idx on question_votes(question_id);
