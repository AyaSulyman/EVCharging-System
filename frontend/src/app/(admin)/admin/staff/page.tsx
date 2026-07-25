"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, UserCog, UserMinus, MapPin } from "lucide-react";
import { useApi } from "@/lib/useApi";
import { formatDate } from "@/lib/utils";

interface StaffStation {
  _id: string;
  name: string;
}
interface StaffMember {
  _id: string;
  name: string;
  email: string;
  phone?: string;
  staffStationIds: StaffStation[];
  createdAt: string;
}
interface Station {
  _id: string;
  name: string;
}

const EMPTY = { name: "", email: "", password: "", phone: "", stationIds: [] as string[] };

export default function AdminStaffPage() {
  const { call, token } = useApi();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    const [s, st] = await Promise.all([
      call("/api/admin/staff").then((r) => r.json()),
      call("/api/stations").then((r) => r.json()),
    ]);
    setStaff(s.staff ?? []);
    setStations(st.stations ?? []);
    setLoading(false);
  }, [call, token]);

  useEffect(() => {
    if (!token) return;
    load();
  }, [token, load]);

  function toggleStation(id: string) {
    setForm((f) => ({
      ...f,
      stationIds: f.stationIds.includes(id)
        ? f.stationIds.filter((x) => x !== id)
        : [...f.stationIds, id],
    }));
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (form.stationIds.length === 0) {
      setError("Assign at least one station.");
      return;
    }
    setCreating(true);
    const res = await call("/api/admin/staff", {
      method: "POST",
      body: JSON.stringify(form),
    });
    const data = await res.json();
    setCreating(false);
    if (!res.ok) {
      setError(data.error ?? "Could not create staff account");
      return;
    }
    setForm(EMPTY);
    load();
  }

  async function revoke(id: string) {
    const res = await call(`/api/admin/staff/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ active: false }),
    });
    if (res.ok) load();
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-ink">Staff</h1>
      <p className="mt-1 text-ink-soft">On-site operators and the stations they run.</p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Create */}
      <form onSubmit={create} className="card mt-6">
        <h2 className="text-sm font-semibold text-ink">Add staff account</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">Name</label>
            <input
              className="field"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Email</label>
            <input
              className="field"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Temporary password</label>
            <input
              className="field"
              type="text"
              placeholder="At least 8 characters"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Phone (optional)</label>
            <input
              className="field"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </div>
        </div>

        <label className="label mt-4">Assigned stations</label>
        <div className="flex flex-wrap gap-2">
          {stations.map((s) => {
            const on = form.stationIds.includes(s._id);
            return (
              <button
                type="button"
                key={s._id}
                onClick={() => toggleStation(s._id)}
                className={`chip cursor-pointer ${on ? "bg-primary text-white" : "bg-canvas text-ink-soft"}`}
              >
                <MapPin className="h-3 w-3" />
                {s.name.replace("ChargeHub — ", "")}
              </button>
            );
          })}
        </div>

        <button type="submit" disabled={creating} className="btn-primary mt-5">
          {creating && <Loader2 className="h-4 w-4 animate-spin" />}
          {creating ? "Creating…" : "Create staff account"}
        </button>
      </form>

      {/* List */}
      <div className="card mt-6 overflow-x-auto">
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : staff.length === 0 ? (
          <p className="py-12 text-center text-sm text-ink-soft">No staff accounts yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                <th className="pb-2 pr-4 font-medium">Staff</th>
                <th className="pb-2 pr-4 font-medium">Stations</th>
                <th className="pb-2 pr-4 font-medium">Added</th>
                <th className="pb-2 font-medium text-right">Access</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {staff.map((m) => (
                <tr key={m._id} className="text-ink">
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-dark text-white">
                        <UserCog className="h-4 w-4" />
                      </span>
                      <div>
                        <p className="font-medium">{m.name}</p>
                        <p className="text-xs text-ink-soft">{m.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex flex-wrap gap-1">
                      {m.staffStationIds.map((s) => (
                        <span key={s._id} className="chip bg-canvas text-ink-soft">
                          {s.name.replace("ChargeHub — ", "")}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-3 pr-4 text-ink-soft">{formatDate(m.createdAt)}</td>
                  <td className="py-3 text-right">
                    <button
                      onClick={() => revoke(m._id)}
                      className="btn-secondary ml-auto inline-flex items-center gap-1.5"
                    >
                      <UserMinus className="h-4 w-4" />
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
