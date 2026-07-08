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
psql "$DATABASE_URL" -f migrations/0001_initial.sql
```

For a fresh Supabase Auth install, run the auth migration too. This deletes existing local users and cascades owned events/questions.

```bash
psql "$DATABASE_URL" -f migrations/0002_supabase_auth_fresh_start.sql
```

### 2. Configure Supabase Auth

Create a Supabase project and enable the Google provider in Authentication.

Use these redirect URLs in Supabase and Google OAuth:

```text
http://localhost:8787/app
https://preguntaya.alonsoastroza.workers.dev/app
https://<your-custom-domain>/app
```

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
```

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
npm run deploy
```

Then map your custom domain in Cloudflare.
