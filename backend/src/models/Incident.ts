import { Schema, models, model } from "mongoose";
import { INCIDENT_TYPES, INCIDENT_SEVERITIES, INCIDENT_LIFECYCLE } from "./incidentPolicy";

/**
 * A technical incident affecting one station's chargers — its own domain, its own lifecycle.
 * See `incidentPolicy.ts` for why this is deliberately not a reservation state.
 */
const IncidentSchema = new Schema(
  {
    type: { type: String, enum: INCIDENT_TYPES, required: true },
    severity: { type: String, enum: INCIDENT_SEVERITIES, required: true },
    status: { type: String, enum: INCIDENT_LIFECYCLE, default: "CREATED", index: true },

    stationId: { type: Schema.Types.ObjectId, ref: "Station", required: true, index: true },
    // Snapshotted at creation — which specific chargers this incident names. See
    // incidentPolicy.ts → requiresExplicitChargers for when this may be inferred as "all of them."
    chargerIds: { type: [Schema.Types.ObjectId], ref: "Charger", default: [] },

    title: { type: String, required: true },
    description: { type: String, default: null },

    createdByStaffId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    // Stamped once per transition, the same shape as `overstayWarningAt`/`overstayEscalatedAt` —
    // a recorded fact, not a second lifecycle. Null until that transition actually happens.
    investigatingAt: { type: Date, default: null },
    activeAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },

    resolutionNotes: { type: String, default: null },
  },
  { timestamps: true }
);

/** Supports the staff dashboard's core question: "what's open at my stations right now?" */
IncidentSchema.index({ stationId: 1, status: 1 });

export default models.Incident || model("Incident", IncidentSchema);
