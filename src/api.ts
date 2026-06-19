export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? "The request could not be completed.");
  }

  return payload as T;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
