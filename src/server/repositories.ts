import type { NeonQueryFunction } from "@neondatabase/serverless";
import { createError } from "./http";
import { normalizeSlug } from "./validation";

export type Sql = NeonQueryFunction<false, false>;

export type EventPayload = {
  title: string;
  slug: string;
  dateLabel: string;
  locationLabel: string;
  language: string;
  introText: string;
  askButtonLabel: string;
  footerLabel: string;
  footerUrl: string;
  accentColor: string;
  isPublished: boolean;
  isArchived: boolean;
};

export type TalkPayload = {
  id: string;
  title: string;
  speakers: string;
  role: string;
  position: number;
};

export type CreateTalkPayload = Omit<TalkPayload, "id" | "position">;

export type PublicQuestionFilters = {
  status: string;
  talkId: string;
  voterId: string;
};

export async function listOwnerEvents(sql: Sql, userId: string) {
  return sql`
    select
      id::text,
      slug,
      title,
      date_label as "dateLabel",
      location_label as "locationLabel",
      language,
      is_published as "isPublished",
      is_archived as "isArchived",
      updated_at as "updatedAt"
    from events
    where owner_id = ${userId}
    order by updated_at desc
  `;
}

export async function createOwnerEventWithTalks(
  sql: Sql,
  input: {
    eventId: string;
    ownerId: string;
    slug: string;
    title: string;
    dateLabel: string;
    locationLabel: string;
    language: string;
    talks: CreateTalkPayload[];
  },
) {
  const results = await sql.transaction((tx) => [
    tx`
      insert into events (id, owner_id, slug, title, date_label, location_label, language, intro_text, ask_button_label, footer_label, footer_url)
      values (${input.eventId}, ${input.ownerId}, ${input.slug}, ${input.title}, ${input.dateLabel}, ${input.locationLabel}, ${input.language}, '', '', '', '')
      returning
        id::text,
        slug,
        title,
        date_label as "dateLabel",
        location_label as "locationLabel",
        language,
        is_published as "isPublished",
        is_archived as "isArchived",
        updated_at as "updatedAt"
    `,
    ...input.talks.map((talk, index) => tx`
      insert into event_talks (event_id, title, speakers, role, position)
      values (${input.eventId}, ${talk.title}, ${talk.speakers}, ${talk.role}, ${index})
    `),
  ]);
  return results[0][0];
}

export async function getOwnerEvent(sql: Sql, userId: string, eventId: string) {
  const eventRows = await sql`
    select
      id::text,
      slug,
      title,
      date_label as "dateLabel",
      location_label as "locationLabel",
      language,
      intro_text as "introText",
      ask_button_label as "askButtonLabel",
      footer_label as "footerLabel",
      footer_url as "footerUrl",
      accent_color as "accentColor",
      is_published as "isPublished",
      is_archived as "isArchived",
      updated_at as "updatedAt"
    from events
    where id = ${eventId} and owner_id = ${userId}
    limit 1
  `;
  const event = eventRows[0] as (Record<string, unknown> & { id: string }) | undefined;
  if (!event) throw createError(404, "Event not found.");

  const talks = await listTalks(sql, eventId);
  return { event, talks };
}

export async function updateOwnerEventRow(sql: Sql, userId: string, eventId: string, payload: EventPayload) {
  const rows = await sql`
    update events
    set
      slug = ${payload.slug},
      title = ${payload.title},
      date_label = ${payload.dateLabel},
      location_label = ${payload.locationLabel},
      language = ${payload.language},
      intro_text = ${payload.introText},
      ask_button_label = ${payload.askButtonLabel},
      footer_label = ${payload.footerLabel},
      footer_url = ${payload.footerUrl},
      accent_color = ${payload.accentColor},
      is_published = ${payload.isPublished},
      is_archived = ${payload.isArchived},
      updated_at = now()
    where id = ${eventId} and owner_id = ${userId}
    returning
      id::text,
      slug,
      title,
      date_label as "dateLabel",
      location_label as "locationLabel",
      language,
      intro_text as "introText",
      ask_button_label as "askButtonLabel",
      footer_label as "footerLabel",
      footer_url as "footerUrl",
      accent_color as "accentColor",
      is_published as "isPublished",
      is_archived as "isArchived",
      updated_at as "updatedAt"
  `;
  return rows[0];
}

export async function listTalkIds(sql: Sql, eventId: string): Promise<string[]> {
  const existingRows = await sql`select id::text from event_talks where event_id = ${eventId}`;
  return existingRows.map((row) => String(row.id));
}

export async function replaceEventTalks(sql: Sql, eventId: string, talks: TalkPayload[], deletedIds: string[]) {
  await sql.transaction((tx) => [
    ...talks.map((talk) => tx`
      insert into event_talks (id, event_id, title, speakers, role, position, updated_at)
      values (${talk.id}, ${eventId}, ${talk.title}, ${talk.speakers}, ${talk.role}, ${talk.position}, now())
      on conflict (id)
      do update set
        title = excluded.title,
        speakers = excluded.speakers,
        role = excluded.role,
        position = excluded.position,
        updated_at = now()
    `),
    ...deletedIds.map((id) => tx`delete from event_talks where id = ${id} and event_id = ${eventId}`),
    tx`update events set updated_at = now() where id = ${eventId}`,
  ]);
}

export async function listOwnerQuestions(sql: Sql, userId: string, eventId: string) {
  await assertOwnsEvent(sql, userId, eventId);
  return sql`
    select
      q.id::text,
      q.event_id as "eventId",
      q.talk_id as "talkId",
      q.body,
      q.author_name as "authorName",
      q.status,
      q.pinned,
      q.created_at as "createdAt",
      t.title as "talkTitle",
      t.speakers as "talkSpeakers",
      q.score::int as score
    from questions q
    left join event_talks t on t.id = q.talk_id
    where q.event_id = ${eventId}
    order by q.pinned desc, q.status asc, q.score desc, q.created_at asc
    limit 300
  `;
}

export async function getOwnerQuestionForUpdate(sql: Sql, userId: string, questionId: string) {
  const rows = await sql`
    select q.id::text, q.event_id::text as "eventId", q.status, q.pinned
    from questions q
    join events e on e.id = q.event_id
    where q.id = ${questionId} and e.owner_id = ${userId}
    limit 1
  `;
  return rows[0] as { id: string; eventId: string; status: string; pinned: boolean } | undefined;
}

export async function updateQuestionModeration(sql: Sql, questionId: string, status: string, pinned: boolean) {
  const updated = await sql`
    update questions
    set status = ${status}, pinned = ${pinned}, updated_at = now()
    where id = ${questionId}
    returning id::text, status, pinned
  `;
  return updated[0];
}

export async function getPublicEvent(sql: Sql, slug: string) {
  const eventRows = await sql`
    select
      id::text,
      slug,
      title,
      date_label as "dateLabel",
      location_label as "locationLabel",
      language,
      intro_text as "introText",
      ask_button_label as "askButtonLabel",
      footer_label as "footerLabel",
      footer_url as "footerUrl",
      accent_color as "accentColor",
      is_published as "isPublished",
      is_archived as "isArchived",
      updated_at as "updatedAt"
    from events
    where slug = ${slug}
      and is_published = true
      and is_archived = false
    limit 1
  `;
  const event = eventRows[0] as (Record<string, unknown> & { id: string }) | undefined;
  if (!event) throw createError(404, "Event not found.");

  const talks = await listTalks(sql, String(event.id));
  return { ...event, talks };
}

export async function getPublicEventAccess(sql: Sql, slug: string) {
  const rows = await sql`
    select id::text
    from events
    where slug = ${slug}
      and is_published = true
      and is_archived = false
    limit 1
  `;
  const event = rows[0] as { id: string } | undefined;
  if (!event) throw createError(404, "Event not found.");
  return event;
}

export async function listPublicQuestions(sql: Sql, eventId: string, filters: PublicQuestionFilters) {
  if (filters.talkId) {
    return sql`
      select
        q.id::text,
        q.event_id as "eventId",
        q.talk_id as "talkId",
        q.body,
        q.author_name as "authorName",
        q.status,
        q.pinned,
        q.created_at as "createdAt",
        t.title as "talkTitle",
        t.speakers as "talkSpeakers",
        q.score::int as score,
        coalesce(uv.value, 0)::int as "userVote"
      from questions q
      left join event_talks t on t.id = q.talk_id
      left join question_votes uv on uv.question_id = q.id and uv.voter_id = ${filters.voterId}
      where q.event_id = ${eventId}
        and q.status <> 'hidden'
        and (${filters.status} = 'all' or (${filters.status} = 'answered' and q.status = 'answered') or (${filters.status} = 'open' and q.status = 'open'))
        and q.talk_id = ${filters.talkId}
      order by q.pinned desc, q.score desc, q.created_at asc
      limit 200
    `;
  }

  return sql`
    select
      q.id::text,
      q.event_id as "eventId",
      q.talk_id as "talkId",
      q.body,
      q.author_name as "authorName",
      q.status,
      q.pinned,
      q.created_at as "createdAt",
      t.title as "talkTitle",
      t.speakers as "talkSpeakers",
      q.score::int as score,
      coalesce(uv.value, 0)::int as "userVote"
    from questions q
    left join event_talks t on t.id = q.talk_id
    left join question_votes uv on uv.question_id = q.id and uv.voter_id = ${filters.voterId}
    where q.event_id = ${eventId}
      and q.status <> 'hidden'
      and (${filters.status} = 'all' or (${filters.status} = 'answered' and q.status = 'answered') or (${filters.status} = 'open' and q.status = 'open'))
    order by q.pinned desc, q.score desc, q.created_at asc
    limit 200
  `;
}

export async function talkBelongsToEvent(sql: Sql, eventId: string, talkId: string): Promise<boolean> {
  const talkRows = await sql`
    select id::text from event_talks
    where id = ${talkId} and event_id = ${eventId}
    limit 1
  `;
  return Boolean(talkRows[0]);
}

export async function findRecentDuplicateQuestion(
  sql: Sql,
  input: { eventId: string; voterId: string; normalizedQuestion: string },
): Promise<boolean> {
  const duplicateRows = await sql`
    select id::text
    from questions
    where event_id = ${input.eventId}
      and voter_id = ${input.voterId}
      and regexp_replace(lower(trim(body)), '\\s+', ' ', 'g') = ${input.normalizedQuestion}
      and created_at > now() - interval '2 minutes'
    limit 1
  `;
  return Boolean(duplicateRows[0]);
}

export async function insertPublicQuestion(
  sql: Sql,
  input: { eventId: string; talkId: string; body: string; authorName: string | null; voterId: string },
) {
  const rows = await sql`
    insert into questions (event_id, talk_id, body, author_name, voter_id)
    values (${input.eventId}, ${input.talkId}, ${input.body}, ${input.authorName}, ${input.voterId})
    returning id::text
  `;
  return rows[0];
}

export async function getVoteTarget(sql: Sql, questionId: string) {
  const rows = await sql`
    select
      q.id::text,
      q.status,
      q.event_id::text as "eventId",
      e.is_published as "isPublished",
      e.is_archived as "isArchived"
    from questions q
    join events e on e.id = q.event_id
    where q.id = ${questionId}
    limit 1
  `;
  return rows[0] as { id: string; status: string; eventId: string; isPublished: boolean; isArchived: boolean } | undefined;
}

export async function deleteVote(sql: Sql, questionId: string, voterId: string): Promise<void> {
  await sql`delete from question_votes where question_id = ${questionId} and voter_id = ${voterId}`;
}

export async function upsertVote(sql: Sql, questionId: string, voterId: string, value: number): Promise<void> {
  await sql`
    insert into question_votes (question_id, voter_id, value, updated_at)
    values (${questionId}, ${voterId}, ${value}, now())
    on conflict (question_id, voter_id)
    do update set value = excluded.value, updated_at = now()
  `;
}

export async function listTalks(sql: Sql, eventId: string) {
  return sql`
    select id::text, title, speakers, role, position
    from event_talks
    where event_id = ${eventId}
    order by position asc, title asc
  `;
}

export async function assertOwnsEvent(sql: Sql, userId: string, eventId: string): Promise<void> {
  const rows = await sql`
    select id::text
    from events
    where id = ${eventId} and owner_id = ${userId}
    limit 1
  `;
  if (!rows[0]) throw createError(404, "Event not found.");
}

export async function uniqueSlug(sql: Sql, base: string): Promise<string> {
  const root = normalizeSlug(base) || "event";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const slug = attempt === 0 ? root : `${root}-${crypto.randomUUID().slice(0, 8)}`;
    const rows = await sql`select id from events where slug = ${slug} limit 1`;
    if (!rows[0]) return slug;
  }
  return `${root}-${crypto.randomUUID().slice(0, 12)}`;
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return (
    record.code === "23505" &&
    (record.constraint === constraint ||
      record.constraint_name === constraint ||
      record.constraintName === constraint ||
      record.detail === constraint)
  );
}
