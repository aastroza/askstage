export type ApiError = {
  status: number;
  message: string;
};

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...jsonHeaders, ...headers },
  });
}

export function canonicalOriginResponse(
  request: Request,
  env: { PUBLIC_ORIGIN?: string },
  url: URL,
): Response | null {
  const canonicalOrigin = normalizeOrigin(env.PUBLIC_ORIGIN);
  if (!canonicalOrigin || url.origin === canonicalOrigin) return null;

  if ((request.method === "GET" || request.method === "HEAD") && !url.pathname.startsWith("/api/")) {
    const target = new URL(`${url.pathname}${url.search}`, canonicalOrigin);
    return Response.redirect(target.toString(), 308);
  }

  return json({ error: "Not found." }, 404);
}

function normalizeOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;

  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function withSecurityHeaders(response: Response, url: URL): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("content-security-policy", contentSecurityPolicy(url));
  if (url.protocol === "https:") {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function contentSecurityPolicy(url: URL): string {
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self' https://*.supabase.co https://challenges.cloudflare.com",
    "script-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "form-action 'self'",
  ];
  if (url.protocol === "https:") directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function createError(status: number, message: string): ApiError {
  return { status, message };
}

export function normalizeError(error: unknown): ApiError {
  if (isApiError(error)) return error;
  console.error(JSON.stringify({ level: "error", message: String(error) }));
  return { status: 500, message: "Internal server error." };
}

function isApiError(error: unknown): error is ApiError {
  return Boolean(
    error &&
      typeof error === "object" &&
      "status" in error &&
      "message" in error &&
      typeof (error as ApiError).status === "number" &&
      typeof (error as ApiError).message === "string",
  );
}
