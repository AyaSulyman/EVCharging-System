import { Schema, models, model } from "mongoose";

/**
 * A driver's behaviour profile — a cached projection of their reservation event history.
 *
 * WHY ITS OWN COLLECTION rather than more fields on `users`. The reliability score and its four
 * counters live on the user because they are read on *every* list and board row and must be
 * indexable for sorting. These metrics are the opposite: a dozen nested figures read only when
 * someone opens a specific driver. Putting them on `users` would grow the document every list query
 * already pulls, to serve a screen almost nobody opens.
 *
 * NOT A SOURCE OF TRUTH. Every field here is recomputed by folding `reservationevents`. If this
 * collection disagrees with the log, the log is right — run `npm run ops:behavior`. Nothing may
 * increment these values as events happen; see customerBehaviorPolicy.ts for why derivation rather
 * than accumulation is the correct choice.
 *
 * SAFE TO DROP. Because it is entirely derived, this collection can be deleted and rebuilt at any
 * time with no loss. That is the test of a projection done properly, and it is why the metric
 * definitions can be changed freely — a redefinition is a recompute, not a migration.
 */

const DelaySchema = new Schema(
  {
    lateArrivals: { type: Number, default: 0 },
    onTimeArrivals: { type: Number, default: 0 },
    totalArrivals: { type: Number, default: 0 },
    // Averaged across late arrivals only. Including the on-time zeros would dilute the figure
    // toward nothing and hide exactly the behaviour this is meant to expose.
    avgDelayMinutes: { type: Number, default: 0 },
    medianDelayMinutes: { type: Number, default: 0 },
    maxDelayMinutes: { type: Number, default: 0 },
    distribution: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const CancellationSchema = new Schema(
  {
    total: { type: Number, default: 0 },
    // Attributed to the operator. Recorded so the profile can show it was excluded, rather than
    // silently omitting cancellations that did happen but were not the driver's doing.
    waived: { type: Number, default: 0 },
    byLeadTime: { type: Schema.Types.Mixed, default: {} },
    avgNoticeHours: { type: Number, default: 0 },
  },
  { _id: false }
);

const NoShowSchema = new Schema(
  {
    total: { type: Number, default: 0 },
    waived: { type: Number, default: 0 },
    // Denominator is reservations that reached their start time, not all reservations — a
    // cancellation is not a failure to show up.
    ratePercent: { type: Number, default: 0 },
  },
  { _id: false }
);

const ExtensionSchema = new Schema(
  {
    requested: { type: Number, default: 0 },
    approved: { type: Number, default: 0 },
    denied: { type: Number, default: 0 },
    avgExtensionMinutes: { type: Number, default: 0 },
    // The extension feature does not exist yet, so these are structurally zero. Stored explicitly
    // so a dashboard can say "not implemented" instead of showing an empty chart as if it were a
    // finding about the driver.
    notImplemented: { type: Boolean, default: true },
  },
  { _id: false }
);

const ArrivalAccuracySchema = new Schema(
  {
    // Share of arrivals within the grace period. The headline behavioural number.
    accuracyPercent: { type: Number, default: 0 },
    // Absolute, so consistently-early arrivals count as inaccurate too.
    avgAbsoluteDeviationMinutes: { type: Number, default: 0 },
    withinGrace: { type: Number, default: 0 },
    outsideGrace: { type: Number, default: 0 },
    early: { type: Number, default: 0 },
  },
  { _id: false }
);

const TrendSchema = new Schema(
  {
    direction: {
      type: String,
      enum: ["improving", "declining", "steady", "insufficient_data"],
      default: "insufficient_data",
    },
    recentIncidents: { type: Number, default: 0 },
    previousIncidents: { type: Number, default: 0 },
  },
  { _id: false }
);

const CustomerBehaviorProfileSchema = new Schema(
  {
    // One profile per driver. Unique rather than merely indexed: two profiles for one driver would
    // mean two different answers to the same question, and whichever was read first would win.
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    delays: { type: DelaySchema, default: () => ({}) },
    cancellations: { type: CancellationSchema, default: () => ({}) },
    noShows: { type: NoShowSchema, default: () => ({}) },
    extensions: { type: ExtensionSchema, default: () => ({}) },
    arrivalAccuracy: { type: ArrivalAccuracySchema, default: () => ({}) },
    trend: { type: TrendSchema, default: () => ({}) },

    totalReservations: { type: Number, default: 0 },
    totalCompleted: { type: Number, default: 0 },
    earlyDepartures: { type: Number, default: 0 },
    overstays: { type: Number, default: 0 },

    /** One-line operational read, generated with the metrics so list views need no extra work. */
    summary: { type: String, default: "" },

    firstSeen: { type: Date, default: null },
    lastActivity: { type: Date, default: null },
    /** When this projection was last rebuilt, for the staleness check on read. */
    computedAt: { type: Date, default: null },
    /** How many events the fold read. A cheap sanity check when a figure looks wrong. */
    eventsProcessed: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/**
 * Supports the operator's two sorted views: worst arrival accuracy, and highest no-show rate.
 * Declared now because these are the only reads that would otherwise scan the whole collection.
 */
CustomerBehaviorProfileSchema.index({ "arrivalAccuracy.accuracyPercent": 1 });
CustomerBehaviorProfileSchema.index({ "noShows.ratePercent": -1 });

export default models.CustomerBehaviorProfile ||
  model("CustomerBehaviorProfile", CustomerBehaviorProfileSchema);
