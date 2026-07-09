import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const runPostgresTests = databaseUrl ? describe : describe.skip;
type Sql = NeonQueryFunction<false, false>;

runPostgresTests("postgres integration", () => {
  it("keeps denormalized question scores in sync with vote changes", async () => {
    const sql = neon(databaseUrl as string);
    const suffix = crypto.randomUUID();
    const email = `postgres-${suffix}@example.com`;
    const slug = `postgres-${suffix}`;
    let ownerId = "";

    try {
      const users = await sql`
        insert into users (email, supabase_user_id, auth_provider)
        values (${email}, ${`supabase-${suffix}`}, 'supabase')
        returning id::text
      `;
      ownerId = String(users[0].id);

      const events = await sql`
        insert into events (owner_id, slug, title)
        values (${ownerId}, ${slug}, 'Postgres Integration')
        returning id::text
      `;
      const eventId = String(events[0].id);

      const talks = await sql`
        insert into event_talks (event_id, title)
        values (${eventId}, 'Talk')
        returning id::text
      `;
      const talkId = String(talks[0].id);

      const questions = await sql`
        insert into questions (event_id, talk_id, body, voter_id)
        values (${eventId}, ${talkId}, 'How does the score trigger behave?', 'asker')
        returning id::text, score
      `;
      const questionId = String(questions[0].id);
      expect(Number(questions[0].score)).toBe(0);

      await sql`
        insert into question_votes (question_id, voter_id, value)
        values (${questionId}, 'voter-a', 1)
      `;
      await expectQuestionScore(sql, questionId, 1);

      await sql`
        insert into question_votes (question_id, voter_id, value)
        values (${questionId}, 'voter-b', -1)
      `;
      await expectQuestionScore(sql, questionId, 0);

      await sql`
        update question_votes
        set value = 1
        where question_id = ${questionId} and voter_id = 'voter-b'
      `;
      await expectQuestionScore(sql, questionId, 2);

      await sql`
        delete from question_votes
        where question_id = ${questionId} and voter_id = 'voter-a'
      `;
      await expectQuestionScore(sql, questionId, 1);
    } finally {
      if (ownerId) {
        await sql`delete from users where id = ${ownerId}`;
      }
    }
  });
});

async function expectQuestionScore(sql: Sql, questionId: string, expected: number): Promise<void> {
  const rows = await sql`
    select
      q.score,
      coalesce(sum(v.value), 0)::int as aggregate_score
    from questions q
    left join question_votes v on v.question_id = q.id
    where q.id = ${questionId}
    group by q.id, q.score
  `;

  expect(Number(rows[0].score)).toBe(expected);
  expect(Number(rows[0].aggregate_score)).toBe(expected);
}
