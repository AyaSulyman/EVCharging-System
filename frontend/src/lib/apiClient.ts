const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export function apiUrl(path: string): string {
  return `${API_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Calls the real backend. Pass `token` (the NextAuth session's backendToken)
 * for any endpoint that requires auth.
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
  token?: string
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);

  return fetch(apiUrl(path), { ...init, headers, cache: "no-store" });
}

/** Convenience helper: fetch + parse JSON, throwing with the backend's error message on failure. */
export async function apiJson<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const res = await apiFetch(path, init, token);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data as T;
}
