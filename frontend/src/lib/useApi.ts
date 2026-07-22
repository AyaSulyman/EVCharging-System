"use client";

import { useSession } from "next-auth/react";
import { apiUrl } from "@/lib/apiClient";

/**
 * Client-side helper for calling the real backend from components.
 * Automatically attaches the current session's backend JWT as a Bearer token.
 *
 * Usage:
 *   const { call } = useApi();
 *   const res = await call("/api/vehicles", { method: "POST", body: JSON.stringify(form) });
 */
export function useApi() {
  const { data: session } = useSession();
  const token = (session as { backendToken?: string } | null)?.backendToken;

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type") && init.body) {
      headers.set("Content-Type", "application/json");
    }
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(apiUrl(path), { ...init, headers });
  }

  return { call, token };
}
