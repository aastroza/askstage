# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

AskStage: a live event Q&A platform. Organizers sign in with Google (Supabase Auth), create events with talks, and share a public link/QR. Attendees join `/e/:slug` without an account, submit questions, and vote. Organizers moderate (pin, mark answered, hide).

## Stack

- **Frontend:** React + Vite, plain CSS (`src/styles.css`). Single-page app, hand-rolled routing in `App.tsx`.
- **Backend:** Cloudflare Worker (`src/worker.ts`) serving both the API (`/api/*`) and static assets (SPA fallback).
- **Database:** Neon Postgres via `@neondatabase/serverless` (HTTP driver).
- **Auth:** Supabase Auth with Google OAuth. The Worker verifies access tokens and maps Supabase users to local `users` rows.

## Commands

```bash
npm run dev      # wrangler dev on :8787 (Worker + assets, local)
npm run build    # wrangler types + tsc --noEmit + vite build
npm run check    # types + typecheck + wrangler deploy --dry-run
npm run deploy   # build + wrangler deploy
```

Local env goes in `.dev.vars` (never commit): `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`. Production secrets via `npx wrangler secret put <NAME>`.

Run `npm run types` (or `build`) after changing `wrangler.jsonc` so the generated `Env` type stays in sync.

## Layout

```text
src/worker.ts     All API routes, auth, validation, SQL. Server code lives here.
src/App.tsx       All UI (owner dashboard + public event page), polling loops.
src/api.ts        Fetch wrapper; attaches Supabase Bearer token.
src/supabase.ts   Supabase client bootstrap (config fetched from /api/auth/config).
src/copy.ts       UI strings (en/es).
src/types.ts      Shared TypeScript types.
migrations/       Plain SQL, applied manually with psql, numbered in order.
wrangler.jsonc    Worker config.
```

## Conventions

- **All code, comments, commit messages, and identifiers in English.** UI copy may be bilingual (see `src/copy.ts`), but nothing else.
- TypeScript everywhere; `npm run build` must pass `tsc --noEmit` with zero errors.
- SQL only through Neon tagged templates (`` sql`...` ``). Never build queries by string concatenation.
- API responses are JSON via the `json()` helper. Errors use `createError(status, message)`; public-facing error messages stay generic.
- API JSON uses camelCase keys; SQL selects alias snake_case columns (`date_label as "dateLabel"`). Keep that pattern.
- Input handling: `cleanText()` + `.slice(max)` for strings, explicit whitelists for enums (language, status), regex validation for uuids/colors/urls. Validate everything that crosses the API boundary.
- No new dependencies without a reason. Pin exact or caret versions; never `"latest"`.

## Security invariants (do not break)

1. Every `/api/owner/*` route requires an authenticated user (`requireUser`).
2. Every owner operation on an event or question verifies ownership against `owner_id` (see `assertOwnsEvent`). Ownership failures return 404, not 403, to avoid leaking existence.
3. Public routes only expose events with `is_published = true and is_archived = false`.
4. Questions with `status = 'hidden'` never appear in public responses.
5. A question may only reference a talk belonging to the same event.
6. Question body length: 8–280 chars. Talks per event: max 40.
7. Slugs are unique, lowercase, `[a-z0-9-]`, max 64 chars (`normalizeSlug`).
8. Never trust client-supplied identity for voting. Voter identity must be server-issued and event-scoped. Do not reintroduce client-generated `voterId`.
9. Never log or store raw IPs or tokens. Hash with a salt if needed.

## Database rules

- The Neon HTTP driver has **no interactive transactions**. Multi-statement atomic work must use a single SQL statement (CTE), `sql.transaction([...])` (independent statements only), or a Postgres trigger.
- Migrations are append-only numbered files under `migrations/`, applied with `psql -f`. Never edit an applied migration.
- **Never write a migration that deletes or truncates user data.** Destructive scripts belong in `migrations/dev_only/` with a warning header, and the README must flag them.
- Prefer `add column if not exists` / `create index if not exists` so migrations are re-runnable.
- Cascades are aggressive (`events.owner_id on delete cascade` reaches talks, questions, votes). Think twice before any `delete from users` or event deletion path.

## Testing

- Preserve the invariants above; when adding tests, cover them first (owner isolation, public visibility, question validation, vote validation).
- Prefer Vitest with `@cloudflare/vitest-pool-workers` so code runs in the Workers runtime.
- Test DB: a disposable Neon branch or local Postgres. Never run tests against production `DATABASE_URL`.

## Gotchas

- Supabase anon key is intentionally public (served by `/api/auth/config`); the service role key must never appear anywhere in this repo.
- Slug conflict detection currently matches error strings; when touching it, switch to Postgres error code `23505` + constraint name.
- Client polls every 12 seconds. Anything you add to the public read path runs at attendee scale; keep those queries cheap.

## Workflow

- Small, reviewable PRs, one concern each.
- Update README when behavior, setup, or migrations change.