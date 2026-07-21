import { verifyToken, type TokenPayload } from "@/utils/jwt";

/** Reads the `Authorization: Bearer <token>` header and returns the decoded user, or null. */
export function getAuthUser(req: Request): TokenPayload | null {
  const header = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return verifyToken(token);
}

export function requireAuth(req: Request): TokenPayload {
  const user = getAuthUser(req);
  if (!user) throw new AuthError("Unauthorized", 401);
  return user;
}

export function requireAdmin(req: Request): TokenPayload {
  const user = requireAuth(req);
  if (user.role !== "admin") throw new AuthError("Forbidden", 403);
  return user;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
