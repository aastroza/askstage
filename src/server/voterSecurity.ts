import { createError } from "./http";

export type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type VoterSecurityEnv = {
  VOTER_TOKEN_SECRET?: string;
};

export type VoterTokenPayload = {
  eventId: string;
  voterId: string;
  iat: number;
  exp: number;
};

export async function createVoterToken(env: VoterSecurityEnv, eventId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: VoterTokenPayload = {
    eventId,
    voterId: crypto.randomUUID(),
    iat: now,
    exp: now + 7 * 24 * 60 * 60,
  };
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await signVoterPayload(env, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export async function optionalVoterToken(
  request: Request,
  env: VoterSecurityEnv,
  eventId: string,
): Promise<VoterTokenPayload | null> {
  const token = cookieValue(request, "askstage_voter");
  if (!token) return null;
  try {
    const payload = await verifyVoterToken(env, token);
    return payload.eventId === eventId ? payload : null;
  } catch {
    return null;
  }
}

export async function requireVoterToken(request: Request, env: VoterSecurityEnv): Promise<VoterTokenPayload> {
  const token = cookieValue(request, "askstage_voter");
  if (!token) throw createError(401, "Voter token required.");
  return verifyVoterToken(env, token);
}

export async function verifyVoterToken(env: VoterSecurityEnv, token: string): Promise<VoterTokenPayload> {
  const [encodedPayload, signature] = token.split(".", 2);
  if (!encodedPayload || !signature) throw createError(401, "Invalid voter token.");
  const expected = await signVoterPayload(env, encodedPayload);
  if (!timingSafeEqual(signature, expected)) throw createError(401, "Invalid voter token.");

  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload))) as Partial<VoterTokenPayload>;
  if (!payload.eventId || !payload.voterId || !payload.exp) throw createError(401, "Invalid voter token.");
  if (payload.exp < Math.floor(Date.now() / 1000)) throw createError(401, "Expired voter token.");
  return payload as VoterTokenPayload;
}

async function signVoterPayload(env: VoterSecurityEnv, encodedPayload: string): Promise<string> {
  if (!env.VOTER_TOKEN_SECRET) throw createError(500, "Voter tokens are not configured.");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.VOTER_TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encodedPayload));
  return base64UrlEncode(new Uint8Array(signature));
}

export function voterCookie(token: string, url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `askstage_voter=${token}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`;
}

export function cookieValue(request: Request, name: string): string {
  const cookie = request.headers.get("cookie") ?? "";
  const prefix = `${name}=`;
  return cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length) ?? "";
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

export async function enforceRateLimit(
  limiter: RateLimitBinding | undefined,
  env: VoterSecurityEnv,
  keyParts: string[],
): Promise<void> {
  if (!limiter) return;
  const key = await rateLimitKey(env, keyParts);
  const result = await limiter.limit({ key });
  if (!result.success) throw createError(429, "Too many requests. Please try again shortly.");
}

export async function rateLimitKey(env: VoterSecurityEnv, keyParts: string[]): Promise<string> {
  const value = keyParts.join(":");
  if (!env.VOTER_TOKEN_SECRET) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return base64UrlEncode(new Uint8Array(digest)).slice(0, 64);
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.VOTER_TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(signature)).slice(0, 64);
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
