import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8").toLowerCase();
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

describe("database migrations", () => {
  it("keeps the production Supabase Auth migration non-destructive", () => {
    const migration = read("migrations/0002_supabase_auth_columns.sql");

    expect(migration).toContain("add column if not exists supabase_user_id");
    expect(migration).toContain("users_supabase_user_id_idx");
    expect(migration).not.toContain("delete from users");
    expect(migration).not.toContain("drop table");
    expect(migration).not.toContain("drop column");
  });

  it("isolates the destructive Supabase Auth reset under dev_only", () => {
    const destructive = read("migrations/dev_only/0002_supabase_auth_fresh_start_destructive.sql");
    const readme = read("readme.md");

    expect(destructive).toContain("delete from users");
    expect(destructive).toContain("never run this on a");
    expect(readme).toContain("migrations/dev_only/");
    expect(readme).not.toContain("0002_supabase_auth_fresh_start.sql");
  });

  it("adds and maintains denormalized question scores", () => {
    const migration = read("migrations/0003_question_score.sql");

    expect(migration).toContain("add column if not exists score");
    expect(migration).toContain("select sum(v.value)::int");
    expect(migration).toContain("create trigger question_votes_score_sync_trigger");
    expect(migration).toContain("after insert or update or delete on question_votes");
  });

  it("uses the safe migration runner for root migrations only", () => {
    const runner = read("scripts/migrate-safe.mjs");
    const httpRunner = read("scripts/migrate-http.mjs");
    const readme = read("readme.md");

    expect(runner).toContain("readdirsync(migrationdir, { withfiletypes: true })");
    expect(runner).toContain("entry.isfile()");
    expect(runner).toContain("on_error_stop=1");
    expect(runner).not.toContain("dev_only");
    expect(httpRunner).toContain("entry.isfile()");
    expect(httpRunner).toContain("sql.query(statement, [])");
    expect(httpRunner).not.toContain("dev_only");
    expect(readme).toContain("npm run db:migrate");
    expect(readme).toContain("intentionally ignores `migrations/dev_only/`");
  });
});

describe("dependency maintenance", () => {
  it("keeps automated update PRs enabled", () => {
    const dependabot = read(".github/dependabot.yml");

    expect(dependabot).toContain("package-ecosystem: npm");
    expect(dependabot).toContain("package-ecosystem: github-actions");
    expect(dependabot).toContain("interval: weekly");
  });
});

describe("production exposure", () => {
  it("keeps preview URLs disabled and constrains workers.dev exposure", () => {
    const wrangler = readJson<{
      workers_dev?: boolean;
      preview_urls?: boolean;
      vars?: { PUBLIC_ORIGIN?: string };
      secrets?: { required?: string[] };
    }>("wrangler.jsonc");
    const readme = read("readme.md");
    const publicOrigin = wrangler.vars?.PUBLIC_ORIGIN ?? "";
    const productionUsesWorkersDev = publicOrigin.endsWith(".workers.dev");

    expect(wrangler.preview_urls).toBe(false);
    expect(wrangler.workers_dev).toBe(productionUsesWorkersDev);
    expect(wrangler.secrets?.required).toEqual(
      expect.arrayContaining(["DATABASE_URL", "SUPABASE_URL", "SUPABASE_ANON_KEY", "VOTER_TOKEN_SECRET"]),
    );
    expect(readme).toContain("set `workers_dev` to `false`");
    expect(readme).toContain("remove the workers subdomain");
  });
});
