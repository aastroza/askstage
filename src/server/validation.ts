import { createError } from "./http";

export function slugFromTitle(value: string): string {
  return normalizeSlug(value) || "event";
}

export function normalizeSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function assertQuestionStatus(value: unknown): string {
  if (value === "open" || value === "answered" || value === "hidden") return value;
  throw createError(400, "Invalid question status.");
}

export function safeUuid(value: string | null): string {
  if (!value) return "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : "";
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeQuestionBody(value: string): string {
  return cleanText(value).toLowerCase();
}

export function assertString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw createError(400, `Missing ${name}.`);
  }
  return value.trim();
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const data = await request.json().catch(() => null);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw createError(400, "Invalid JSON.");
  }
  return data as Record<string, unknown>;
}
