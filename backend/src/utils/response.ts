import { NextResponse } from "next/server";

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
