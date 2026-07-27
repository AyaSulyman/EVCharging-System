"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Loader2, ArrowLeft, Target, Clock, XCircle, Ban, Timer, Info } from "lucide-react";
import { useApi } from "@/lib/useApi";
import { formatDate, formatTime } from "@/lib/utils";

/**
 * One driver's behaviour in detail, plus the raw event timeline behind it.
 *
 * Metrics and evidence on the same screen, deliberately. An operator who doubts a figure — "82%
 * accuracy, really?" — needs the individual incidents without another navigation step, and a summary
 * that cannot be checked is a summary nobody trusts.
 */

interface Bucket {
  key: string;
  label: string;
}

interface Profile {
  userId: string;
  name: string;
  email: string;
  summary: string;
  totalReservations: number;
  totalCompleted: number;
  earlyDepartures: number;
  overstays: number;
  overstayDetail: {
    escalated: number;
    alerted: number;
    avgDurationMinutes: number;
    maxDurationMinutes: number;
  };
  computedAt: string | null;
  eventsProcessed: number;
  firstSeen: string | null;
  lastActivity: string | null;
  delays: {
    lateArrivals: number;
    onTimeArrivals: number;
    totalArrivals: number;
    avgDelayMinutes: number;
    medianDelayMinutes: number;
    maxDelayMinutes: number;
    distribution: Record<string, number>;
  };
  cancellations: {
    total: number;
    waived: number;
    byLeadTime: Record<string, number>;
    avgNoticeHours: number;
  };
  noShows: { total: number; waived: number; ratePercent: number };
  extensions: {
    requested: number;
    approved: number;
    denied: number;
    avgExtensionMinutes: number;
    notImplemented: boolean;
  };
  arrivalAccuracy: {
    accuracyPercent: number;
    avgAbsoluteDeviationMinutes: number;
    withinGrace: number;
    outsideGrace: number;
    early: number;
  };
  trend: { direction: string; recentIncidents: number; previousIncidents: number };
}

interface TimelineEntry {
  _id: string;
  type: string;
  occurredAt: string;
  fault: string;
  penalize: boolean;
  basis: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
}

/** Event types coloured by what they mean for the driver, not by severity to the system. */
const EVENT_STYLE: Record<string, string> = {
  "reservation.no_show": "bg-red-50 text-red-700",
  "reservation.cancelled": "bg-amber-50 text-amber-700",
  "session.ended": "bg-emerald-50 text-emerald-700",
  "session.started": "bg-blue-50 text-blue-700",
  "commitment.failed": "bg-amber-50 text-amber-700",
  "commitment.forfeited": "bg-red-50 text-red-700",
  "commitment.refunded": "bg-canvas text-ink-soft",
};

export default function BehaviorDetailPage() {
  const params = useParams();
  const userId = params?.userId as string;
  const { call, token } = useApi();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [definitions, setDefinitions] = useState<{
    delayBuckets: Bucket[];
    cancellationBuckets: Bucket[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token || !userId) return;
    const res = await call(`/api/admin/behavior/${userId}`);
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error ?? "Failed to load the profile");
      return;
    }
    setProfile(data.profile);
    setTimeline(data.timeline ?? []);
    setDefinitions(data.definitions ?? null);
  }, [call, token, userId]);

  useEffect(() => {
    if (!token) return;
    load();
  }, [token, load]);

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div>
        <BackLink />
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {error || "Profile not found"}
        </div>
      </div>
    );
  }

  const maxDelayBucket = Math.max(1, ...Object.values(profile.delays.distribution ?? {}));

  return (
    <div>
      <BackLink />

      <div className="mt-3">
        <h1 className="text-2xl font-bold text-ink">{profile.name}</h1>
        <p className="mt-0.5 text-ink-soft">{profile.email}</p>
        <p className="mt-2 text-sm font-medium text-ink">{profile.summary}</p>
      </div>

      {/* Headline metrics */}
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="Arrival accuracy"
          value={`${profile.arrivalAccuracy.accuracyPercent}%`}
          hint={`${profile.arrivalAccuracy.withinGrace} of ${profile.delays.totalArrivals} within grace`}
          icon={Target}
        />
        <Metric
          label="Median delay"
          value={`${profile.delays.medianDelayMinutes}m`}
          hint={`avg ${profile.delays.avgDelayMinutes}m · worst ${profile.delays.maxDelayMinutes}m`}
          icon={Clock}
        />
        <Metric
          label="No-show rate"
          value={`${profile.noShows.ratePercent}%`}
          hint={`${profile.noShows.total} of ${profile.noShows.total + profile.totalCompleted} attended`}
          icon={Ban}
        />
        <Metric
          label="Cancellations"
          value={profile.cancellations.total}
          hint={
            profile.cancellations.total
              ? `avg ${profile.cancellations.avgNoticeHours}h notice`
              : "none"
          }
          icon={XCircle}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* Delay distribution */}
        <div className="card">
          <h2 className="text-sm font-semibold text-ink">When they arrive</h2>
          <p className="mt-0.5 text-xs text-ink-soft">
            Deviation from the promised start across {profile.delays.totalArrivals} arrivals.
          </p>
          <div className="mt-4 space-y-2">
            {(definitions?.delayBuckets ?? []).map((b) => {
              const count = profile.delays.distribution?.[b.key] ?? 0;
              return (
                <div key={b.key} className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-ink-soft">{b.label}</span>
                  <div className="h-5 flex-1 overflow-hidden rounded bg-canvas">
                    <div
                      className={`h-full rounded ${
                        b.key === "onTime"
                          ? "bg-emerald-400"
                          : b.key === "over30"
                            ? "bg-red-400"
                            : "bg-amber-400"
                      }`}
                      style={{ width: `${(count / maxDelayBucket) * 100}%` }}
                    />
                  </div>
                  <span className="w-8 shrink-0 text-right text-xs font-medium text-ink">
                    {count}
                  </span>
                </div>
              );
            })}
          </div>
          {profile.arrivalAccuracy.early > 0 && (
            <p className="mt-3 text-xs text-ink-soft">
              Arrived early {profile.arrivalAccuracy.early}×. Average deviation either way:{" "}
              {profile.arrivalAccuracy.avgAbsoluteDeviationMinutes} min.
            </p>
          )}
        </div>

        {/* Cancellation lead time */}
        <div className="card">
          <h2 className="text-sm font-semibold text-ink">How much notice they give</h2>
          <p className="mt-0.5 text-xs text-ink-soft">
            Cancellations by how far ahead of the slot they happened.
          </p>
          {profile.cancellations.total === 0 ? (
            <p className="mt-4 text-sm text-ink-soft">No cancellations on record.</p>
          ) : (
            <div className="mt-4 space-y-2">
              {(definitions?.cancellationBuckets ?? []).map((b) => {
                const count = profile.cancellations.byLeadTime?.[b.key] ?? 0;
                const max = Math.max(1, ...Object.values(profile.cancellations.byLeadTime ?? {}));
                return (
                  <div key={b.key} className="flex items-center gap-3">
                    <span className="w-28 shrink-0 text-xs text-ink-soft">{b.label}</span>
                    <div className="h-5 flex-1 overflow-hidden rounded bg-canvas">
                      <div
                        className={`h-full rounded ${
                          b.key === "over24h" ? "bg-emerald-400" : "bg-red-400"
                        }`}
                        style={{ width: `${(count / max) * 100}%` }}
                      />
                    </div>
                    <span className="w-8 shrink-0 text-right text-xs font-medium text-ink">
                      {count}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {profile.cancellations.waived > 0 && (
            <p className="mt-3 text-xs text-emerald-700">
              {profile.cancellations.waived} further cancellation
              {profile.cancellations.waived > 1 ? "s were" : " was"} caused by us and excluded.
            </p>
          )}
        </div>

        {/* Session conduct */}
        <div className="card">
          <h2 className="text-sm font-semibold text-ink">Session conduct</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="Reservations made" value={profile.totalReservations} />
            <Row label="Sessions completed" value={profile.totalCompleted} />
            <Row label="Left early (freed capacity)" value={profile.earlyDepartures} good />
            <Row label="Overstayed" value={profile.overstays} bad />
            {profile.overstays > 0 && (
              <>
                <Row
                  label="Avg / longest overstay"
                  value={`${profile.overstayDetail.avgDurationMinutes} / ${profile.overstayDetail.maxDurationMinutes} min`}
                />
                {(profile.overstayDetail.escalated > 0 || profile.overstayDetail.alerted > 0) && (
                  <Row
                    label="Escalated / alerted"
                    value={`${profile.overstayDetail.escalated} / ${profile.overstayDetail.alerted}`}
                    bad
                  />
                )}
              </>
            )}
          </dl>
          <p className="mt-3 text-xs text-ink-soft">
            Trend over the last 30 days: {profile.trend.recentIncidents} incident
            {profile.trend.recentIncidents === 1 ? "" : "s"} vs{" "}
            {profile.trend.previousIncidents} in the 30 before.
          </p>
        </div>

        {/* Extensions — honest about not existing yet */}
        <div className="card">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Timer className="h-4 w-4" />
            Extensions
          </h2>
          {profile.extensions.notImplemented ? (
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-canvas px-3.5 py-2.5 text-xs text-ink-soft">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Session extensions are not built yet, so these figures are structurally zero rather
                than a finding about this driver. Tracking is in place and will populate as soon as
                the feature ships.
              </span>
            </div>
          ) : (
            <dl className="mt-3 space-y-2 text-sm">
              <Row label="Requested" value={profile.extensions.requested} />
              <Row label="Approved" value={profile.extensions.approved} />
              <Row label="Denied" value={profile.extensions.denied} />
              <Row
                label="Average length"
                value={`${profile.extensions.avgExtensionMinutes}m`}
              />
            </dl>
          )}
        </div>
      </div>

      {/* The evidence */}
      <div className="card mt-4">
        <h2 className="text-sm font-semibold text-ink">Event history</h2>
        <p className="mt-0.5 text-xs text-ink-soft">
          The append-only record every figure above is derived from. Newest first.
        </p>
        {timeline.length === 0 ? (
          <p className="mt-4 text-sm text-ink-soft">No events recorded yet.</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {timeline.map((e) => (
              <li
                key={e._id}
                className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-line pb-2 text-sm last:border-0"
              >
                <span className={`chip ${EVENT_STYLE[e.type] ?? "bg-canvas text-ink-soft"}`}>
                  {e.type}
                </span>
                <span className="text-xs text-ink-soft">
                  {formatDate(e.occurredAt)} {formatTime(e.occurredAt)}
                </span>
                {e.basis && <span className="text-xs text-ink">{e.basis.replace(/_/g, " ")}</span>}
                {e.fault !== "customer" && (
                  <span className="chip bg-emerald-50 text-emerald-700">
                    {e.fault} — waived
                  </span>
                )}
                {typeof e.metadata?.delayMinutes === "number" && e.metadata.delayMinutes !== 0 && (
                  <span className="text-xs text-ink-soft">
                    {e.metadata.delayMinutes as number} min late
                  </span>
                )}
                {typeof e.metadata?.hoursUntilStart === "number" && (
                  <span className="text-xs text-ink-soft">
                    {e.metadata.hoursUntilStart as number}h notice
                  </span>
                )}
                {e.reason && <span className="text-xs italic text-ink-soft">{e.reason}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-3 text-xs text-ink-soft">
        {profile.eventsProcessed} events folded
        {profile.computedAt && ` · rebuilt ${formatDate(profile.computedAt)}`}
        {profile.firstSeen && ` · first seen ${formatDate(profile.firstSeen)}`}
      </p>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/admin/behavior"
      className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft hover:text-ink"
    >
      <ArrowLeft className="h-4 w-4" />
      All drivers
    </Link>
  );
}

function Metric({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="card py-4">
      <div className="flex items-center gap-2 text-ink-soft">
        <Icon className="h-4 w-4" />
        <span className="text-xs">{label}</span>
      </div>
      <p className="mt-1.5 text-2xl font-bold text-ink">{value}</p>
      <p className="mt-0.5 text-xs text-ink-soft">{hint}</p>
    </div>
  );
}

function Row({
  label,
  value,
  good,
  bad,
}: {
  label: string;
  value: string | number;
  good?: boolean;
  bad?: boolean;
}) {
  const numeric = typeof value === "number" ? value : 1;
  return (
    <div className="flex items-center justify-between">
      <dt className="text-ink-soft">{label}</dt>
      <dd
        className={`font-semibold ${
          numeric === 0
            ? "text-ink-soft/50"
            : good
              ? "text-emerald-700"
              : bad
                ? "text-red-600"
                : "text-ink"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
