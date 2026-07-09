# AskStage

A lightweight web app for live event Q&A, audience question voting, and shareable QR access.

## What it does

- Organizers sign in and create event pages.
- Each event has a public link and QR code.
- Attendees can ask questions without an account.
- Attendees can upvote or downvote questions.
- Organizers can customize the event page language, copy, accent color, talks, footer CTA, and publication state.
- Organizers can pin, mark answered, or hide questions.

## Stack

- React + Vite
- Cloudflare Workers + Static Assets
- Neon Postgres
- Supabase Auth with Google

## Self-hosting

### 1. Create a Neon database

Create a Neon project and copy its pooled connection string.

Run the schema:

```bash
npm run db:migrate
```

This applies the ordered `.sql` files directly under `migrations/`, including
the safe Supabase Auth columns, denormalized question scores, and public
question voter metadata. It intentionally ignores `migrations/dev_only/`.
If `psql` is not available locally, `npm run db:migrate:http` applies the same
root migrations through Neon's HTTP driver.

If you are upgrading an existing database, take a Neon backup or confirm point-in-time
restore is available before applying migrations.

Development-only reset scripts live in `migrations/dev_only/`. Do not run those
against production or shared databases; they may delete users and cascade into
events, talks, questions, and votes.

### 2. Configure Supabase Auth

Create a Supabase project and enable the Google provider in Authentication.

Use these redirect URLs in Supabase and Google OAuth:

```text
http://localhost:8787/app
https://askstage.com/app
https://www.askstage.com/app
```

`https://askstage.com` is the canonical production origin. Keep
`https://www.askstage.com/app` in the OAuth allowlists only if you also allow
users to start login from the `www` hostname.

### 3. Install dependencies

```bash
npm install
```

### 4. Configure local environment

Create `.dev.vars`:

```bash
DATABASE_URL="postgresql://..."
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_ANON_KEY="..."
VOTER_TOKEN_SECRET="generate-a-long-random-secret"
PUBLIC_ORIGIN="https://<your-public-origin>"
# Optional. Enables Cloudflare Turnstile on public question submissions.
PUBLIC_TURNSTILE_SITE_KEY="..."
TURNSTILE_SECRET_KEY="..."
# Optional. Defaults to "authenticated".
SUPABASE_JWT_AUDIENCE="authenticated"
```

Public question reads, question submissions, and votes are protected by Workers
Rate Limiting bindings declared in `wrangler.jsonc`.

Required Cloudflare secrets are also declared in `wrangler.jsonc`; Wrangler will
validate them during deploy.

`PUBLIC_ORIGIN` is the canonical production origin. When it is set, API requests
from other hosts return 404 and browser navigations are redirected to the
canonical origin.

Preview deploy URLs and the Workers subdomain are disabled in `wrangler.jsonc`.
Production is served through the configured custom domains `askstage.com` and
`www.askstage.com`, with `askstage.com` as the canonical origin.

Public and organizer question lists use Server-Sent Events for quick refreshes,
with 12-second polling retained as a fallback.

Turnstile is optional and should be enabled only when an event needs extra
abuse protection. Configure both `PUBLIC_TURNSTILE_SITE_KEY` and
`TURNSTILE_SECRET_KEY`; public question submissions will then require a valid
Turnstile token.

### Database integration tests

The fast test suite runs Worker tests in Cloudflare's Vitest Workers runtime and
migration checks in Node:

```bash
npm test
```

To verify the real Postgres score trigger, create a disposable Neon branch, apply
the migrations, and run:

```bash
npm run db:migrate
TEST_DATABASE_URL="postgresql://..." npm run test:db
```

CI applies the root migrations with `npm run db:migrate:http` and runs the same
DB integration test automatically when the repository secret `TEST_DATABASE_URL`
is present.

### 5. Run locally

```bash
npm run dev
```

Open `http://localhost:8787`.

### 6. Deploy to Cloudflare

```bash
npx wrangler secret put DATABASE_URL
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put VOTER_TOKEN_SECRET
npm run deploy
```

`PUBLIC_ORIGIN` and `ENVIRONMENT` are non-secret vars committed in
`wrangler.jsonc`. Turnstile is optional; if enabled, configure
`PUBLIC_TURNSTILE_SITE_KEY` as a var and `TURNSTILE_SECRET_KEY` as a secret.
