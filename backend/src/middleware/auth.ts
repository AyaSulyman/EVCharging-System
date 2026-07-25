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
    .select("+sessionGeneration")
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

/** An authenticated staff (or admin) principal, carrying the stations it may operate. */
export interface StaffAuth extends TokenPayload {
  /** Stations this principal may act on. Empty for admin, who is treated as all-stations. */
  staffStationIds: string[];
  /** True for admin, which is a superset of staff for support purposes. */
  isAdmin: boolean;
}

/**
 * Gate for the staff surface. Admits `staff` and, as a superset, `admin`.
 *
 * The station scope is read fresh from the database on every request rather than trusted
 * from the token, so that revoking or reassigning a staff member's stations takes effect
 * immediately — a stale token cannot widen access. (Role changes additionally bump the
 * account's sessionGeneration, which requireAuth already enforces, so a demoted staff token
 * is rejected outright.) Use assertStationInScope to authorise a specific station.
 */
export async function requireStaff(req: Request): Promise<StaffAuth> {
  const user = await requireAuth(req);
  if (user.role !== "staff" && user.role !== "admin") {
    throw new AuthError("Forbidden", 403);
  }

  const isAdmin = user.role === "admin";
  let staffStationIds: string[] = [];
  if (!isAdmin) {
    const account = await User.findById(user.id)
      .select("staffStationIds")
      .lean<{ staffStationIds?: unknown[] } | null>();
    staffStationIds = (account?.staffStationIds ?? []).map((s) => String(s));
  }

  return { ...user, staffStationIds, isAdmin };
}

/**
 * Authorises an action against a specific station. Admin passes for any station; a staff
 * member passes only for a station in their assignment. Throws 403 otherwise.
 */
export function assertStationInScope(auth: StaffAuth, stationId: string | { toString(): string }): void {
  if (auth.isAdmin) return;
  if (!auth.staffStationIds.includes(String(stationId))) {
    throw new AuthError("Forbidden: station outside your assignment", 403);
  }
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
