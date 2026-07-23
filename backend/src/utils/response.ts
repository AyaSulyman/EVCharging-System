import { NextResponse } from "next/server";
import { AuthError } from "@/middleware/auth";
import { ValidationError } from "@/validation";

const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/** JSON response with CORS headers applied — use this instead of NextResponse.json directly. */
export function json(data: unknown, init?: { status?: number }) {
  return NextResponse.json(data, {
    status: init?.status ?? 200,
    headers: CORS_HEADERS,
  });
}

/** Standard preflight (OPTIONS) response — export `OPTIONS = preflight` from any route file. */
export function preflight() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export function serialize<T>(doc: unknown): T {
  return JSON.parse(JSON.stringify(doc)) as T;
}

/**
 * Maps a thrown error to a response, so every handler treats authorisation failures,
 * validation failures and domain sentinels the same way.
 *
 * Domain services signal expected outcomes with sentinel messages (SLOT_UNAVAILABLE,
 * VEHICLE_NOT_OWNED …); pass the ones a route understands. Anything unrecognised is
 * logged and returned as the fallback, so an unexpected fault never leaks internals.
 */
export function errorResponse(
  err: unknown,
  fallback: string,
  sentinels: Record<string, { status: number; error: string }> = {}
) {
  if (err instanceof AuthError) {
    return json({ error: err.message }, { status: err.status });
  }
  if (err instanceof ValidationError) {
    return json({ error: err.message, issues: err.issues }, { status: err.status });
  }
  const mapped = err instanceof Error ? sentinels[err.message] : undefined;
  if (mapped) return json({ error: mapped.error }, { status: mapped.status });

  console.error(err);
  return json({ error: fallback }, { status: 500 });
}
