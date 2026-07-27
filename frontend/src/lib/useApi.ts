"use client";

import { useCallback } from "react";
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

  // Memoized on `token` alone: callers commonly put `call` in a useCallback/useEffect
  // dependency array, and a fresh function identity every render would re-fire that effect
  // every render — an infinite fetch loop, not just a wasted allocation.
  const call = useCallback(
    async (path: string, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers);
      if (!headers.has("Content-Type") && init.body) {
        headers.set("Content-Type", "application/json");
      }
      if (token) headers.set("Authorization", `Bearer ${token}`);
      return fetch(apiUrl(path), { ...init, headers });
    },
    [token]
  );

  return { call, token };
}
