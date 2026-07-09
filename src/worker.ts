import { neon } from "@neondatabase/serverless";
import {
  currentUser,
  requireUser,
  type UserRow,
  validateSupabaseClaims,
} from "./server/auth";
import {
  canonicalOriginResponse,
  contentSecurityPolicy,
  createError,
  json,
  normalizeError,
  withSecurityHeaders,
} from "./server/http";
import {
  base64UrlDecode,
  base64UrlEncode,
  clientIp,
  cookieValue,
  createVoterToken,
  enforceRateLimit,
  optionalVoterToken,
  rateLimitKey,
  requireVoterToken,
  type RateLimitBinding,
  type VoterTokenPayload,
  verifyVoterToken,
  voterCookie,
} from "./server/voterSecurity";
import {
  assertQuestionStatus,
  assertString,
  cleanText,
  isHttpUrl,
  normalizeQuestionBody,
  normalizeSlug,
  readJson,
  safeUuid,
  slugFromTitle,
} from "./server/validation";
import * as repository from "./server/repositories";
import type { Sql, TalkPayload } from "./server/repositories";
import { broadcastQuestionsChanged, createQuestionStream } from "./server/realtime";

type WorkerEnv = Omit<Env, "SUPABASE_URL" | "SUPABASE_ANON_KEY"> & {
  DATABASE_URL: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_JWT_AUDIENCE?: string;
  PUBLIC_ORIGIN?: string;
  PUBLIC_TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  VOTER_TOKEN_SECRET?: string;
  PUBLIC_QUESTION_RATE_LIMIT?: RateLimitBinding;
  PUBLIC_VOTE_RATE_LIMIT?: RateLimitBinding;
  PUBLIC_QUESTION_READ_RATE_LIMIT?: RateLimitBinding;
};

let sqlFactory = neon;

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    try {
      const originResponse = canonicalOriginResponse(request, env, url);
      if (originResponse) {
        return withSecurityHeaders(originResponse, url);
      }

      if (url.pathname.startsWith("/api/")) {
        return withSecurityHeaders(await handleApi(request, env, url), url);
      }

      const assetResponse = withSecurityHeaders(await env.ASSETS.fetch(request), url);
      const acceptsHtml = request.headers.get("accept")?.includes("text/html");
      if (assetResponse.status !== 404 || !acceptsHtml) {
        return assetResponse;
      }

      return withSecurityHeaders(await env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request)), url);
    } catch (error) {
      const apiError = normalizeError(error);
      return withSecurityHeaders(json({ error: apiError.message }, apiError.status), url);
    }
  },
} satisfies ExportedHandler<WorkerEnv>;

async function handleApi(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/auth/config") {
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      throw createError(500, "Supabase Auth is not configured.");
    }
    return json({
      supabaseUrl: env.SUPABASE_URL,
      supabaseAnonKey: env.SUPABASE_ANON_KEY,
    });
  }

  if (request.method === "POST" && (url.pathname === "/api/auth/signup" || url.pathname === "/api/auth/login")) {
    throw createError(410, "Password authentication has been replaced by Google sign-in.");
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    return json({ ok: true });
  }

  if (url.pathname !== "/api/me" && parts[1] !== "owner" && parts[1] !== "public") {
    throw createError(404, "Route not found.");
  }

  const sql = sqlFactory(env.DATABASE_URL);

  if (request.method === "GET" && url.pathname === "/api/me") {
    const user = await currentUser(request, env, sql);
    return json({ user });
  }

  if (parts[1] === "owner") {
    const user = await requireUser(request, env, sql);

    if (request.method === "GET" && url.pathname === "/api/owner/events") {
      const events = await repository.listOwnerEvents(sql, user.id);
      return json({ events });
    }

    if (request.method === "POST" && url.pathname === "/api/owner/events") {
      return createOwnerEvent(request, sql, user.id);
    }

    if (parts[2] === "events" && parts[3]) {
      const eventId = parts[3];

      if (request.method === "GET" && parts.length === 4) {
        const data = await repository.getOwnerEvent(sql, user.id, eventId);
        return json(data);
      }

      if (request.method === "PATCH" && parts.length === 4) {
        return updateOwnerEvent(request, sql, user.id, eventId);
      }

      if (request.method === "PUT" && parts[4] === "talks") {
        return replaceTalks(request, sql, user.id, eventId);
      }

      if (request.method === "GET" && parts[4] === "stream") {
        return streamOwnerQuestions(sql, user.id, eventId);
      }

      if (request.method === "GET" && parts[4] === "questions") {
        const questions = await repository.listOwnerQuestions(sql, user.id, eventId);
        return json({ questions });
      }
    }

    if (request.method === "PATCH" && parts[2] === "questions" && parts[3]) {
      return updateOwnerQuestion(request, sql, user.id, parts[3]);
    }
  }

  if (parts[1] === "public") {
    if (request.method === "GET" && parts[2] === "events" && parts[3] && parts.length === 4) {
      const event = await getPublicEvent(env, sql, parts[3]);
      return json({ event });
    }

    if (request.method === "POST" && parts[2] === "events" && parts[3] && parts[4] === "voter" && parts.length === 5) {
      return issuePublicVoter(request, env, sql, parts[3]);
    }

    if (request.method === "GET" && parts[2] === "events" && parts[3] && parts[4] === "stream" && parts.length === 5) {
      return streamPublicQuestions(sql, parts[3]);
    }

    if (parts[2] === "events" && parts[3] && parts[4] === "questions") {
      if (request.method === "GET") {
        const questions = await listPublicQuestions(request, env, sql, parts[3], url);
        return json({ questions });
      }

      if (request.method === "POST") {
        return createPublicQuestion(request, env, sql, parts[3]);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/public/votes") {
      return vote(request, env, sql);
    }
  }

  throw createError(404, "Route not found.");
}

async function createOwnerEvent(request: Request, sql: Sql, userId: string): Promise<Response> {
  const body = await readJson(request);
  const title = cleanText(typeof body.title === "string" ? body.title : "Untitled event").slice(0, 140) || "Untitled event";
  const slug = await repository.uniqueSlug(sql, slugFromTitle(title));
  const language = body.language === "es" ? "es" : "en";
  const dateLabel = cleanText(String(body.dateLabel ?? "")).slice(0, 80);
  const locationLabel = cleanText(String(body.locationLabel ?? "")).slice(0, 80);
  const talks = parseCreateTalks(body.talks, language);
  const eventId = crypto.randomUUID();

  const event = await repository.createOwnerEventWithTalks(sql, {
    eventId,
    ownerId: userId,
    slug,
    title,
    dateLabel,
    locationLabel,
    language,
    talks,
  });

  return json({ event }, 201);
}

async function updateOwnerEvent(request: Request, sql: Sql, userId: string, eventId: string): Promise<Response> {
  const body = await readJson(request);
  await repository.assertOwnsEvent(sql, userId, eventId);

  const payload = parseEventPayload(body);
  try {
    const event = await repository.updateOwnerEventRow(sql, userId, eventId, payload);
    return json({ event });
  } catch (error) {
    if (repository.isUniqueViolation(error, "events_slug_key")) throw createError(409, "That slug is already in use.");
    throw error;
  }
}

async function replaceTalks(request: Request, sql: Sql, userId: string, eventId: string): Promise<Response> {
  await repository.assertOwnsEvent(sql, userId, eventId);
  const body = await readJson(request);
  const incoming = Array.isArray(body.talks) ? body.talks : [];
  if (!incoming.length) throw createError(400, "At least one talk is required.");
  if (incoming.length > 40) throw createError(400, "An event can have up to 40 talks.");

  const existingTalkIds = await repository.listTalkIds(sql, eventId);
  const existingIds = new Set(existingTalkIds);
  const talkPayloads: TalkPayload[] = [];
  const nextIds = new Set<string>();

  for (let index = 0; index < incoming.length; index += 1) {
    const raw = incoming[index] as Record<string, unknown>;
    const id = typeof raw.id === "string" && existingIds.has(raw.id) ? raw.id : crypto.randomUUID();
    const title = cleanText(assertString(raw.title, "talk title")).slice(0, 160);
    const speakers = cleanText(typeof raw.speakers === "string" ? raw.speakers : "").slice(0, 280);
    const role = cleanText(typeof raw.role === "string" ? raw.role : "").slice(0, 160);
    nextIds.add(id);
    talkPayloads.push({ id, title, speakers, role, position: index });
  }

  const deletedIds = existingTalkIds.filter((id) => !nextIds.has(id));

  await repository.replaceEventTalks(sql, eventId, talkPayloads, deletedIds);

  broadcastQuestionsChanged(eventId);
  const talks = await repository.listTalks(sql, eventId);
  return json({ talks });
}

async function streamOwnerQuestions(sql: Sql, userId: string, eventId: string): Promise<Response> {
  await repository.assertOwnsEvent(sql, userId, eventId);
  return createQuestionStream(eventId);
}

async function updateOwnerQuestion(request: Request, sql: Sql, userId: string, questionId: string): Promise<Response> {
  const body = await readJson(request);
  const question = await repository.getOwnerQuestionForUpdate(sql, userId, questionId);
  if (!question) throw createError(404, "Question not found.");

  const status = body.status === undefined ? question.status : assertQuestionStatus(body.status);
  const pinned = typeof body.pinned === "boolean" ? body.pinned : question.pinned;
  const questionUpdate = await repository.updateQuestionModeration(sql, questionId, status, pinned);

  broadcastQuestionsChanged(question.eventId);
  return json({ question: questionUpdate });
}

async function getPublicEvent(env: WorkerEnv, sql: Sql, slug: string) {
  const event = await repository.getPublicEvent(sql, slug);
  return { ...event, turnstileSiteKey: env.PUBLIC_TURNSTILE_SITE_KEY || undefined };
}

async function issuePublicVoter(request: Request, env: WorkerEnv, sql: Sql, slug: string): Promise<Response> {
  const event = await repository.getPublicEventAccess(sql, slug);
  const existing = await optionalVoterToken(request, env, String(event.id));
  if (existing) return json({ ok: true });

  const token = await createVoterToken(env, String(event.id));
  return json(
    { ok: true },
    200,
    { "set-cookie": voterCookie(token, new URL(request.url)) },
  );
}

async function streamPublicQuestions(sql: Sql, slug: string): Promise<Response> {
  const event = await repository.getPublicEventAccess(sql, slug);
  return createQuestionStream(String(event.id));
}

async function listPublicQuestions(request: Request, env: WorkerEnv, sql: Sql, slug: string, url: URL) {
  const event = await repository.getPublicEventAccess(sql, slug);
  await enforceRateLimit(env.PUBLIC_QUESTION_READ_RATE_LIMIT, env, ["questions", String(event.id), clientIp(request)]);
  const voter = await optionalVoterToken(request, env, String(event.id));
  const voterId = voter?.voterId ?? "";
  const status = url.searchParams.get("status") ?? "open";
  const talkId = safeUuid(url.searchParams.get("talkId"));

  return repository.listPublicQuestions(sql, String(event.id), { status, talkId, voterId });
}
async function createPublicQuestion(request: Request, env: WorkerEnv, sql: Sql, slug: string): Promise<Response> {
  const body = await readJson(request);
  if (body.website) return json({ ok: true }, 201);

  const event = await repository.getPublicEventAccess(sql, slug);
  const voter = await requireVoterToken(request, env);
  if (voter.eventId !== String(event.id)) throw createError(403, "Question is not allowed.");
  await verifyTurnstileIfConfigured(request, env, body.turnstileToken);
  await enforceRateLimit(env.PUBLIC_QUESTION_RATE_LIMIT, env, ["question", String(event.id), voter.voterId, clientIp(request)]);

  const talkId = assertString(body.talkId, "talkId");
  const questionBody = cleanText(assertString(body.body, "body"));
  const authorName = body.authorName ? cleanText(String(body.authorName)).slice(0, 80) : null;

  if (questionBody.length < 8 || questionBody.length > 280) {
    throw createError(400, "Question must be between 8 and 280 characters.");
  }

  const talkIsValid = await repository.talkBelongsToEvent(sql, String(event.id), talkId);
  if (!talkIsValid) throw createError(400, "Talk does not belong to this event.");

  const normalizedQuestion = normalizeQuestionBody(questionBody);
  const isDuplicate = await repository.findRecentDuplicateQuestion(sql, {
    eventId: String(event.id),
    voterId: voter.voterId,
    normalizedQuestion,
  });
  if (isDuplicate) throw createError(429, "Please wait before sending that question again.");

  const question = await repository.insertPublicQuestion(sql, {
    eventId: String(event.id),
    talkId,
    body: questionBody,
    authorName,
    voterId: voter.voterId,
  });

  broadcastQuestionsChanged(String(event.id));
  return json({ question }, 201);
}

async function vote(request: Request, env: WorkerEnv, sql: Sql): Promise<Response> {
  const body = await readJson(request);
  const questionId = safeUuid(assertString(body.questionId, "questionId"));
  const value = Number(body.value);

  if (!questionId) throw createError(404, "Question not found.");
  if (![-1, 0, 1].includes(value)) throw createError(400, "Invalid vote.");

  const voter = await requireVoterToken(request, env);
  const question = await repository.getVoteTarget(sql, questionId);
  if (!question) throw createError(404, "Question not found.");
  if (question.eventId !== voter.eventId) throw createError(403, "Vote is not allowed.");
  if (!question.isPublished || question.isArchived || question.status === "hidden") {
    throw createError(403, "Vote is not allowed.");
  }
  await enforceRateLimit(env.PUBLIC_VOTE_RATE_LIMIT, env, ["vote", question.eventId, voter.voterId]);

  if (value === 0) {
    await repository.deleteVote(sql, questionId, voter.voterId);
  } else {
    await repository.upsertVote(sql, questionId, voter.voterId, value);
  }

  broadcastQuestionsChanged(question.eventId);
  return json({ ok: true });
}

async function verifyTurnstileIfConfigured(request: Request, env: WorkerEnv, token: unknown): Promise<void> {
  if (!env.TURNSTILE_SECRET_KEY) return;
  if (typeof token !== "string" || !token.trim()) throw createError(400, "Verification required.");

  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET_KEY);
  form.set("response", token);
  const ip = clientIp(request);
  if (ip !== "unknown") form.set("remoteip", ip);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw createError(400, "Verification failed.");

  const result = (await response.json().catch(() => null)) as { success?: boolean } | null;
  if (!result?.success) throw createError(400, "Verification failed.");
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

export const testInternals = {
  assertQuestionStatus,
  base64UrlDecode,
  base64UrlEncode,
  canonicalOriginResponse,
  cleanText,
  contentSecurityPolicy,
  cookieValue,
  createVoterToken,
  normalizeQuestionBody,
  normalizeSlug,
  rateLimitKey,
  safeUuid,
  setSqlFactory(factory: typeof neon) {
    sqlFactory = factory;
  },
  isUniqueViolation: repository.isUniqueViolation,
  validateSupabaseClaims,
  verifyVoterToken,
  voterCookie,
};
