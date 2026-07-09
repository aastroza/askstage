alter table questions
  add column if not exists score integer not null default 0;

update questions q
set score = coalesce((
  select sum(v.value)::int
  from question_votes v
  where v.question_id = q.id
), 0);

create index if not exists questions_public_rank_idx
  on questions(event_id, status, pinned desc, score desc, created_at asc);

create or replace function sync_question_vote_score()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    update questions
    set score = score + new.value
    where id = new.question_id;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.question_id = old.question_id then
      update questions
      set score = score + new.value - old.value
      where id = new.question_id;
    else
      update questions
      set score = score - old.value
      where id = old.question_id;

      update questions
      set score = score + new.value
      where id = new.question_id;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    update questions
    set score = score - old.value
    where id = old.question_id;
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists question_votes_score_sync_trigger on question_votes;

create trigger question_votes_score_sync_trigger
after insert or update or delete on question_votes
for each row
execute function sync_question_vote_score();
