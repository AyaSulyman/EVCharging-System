import { connectDB } from "@/config/database";
import User from "@/models/User";
import { verifyToken, type TokenPayload } from "@/utils/jwt";

/** Decodes and verifies the bearer token. Does not check whether the session is still active. */
export function getAuthUser(req: Request): TokenPayload | null {
  const header = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return verifyToken(token);
}

/**
 * Verifies the bearer token and confirms the session has not been revoked.
 *
 * Tokens are stateless, so revocation works by comparing the generation stamped
 * into the token against the account's current sessionGeneration: incrementing
 * that field invalidates every token issued before it. This costs one indexed
 * read per authenticated request, which is the price of being able to revoke a
 * credential at all.
 *
 * Tokens issued before this field existed carry no generation and are treated as
 * generation 0, which matches the default on existing accounts.
 */
export async function requireAuth(req: Request): Promise<TokenPayload> {
  const user = getAuthUser(req);
  if (!user) throw new AuthError("Unauthorized", 401);

  await connectDB();
  const account = await User.findById(user.id)
    .select("sessionGeneration")
    .lean<{ sessionGeneration?: number } | null>();

  // The account was deleted after the token was issued.
  if (!account) throw new AuthError("Unauthorized", 401);

  if ((account.sessionGeneration ?? 0) !== (user.gen ?? 0)) {
    throw new AuthError("Session expired", 401);
  }

  return user;
}

export async function requireAdmin(req: Request): Promise<TokenPayload> {
  const user = await requireAuth(req);
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
