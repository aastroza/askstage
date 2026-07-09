# AskStage

AskStage is a small live Q&A app for talks, panels, and classes. Organizers create an event page, share a public link or QR code, and moderate questions while attendees submit and vote without signing in.

## Stack

- React + Vite
- Cloudflare Workers + Static Assets
- Neon Postgres
- Supabase Auth with Google

## Self-host

You need:

- A Neon Postgres database
- A Supabase project with Google Auth enabled
- A Cloudflare account for Workers deploys
- Node.js 22+

Install dependencies:

```bash
npm install
```

Create a `.dev.vars` file:

```bash
DATABASE_URL="postgresql://..."
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_ANON_KEY="..."
VOTER_TOKEN_SECRET="generate-a-long-random-secret"
PUBLIC_ORIGIN="http://localhost:8787"
```

Initialize the database schema:

```bash
npm run db:migrate
```

If you do not have `psql` installed, use:

```bash
npm run db:migrate:http
```

In Supabase and Google OAuth, allow this redirect URL for local development:

```text
http://localhost:8787/app
```

Run the app:

```bash
npm run dev
```

Open `http://localhost:8787`.

## Deploy

Set these Cloudflare secrets:

```bash
npx wrangler secret put DATABASE_URL
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put VOTER_TOKEN_SECRET
```

Set your production origin in `wrangler.jsonc`:

```json
"PUBLIC_ORIGIN": "https://your-domain.com"
```

Add the production OAuth redirect URL in Supabase and Google:

```text
https://your-domain.com/app
```

Deploy:

```bash
npm run deploy
```

Optional Turnstile protection for public question submissions uses:

- `PUBLIC_TURNSTILE_SITE_KEY` as a Cloudflare var
- `TURNSTILE_SECRET_KEY` as a Cloudflare secret

## Contribute

Run the main checks before opening a PR:

```bash
npm test
npm run build
npm run check
npm audit --audit-level=high
```

The test suite includes Worker API tests and Node checks for database setup, dependency maintenance, and production exposure settings.

For real Postgres trigger coverage, provide a disposable database URL:

```bash
TEST_DATABASE_URL="postgresql://..." npm run test:db
```

## License

MIT
