"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, AlertOctagon, PlusCircle, CheckCircle2, RefreshCw, GitBranch } from "lucide-react";
import { useApi } from "@/lib/useApi";
import { cn, formatDate, formatTime } from "@/lib/utils";

interface Station {
  _id: string;
  name: string;
}
interface Charger {
  _id: string;
  stationId: string;
  label: string;
}
interface IncidentRow {
  _id: string;
  type: string;
  severity: string;
  status: string;
  title: string;
  stationName: string;
  chargerLabels: string[];
  createdAt: string;
  actionRequired: string;
  activeReservationCount: number;
  upcomingReservationCount: number;
  affectedRecommendationCount: number;
  affectedWaitlistCount: number;
}

interface ChainEntry {
  bookingId: { _id: string; bookingCode?: string } | string;
  userId: { _id: string; name?: string; email?: string } | string;
  position: number;
  delayMinutes: number;
  severity: "MINOR" | "MODERATE" | "SEVERE" | "CRITICAL";
  originalScheduledStart: string;
  originalScheduledEnd: string;
  estimatedNewStart: string;
  estimatedNewEnd: string;
  recoveryRequestId: string | null;
}
interface Propagation {
  _id: string;
  chain: ChainEntry[];
  maxCascadeDepth: number;
  resolutionStatus: "OPEN" | "RECOVERING" | "RESOLVED";
}

const DELAY_SEVERITY_STYLE: Record<string, string> = {
  MINOR: "bg-canvas text-ink-soft",
  MODERATE: "bg-amber-100 text-amber-800",
  SEVERE: "bg-orange-100 text-orange-800",
  CRITICAL: "bg-red-100 text-red-700",
};

const INCIDENT_TYPES = [
  { value: "CHARGER_FAILURE", label: "Charger failure" },
  { value: "MAINTENANCE", label: "Maintenance" },
  { value: "POWER_OUTAGE", label: "Power outage" },
  { value: "PARTIAL_STATION_OUTAGE", label: "Partial station outage" },
];
const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

const SEVERITY_STYLE: Record<string, string> = {
  LOW: "bg-canvas text-ink-soft",
  MEDIUM: "bg-amber-100 text-amber-800",
  HIGH: "bg-orange-100 text-orange-800",
  CRITICAL: "bg-red-100 text-red-700",
};
const STATUS_STYLE: Record<string, string> = {
  CREATED: "bg-canvas text-ink-soft",
  INVESTIGATING: "bg-amber-100 text-amber-800",
  ACTIVE: "bg-red-100 text-red-700",
  RESOLVED: "bg-green-100 text-green-700",
  CLOSED: "bg-canvas text-ink-soft",
};

/**
 * The forward transitions this screen offers, mirroring `ALLOWED_INCIDENT_TRANSITIONS` in
 * `incidentPolicy.ts` — the server is still the authority (it validates independently), this only
 * decides which buttons make sense to show.
 */
const NEXT_STEPS: Record<string, { status: string; label: string }[]> = {
  CREATED: [
    { status: "INVESTIGATING", label: "Start investigating" },
    { status: "ACTIVE", label: "Confirm active" },
    { status: "RESOLVED", label: "Mark resolved" },
  ],
  INVESTIGATING: [
    { status: "ACTIVE", label: "Confirm active" },
    { status: "RESOLVED", label: "Mark resolved" },
  ],
  ACTIVE: [{ status: "RESOLVED", label: "Mark resolved" }],
  RESOLVED: [
    { status: "CLOSED", label: "Close" },
    { status: "ACTIVE", label: "Reopen" },
  ],
};

export default function StaffIncidentsPage() {
  const { call, token } = useApi();
  const [stations, setStations] = useState<Station[]>([]);
  const [chargers, setChargers] = useState<Charger[]>([]);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState("CHARGER_FAILURE");
  const [severity, setSeverity] = useState("MEDIUM");
  const [stationId, setStationId] = useState("");
  const [chargerIds, setChargerIds] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [notesFor, setNotesFor] = useState<{ id: string; nextStatus: string } | null>(null);
  const [notes, setNotes] = useState("");

  // Which incident's cascade panel is open, its data (cached per incident so re-opening is
  // instant), and whether a recalculate is in flight for it.
  const [cascadeFor, setCascadeFor] = useState<string | null>(null);
  const [cascadeData, setCascadeData] = useState<Record<string, Propagation | null>>({});
  const [cascadeLoading, setCascadeLoading] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const [board, list] = await Promise.all([
      call("/api/staff/board").then((r) => r.json()),
      call("/api/staff/incidents").then((r) => r.json()),
    ]);
    setStations(board.board?.stations ?? []);
    setChargers(board.board?.chargers ?? []);
    setIncidents(list.incidents ?? []);
    setLoading(false);
  }, [call, token]);

  useEffect(() => {
    if (!token) return;
    load();
  }, [token, load]);

  const stationChargers = useMemo(
    () => chargers.filter((c) => c.stationId === stationId),
    [chargers, stationId]
  );

  async function submitIncident(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    const res = await call("/api/staff/incidents", {
      method: "POST",
      body: JSON.stringify({
        type,
        severity,
        stationId,
        chargerIds: chargerIds.length ? chargerIds : undefined,
        title,
        description: description || undefined,
      }),
    });
    const data = await res.json();
    setSubmitting(false);
    if (!res.ok) {
      setError(data.error ?? "Could not report the incident");
      return;
    }
    setShowForm(false);
    setTitle("");
    setDescription("");
    setChargerIds([]);
    await load();
  }

  async function transition(incidentId: string, nextStatus: string, resolutionNotes?: string) {
    setBusyId(incidentId);
    setError("");
    const res = await call("/api/staff/incidents/transition", {
      method: "POST",
      body: JSON.stringify({ incidentId, nextStatus, resolutionNotes }),
    });
    const data = await res.json();
    setBusyId(null);
    if (!res.ok) {
      setError(data.error ?? "Could not update the incident");
      return;
    }
    setNotesFor(null);
    setNotes("");
    await load();
  }

  function handleStep(id: string, nextStatus: string) {
    if (nextStatus === "RESOLVED") {
      setNotesFor({ id, nextStatus });
      return;
    }
    transition(id, nextStatus);
  }

  async function toggleCascade(incidentId: string) {
    if (cascadeFor === incidentId) {
      setCascadeFor(null);
      return;
    }
    setCascadeFor(incidentId);
    if (cascadeData[incidentId] !== undefined) return; // already loaded once
    setCascadeLoading(incidentId);
    const res = await call(`/api/staff/delay-propagation?incidentId=${incidentId}`);
    const data = await res.json();
    setCascadeLoading(null);
    setCascadeData((prev) => ({ ...prev, [incidentId]: res.ok ? data.propagation : null }));
  }

  async function recalculateCascade(incidentId: string) {
    setCascadeLoading(incidentId);
    const res = await call("/api/staff/delay-propagation/run", {
      method: "POST",
      body: JSON.stringify({ incidentId }),
    });
    const data = await res.json();
    setCascadeLoading(null);
    if (res.ok) setCascadeData((prev) => ({ ...prev, [incidentId]: data.propagation }));
    else setError(data.error ?? "Could not recalculate the delay cascade");
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Technical incidents</h1>
          <p className="mt-1 text-ink-soft">
            Charger and station problems — creation, tracking and resolution, plus the delay
            cascade an open incident causes. Rescheduling the original reservation is still a
            manual decision, not automatic.
          </p>
        </div>
        <button onClick={() => setShowForm((s) => !s)} className="btn-primary inline-flex items-center gap-1.5">
          <PlusCircle className="h-4 w-4" />
          Report incident
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      {showForm && (
        <form onSubmit={submitIncident} className="card mt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label">Type</label>
              <select className="field" value={type} onChange={(e) => setType(e.target.value)}>
                {INCIDENT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Severity</label>
              <select className="field" value={severity} onChange={(e) => setSeverity(e.target.value)}>
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Station</label>
              <select
                className="field"
                value={stationId}
                onChange={(e) => {
                  setStationId(e.target.value);
                  setChargerIds([]);
                }}
              >
                <option value="">Select…</option>
                {stations.map((s) => (
                  <option key={s._id} value={s._id}>
                    {s.name.replace("ChargeHub — ", "")}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">
                Affected chargers
                {type === "POWER_OUTAGE" && (
                  <span className="ml-1 font-normal text-ink-soft">(leave empty for the whole station)</span>
                )}
              </label>
              <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
                {stationChargers.length === 0 ? (
                  <p className="px-1 text-xs text-ink-soft">Select a station first.</p>
                ) : (
                  stationChargers.map((c) => (
                    <label key={c._id} className="flex items-center gap-2 px-1 text-sm">
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={chargerIds.includes(c._id)}
                        onChange={(e) =>
                          setChargerIds((prev) =>
                            e.target.checked ? [...prev, c._id] : prev.filter((id) => id !== c._id)
                          )
                        }
                      />
                      {c.label}
                    </label>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="mt-4">
            <label className="label">Title</label>
            <input
              className="field"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Charger A1 not delivering power"
              required
            />
          </div>
          <div className="mt-4">
            <label className="label">Description (optional)</label>
            <textarea
              className="field"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <button
            type="submit"
            disabled={submitting || !stationId || !title}
            className="btn-primary mt-4"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Report incident
          </button>
        </form>
      )}

      <div className="mt-6 space-y-3">
        {incidents.length === 0 ? (
          <p className="card py-12 text-center text-sm text-ink-soft">
            No open incidents at your stations.
          </p>
        ) : (
          incidents.map((inc) => (
            <div key={inc._id} className="card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <AlertOctagon className="h-4 w-4 text-orange-600" />
                    <p className="font-semibold text-ink">{inc.title}</p>
                    <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", SEVERITY_STYLE[inc.severity])}>
                      {inc.severity}
                    </span>
                    <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", STATUS_STYLE[inc.status])}>
                      {inc.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-ink-soft">
                    {INCIDENT_TYPES.find((t) => t.value === inc.type)?.label ?? inc.type} ·{" "}
                    {inc.stationName} · {inc.chargerLabels.join(", ") || "all chargers"}
                  </p>
                  <p className="mt-1.5 text-sm text-ink-soft">{inc.actionRequired}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => toggleCascade(inc._id)}
                    className="btn-ghost inline-flex items-center gap-1.5"
                  >
                    <GitBranch className="h-4 w-4" />
                    {cascadeFor === inc._id ? "Hide cascade" : "Delay cascade"}
                  </button>
                  {(NEXT_STEPS[inc.status] ?? []).map((step) => (
                    <button
                      key={step.status}
                      onClick={() => handleStep(inc._id, step.status)}
                      disabled={busyId === inc._id}
                      className="btn-secondary"
                    >
                      {busyId === inc._id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      {step.label}
                    </button>
                  ))}
                </div>
              </div>

              {notesFor?.id === inc._id && (
                <div className="mt-3 rounded-xl2 bg-canvas p-3.5">
                  <label className="label">Resolution notes (optional)</label>
                  <textarea
                    className="field"
                    rows={2}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="What was done to fix it"
                  />
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => transition(inc._id, "RESOLVED", notes || undefined)}
                      disabled={busyId === inc._id}
                      className="btn-primary inline-flex items-center gap-1.5"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      Confirm resolved
                    </button>
                    <button onClick={() => setNotesFor(null)} className="btn-ghost">
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Affected resources — identification only, per this phase's scope. Nothing here
                  reschedules, re-ranks or re-offers anything. */}
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-ink-soft sm:grid-cols-4">
                <span>{inc.activeReservationCount} active reservation{inc.activeReservationCount === 1 ? "" : "s"}</span>
                <span>{inc.upcomingReservationCount} upcoming reservation{inc.upcomingReservationCount === 1 ? "" : "s"}</span>
                <span>{inc.affectedRecommendationCount} affected recommendation{inc.affectedRecommendationCount === 1 ? "" : "s"}</span>
                <span>{inc.affectedWaitlistCount} affected waitlist request{inc.affectedWaitlistCount === 1 ? "" : "s"}</span>
              </div>

              {/* Delay cascade — Reservation A delayed, B/C affected behind it on the same
                  charger. Estimated times only: nothing here is applied back to the booking it
                  describes. Recovery requests already filed are shown, never re-filed. */}
              {cascadeFor === inc._id && (
                <div className="mt-3 rounded-xl2 bg-canvas p-3.5">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-ink">Cascade — original vs. estimated times</p>
                    <button
                      onClick={() => recalculateCascade(inc._id)}
                      disabled={cascadeLoading === inc._id}
                      className="btn-ghost inline-flex items-center gap-1.5 text-xs"
                    >
                      {cascadeLoading === inc._id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      Recalculate
                    </button>
                  </div>

                  {cascadeLoading === inc._id && !cascadeData[inc._id] ? (
                    <div className="flex justify-center py-6">
                      <Loader2 className="h-5 w-5 animate-spin text-primary" />
                    </div>
                  ) : !cascadeData[inc._id] || cascadeData[inc._id]!.chain.length === 0 ? (
                    <p className="mt-2 text-xs text-ink-soft">
                      No cascade computed yet — either nothing is delayed enough to matter, or the
                      periodic sweep has not run against this incident yet. Recalculate to check now.
                    </p>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {cascadeData[inc._id]!.chain.map((entry) => {
                        const user = typeof entry.userId === "string" ? null : entry.userId;
                        const booking = typeof entry.bookingId === "string" ? null : entry.bookingId;
                        return (
                          <div
                            key={typeof entry.bookingId === "string" ? entry.bookingId : entry.bookingId._id}
                            className="rounded-lg bg-white p-2.5 text-xs"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-medium text-ink">
                                {entry.position === 0 ? "Root" : `+${entry.position}`} ·{" "}
                                {booking?.bookingCode ?? "reservation"} · {user?.name ?? "driver"}
                              </span>
                              <span className={cn("rounded-full px-2 py-0.5 font-semibold", DELAY_SEVERITY_STYLE[entry.severity])}>
                                {entry.severity} · {entry.delayMinutes} min
                              </span>
                            </div>
                            <p className="mt-1 text-ink-soft">
                              Original {formatDate(entry.originalScheduledStart)}{" "}
                              {formatTime(entry.originalScheduledStart)}–{formatTime(entry.originalScheduledEnd)}
                              {" → "}estimated {formatTime(entry.estimatedNewStart)}–{formatTime(entry.estimatedNewEnd)}
                            </p>
                            <p className="mt-0.5 text-ink-soft">
                              {entry.recoveryRequestId
                                ? "Recovery request filed — competing for a new slot with priority."
                                : "No recovery request needed yet."}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
