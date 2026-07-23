# Compact figures for the 5-page proposal, drawn 1:1 at final printed size.
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, FancyArrowPatch
from figures import entity, ep, link, NAVY, STEEL, LIGHT, GREY, ACCENT, TEXT


def fig_erd_compact(path):
    fig, ax = plt.subplots(figsize=(6.5, 4.42))
    ax.set_xlim(-0.42, 6.52); ax.set_ylim(0, 4.42); ax.axis("off")
    W, hdr, rh, pad, fs, hfs = 2.00, 0.185, 0.126, 0.05, 6.5, 7.0
    E = lambda x, y, t, r: entity(ax, x, y, W, t, r, hdr=hdr, rh=rh, pad=pad, fs=fs, hfs=hfs)

    user = E(0.05, 4.24, "USER", ["PK  _id", "UQ  email", "passwordHash", "role {driver, operator}"])
    veh  = E(0.05, 3.26, "VEHICLE", ["PK  _id", "FK  userId", "make · model · year",
                                     "connectorType", "batteryCapacity · level"])
    conn = E(0.05, 2.14, "VEHICLE_CONNECTION", ["PK  _id", "FK  userId", "UQ  (userId, vehicleId)",
                                                "provider {tesla, mock, …}", "tokens · lastSyncedAt"])

    notif = E(2.25, 4.24, "NOTIFICATION", ["PK  _id", "FK  userId", "type · title · message", "isRead"])
    resv  = E(2.25, 3.26, "RESERVATION", ["PK  _id", "FK  userId", "FK  vehicleId", "UQ  slotId",
                                          "FK  chargerId  (denorm.)", "FK  stationId  (denorm.)",
                                          "UQ  reservationCode", "startTime · endTime", "status",
                                          "appliedPrice · amount"])
    site  = E(2.25, 1.52, "SITE_CONTENT", ["PK  _id", "title · imageUrl", "order · isActive"])

    stn  = E(4.45, 4.24, "STATION", ["PK  _id", "name · address", "location : GeoJSON",
                                     "IX  2dsphere", "hours · amenities"])
    chg  = E(4.45, 3.14, "CHARGER", ["PK  _id", "FK  stationId", "connectorType · powerKW",
                                     "pricePerKWh", "status", "UQ  qrCode"])
    slot = E(4.45, 1.92, "SLOT  (interval)", ["PK  _id", "FK  chargerId", "startTime · endTime",
                                              "duration", "status", "UQ  (chargerId, startTime)"])

    L = lambda *a, **k: link(ax, *a, fs=5.9, off=0.058, **k)
    L(ep(user, "R", .50), ep(notif, "L", .50), "1", "N")
    L(ep(user, "B", .35), ep(veh, "T", .35), "1", "N")
    L(ep(veh, "B", .35), ep(conn, "T", .35), "1", "1")
    L(ep(user, "L", .70), ep(conn, "L", .30), "1", "N", rad=0.36)
    L(ep(user, "B", .88), ep(resv, "T", .20), "1", "N")
    L(ep(veh, "R", .30), ep(resv, "L", .12), "1", "N")
    L(ep(stn, "B", .50), ep(chg, "T", .50), "1", "N")
    L(ep(chg, "B", .50), ep(slot, "T", .50), "1", "N")
    L(ep(resv, "R", .82), ep(slot, "L", .28), "1", "1", lw=1.7, color=ACCENT)
    L(ep(resv, "R", .36), ep(chg, "L", .62), "N", "1", dashed=True, color=GREY)
    L(ep(resv, "R", .10), ep(stn, "L", .86), "N", "1", dashed=True, color=GREY)

    ax.add_patch(Rectangle((0.05, 0.42), 6.40, 0.30, facecolor=LIGHT, edgecolor=STEEL,
                           linewidth=0.8, zorder=3))
    leg = [("PK · FK · UQ · IX", "key · reference · index", STEEL, 0.16),
           ("solid", "enforced relationship", NAVY, 1.85),
           ("dashed", "denormalised reference", GREY, 3.45),
           ("amber 1:1", "reservation invariant", ACCENT, 5.05)]
    for a, b, c, x in leg:
        ax.text(x, 0.63, a, fontsize=5.9, color=c, fontweight="bold", va="center", zorder=5)
        ax.text(x, 0.50, b, fontsize=5.6, color=TEXT, va="center", zorder=5)
    plt.savefig(path, dpi=300, bbox_inches="tight", pad_inches=0.02, facecolor="white")
    plt.close()


def fig_arch_compact(path):
    fig, ax = plt.subplots(figsize=(6.4, 1.72))
    ax.set_xlim(0, 6.4); ax.set_ylim(0, 1.72); ax.axis("off")
    tiers = [(0.05, "Client application", "Next.js · server-rendered",
              ["Discovery · QR landing · wizard", "Vehicle garage · guidance", "Operator console"],
              "no direct database access"),
             (2.22, "API service", "Next.js · headless REST",
              ["Authorisation · validation", "Domain services · claim logic", "Vehicle provider layer"],
              "stateless · token authenticated"),
             (4.39, "MongoDB Atlas", "document database",
              ["Accounts · stations · chargers", "Reservable intervals", "Reservations · vehicles"],
              "uniqueness constraints · geo index")]
    for x, title, sub, items, foot in tiers:
        w, h, y0 = 1.96, 1.52, 0.10
        ax.add_patch(Rectangle((x, y0), w, h, facecolor=LIGHT, edgecolor=NAVY, linewidth=1.0, zorder=3))
        ax.add_patch(Rectangle((x, y0 + h - 0.38), w, 0.38, facecolor=NAVY, edgecolor=NAVY,
                               linewidth=1.0, zorder=4))
        ax.text(x + w / 2, y0 + h - 0.145, title, ha="center", va="center", color="white",
                fontsize=7.4, fontweight="bold", zorder=5)
        ax.text(x + w / 2, y0 + h - 0.295, sub, ha="center", va="center", color="#C4D6E4",
                fontsize=5.8, zorder=5)
        yy = y0 + h - 0.56
        for it in items:
            ax.text(x + 0.08, yy, "·  " + it, ha="left", va="center", fontsize=6.0, color=TEXT, zorder=5)
            yy -= 0.215
        ax.text(x + w / 2, y0 + 0.11, foot, ha="center", va="center", fontsize=5.7,
                color=GREY, style="italic", zorder=5)
    for x0, x1 in [(2.01, 2.22), (4.18, 4.39)]:
        ax.add_patch(FancyArrowPatch((x0, 0.98), (x1, 0.98), arrowstyle="-|>", mutation_scale=7,
                                     linewidth=1.0, color=STEEL, zorder=6))
        ax.add_patch(FancyArrowPatch((x1, 0.76), (x0, 0.76), arrowstyle="-|>", mutation_scale=7,
                                     linewidth=1.0, color=STEEL, zorder=6))
    plt.savefig(path, dpi=300, bbox_inches="tight", pad_inches=0.02, facecolor="white")
    plt.close()


if __name__ == "__main__":
    fig_erd_compact("fig_erd_compact.png")
    fig_arch_compact("fig_arch_compact.png")
    from PIL import Image
    for f in ("fig_erd_compact.png", "fig_arch_compact.png"):
        im = Image.open(f)
        print(f, round(im.size[0] / 300, 2), "x", round(im.size[1] / 300, 2), "in")
