import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const migrationsDir = path.resolve("migrations");
const sql = neon(databaseUrl);

const files = (await readdir(migrationsDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
  .map((entry) => entry.name)
  .sort();

for (const file of files) {
  const source = await readFile(path.join(migrationsDir, file), "utf8");
  const statements = splitSqlStatements(source);
  for (const statement of statements) {
    await sql.query(statement, []);
  }
  console.log(`applied ${file}`);
}

function splitSqlStatements(source) {
  const statements = [];
  let current = "";
  let singleQuote = false;
  let doubleQuote = false;
  let lineComment = false;
  let blockComment = false;
  let dollarQuote = "";

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] ?? "";

    if (lineComment) {
      current += char;
      if (char === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }

    if (dollarQuote) {
      if (source.startsWith(dollarQuote, index)) {
        current += dollarQuote;
        index += dollarQuote.length - 1;
        dollarQuote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (!singleQuote && !doubleQuote && char === "-" && next === "-") {
      current += char + next;
      index += 1;
      lineComment = true;
      continue;
    }

    if (!singleQuote && !doubleQuote && char === "/" && next === "*") {
      current += char + next;
      index += 1;
      blockComment = true;
      continue;
    }

    if (!singleQuote && !doubleQuote && char === "$") {
      const match = source.slice(index).match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        dollarQuote = match[0];
        current += dollarQuote;
        index += dollarQuote.length - 1;
        continue;
      }
    }

    if (!doubleQuote && char === "'" && source[index - 1] !== "\\") {
      singleQuote = !singleQuote;
      current += char;
      continue;
    }

    if (!singleQuote && char === '"') {
      doubleQuote = !doubleQuote;
      current += char;
      continue;
    }

    if (!singleQuote && !doubleQuote && char === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      continue;
    }

    current += char;
  }

  const trailing = current.trim();
  if (trailing) statements.push(trailing);
  return statements;
}
