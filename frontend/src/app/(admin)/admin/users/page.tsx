"use client";

import { useEffect, useState } from "react";
import { Loader2, Search, Shield, User as UserIcon } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useApi } from "@/lib/useApi";

interface AdminUser {
  _id: string;
  name: string;
  email: string;
  phone?: string;
  role: "user" | "admin";
  createdAt: string;
  bookingCount: number;
  vehicleCount: number;
  /** Charge estimate for kept reservations. Not billed — no payment processing exists. */
  estimatedSpend: number;
}

export default function AdminUsersPage() {
  const { call, token } = useApi();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  useEffect(() => {
    // The session hydrates after first render, so the bearer token is not available
    // on mount. Waiting for it prevents an unauthenticated first request that would
    // never be retried, which made these screens load empty on a direct link or refresh.
    if (!token) return;
    call("/api/users")
      .then((r) => r.json())
      .then((d) => setUsers(d.users ?? []))
      .finally(() => setLoading(false));
  }, [token]);

  const filtered = users.filter(
    (u) =>
      !query ||
      u.name.toLowerCase().includes(query.toLowerCase()) ||
      u.email.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div>
      <h1 className="text-2xl font-bold text-ink">Users</h1>
      <p className="mt-1 text-ink-soft">All registered drivers and admins.</p>

      <div className="mt-6 flex items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">
          {users.length} user{users.length !== 1 ? "s" : ""}
        </p>
        <div className="relative sm:w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" />
          <input
            className="field pl-9"
            placeholder="Search name or email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="card mt-6 overflow-x-auto">
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                <th className="pb-2 pr-4 font-medium">User</th>
                <th className="pb-2 pr-4 font-medium">Role</th>
                <th className="pb-2 pr-4 font-medium">Bookings</th>
                <th className="pb-2 pr-4 font-medium">Vehicles</th>
                <th className="pb-2 pr-4 font-medium">Est. spent</th>
                <th className="pb-2 font-medium">Joined</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map((u) => (
                <tr key={u._id} className="text-ink">
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-dark text-xs font-bold text-white">
                        {u.name.charAt(0).toUpperCase()}
                      </span>
                      <div>
                        <p className="font-medium">{u.name}</p>
                        <p className="text-xs text-ink-soft">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 pr-4">
                    {u.role === "admin" ? (
                      <span className="chip bg-primary-light text-primary">
                        <Shield className="h-3 w-3" />
                        Admin
                      </span>
                    ) : (
                      <span className="chip bg-canvas text-ink-soft">
                        <UserIcon className="h-3 w-3" />
                        User
                      </span>
                    )}
                  </td>
                  <td className="py-3 pr-4">{u.bookingCount}</td>
                  <td className="py-3 pr-4">{u.vehicleCount}</td>
                  <td className="py-3 pr-4">{formatCurrency(u.estimatedSpend)}</td>
                  <td className="py-3 text-ink-soft">{formatDate(u.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
