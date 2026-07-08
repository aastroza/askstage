import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

type WorkerEnv = Omit<Env, "ALLOW_SIGNUPS"> & {
  DATABASE_URL: string;
  ALLOW_SIGNUPS?: string;
};

type Sql = NeonQueryFunction<false, false>;

type ApiError = {
  status: number;
  message: string;
};

type UserRow = {
  id: string;
  email: string;
};

const sessionCookie = "py_session";
const sessionMaxAgeSeconds = 60 * 60 * 24 * 30;

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url, ctx);
      }

      const assetResponse = await env.ASSETS.fetch(request);
      const acceptsHtml = request.headers.get("accept")?.includes("text/html");
      if (assetResponse.status !== 404 || !acceptsHtml) {
        return assetResponse;
      }

      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
    } catch (error) {
      const apiError = normalizeError(error);
      return json({ error: apiError.message }, apiError.status);
    }
  },
} satisfies ExportedHandler<WorkerEnv>;

async function handleApi(request: Request, env: WorkerEnv, url: URL, ctx: ExecutionContext): Promise<Response> {
  const sql = neon(env.DATABASE_URL);
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/me") {
    const user = await currentUser(request, sql);
    return json({ user });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/signup") {
    if (env.ALLOW_SIGNUPS === "false") throw createError(403, "Signups are disabled.");
    return signup(request, sql, url);
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    return login(request, sql, url);
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const token = cookieValue(request, sessionCookie);
    if (token) {
      const tokenHash = await sha256(token);
      ctx.waitUntil(sql`delete from auth_sessions where token_hash = ${tokenHash}`);
    }
    return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(url) });
  }

  if (parts[1] === "owner") {
    const user = await requireUser(request, sql);

    if (request.method === "GET" && url.pathname === "/api/owner/events") {
      const events = await listOwnerEvents(sql, user.id);
      return json({ events });
    }

    if (request.method === "POST" && url.pathname === "/api/owner/events") {
      return createOwnerEvent(request, sql, user.id);
    }

    if (parts[2] === "events" && parts[3]) {
      const eventId = parts[3];

      if (request.method === "GET" && parts.length === 4) {
        const data = await getOwnerEvent(sql, user.id, eventId);
        return json(data);
      }

      if (request.method === "PATCH" && parts.length === 4) {
        return updateOwnerEvent(request, sql, user.id, eventId);
      }

      if (request.method === "PUT" && parts[4] === "talks") {
        return replaceTalks(request, sql, user.id, eventId);
      }

      if (request.method === "GET" && parts[4] === "questions") {
        const questions = await listOwnerQuestions(sql, user.id, eventId);
        return json({ questions });
      }
    }

    if (request.method === "PATCH" && parts[2] === "questions" && parts[3]) {
      return updateOwnerQuestion(request, sql, user.id, parts[3]);
    }
  }

  if (parts[1] === "public") {
    if (request.method === "GET" && parts[2] === "events" && parts[3] && parts.length === 4) {
      const event = await getPublicEvent(sql, parts[3]);
      return json({ event });
    }

    if (parts[2] === "events" && parts[3] && parts[4] === "questions") {
      if (request.method === "GET") {
        const questions = await listPublicQuestions(sql, parts[3], url);
        return json({ questions });
      }

      if (request.method === "POST") {
        return createPublicQuestion(request, sql, parts[3]);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/public/votes") {
      return vote(request, sql);
    }
  }

  throw createError(404, "Route not found.");
}

async function signup(request: Request, sql: Sql, url: URL): Promise<Response> {
  const body = await readJson(request);
  const email = normalizeEmail(assertString(body.email, "email"));
  const password = assertString(body.password, "password");
  if (password.length < 10) throw createError(400, "Password must be at least 10 characters.");

  const salt = randomToken(16);
  const passwordHash = await hashPassword(password, salt);

  try {
    const rows = await sql`
      insert into users (email, password_hash, password_salt)
      values (${email}, ${passwordHash}, ${salt})
      returning id::text, email
    `;
    return createSessionResponse(sql, rows[0] as UserRow, url, 201);
  } catch (error) {
    if (String(error).includes("users_email_lower_idx")) {
      throw createError(409, "An account already exists for that email.");
    }
    throw error;
  }
}

async function login(request: Request, sql: Sql, url: URL): Promise<Response> {
  const body = await readJson(request);
  const email = normalizeEmail(assertString(body.email, "email"));
  const password = assertString(body.password, "password");

  const rows = await sql`
    select id::text, email, password_hash, password_salt
    from users
    where lower(email) = lower(${email})
    limit 1
  `;
  const user = rows[0] as (UserRow & { password_hash: string; password_salt: string }) | undefined;
  if (!user) throw createError(401, "Invalid email or password.");

  const passwordHash = await hashPassword(password, user.password_salt);
  if (!(await timingSafeEqual(passwordHash, user.password_hash))) {
    throw createError(401, "Invalid email or password.");
  }

  return createSessionResponse(sql, { id: user.id, email: user.email }, url);
}

async function createSessionResponse(sql: Sql, user: UserRow, url: URL, status = 200): Promise<Response> {
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  await sql`
    insert into auth_sessions (user_id, token_hash, expires_at)
    values (${user.id}, ${tokenHash}, now() + interval '30 days')
  `;

  return json({ user }, status, { "set-cookie": sessionCookieHeader(token, url) });
}

async function currentUser(request: Request, sql: Sql): Promise<UserRow | null> {
  const token = cookieValue(request, sessionCookie);
  if (!token) return null;

  const tokenHash = await sha256(token);
  const rows = await sql`
    select u.id::text, u.email
    from auth_sessions s
    join users u on u.id = s.user_id
    where s.token_hash = ${tokenHash}
      and s.expires_at > now()
    limit 1
  `;

  return (rows[0] as UserRow | undefined) ?? null;
}

async function requireUser(request: Request, sql: Sql): Promise<UserRow> {
  const user = await currentUser(request, sql);
  if (!user) throw createError(401, "Authentication required.");
  return user;
}

async function listOwnerEvents(sql: Sql, userId: string) {
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

async function createOwnerEvent(request: Request, sql: Sql, userId: string): Promise<Response> {
  const body = await readJson(request);
  const title = cleanText(typeof body.title === "string" ? body.title : "Untitled event").slice(0, 140) || "Untitled event";
  const slug = await uniqueSlug(sql, slugFromTitle(title));
  const language = body.language === "es" ? "es" : "en";
  const dateLabel = cleanText(String(body.dateLabel ?? "")).slice(0, 80);
  const locationLabel = cleanText(String(body.locationLabel ?? "")).slice(0, 80);
  const talks = parseCreateTalks(body.talks, language);

  const rows = await sql`
    insert into events (owner_id, slug, title, date_label, location_label, language, intro_text, ask_button_label, footer_label, footer_url)
    values (${userId}, ${slug}, ${title}, ${dateLabel}, ${locationLabel}, ${language}, '', '', '', '')
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
  `;

  for (const [index, talk] of talks.entries()) {
    await sql`
      insert into event_talks (event_id, title, speakers, role, position)
      values (${rows[0].id}, ${talk.title}, ${talk.speakers}, ${talk.role}, ${index})
    `;
  }

  return json({ event: rows[0] }, 201);
}

async function getOwnerEvent(sql: Sql, userId: string, eventId: string) {
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

async function updateOwnerEvent(request: Request, sql: Sql, userId: string, eventId: string): Promise<Response> {
  const body = await readJson(request);
  await assertOwnsEvent(sql, userId, eventId);

  const payload = parseEventPayload(body);
  try {
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
    return json({ event: rows[0] });
  } catch (error) {
    if (String(error).includes("events_slug_key")) throw createError(409, "That slug is already in use.");
    throw error;
  }
}

async function replaceTalks(request: Request, sql: Sql, userId: string, eventId: string): Promise<Response> {
  await assertOwnsEvent(sql, userId, eventId);
  const body = await readJson(request);
  const incoming = Array.isArray(body.talks) ? body.talks : [];
  if (!incoming.length) throw createError(400, "At least one talk is required.");
  if (incoming.length > 40) throw createError(400, "An event can have up to 40 talks.");

  const existingRows = await sql`select id::text from event_talks where event_id = ${eventId}`;
  const existingIds = new Set(existingRows.map((row) => String(row.id)));
  const nextIds = new Set<string>();

  for (let index = 0; index < incoming.length; index += 1) {
    const raw = incoming[index] as Record<string, unknown>;
    const id = typeof raw.id === "string" && existingIds.has(raw.id) ? raw.id : crypto.randomUUID();
    const title = cleanText(assertString(raw.title, "talk title")).slice(0, 160);
    const speakers = cleanText(typeof raw.speakers === "string" ? raw.speakers : "").slice(0, 280);
    const role = cleanText(typeof raw.role === "string" ? raw.role : "").slice(0, 160);
    nextIds.add(id);

    await sql`
      insert into event_talks (id, event_id, title, speakers, role, position, updated_at)
      values (${id}, ${eventId}, ${title}, ${speakers}, ${role}, ${index}, now())
      on conflict (id)
      do update set
        title = excluded.title,
        speakers = excluded.speakers,
        role = excluded.role,
        position = excluded.position,
        updated_at = now()
    `;
  }

  for (const row of existingRows) {
    const id = String(row.id);
    if (!nextIds.has(id)) {
      await sql`delete from event_talks where id = ${id} and event_id = ${eventId}`;
    }
  }

  await sql`update events set updated_at = now() where id = ${eventId}`;
  const talks = await listTalks(sql, eventId);
  return json({ talks });
}

async function listOwnerQuestions(sql: Sql, userId: string, eventId: string) {
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
      coalesce(v.score, 0)::int as score
    from questions q
    left join event_talks t on t.id = q.talk_id
    left join (
      select question_id, sum(value)::int as score
      from question_votes
      group by question_id
    ) v on v.question_id = q.id
    where q.event_id = ${eventId}
    order by q.pinned desc, q.status asc, score desc, q.created_at asc
    limit 300
  `;
}

async function updateOwnerQuestion(request: Request, sql: Sql, userId: string, questionId: string): Promise<Response> {
  const body = await readJson(request);
  const rows = await sql`
    select q.id::text, q.status, q.pinned
    from questions q
    join events e on e.id = q.event_id
    where q.id = ${questionId} and e.owner_id = ${userId}
    limit 1
  `;
  const question = rows[0] as { id: string; status: string; pinned: boolean } | undefined;
  if (!question) throw createError(404, "Question not found.");

  const status = body.status === undefined ? question.status : assertQuestionStatus(body.status);
  const pinned = typeof body.pinned === "boolean" ? body.pinned : question.pinned;
  const updated = await sql`
    update questions
    set status = ${status}, pinned = ${pinned}, updated_at = now()
    where id = ${questionId}
    returning id::text, status, pinned
  `;

  return json({ question: updated[0] });
}

async function getPublicEvent(sql: Sql, slug: string) {
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

async function listPublicQuestions(sql: Sql, slug: string, url: URL) {
  const event = await getPublicEvent(sql, slug);
  const voterId = safeVoterId(url.searchParams.get("voterId"));
  const status = url.searchParams.get("status") ?? "open";
  const talkId = safeUuid(url.searchParams.get("talkId"));

  if (talkId) {
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
        coalesce(v.score, 0)::int as score,
        coalesce(uv.value, 0)::int as "userVote"
      from questions q
      left join event_talks t on t.id = q.talk_id
      left join (
        select question_id, sum(value)::int as score
        from question_votes
        group by question_id
      ) v on v.question_id = q.id
      left join question_votes uv on uv.question_id = q.id and uv.voter_id = ${voterId}
      where q.event_id = ${event.id}
        and q.status <> 'hidden'
        and (${status} = 'all' or (${status} = 'answered' and q.status = 'answered') or (${status} = 'open' and q.status = 'open'))
        and q.talk_id = ${talkId}
      order by q.pinned desc, score desc, q.created_at asc
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
      coalesce(v.score, 0)::int as score,
      coalesce(uv.value, 0)::int as "userVote"
    from questions q
    left join event_talks t on t.id = q.talk_id
    left join (
      select question_id, sum(value)::int as score
      from question_votes
      group by question_id
    ) v on v.question_id = q.id
    left join question_votes uv on uv.question_id = q.id and uv.voter_id = ${voterId}
    where q.event_id = ${event.id}
      and q.status <> 'hidden'
      and (${status} = 'all' or (${status} = 'answered' and q.status = 'answered') or (${status} = 'open' and q.status = 'open'))
    order by q.pinned desc, score desc, q.created_at asc
    limit 200
  `;
}
async function createPublicQuestion(request: Request, sql: Sql, slug: string): Promise<Response> {
  const body = await readJson(request);
  const event = await getPublicEvent(sql, slug);
  const talkId = assertString(body.talkId, "talkId");
  const questionBody = cleanText(assertString(body.body, "body"));
  const authorName = body.authorName ? cleanText(String(body.authorName)).slice(0, 80) : null;

  if (questionBody.length < 8 || questionBody.length > 280) {
    throw createError(400, "Question must be between 8 and 280 characters.");
  }

  const talkRows = await sql`
    select id::text from event_talks
    where id = ${talkId} and event_id = ${event.id}
    limit 1
  `;
  if (!talkRows[0]) throw createError(400, "Talk does not belong to this event.");

  const rows = await sql`
    insert into questions (event_id, talk_id, body, author_name)
    values (${event.id}, ${talkId}, ${questionBody}, ${authorName})
    returning id::text
  `;

  return json({ question: rows[0] }, 201);
}

async function vote(request: Request, sql: Sql): Promise<Response> {
  const body = await readJson(request);
  const questionId = assertString(body.questionId, "questionId");
  const voterId = safeVoterId(assertString(body.voterId, "voterId"));
  const value = Number(body.value);

  if (![-1, 0, 1].includes(value)) throw createError(400, "Invalid vote.");

  if (value === 0) {
    await sql`delete from question_votes where question_id = ${questionId} and voter_id = ${voterId}`;
  } else {
    await sql`
      insert into question_votes (question_id, voter_id, value, updated_at)
      values (${questionId}, ${voterId}, ${value}, now())
      on conflict (question_id, voter_id)
      do update set value = excluded.value, updated_at = now()
    `;
  }

  return json({ ok: true });
}

async function listTalks(sql: Sql, eventId: string) {
  return sql`
    select id::text, title, speakers, role, position
    from event_talks
    where event_id = ${eventId}
    order by position asc, title asc
  `;
}

async function assertOwnsEvent(sql: Sql, userId: string, eventId: string): Promise<void> {
  const rows = await sql`
    select id::text
    from events
    where id = ${eventId} and owner_id = ${userId}
    limit 1
  `;
  if (!rows[0]) throw createError(404, "Event not found.");
}

function parseEventPayload(body: Record<string, unknown>) {
  const language = body.language === "es" ? "es" : "en";
  const accentColor = String(body.accentColor ?? "").trim();
  const footerUrl = String(body.footerUrl ?? "").trim();
  const slug = normalizeSlug(assertString(body.slug, "slug"));
  if (!slug) throw createError(400, "Slug is required.");
  if (!/^#[0-9a-fA-F]{6}$/.test(accentColor)) throw createError(400, "Accent color must be a hex color.");
  if (footerUrl && !isHttpUrl(footerUrl)) throw createError(400, "Footer URL must be a valid http or https URL.");

  return {
    title: cleanText(assertString(body.title, "title")).slice(0, 140),
    slug,
    dateLabel: cleanText(String(body.dateLabel ?? "")).slice(0, 80),
    locationLabel: cleanText(String(body.locationLabel ?? "")).slice(0, 80),
    language,
    introText: cleanText(String(body.introText ?? "")).slice(0, 220),
    askButtonLabel: cleanText(String(body.askButtonLabel ?? "")).slice(0, 40),
    footerLabel: cleanText(String(body.footerLabel ?? "")).slice(0, 80),
    footerUrl,
    accentColor,
    isPublished: Boolean(body.isPublished),
    isArchived: Boolean(body.isArchived),
  };
}

function parseCreateTalks(value: unknown, language: string) {
  const fallbackTitle = language === "es" ? "Sesion principal" : "Main session";
  if (!Array.isArray(value)) {
    return [{ title: fallbackTitle, speakers: "", role: "" }];
  }

  const talks = value
    .slice(0, 40)
    .map((item) => {
      const raw = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      return {
        title: cleanText(String(raw.title ?? "")).slice(0, 160),
        speakers: cleanText(String(raw.speakers ?? "")).slice(0, 280),
        role: cleanText(String(raw.role ?? "")).slice(0, 160),
      };
    })
    .filter((talk) => talk.title);

  return talks.length ? talks : [{ title: fallbackTitle, speakers: "", role: "" }];
}

async function uniqueSlug(sql: Sql, base: string): Promise<string> {
  const root = normalizeSlug(base) || "event";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const slug = attempt === 0 ? root : `${root}-${crypto.randomUUID().slice(0, 8)}`;
    const rows = await sql`select id from events where slug = ${slug} limit 1`;
    if (!rows[0]) return slug;
  }
  return `${root}-${crypto.randomUUID().slice(0, 12)}`;
}

function slugFromTitle(value: string): string {
  return normalizeSlug(value) || "event";
}

function normalizeSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function assertQuestionStatus(value: unknown): string {
  if (value === "open" || value === "answered" || value === "hidden") return value;
  throw createError(400, "Invalid question status.");
}

function safeUuid(value: string | null): string {
  if (!value) return "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : "";
}

function safeVoterId(value: string | null): string {
  if (!value) return "anonymous";
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "anonymous";
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw createError(400, "Invalid email.");
  return email;
}

function assertString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw createError(400, `Missing ${name}.`);
  }
  return value.trim();
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const data = await request.json().catch(() => null);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw createError(400, "Invalid JSON.");
  }
  return data as Record<string, unknown>;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...jsonHeaders, ...headers },
  });
}

function sessionCookieHeader(token: string, url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${sessionCookie}=${token}; Max-Age=${sessionMaxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function clearSessionCookie(url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${sessionCookie}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return rawValue.join("=");
  }

  return null;
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: toArrayBuffer(base64UrlToBytes(salt)),
      iterations: 100000,
    },
    key,
    256,
  );
  return base64UrlEncode(new Uint8Array(bits));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;

  let diff = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    diff |= leftBytes[index] ^ rightBytes[index];
  }
  return diff === 0;
}

function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function createError(status: number, message: string): ApiError {
  return { status, message };
}

function normalizeError(error: unknown): ApiError {
  if (isApiError(error)) return error;
  console.error(JSON.stringify({ level: "error", message: String(error) }));
  return { status: 500, message: "Internal server error." };
}

function isApiError(error: unknown): error is ApiError {
  return Boolean(
    error &&
      typeof error === "object" &&
      "status" in error &&
      "message" in error &&
      typeof (error as ApiError).status === "number" &&
      typeof (error as ApiError).message === "string",
  );
}
