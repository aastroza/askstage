import { type NeonQueryFunction } from "@neondatabase/serverless";
import { createError } from "./http";
import { base64UrlDecode } from "./voterSecurity";

type Sql = NeonQueryFunction<false, false>;

export type AuthEnv = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_JWT_AUDIENCE?: string;
};

export type UserRow = {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
};

type SupabaseUser = {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
};

type SupabaseJwtClaims = {
  sub?: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
  exp?: number;
  nbf?: number;
  aud?: string | string[];
  iss?: string;
};

type JwtHeader = {
  alg?: string;
  kid?: string;
};

type JsonWebKeySet = {
  keys?: Array<JsonWebKey & { kid?: string; alg?: string }>;
};

let jwksCache: { url: string; expiresAt: number; keys: JsonWebKeySet["keys"] } | null = null;

export async function currentUser(request: Request, env: AuthEnv, sql: Sql): Promise<UserRow | null> {
  const supabaseToken = bearerToken(request);
  if (!supabaseToken) return null;

  const supabaseUser = await verifySupabaseUser(env, supabaseToken);
  if (!supabaseUser.email) throw createError(401, "Authenticated user is missing an email address.");

  const user = await ensureLocalUser(sql, supabaseUser);
  const metadata = supabaseUser.user_metadata ?? {};
  return {
    ...user,
    name: profileName(metadata, user.email),
    avatarUrl: profileAvatarUrl(metadata),
  };
}

export async function requireUser(request: Request, env: AuthEnv, sql: Sql): Promise<UserRow> {
  const user = await currentUser(request, env, sql);
  if (!user) throw createError(401, "Authentication required.");
  return user;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const [scheme, token] = header.split(/\s+/, 2);
  if (scheme.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

async function verifySupabaseUser(env: AuthEnv, accessToken: string): Promise<SupabaseUser> {
  const localUser = await verifySupabaseJwt(env, accessToken).catch(() => null);
  if (localUser) return localUser;

  return verifySupabaseUserRemote(env, accessToken);
}

async function verifySupabaseUserRemote(env: AuthEnv, accessToken: string): Promise<SupabaseUser> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw createError(500, "Supabase Auth is not configured.");
  }

  const response = await fetch(`${normalizeSupabaseUrl(env)}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) throw createError(401, "Authentication required.");

  const user = (await response.json()) as Partial<SupabaseUser>;
  if (!user.id) throw createError(401, "Authentication required.");
  return { id: user.id, email: user.email, user_metadata: user.user_metadata };
}

async function verifySupabaseJwt(env: AuthEnv, accessToken: string): Promise<SupabaseUser> {
  if (!env.SUPABASE_URL) throw createError(500, "Supabase Auth is not configured.");

  const [encodedHeader, encodedPayload, encodedSignature] = accessToken.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw createError(401, "Authentication required.");

  const header = parseBase64UrlJson<JwtHeader>(encodedHeader);
  if (!header.alg || !header.kid) throw createError(401, "Authentication required.");

  const key = await getSupabaseJwksKey(env, header);
  const algorithm = jwtVerifyAlgorithm(header.alg);
  const cryptoKey = await crypto.subtle.importKey("jwk", key, algorithm.importAlgorithm, false, ["verify"]);
  const verified = await crypto.subtle.verify(
    algorithm.verifyAlgorithm,
    cryptoKey,
    base64UrlDecode(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!verified) throw createError(401, "Authentication required.");

  const claims = parseBase64UrlJson<SupabaseJwtClaims>(encodedPayload);
  validateSupabaseClaims(env, claims);
  return { id: claims.sub ?? "", email: claims.email, user_metadata: claims.user_metadata };
}

async function getSupabaseJwksKey(env: AuthEnv, header: JwtHeader): Promise<JsonWebKey> {
  const supabaseUrl = normalizeSupabaseUrl(env);
  const jwksUrl = `${supabaseUrl}/auth/v1/.well-known/jwks.json`;
  const now = Date.now();
  if (!jwksCache || jwksCache.url !== jwksUrl || jwksCache.expiresAt < now) {
    const response = await fetch(jwksUrl, {
      headers: env.SUPABASE_ANON_KEY ? { apikey: env.SUPABASE_ANON_KEY } : undefined,
    });
    if (!response.ok) throw createError(401, "Authentication required.");

    const jwks = (await response.json()) as JsonWebKeySet;
    jwksCache = {
      url: jwksUrl,
      expiresAt: now + 10 * 60 * 1000,
      keys: Array.isArray(jwks.keys) ? jwks.keys : [],
    };
  }

  const key = jwksCache.keys?.find((candidate) => candidate.kid === header.kid);
  if (!key) throw createError(401, "Authentication required.");
  return key;
}

function jwtVerifyAlgorithm(alg: string): {
  importAlgorithm: EcKeyImportParams | RsaHashedImportParams;
  verifyAlgorithm: EcdsaParams | RsaPssParams | AlgorithmIdentifier;
} {
  if (alg === "RS256") {
    const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    return { importAlgorithm: algorithm, verifyAlgorithm: algorithm.name };
  }

  if (alg === "ES256") {
    return {
      importAlgorithm: { name: "ECDSA", namedCurve: "P-256" },
      verifyAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    };
  }

  throw createError(401, "Authentication required.");
}

export function validateSupabaseClaims(env: AuthEnv, claims: SupabaseJwtClaims): void {
  if (!claims.sub) throw createError(401, "Authentication required.");
  const now = Math.floor(Date.now() / 1000);
  if (!claims.exp || claims.exp <= now) throw createError(401, "Authentication required.");
  if (claims.nbf && claims.nbf > now) throw createError(401, "Authentication required.");

  const expectedAudience = env.SUPABASE_JWT_AUDIENCE ?? "authenticated";
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expectedAudience)) throw createError(401, "Authentication required.");

  const expectedIssuer = `${normalizeSupabaseUrl(env)}/auth/v1`;
  if (claims.iss && claims.iss !== expectedIssuer) throw createError(401, "Authentication required.");
}

function parseBase64UrlJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(value))) as T;
}

function normalizeSupabaseUrl(env: AuthEnv): string {
  if (!env.SUPABASE_URL) throw createError(500, "Supabase Auth is not configured.");
  return env.SUPABASE_URL.replace(/\/$/, "");
}

async function ensureLocalUser(sql: Sql, supabaseUser: SupabaseUser): Promise<UserRow> {
  const email = normalizeEmail(supabaseUser.email ?? "");
  const existingRows = await sql`
    select id::text, email
    from users
    where supabase_user_id = ${supabaseUser.id}
    limit 1
  `;
  const existing = existingRows[0] as UserRow | undefined;
  if (existing) {
    if (normalizeEmail(existing.email) === email) return existing;

    const updatedRows = await sql`
      update users
      set email = ${email}
      where id = ${existing.id}
      returning id::text, email
    `;
    return updatedRows[0] as UserRow;
  }

  const linkedRows = await sql`
    update users
    set supabase_user_id = ${supabaseUser.id},
        auth_provider = 'supabase'
    where lower(email) = ${email}
      and supabase_user_id is null
    returning id::text, email
  `;
  if (linkedRows[0]) return linkedRows[0] as UserRow;

  const rows = await sql`
    insert into users (email, supabase_user_id, auth_provider)
    values (${email}, ${supabaseUser.id}, 'supabase')
    on conflict (supabase_user_id)
    where supabase_user_id is not null
    do update set email = excluded.email
    returning id::text, email
  `;
  return rows[0] as UserRow;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw createError(400, "Invalid email.");
  return email;
}

function profileName(metadata: Record<string, unknown>, email: string): string {
  const value = metadata.full_name ?? metadata.name;
  if (typeof value === "string" && value.trim()) return cleanText(value).slice(0, 120);
  return email.split("@")[0] ?? email;
}

function profileAvatarUrl(metadata: Record<string, unknown>): string {
  const value = metadata.avatar_url ?? metadata.picture;
  return typeof value === "string" && isHttpUrl(value) ? value : "";
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
