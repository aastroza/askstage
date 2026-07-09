alter table questions
  add column if not exists voter_id text;

create index if not exists questions_voter_recent_idx
  on questions(event_id, voter_id, created_at desc)
  where voter_id is not null;
