# PreguntaYa

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

## Self-hosting

### 1. Create a Neon database

Create a Neon project and copy its pooled connection string.

Run the schema:

```bash
psql "$DATABASE_URL" -f migrations/0001_initial.sql
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure local secrets

Create `.dev.vars`:

```bash
DATABASE_URL="postgresql://..."
ALLOW_SIGNUPS="true"
```

Set `ALLOW_SIGNUPS="false"` after creating your first account if you want a private install.

### 4. Run locally

```bash
npm run dev
```

Open `http://localhost:8787`.

### 5. Deploy to Cloudflare

```bash
npx wrangler secret put DATABASE_URL
npm run deploy
```

Optional:

```bash
npx wrangler secret put ALLOW_SIGNUPS
```

Then map your custom domain in Cloudflare.
