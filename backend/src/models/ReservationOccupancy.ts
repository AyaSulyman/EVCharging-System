import { Schema, models, model } from "mongoose";

/**
 * Charger occupancy, one document per 15-minute atom held by a reservation.
 *
 * THIS COLLECTION IS THE ARBITER OF CONFLICTS for duration-aware reservations, exactly as the partial
 * unique index on `bookings.slotId` was for fixed-slot ones. A reservation covering 15:00–16:30
 * inserts six rows; a second reservation touching any of those atoms fails on a duplicate key. The
 * decision is the database's, not the application's — which is the whole point, because application
 * checks can be bypassed by a code path nobody has written yet.
 *
 * WHY A SEPARATE COLLECTION rather than an array on the booking. A unique index cannot span the
 * elements of one document's array against another document's array in the way this needs: two
 * bookings each holding `[15:00, 15:15]` would be two distinct documents with no field on which they
 * collide. One row per atom makes the collision a plain duplicate key on a compound index, which
 * MongoDB enforces natively and cheaply.
 *
 * WHY THE INDEX IS PLAIN UNIQUE, NOT PARTIAL. The slot mechanism needed a partial filter because a
 * cancelled reservation kept its `slotId` for history while the interval was released — status and
 * occupancy lived on the same field, so the index had to distinguish them. Here they are separate
 * concerns: an occupancy row *is* the lease. Releasing capacity means deleting the rows, and history
 * stays on the booking where it belongs. That removes the subtlety entirely — there is no status to
 * filter on and no way for a released atom to stay indexed.
 *
 * ROWS ARE DERIVED AND DISPOSABLE. Every row is reconstructable from its booking's range. If this
 * collection is ever lost, `ops:migrate-occupancy` rebuilds it. What must never happen is the
 * reverse — an atom held here with no live booking behind it — which is why release is keyed on
 * bookingId and reconciliation checks both directions.
 */

const ReservationOccupancySchema = new Schema(
  {
    // The reservation holding this atom. Indexed because release is always "free everything this
    // booking holds", which must be one query rather than one per atom.
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    chargerId: { type: Schema.Types.ObjectId, ref: "Charger", required: true },
    // Denormalised so station-level availability and utilization do not need a charger join on a
    // read path that runs on every booking screen.
    stationId: { type: Schema.Types.ObjectId, ref: "Station", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    /** Start of the atom. Always aligned to the 15-minute grid — see occupancyPolicy. */
    atomStart: { type: Date, required: true },
    /** End of the atom, stored rather than derived so range queries need no arithmetic. */
    atomEnd: { type: Date, required: true },
  },
  {
    timestamps: true,
    /**
     * Collection name pinned explicitly.
     *
     * Mongoose would pluralise "ReservationOccupancy" to `reservationoccupancies`, while the
     * migration and the verification harness address `reservationoccupancy`. Those are two different
     * collections, so the backfill would have written somewhere the application never reads — the
     * conflict index would exist on an empty collection and every range reservation would look free.
     * Caught by running the harness; pinned so it can never drift again.
     *
     * "Occupancy" is a mass noun, so the singular is also the better name. This project already has
     * non-obvious collection names (`bookings`, `banners`) — see CLAUDE.md §4.
     */
    collection: "reservationoccupancy",
  }
);

/**
 * THE CENTRAL CONSTRAINT. One atom on one charger is held by at most one reservation, ever.
 *
 * Enforced here rather than in application code so it holds for every write path, including ones not
 * yet written. This is the duration-aware equivalent of the partial unique index on `bookings.slotId`
 * and carries the same weight: **never make this index non-unique, and never move the check into
 * application logic.** A range model without it is a race waiting to be reported as a double booking.
 */
ReservationOccupancySchema.index({ chargerId: 1, atomStart: 1 }, { unique: true });

/**
 * The availability read: "what is occupied on these chargers between these times". Runs on every
 * booking screen, so it gets its own index rather than relying on the unique one above — that index
 * leads on chargerId and would serve a single-charger query, but availability is asked across all the
 * chargers at a station at once.
 */
ReservationOccupancySchema.index({ stationId: 1, atomStart: 1 });

export default models.ReservationOccupancy ||
  model("ReservationOccupancy", ReservationOccupancySchema);
