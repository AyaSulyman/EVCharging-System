import { Schema, models, model } from "mongoose";

const UserSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, index: true, lowercase: true },
    phone: { type: String, default: "" },
    // Excluded from every query by default. The login path is the only consumer
    // and opts back in explicitly with .select("+passwordHash").
    passwordHash: { type: String, required: true, select: false },
    // `staff` (Phase 2) is a dedicated on-site operator role, scoped to specific stations
    // via staffStationIds below. It sits between `user` (driver) and `admin` (operator/owner):
    // it can run the day-to-day of its station(s) but has none of the platform-wide powers.
    role: { type: String, enum: ["admin", "staff", "user"], default: "user" },
    // The station(s) a staff account may operate. Empty for admins and drivers. Every staff
    // action is checked against this list, so a staff member cannot touch another station.
    // Admin is treated as all-stations and does not use this field.
    staffStationIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "Station" }],
      default: [],
    },
    avatar: { type: String },
    /**
     * Marks a generated demo account. Same reason as on Booking: `ops:demo-data --clear` can then
     * remove exactly what it created rather than guessing from a name or an email pattern.
     */
    isDemo: { type: Boolean, default: false },

    /* ----------------------------------------------------------------------------
     * Customer reliability — ADDITIVE, and entirely DERIVED.
     *
     * These are a cached projection of the driver's `reservationevents` history, not a
     * source of truth. Nothing may increment them directly: `reliability.service`
     * recomputes them by folding the event log, so a replayed or duplicated event cannot
     * double-count and a lost one self-corrects on the next recompute. If these ever
     * disagree with the log, the log is right — run `npm run ops:reliability`.
     *
     * Only events attributed to the customer count. A cancellation caused by a charger
     * failure or an operator reschedule is waived, per approved policy.
     * -------------------------------------------------------------------------- */
    reliabilityScore: { type: Number, default: 100 },
    totalReservations: { type: Number, default: 0 },
    totalCancellations: { type: Number, default: 0 },
    totalNoShows: { type: Number, default: 0 },
    totalLateArrivals: { type: Number, default: 0 },
    // Sessions ended past their (extension-aware) scheduled end — the Overstay Engine's
    // reliability input. Same derived-not-accumulated discipline as every counter here.
    totalOverstays: { type: Number, default: 0 },
    // Completed sessions — the positive side of the ledger, kept so a dashboard can explain a
    // score without re-reading the event log.
    totalCompleted: { type: Number, default: 0 },
    // Events the fold counted but did not penalise (operator-fault or explicitly non-penalising) —
    // computed by scoreFromEvents on every recompute, stored here so a caller doesn't have to
    // re-fold the log to see it.
    waivedEvents: { type: Number, default: 0 },
    // When the projection was last rebuilt. Drives the staleness check that lets a dashboard
    // refresh a score on read instead of serving a stale one.
    reliabilityComputedAt: { type: Date, default: null },
    // Incrementing this invalidates every token issued before the change. Internal
    // machinery, so excluded from reads by default like the credential hash — the
    // authorisation check opts in with .select("+sessionGeneration").
    sessionGeneration: { type: Number, default: 0, select: false },
  },
  { timestamps: true }
);

/**
 * Supports the operator's "who are my least reliable drivers?" read, which is the one query that
 * would otherwise scan every account. Descending because the interesting end of the list is the
 * low scores, and those are what an operator sorts toward.
 */
UserSchema.index({ role: 1, reliabilityScore: 1 });

export default models.User || model("User", UserSchema);
