import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { testInternals } from "./worker";

const env = {
  VOTER_TOKEN_SECRET: "test-secret-with-enough-entropy",
  SUPABASE_URL: "https://project.supabase.co",
} as any;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) {
        return Response.json({ id: "supabase-a", email: "owner@example.com", user_metadata: {} });
      }
      return new Response("not found", { status: 404 });
    }),
  );
});

describe("signed voter tokens", () => {
  it("round-trips a valid token", async () => {
    const token = await testInternals.createVoterToken(env, "event-1");
    const payload = await testInternals.verifyVoterToken(env, token);

    expect(payload.eventId).toBe("event-1");
    expect(payload.voterId).toMatch(/[0-9a-f-]{36}/);
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it("rejects tampered tokens", async () => {
    const token = await testInternals.createVoterToken(env, "event-1");
    const [payload, signature] = token.split(".");
    const tamperedPayload = testInternals.base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({ eventId: "event-2", voterId: "voter", iat: 1, exp: 9999999999 })),
    );

    await expect(testInternals.verifyVoterToken(env, `${tamperedPayload}.${signature}`)).rejects.toMatchObject({
      status: 401,
    });
    expect(payload).toBeTruthy();
  });

  it("rejects expired tokens", async () => {
    const payload = testInternals.base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({ eventId: "event-1", voterId: "voter", iat: 1, exp: 2 })),
    );
    const signature = await signPayload(payload);

    await expect(testInternals.verifyVoterToken(env, `${payload}.${signature}`)).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("public request helpers", () => {
  it("builds an httpOnly same-site voter cookie", () => {
    const cookie = testInternals.voterCookie("token", new URL("https://askstage.test/e/demo"));

    expect(cookie).toContain("askstage_voter=token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("reads cookie values exactly by name", () => {
    const request = new Request("https://askstage.test", {
      headers: { cookie: "other=1; askstage_voter=abc.def; askstage_voter_extra=no" },
    });

    expect(testInternals.cookieValue(request, "askstage_voter")).toBe("abc.def");
  });

  it("normalizes slugs and question bodies", () => {
    expect(testInternals.normalizeSlug("  Charla con acentos: Diseño & IA! ")).toBe("charla-con-acentos-diseno-ia");
    expect(testInternals.normalizeQuestionBody("  How   does this work?\n")).toBe("how does this work?");
  });

  it("only accepts uuid-shaped ids", () => {
    expect(testInternals.safeUuid("28b609ef-4919-48c8-8b1f-b271fe9462b3")).toBe("28b609ef-4919-48c8-8b1f-b271fe9462b3");
    expect(testInternals.safeUuid("not-a-uuid")).toBe("");
  });

  it("generates opaque rate-limit keys", async () => {
    const key = await testInternals.rateLimitKey(env, ["vote", "event-1", "voter-1", "203.0.113.10"]);

    expect(key).toHaveLength(43);
    expect(key).not.toContain("203.0.113.10");
    expect(key).not.toContain("voter-1");
  });
});

describe("security headers", () => {
  it("adds strict CSP directives for https", () => {
    const csp = testInternals.contentSecurityPolicy(new URL("https://askstage.test"));

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self' https://*.supabase.co");
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("adds base security headers to successful API responses", async () => {
    const response = await worker.fetch(new Request("https://askstage.test/api/health"), routeEnv());

    expect(response.status).toBe(200);
    expectSecurityHeaders(response);
  });

  it("adds base security headers to API error responses", async () => {
    const response = await worker.fetch(new Request("https://askstage.test/api/missing"), routeEnv());

    expect(response.status).toBe(404);
    expectSecurityHeaders(response);
  });

  it("adds base security headers to asset responses", async () => {
    const response = await worker.fetch(new Request("https://askstage.test/app", {
      headers: { accept: "text/html" },
    }), routeEnv({ assetResponse: new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) }));

    expect(response.status).toBe(200);
    expectSecurityHeaders(response);
  });

  it("redirects browser navigations to the canonical production origin", () => {
    const response = testInternals.canonicalOriginResponse(
      new Request("https://preview.askstage.test/app?event=1"),
      { PUBLIC_ORIGIN: "https://askstage.test" } as any,
      new URL("https://preview.askstage.test/app?event=1"),
    );

    expect(response?.status).toBe(308);
    expect(response?.headers.get("location")).toBe("https://askstage.test/app?event=1");
  });

  it("does not serve API requests from non-canonical origins", async () => {
    const response = testInternals.canonicalOriginResponse(
      new Request("https://preview.askstage.test/api/health"),
      { PUBLIC_ORIGIN: "https://askstage.test" } as any,
      new URL("https://preview.askstage.test/api/health"),
    );

    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toEqual({ error: "Not found." });
  });
});

describe("supabase claim validation", () => {
  it("accepts current authenticated claims", () => {
    expect(() =>
      testInternals.validateSupabaseClaims(env, {
        sub: "user-1",
        email: "user@example.com",
        aud: "authenticated",
        iss: "https://project.supabase.co/auth/v1",
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    ).not.toThrow();
  });

  it("rejects expired claims", () => {
    expect(() =>
      testInternals.validateSupabaseClaims(env, {
        sub: "user-1",
        aud: "authenticated",
        exp: 1,
      }),
    ).toThrow();
  });
});

describe("postgres error handling", () => {
  it("recognizes slug unique constraint violations without string matching", () => {
    expect(testInternals.isUniqueViolation({ code: "23505", constraint: "events_slug_key" }, "events_slug_key")).toBe(true);
    expect(testInternals.isUniqueViolation({ code: "23505", constraint: "other_key" }, "events_slug_key")).toBe(false);
    expect(testInternals.isUniqueViolation(new Error("events_slug_key"), "events_slug_key")).toBe(false);
  });
});

describe("supabase user mapping", () => {
  it("verifies Supabase JWTs locally without calling the remote user endpoint", async () => {
    const signedJwt = await createSignedSupabaseJwt();
    const remoteUserCalls: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/.well-known/jwks.json")) {
        return Response.json({ keys: [signedJwt.publicJwk] });
      }
      if (url.includes("/auth/v1/user")) {
        remoteUserCalls.push(url);
        return new Response("unexpected remote user lookup", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    });
    const fake = createFakeSql({
      users: [{ id: "user-a", email: "owner@example.com", supabase_user_id: "supabase-a" }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await worker.fetch(new Request("https://askstage.test/api/me", {
      headers: { authorization: `Bearer ${signedJwt.token}` },
    }), routeEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: "user-a", email: "owner@example.com" } });
    expect(remoteUserCalls).toEqual([]);
    expect(fake.userWriteCount()).toBe(0);
  });

  it("does not write to users on authenticated reads when the local user already exists", async () => {
    const fake = createFakeSql({
      users: [{ id: "user-a", email: "owner@example.com", supabase_user_id: "supabase-a" }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await worker.fetch(new Request("https://askstage.test/api/me", {
      headers: { authorization: "Bearer opaque-token" },
    }), routeEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: "user-a", email: "owner@example.com" } });
    expect(fake.userWriteCount()).toBe(0);
  });

  it("links a legacy same-email user row instead of inserting a duplicate", async () => {
    const fake = createFakeSql({
      users: [{ id: "legacy-user", email: "owner@example.com", supabase_user_id: null }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await worker.fetch(new Request("https://askstage.test/api/me", {
      headers: { authorization: "Bearer opaque-token" },
    }), routeEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: "legacy-user", email: "owner@example.com" } });
    expect(fake.users()).toMatchObject([{ id: "legacy-user", supabase_user_id: "supabase-a" }]);
    expect(fake.userWriteCount()).toBe(1);
  });
});

describe("api invariants", () => {
  it("lets an owner list only their own events", async () => {
    const fake = createFakeSql({
      users: [{ id: "user-a", email: "owner@example.com", supabase_user_id: "supabase-a" }],
      events: [
        { id: "event-a", owner_id: "user-a", slug: "mine", is_published: true, is_archived: false },
        { id: "event-b", owner_id: "user-b", slug: "theirs", is_published: true, is_archived: false },
      ],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await worker.fetch(new Request("https://askstage.test/api/owner/events", {
      headers: { authorization: "Bearer valid" },
    }), routeEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ events: [{ id: "event-a", slug: "mine" }] });
  });

  it("does not let an owner read another owner's event", async () => {
    const fake = createFakeSql({
      users: [{ id: "user-a", email: "owner@example.com", supabase_user_id: "supabase-a" }],
      events: [{ id: "event-b", owner_id: "user-b", slug: "private-event", is_published: true, is_archived: false }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await worker.fetch(
      new Request("https://askstage.test/api/owner/events/event-b", {
        headers: { authorization: "Bearer valid" },
      }),
      routeEnv(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "Event not found." });
  });

  it("does not let an owner update another owner's event", async () => {
    const fake = createFakeSql({
      users: [{ id: "user-a", email: "owner@example.com", supabase_user_id: "supabase-a" }],
      events: [{ id: "event-b", owner_id: "user-b", slug: "private-event", is_published: true, is_archived: false }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await worker.fetch(
      new Request("https://askstage.test/api/owner/events/event-b", {
        method: "PATCH",
        headers: { authorization: "Bearer valid", "content-type": "application/json" },
        body: JSON.stringify({
          slug: "private-event",
          title: "Updated",
          accentColor: "#0f8bff",
          language: "en",
          isPublished: true,
          isArchived: false,
        }),
      }),
      routeEnv(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "Event not found." });
  });

  it("does not let an owner replace talks on another owner's event", async () => {
    const fake = createFakeSql({
      users: [{ id: "user-a", email: "owner@example.com", supabase_user_id: "supabase-a" }],
      events: [{ id: "event-b", owner_id: "user-b", slug: "private-event", is_published: true, is_archived: false }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await worker.fetch(
      new Request("https://askstage.test/api/owner/events/event-b/talks", {
        method: "PUT",
        headers: { authorization: "Bearer valid", "content-type": "application/json" },
        body: JSON.stringify({ talks: [{ title: "Talk", speakers: "", role: "" }] }),
      }),
      routeEnv(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "Event not found." });
  });

  it("does not let an owner moderate another owner's question", async () => {
    const fake = createFakeSql({
      users: [{ id: "user-a", email: "owner@example.com", supabase_user_id: "supabase-a" }],
      events: [{ id: "event-b", owner_id: "user-b", slug: "private-event", is_published: true, is_archived: false }],
      questions: [{ id: "question-b", event_id: "event-b", status: "open", pinned: false }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await worker.fetch(
      new Request("https://askstage.test/api/owner/questions/question-b", {
        method: "PATCH",
        headers: { authorization: "Bearer valid", "content-type": "application/json" },
        body: JSON.stringify({ status: "hidden" }),
      }),
      routeEnv(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "Question not found." });
  });

  it("only exposes published non-archived public events", async () => {
    const fake = createFakeSql({
      events: [
        { id: "event-draft", owner_id: "user-a", slug: "draft", is_published: false, is_archived: false },
        { id: "event-archived", owner_id: "user-a", slug: "archived", is_published: true, is_archived: true },
      ],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const draft = await worker.fetch(new Request("https://askstage.test/api/public/events/draft"), routeEnv());
    const archived = await worker.fetch(new Request("https://askstage.test/api/public/events/archived"), routeEnv());

    expect(draft.status).toBe(404);
    expect(archived.status).toBe(404);
  });

  it("exposes published non-archived public events", async () => {
    const fake = createFakeSql({
      events: [{ id: "event-live", owner_id: "user-a", slug: "live", is_published: true, is_archived: false }],
      eventTalks: [{ id: "talk-a", event_id: "event-live", title: "Talk", speakers: "Speaker", role: "", position: 0 }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await worker.fetch(new Request("https://askstage.test/api/public/events/live"), routeEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ event: { id: "event-live", slug: "live", talks: [{ id: "talk-a" }] } });
  });

  it("does not expose hidden questions publicly", async () => {
    const fake = createFakeSql({
      events: [{ id: "event-live", owner_id: "user-a", slug: "live", is_published: true, is_archived: false }],
      questions: [
        { id: "question-open", event_id: "event-live", status: "open", pinned: false, body: "Visible question" },
        { id: "question-hidden", event_id: "event-live", status: "hidden", pinned: false, body: "Hidden question" },
      ],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await worker.fetch(new Request("https://askstage.test/api/public/events/live/questions?status=all"), routeEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ questions: [{ id: "question-open" }] });
  });

  it("returns 429 when the public question read rate limiter rejects a request", async () => {
    const fake = createFakeSql({
      events: [{ id: "event-live", owner_id: "user-a", slug: "live", is_published: true, is_archived: false }],
      questions: [{ id: "question-open", event_id: "event-live", status: "open", pinned: false, body: "Visible question" }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await worker.fetch(
      new Request("https://askstage.test/api/public/events/live/questions?status=all"),
      routeEnv({ questionReadLimiterSuccess: false }),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "Too many requests. Please try again shortly." });
  });

  it("exposes a Turnstile site key on public events when configured", async () => {
    const fake = createFakeSql({
      events: [{ id: "event-live", owner_id: "user-a", slug: "live", is_published: true, is_archived: false }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await worker.fetch(
      new Request("https://askstage.test/api/public/events/live"),
      routeEnv({ turnstileSiteKey: "site-key" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ event: { turnstileSiteKey: "site-key" } });
  });

  it("opens a public questions stream for live events", async () => {
    const fake = createFakeSql({
      events: [{ id: "event-live", owner_id: "user-a", slug: "live", is_published: true, is_archived: false }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await worker.fetch(new Request("https://askstage.test/api/public/events/live/stream"), routeEnv());
    const reader = response.body?.getReader();
    const chunk = await reader?.read();
    await reader?.cancel();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(new TextDecoder().decode(chunk?.value)).toContain("event: connected");
  });

  it("opens an authenticated owner questions stream for owned events", async () => {
    const fake = createFakeSql({
      users: [{ id: "user-a", email: "owner@example.com", supabase_user_id: "supabase-a" }],
      events: [{ id: "event-a", owner_id: "user-a", slug: "event-a", is_published: false, is_archived: false }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await worker.fetch(
      new Request("https://askstage.test/api/owner/events/event-a/stream", {
        headers: { authorization: "Bearer valid" },
      }),
      routeEnv(),
    );
    const reader = response.body?.getReader();
    const chunk = await reader?.read();
    await reader?.cancel();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(new TextDecoder().decode(chunk?.value)).toContain("event: connected");
  });

  it("returns 409 for event slug conflicts from the database constraint", async () => {
    const fake = createFakeSql({
      users: [{ id: "user-a", email: "owner@example.com", supabase_user_id: "supabase-a" }],
      events: [{ id: "event-a", owner_id: "user-a", slug: "existing", is_published: true, is_archived: false }],
      updateEventError: { code: "23505", constraint: "events_slug_key" },
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await worker.fetch(
      new Request("https://askstage.test/api/owner/events/event-a", {
        method: "PATCH",
        headers: { authorization: "Bearer valid", "content-type": "application/json" },
        body: JSON.stringify({
          slug: "existing",
          title: "Event",
          accentColor: "#0f8bff",
          language: "en",
          isPublished: true,
          isArchived: false,
        }),
      }),
      routeEnv(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "That slug is already in use." });
  });

  it("creates an event and its talks in one transaction", async () => {
    const fake = createFakeSql({
      users: [{ id: "user-a", email: "owner@example.com", supabase_user_id: "supabase-a" }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await worker.fetch(
      new Request("https://askstage.test/api/owner/events", {
        method: "POST",
        headers: { authorization: "Bearer valid", "content-type": "application/json" },
        body: JSON.stringify({
          title: "Main Event",
          dateLabel: "Today",
          locationLabel: "Room 1",
          language: "en",
          talks: [
            { title: "Opening", speakers: "A", role: "Host" },
            { title: "Closing", speakers: "B", role: "Guest" },
          ],
        }),
      }),
      routeEnv(),
    );

    expect(response.status).toBe(201);
    expect(fake.transactionCount()).toBe(1);
    expect(fake.events()).toHaveLength(1);
    expect(fake.eventTalks()).toHaveLength(2);
  });

  it("replaces talks in one transaction", async () => {
    const fake = createFakeSql({
      users: [{ id: "user-a", email: "owner@example.com", supabase_user_id: "supabase-a" }],
      events: [{ id: "event-a", owner_id: "user-a", slug: "event-a", is_published: true, is_archived: false }],
      eventTalks: [
        { id: "talk-a", event_id: "event-a", title: "Old", speakers: "", role: "", position: 0 },
        { id: "talk-b", event_id: "event-a", title: "Delete me", speakers: "", role: "", position: 1 },
      ],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await worker.fetch(
      new Request("https://askstage.test/api/owner/events/event-a/talks", {
        method: "PUT",
        headers: { authorization: "Bearer valid", "content-type": "application/json" },
        body: JSON.stringify({
          talks: [
            { id: "talk-a", title: "Updated", speakers: "A", role: "Host" },
            { title: "New", speakers: "B", role: "Guest" },
          ],
        }),
      }),
      routeEnv(),
    );

    expect(response.status).toBe(200);
    expect(fake.transactionCount()).toBe(1);
    expect(fake.eventTalks().map((talk) => talk.title)).toEqual(["Updated", "New"]);
  });

  it("returns 404 instead of a database error for unknown vote question ids", async () => {
    const fake = createFakeSql({
      events: [{ id: "event-a", owner_id: "user-a", slug: "event-a", is_published: true, is_archived: false }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await voteRequest("event-a", "28b609ef-4919-48c8-8b1f-b271fe9462b3", 1);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "Question not found." });
  });

  it("rejects votes without a voter token", async () => {
    const fake = createFakeSql({
      events: [{ id: "event-a", owner_id: "user-a", slug: "event-a", is_published: true, is_archived: false }],
      questions: [{ id: "28b609ef-4919-48c8-8b1f-b271fe9462b3", event_id: "event-a", status: "open", pinned: false }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await worker.fetch(
      new Request("https://askstage.test/api/public/votes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionId: "28b609ef-4919-48c8-8b1f-b271fe9462b3", value: 1 }),
      }),
      routeEnv(),
    );

    expect(response.status).toBe(401);
    expect(fake.votes()).toHaveLength(0);
  });

  it("rejects votes with tampered or expired voter tokens", async () => {
    const fake = createFakeSql({
      events: [{ id: "event-a", owner_id: "user-a", slug: "event-a", is_published: true, is_archived: false }],
      questions: [{ id: "28b609ef-4919-48c8-8b1f-b271fe9462b3", event_id: "event-a", status: "open", pinned: false }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const validToken = await createTestVoterToken("event-a", "voter-a");
    const [payload, signature] = validToken.split(".");
    const tampered = `${testInternals.base64UrlEncode(new TextEncoder().encode(JSON.stringify({
      eventId: "event-a",
      voterId: "voter-b",
      iat: 1,
      exp: 9999999999,
    })))}.${signature}`;
    const expired = await createTestVoterToken("event-a", "voter-a", 1);

    const tamperedResponse = await voteRequestWithToken("28b609ef-4919-48c8-8b1f-b271fe9462b3", 1, tampered);
    const expiredResponse = await voteRequestWithToken("28b609ef-4919-48c8-8b1f-b271fe9462b3", 1, expired);

    expect(payload).toBeTruthy();
    expect(tamperedResponse.status).toBe(401);
    expect(expiredResponse.status).toBe(401);
    expect(fake.votes()).toHaveLength(0);
  });

  it("rejects votes on hidden, draft, archived, or cross-event questions", async () => {
    const fake = createFakeSql({
      events: [
        { id: "event-a", owner_id: "user-a", slug: "event-a", is_published: true, is_archived: false },
        { id: "event-b", owner_id: "user-a", slug: "event-b", is_published: true, is_archived: false },
        { id: "event-draft", owner_id: "user-a", slug: "draft", is_published: false, is_archived: false },
        { id: "event-archived", owner_id: "user-a", slug: "archived", is_published: true, is_archived: true },
      ],
      questions: [
        { id: "28b609ef-4919-48c8-8b1f-b271fe9462b3", event_id: "event-a", status: "hidden", pinned: false },
        { id: "38b609ef-4919-48c8-8b1f-b271fe9462b3", event_id: "event-b", status: "open", pinned: false },
        { id: "48b609ef-4919-48c8-8b1f-b271fe9462b3", event_id: "event-draft", status: "open", pinned: false },
        { id: "58b609ef-4919-48c8-8b1f-b271fe9462b3", event_id: "event-archived", status: "open", pinned: false },
      ],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    await expectVoteStatus("event-a", "28b609ef-4919-48c8-8b1f-b271fe9462b3", 403);
    await expectVoteStatus("event-a", "38b609ef-4919-48c8-8b1f-b271fe9462b3", 403);
    await expectVoteStatus("event-draft", "48b609ef-4919-48c8-8b1f-b271fe9462b3", 403);
    await expectVoteStatus("event-archived", "58b609ef-4919-48c8-8b1f-b271fe9462b3", 403);
  });

  it("records a valid vote from the signed voter token", async () => {
    const fake = createFakeSql({
      events: [{ id: "event-a", owner_id: "user-a", slug: "event-a", is_published: true, is_archived: false }],
      questions: [{ id: "28b609ef-4919-48c8-8b1f-b271fe9462b3", event_id: "event-a", status: "open", pinned: false }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await voteRequest("event-a", "28b609ef-4919-48c8-8b1f-b271fe9462b3", 1);

    expect(response.status).toBe(200);
    expect(fake.votes()).toMatchObject([{ question_id: "28b609ef-4919-48c8-8b1f-b271fe9462b3", value: 1 }]);
  });

  it("records downvotes and removes votes through the signed voter token", async () => {
    const fake = createFakeSql({
      events: [{ id: "event-a", owner_id: "user-a", slug: "event-a", is_published: true, is_archived: false }],
      questions: [{ id: "28b609ef-4919-48c8-8b1f-b271fe9462b3", event_id: "event-a", status: "open", pinned: false }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);
    const token = await createTestVoterToken("event-a", "voter-a");

    const downvote = await voteRequestWithToken("28b609ef-4919-48c8-8b1f-b271fe9462b3", -1, token);
    const remove = await voteRequestWithToken("28b609ef-4919-48c8-8b1f-b271fe9462b3", 0, token);

    expect(downvote.status).toBe(200);
    expect(remove.status).toBe(200);
    expect(fake.votes()).toHaveLength(0);
  });

  it("rejects invalid vote values before writing", async () => {
    const fake = createFakeSql({
      events: [{ id: "event-a", owner_id: "user-a", slug: "event-a", is_published: true, is_archived: false }],
      questions: [{ id: "28b609ef-4919-48c8-8b1f-b271fe9462b3", event_id: "event-a", status: "open", pinned: false }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await voteRequest("event-a", "28b609ef-4919-48c8-8b1f-b271fe9462b3", 2);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid vote." });
    expect(fake.votes()).toHaveLength(0);
  });

  it("returns 429 when the public vote rate limiter rejects a request", async () => {
    const fake = createFakeSql({
      events: [{ id: "event-a", owner_id: "user-a", slug: "event-a", is_published: true, is_archived: false }],
      questions: [{ id: "28b609ef-4919-48c8-8b1f-b271fe9462b3", event_id: "event-a", status: "open", pinned: false }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await voteRequest(
      "event-a",
      "28b609ef-4919-48c8-8b1f-b271fe9462b3",
      1,
      routeEnv({ voteLimiterSuccess: false }),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "Too many requests. Please try again shortly." });
    expect(fake.votes()).toHaveLength(0);
  });

  it("rejects public questions that are too short or too long", async () => {
    const fake = createFakeSql({
      events: [{ id: "event-a", owner_id: "user-a", slug: "event-a", is_published: true, is_archived: false }],
      eventTalks: [{ id: "talk-a", event_id: "event-a", title: "Talk", speakers: "", role: "", position: 0 }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const tooShort = await publicQuestionRequest("event-a", { talkId: "talk-a", body: "Short" });
    const tooLong = await publicQuestionRequest("event-a", { talkId: "talk-a", body: "x".repeat(281) });

    expect(tooShort.status).toBe(400);
    expect(tooLong.status).toBe(400);
    expect(fake.questions()).toHaveLength(0);
  });

  it("rejects public questions attached to another event's talk", async () => {
    const fake = createFakeSql({
      events: [
        { id: "event-a", owner_id: "user-a", slug: "event-a", is_published: true, is_archived: false },
        { id: "event-b", owner_id: "user-a", slug: "event-b", is_published: true, is_archived: false },
      ],
      eventTalks: [{ id: "talk-b", event_id: "event-b", title: "Talk B", speakers: "", role: "", position: 0 }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await publicQuestionRequest("event-a", { talkId: "talk-b", body: "How does this work?" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Talk does not belong to this event." });
    expect(fake.questions()).toHaveLength(0);
  });

  it("requires a Turnstile token for public questions when configured", async () => {
    const fake = createFakeSql({
      events: [{ id: "event-a", owner_id: "user-a", slug: "event-a", is_published: true, is_archived: false }],
      eventTalks: [{ id: "talk-a", event_id: "event-a", title: "Talk", speakers: "", role: "", position: 0 }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await publicQuestionRequest(
      "event-a",
      { talkId: "talk-a", body: "How does this work?" },
      { env: routeEnv({ turnstileSecret: "secret" }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Verification required." });
    expect(fake.questions()).toHaveLength(0);
  });

  it("accepts public questions after Turnstile verification succeeds", async () => {
    vi.mocked(fetch).mockImplementationOnce(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("challenges.cloudflare.com/turnstile")) {
        return Response.json({ success: true });
      }
      return new Response("not found", { status: 404 });
    });
    const fake = createFakeSql({
      events: [{ id: "event-a", owner_id: "user-a", slug: "event-a", is_published: true, is_archived: false }],
      eventTalks: [{ id: "talk-a", event_id: "event-a", title: "Talk", speakers: "", role: "", position: 0 }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await publicQuestionRequest(
      "event-a",
      { talkId: "talk-a", body: "How does this work?", turnstileToken: "token" },
      { env: routeEnv({ turnstileSecret: "secret" }) },
    );

    expect(response.status).toBe(201);
    expect(fake.questions()).toHaveLength(1);
  });

  it("silently accepts honeypot public questions without writing them", async () => {
    const fake = createFakeSql({
      events: [{ id: "event-a", owner_id: "user-a", slug: "event-a", is_published: true, is_archived: false }],
      eventTalks: [{ id: "talk-a", event_id: "event-a", title: "Talk", speakers: "", role: "", position: 0 }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await publicQuestionRequest("event-a", {
      talkId: "talk-a",
      body: "How does this work?",
      website: "https://bot.example",
    });

    expect(response.status).toBe(201);
    expect(fake.questions()).toHaveLength(0);
  });

  it("rejects duplicate public questions from the same voter shortly after posting", async () => {
    const fake = createFakeSql({
      events: [{ id: "event-a", owner_id: "user-a", slug: "event-a", is_published: true, is_archived: false }],
      eventTalks: [{ id: "talk-a", event_id: "event-a", title: "Talk", speakers: "", role: "", position: 0 }],
      questions: [
        {
          id: "question-existing",
          event_id: "event-a",
          status: "open",
          pinned: false,
          body: "How does this work?",
          voter_id: "voter-a",
        },
      ],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await publicQuestionRequest("event-a", {
      talkId: "talk-a",
      body: "How   does this work?",
    }, { voterId: "voter-a" });

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "Please wait before sending that question again." });
  });

  it("returns 429 when the public question rate limiter rejects a request", async () => {
    const fake = createFakeSql({
      events: [{ id: "event-a", owner_id: "user-a", slug: "event-a", is_published: true, is_archived: false }],
      eventTalks: [{ id: "talk-a", event_id: "event-a", title: "Talk", speakers: "", role: "", position: 0 }],
    });
    testInternals.setSqlFactory(() => fake.sql as never);

    const response = await publicQuestionRequest(
      "event-a",
      { talkId: "talk-a", body: "How does this work?" },
      { env: routeEnv({ questionLimiterSuccess: false }) },
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "Too many requests. Please try again shortly." });
  });
});

async function signPayload(encodedPayload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.VOTER_TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encodedPayload));
  return testInternals.base64UrlEncode(new Uint8Array(signature));
}

async function createSignedSupabaseJwt(): Promise<{ token: string; publicJwk: JsonWebKey & { kid: string; alg: string } }> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey) as JsonWebKey & { kid: string; alg: string };
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";

  const header = testInternals.base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "test-key" })));
  const payload = testInternals.base64UrlEncode(new TextEncoder().encode(JSON.stringify({
    sub: "supabase-a",
    email: "owner@example.com",
    user_metadata: {},
    aud: "authenticated",
    iss: "https://project.supabase.co/auth/v1",
    exp: Math.floor(Date.now() / 1000) + 60,
  })));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );

  return {
    token: `${header}.${payload}.${testInternals.base64UrlEncode(new Uint8Array(signature))}`,
    publicJwk,
  };
}

async function voteRequest(
  eventId: string,
  questionId: string,
  value: number,
  requestEnv: ReturnType<typeof routeEnv> = routeEnv(),
): Promise<Response> {
  const token = await testInternals.createVoterToken(env, eventId);
  return voteRequestWithToken(questionId, value, token, requestEnv);
}

async function voteRequestWithToken(
  questionId: string,
  value: number,
  token: string,
  requestEnv: ReturnType<typeof routeEnv> = routeEnv(),
): Promise<Response> {
  return worker.fetch(
    new Request("https://askstage.test/api/public/votes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `askstage_voter=${token}`,
      },
      body: JSON.stringify({ questionId, value }),
    }),
    requestEnv,
  );
}

async function publicQuestionRequest(
  eventId: string,
  body: Record<string, unknown>,
  options: { env?: ReturnType<typeof routeEnv>; voterId?: string } = {},
): Promise<Response> {
  const token = await createTestVoterToken(eventId, options.voterId ?? "voter-public");
  return worker.fetch(
    new Request(`https://askstage.test/api/public/events/${eventId}/questions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `askstage_voter=${token}`,
      },
      body: JSON.stringify(body),
    }),
    options.env ?? routeEnv(),
  );
}

async function createTestVoterToken(eventId: string, voterId: string, exp = Math.floor(Date.now() / 1000) + 60): Promise<string> {
  const payload = testInternals.base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({
      eventId,
      voterId,
      iat: Math.floor(Date.now() / 1000),
      exp,
    })),
  );
  return `${payload}.${await signPayload(payload)}`;
}

async function expectVoteStatus(eventId: string, questionId: string, status: number): Promise<void> {
  const response = await voteRequest(eventId, questionId, 1);
  expect(response.status).toBe(status);
}

function routeEnv(options: {
  assetResponse?: Response;
  questionLimiterSuccess?: boolean;
  questionReadLimiterSuccess?: boolean;
  voteLimiterSuccess?: boolean;
  turnstileSecret?: string;
  turnstileSiteKey?: string;
} = {}) {
  return {
    DATABASE_URL: "postgresql://test",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    VOTER_TOKEN_SECRET: env.VOTER_TOKEN_SECRET,
    PUBLIC_TURNSTILE_SITE_KEY: options.turnstileSiteKey,
    TURNSTILE_SECRET_KEY: options.turnstileSecret,
    PUBLIC_QUESTION_RATE_LIMIT: {
      limit: async () => ({ success: options.questionLimiterSuccess ?? true }),
    },
    PUBLIC_QUESTION_READ_RATE_LIMIT: {
      limit: async () => ({ success: options.questionReadLimiterSuccess ?? true }),
    },
    PUBLIC_VOTE_RATE_LIMIT: {
      limit: async () => ({ success: options.voteLimiterSuccess ?? true }),
    },
    ASSETS: { fetch: () => options.assetResponse ?? new Response("not found", { status: 404 }) },
    ENVIRONMENT: "production",
  } as any;
}

function expectSecurityHeaders(response: Response): void {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  expect(response.headers.get("permissions-policy")).toContain("camera=()");
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
}

function createFakeSql(data: {
  users?: Array<{ id: string; email: string; supabase_user_id?: string | null }>;
  events?: Array<{ id: string; owner_id: string; slug: string; is_published: boolean; is_archived: boolean }>;
  eventTalks?: Array<{ id: string; event_id: string; title: string; speakers: string; role: string; position: number }>;
  questions?: Array<{ id: string; event_id: string; status: string; pinned: boolean; body?: string; voter_id?: string | null; talk_id?: string | null; score?: number }>;
  updateEventError?: unknown;
}) {
  const users = [...(data.users ?? [])];
  const events = [...(data.events ?? [])];
  const eventTalks = [...(data.eventTalks ?? [])];
  const questions = data.questions ?? [];
  const votes: Array<{ question_id: string; voter_id: string; value: number }> = [];
  let transactions = 0;
  let userWrites = 0;
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");

    if (query.includes("from users") && query.includes("where supabase_user_id")) {
      return users
        .filter((user) => user.supabase_user_id === values[0])
        .map((user) => ({ id: user.id, email: user.email }));
    }

    if (query.includes("update users") && query.includes("where id")) {
      const [email, id] = values;
      const user = users.find((candidate) => candidate.id === id);
      if (!user) return [];
      userWrites += 1;
      user.email = String(email);
      return [{ id: user.id, email: user.email }];
    }

    if (query.includes("update users") && query.includes("where lower(email)")) {
      const [supabaseUserId, email] = values;
      const user = users.find((candidate) => candidate.email.toLowerCase() === String(email).toLowerCase() && candidate.supabase_user_id == null);
      if (!user) return [];
      userWrites += 1;
      user.supabase_user_id = String(supabaseUserId);
      return [{ id: user.id, email: user.email }];
    }

    if (query.includes("insert into users")) {
      const [email, supabaseUserId] = values;
      userWrites += 1;
      const user = { id: "created-user", email: String(email), supabase_user_id: String(supabaseUserId) };
      users.push(user);
      return [user];
    }

    if (query.includes("select id from events where slug")) {
      return events.filter((event) => event.slug === values[0]).map((event) => ({ id: event.id }));
    }

    if (query.includes("insert into events")) {
      const [id, ownerId, slug] = values;
      const event = { id: String(id), owner_id: String(ownerId), slug: String(slug), is_published: true, is_archived: false };
      events.push(event);
      return [ownerEventRow(event)];
    }

    if (query.includes("from events") && query.includes("where owner_id") && !query.includes("limit 1")) {
      return events
        .filter((event) => event.owner_id === values[0])
        .map((event) => ownerEventRow(event));
    }

    if (query.includes("from events") && query.includes("owner_id") && query.includes("limit 1")) {
      return events
        .filter((event) => event.id === values[0] && event.owner_id === values[1])
        .map((event) => ownerEventRow(event));
    }

    if (query.includes("update events")) {
      if (data.updateEventError) throw data.updateEventError;
      const eventId = values[11];
      const ownerId = values[12];
      return events
        .filter((event) => event.id === eventId && event.owner_id === ownerId)
        .map((event) => ownerEventRow(event));
    }

    if (query.includes("from events") && query.includes("slug") && query.includes("is_published = true")) {
      return events
        .filter((event) => event.slug === values[0] && event.is_published && !event.is_archived)
        .map((event) => publicEventRow(event));
    }

    if (query.includes("select id::text from event_talks")) {
      if (query.includes("where id =")) {
        return eventTalks
          .filter((talk) => talk.id === values[0] && talk.event_id === values[1])
          .map((talk) => ({ id: talk.id }));
      }
      return eventTalks.filter((talk) => talk.event_id === values[0]).map((talk) => ({ id: talk.id }));
    }

    if (query.includes("insert into event_talks")) {
      if (query.includes("(event_id, title")) {
        const [eventId, title, speakers, role, position] = values;
        eventTalks.push({ id: crypto.randomUUID(), event_id: String(eventId), title: String(title), speakers: String(speakers), role: String(role), position: Number(position) });
      } else {
        const [id, eventId, title, speakers, role, position] = values;
        const existing = eventTalks.find((talk) => talk.id === id);
        if (existing) {
          Object.assign(existing, { title: String(title), speakers: String(speakers), role: String(role), position: Number(position) });
        } else {
          eventTalks.push({ id: String(id), event_id: String(eventId), title: String(title), speakers: String(speakers), role: String(role), position: Number(position) });
        }
      }
      return [];
    }

    if (query.includes("delete from event_talks")) {
      const index = eventTalks.findIndex((talk) => talk.id === values[0] && talk.event_id === values[1]);
      if (index >= 0) eventTalks.splice(index, 1);
      return [];
    }

    if (query.includes("from event_talks")) {
      return eventTalks
        .filter((talk) => talk.event_id === values[0])
        .sort((left, right) => left.position - right.position || left.title.localeCompare(right.title))
        .map((talk) => ({ id: talk.id, title: talk.title, speakers: talk.speakers, role: talk.role, position: talk.position }));
    }

    if (query.includes("from questions q") && query.includes("join events e") && query.includes("e.owner_id")) {
      return questions
        .filter((question) => {
          const event = events.find((candidate) => candidate.id === question.event_id);
          return question.id === values[0] && event?.owner_id === values[1];
        })
        .map((question) => ({ id: question.id, status: question.status, pinned: question.pinned }));
    }

    if (query.includes("from questions") && query.includes("regexp_replace")) {
      return questions
        .filter((question) =>
          question.event_id === values[0] &&
          question.voter_id === values[1] &&
          normalizeQuestion(String(question.body ?? "")) === values[2],
        )
        .map((question) => ({ id: question.id }));
    }

    if (query.includes("insert into questions")) {
      const [eventId, talkId, body, , voterId] = values;
      const question = {
        id: crypto.randomUUID(),
        event_id: String(eventId),
        talk_id: String(talkId),
        body: String(body),
        voter_id: String(voterId),
        status: "open",
        pinned: false,
      };
      questions.push(question);
      return [{ id: question.id }];
    }

    if (query.includes("from questions q") && query.includes("left join event_talks")) {
      const eventId = String(values[1]);
      const status = String(values[2]);
      const talkId = query.includes("q.talk_id =") ? String(values[5]) : "";
      return questions
        .filter((question) => question.event_id === eventId)
        .filter((question) => question.status !== "hidden")
        .filter((question) => status === "all" || question.status === status)
        .filter((question) => !talkId || question.talk_id === talkId)
        .map((question) => {
          const talk = eventTalks.find((candidate) => candidate.id === question.talk_id);
          return {
            id: question.id,
            eventId: question.event_id,
            talkId: question.talk_id ?? null,
            body: question.body ?? "",
            authorName: null,
            status: question.status,
            pinned: question.pinned,
            createdAt: new Date().toISOString(),
            talkTitle: talk?.title ?? null,
            talkSpeakers: talk?.speakers ?? null,
            score: question.score ?? 0,
            userVote: 0,
          };
        });
    }

    if (query.includes("from questions q") && query.includes("join events e") && query.includes("where q.id")) {
      return questions
        .filter((question) => question.id === values[0])
        .map((question) => {
          const event = events.find((candidate) => candidate.id === question.event_id);
          return {
            id: question.id,
            status: question.status,
            eventId: question.event_id,
            isPublished: event?.is_published ?? false,
            isArchived: event?.is_archived ?? false,
          };
        });
    }

    if (query.includes("insert into question_votes")) {
      const [questionId, voterId, value] = values;
      const existing = votes.find((vote) => vote.question_id === questionId && vote.voter_id === voterId);
      if (existing) {
        existing.value = Number(value);
      } else {
        votes.push({ question_id: String(questionId), voter_id: String(voterId), value: Number(value) });
      }
      return [];
    }

    if (query.includes("delete from question_votes")) {
      const index = votes.findIndex((vote) => vote.question_id === values[0] && vote.voter_id === values[1]);
      if (index >= 0) votes.splice(index, 1);
      return [];
    }

    return [];
  }) as any;
  sql.transaction = async (queriesOrFn: unknown) => {
    transactions += 1;
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => sql(strings, ...values)) as any;
    const queries = typeof queriesOrFn === "function" ? (queriesOrFn as (tx: unknown) => unknown[])(tx) : queriesOrFn;
    return Promise.all(queries as Array<Promise<unknown>>);
  };

  return {
    sql,
    eventTalks: () => [...eventTalks],
    events: () => [...events],
    questions: () => [...questions],
    transactionCount: () => transactions,
    users: () => [...users],
    userWriteCount: () => userWrites,
    votes: () => [...votes],
  };
}

function normalizeQuestion(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function ownerEventRow(event: { id: string; slug: string; is_published: boolean; is_archived: boolean }) {
  return {
    id: event.id,
    slug: event.slug,
    title: "Event",
    dateLabel: "",
    locationLabel: "",
    language: "en",
    introText: "",
    askButtonLabel: "",
    footerLabel: "",
    footerUrl: "",
    accentColor: "#0f8bff",
    isPublished: event.is_published,
    isArchived: event.is_archived,
    updatedAt: new Date().toISOString(),
  };
}

function publicEventRow(event: { id: string; slug: string; is_published: boolean; is_archived: boolean }) {
  return ownerEventRow(event);
}
