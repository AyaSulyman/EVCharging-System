# Figures are drawn 1:1 at their final printed size (inches) so that the point
# sizes below are the point sizes that appear on the page.
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, FancyArrowPatch

NAVY, STEEL, LIGHT, GREY, ACCENT, TEXT = "#1F3B57", "#33607F", "#F1F5F9", "#78889A", "#B4762A", "#12222F"


def entity(ax, x, ytop, w, title, rows, hdr=0.235, rh=0.152, pad=0.075,
           fs=7.2, hfs=8.0, future=False, note=None):
    h = hdr + len(rows) * rh + pad
    edge = GREY if future else NAVY
    ls = (0, (3.5, 2.5)) if future else "solid"
    ax.add_patch(Rectangle((x, ytop - h), w, h, facecolor=("#FBFCFD" if future else "white"),
                           edgecolor=edge, linewidth=1.1, linestyle=ls, zorder=3))
    ax.add_patch(Rectangle((x, ytop - hdr), w, hdr, facecolor=(GREY if future else NAVY),
                           edgecolor=edge, linewidth=1.1, linestyle=ls, zorder=4))
    ax.text(x + w / 2, ytop - hdr / 2, title, ha="center", va="center", color="white",
            fontsize=hfs, fontweight="bold", zorder=5)
    yy = ytop - hdr - rh * 0.68
    for r in rows:
        planned = r.startswith("+")
        label = r[1:].strip() if planned else r
        col = ACCENT if planned else (STEEL if label.startswith(("PK", "FK", "UQ", "IX")) else TEXT)
        wt = "bold" if label.startswith(("PK", "UQ", "IX")) or planned else "normal"
        ax.text(x + 0.09, yy, label, ha="left", va="center", fontsize=fs, color=col,
                fontweight=wt, zorder=5)
        yy -= rh
    if note:
        ax.text(x + w / 2, ytop - h - 0.09, note, ha="center", va="top", fontsize=6.2,
                color=GREY, style="italic", zorder=5)
    return (x, ytop, w, h)


def ep(box, side, frac=0.5):
    x, ytop, w, h = box
    return {"L": (x, ytop - h * frac), "R": (x + w, ytop - h * frac),
            "T": (x + w * frac, ytop), "B": (x + w * frac, ytop - h)}[side]


def link(ax, p1, p2, l="1", r="N", dashed=False, rad=0.0, lw=1.0, color=NAVY, fs=6.6, off=0.075):
    ax.add_patch(FancyArrowPatch(p1, p2, arrowstyle="-", linewidth=lw, color=color, zorder=2,
                                 linestyle=((0, (4, 2.5)) if dashed else "solid"),
                                 connectionstyle=f"arc3,rad={rad}"))
    def lab(p, q, t, sgn):
        dx, dy = q[0] - p[0], q[1] - p[1]
        L = max((dx * dx + dy * dy) ** 0.5, 1e-6)
        ox, oy = -dy / L * off, dx / L * off
        ax.text(p[0] + dx * 0.20 + ox * sgn, p[1] + dy * 0.20 + oy * sgn, t, fontsize=fs,
                color=color, fontweight="bold", ha="center", va="center", zorder=6)
    lab(p1, p2, l, 1); lab(p2, p1, r, -1)


# --------------------------------------------------------------- FIG 1  (6.5 x 3.5)
def fig_architecture(path):
    fig, ax = plt.subplots(figsize=(6.5, 3.5))
    ax.set_xlim(0, 6.5); ax.set_ylim(0, 3.5); ax.axis("off")

    ax.add_patch(Rectangle((0.10, 3.06), 6.30, 0.30, facecolor="white", edgecolor=STEEL,
                           linewidth=1.0, zorder=3))
    ax.text(3.25, 3.21, "Driver   ·   Operator          desktop  ·  mobile browser  ·  QR camera scan",
            ha="center", va="center", fontsize=7.2, color=NAVY, fontweight="bold", zorder=5)
    ax.add_patch(FancyArrowPatch((1.10, 3.06), (1.10, 2.82), arrowstyle="-|>", mutation_scale=8,
                                 linewidth=1.0, color=STEEL, zorder=6))

    tiers = [
        (0.10, "Presentation tier", "Client application", "Next.js  ·  App Router",
         ["Public discovery", "QR landing and wizard", "Vehicle garage · guidance",
          "Operator console"], "no direct database access"),
        (2.24, "Application tier", "API service", "Next.js  ·  headless REST",
         ["Routing · authorisation", "Validation · domain rules", "Vehicle provider layer",
          "Data models"], "stateless · token authenticated"),
        (4.38, "Data tier", "MongoDB Atlas", "document database",
         ["Accounts and ownership", "Stations · chargers", "Reservable intervals",
          "Reservations · vehicles"], "constraints · geospatial index"),
    ]
    for x, tier, title, sub, items, foot in tiers:
        w, h, y0 = 2.02, 1.98, 0.62
        ax.add_patch(Rectangle((x, y0), w, h, facecolor=LIGHT, edgecolor=NAVY, linewidth=1.1, zorder=3))
        ax.add_patch(Rectangle((x, y0 + h - 0.42), w, 0.42, facecolor=NAVY, edgecolor=NAVY,
                               linewidth=1.1, zorder=4))
        ax.text(x + w / 2, y0 + h - 0.16, title, ha="center", va="center", color="white",
                fontsize=7.8, fontweight="bold", zorder=5)
        ax.text(x + w / 2, y0 + h - 0.32, sub, ha="center", va="center", color="#C4D6E4",
                fontsize=6.0, zorder=5)
        ax.text(x + w / 2, y0 + h + 0.11, tier, ha="center", va="center", color=STEEL,
                fontsize=7.0, fontweight="bold", zorder=5)
        yy = y0 + h - 0.62
        for it in items:
            ax.text(x + 0.10, yy, "·  " + it, ha="left", va="center", fontsize=6.2,
                    color=TEXT, zorder=5)
            yy -= 0.25
        ax.text(x + w / 2, y0 + 0.13, foot, ha="center", va="center", fontsize=5.9,
                color=GREY, style="italic", zorder=5)

    for x0, x1 in [(2.12, 2.24), (4.26, 4.38)]:
        ax.add_patch(FancyArrowPatch((x0, 1.72), (x1, 1.72), arrowstyle="-|>", mutation_scale=8,
                                     linewidth=1.1, color=STEEL, zorder=6))
        ax.add_patch(FancyArrowPatch((x1, 1.50), (x0, 1.50), arrowstyle="-|>", mutation_scale=8,
                                     linewidth=1.1, color=STEEL, zorder=6))

    ax.text(3.25, 0.36, "Client to service:  HTTPS, JSON, bearer token          "
                        "Service to database:  driver connection, scoped credential",
            ha="center", va="center", fontsize=6.2, color=STEEL, fontweight="bold")
    ax.text(3.25, 0.20, "Both application tiers are built on a single framework, removing an additional server technology",
            ha="center", va="center", fontsize=6.2, color=GREY, style="italic")
    ax.text(3.25, 0.08, "while preserving a genuine client / service boundary.",
            ha="center", va="center", fontsize=6.2, color=GREY, style="italic")
    plt.savefig(path, dpi=300, bbox_inches="tight", pad_inches=0.02, facecolor="white")
    plt.close()


# --------------------------------------------------------------- FIG 2  (9.0 x 6.35, landscape page)
def fig_erd(path):
    fig, ax = plt.subplots(figsize=(9.0, 6.35))
    ax.set_xlim(-0.62, 8.95); ax.set_ylim(0, 6.35); ax.axis("off")
    W = 2.60

    user = entity(ax, 0.15, 6.10, W, "USER", [
        "PK  _id", "UQ  email", "name  ·  phone", "passwordHash",
        "role  {driver, operator}", "+ sessionGeneration"])
    veh = entity(ax, 0.15, 4.55, W, "VEHICLE", [
        "PK  _id", "FK  userId", "make · model · year", "connectorType  {CCS, CHAdeMO, Type2}",
        "batteryCapacity", "currentBatteryLevel", "estimatedRange"])
    conn = entity(ax, 0.15, 2.85, W, "VEHICLE_CONNECTION", [
        "PK  _id", "FK  userId", "FK  vehicleId", "+ UQ  (userId, vehicleId)",
        "provider  {tesla, hyundai, bmw, mock}", "accessToken · refreshToken",
        "isConnected · lastSyncedAt"])

    notif = entity(ax, 3.15, 6.10, W, "NOTIFICATION", [
        "PK  _id", "FK  userId", "type  {six message types}", "title  ·  message",
        "isRead", "data"])
    resv = entity(ax, 3.15, 4.45, W, "RESERVATION", [
        "PK  _id", "FK  userId", "FK  vehicleId", "FK  slotId", "+ UQ  slotId",
        "FK  chargerId   (denormalised)", "FK  stationId   (denormalised)",
        "UQ  reservationCode", "startTime  ·  endTime", "status  {pending, confirmed,",
        "        cancelled, completed, no_show}", "totalAmount",
        "+ appliedUnitPrice", "+ appliedPowerKW", "paymentStatus   (nominal)"])
    banner = entity(ax, 3.15, 1.78, W, "SITE_CONTENT", [
        "PK  _id", "title  ·  subtitle", "imageUrl", "ctaLabel  ·  ctaHref",
        "order", "isActive"])

    stn = entity(ax, 6.15, 6.10, W, "STATION", [
        "PK  _id", "name  ·  address", "location : GeoJSON Point", "IX  2dsphere (location)",
        "amenities  ·  operatingHours", "images [ ]", "isActive"])
    chg = entity(ax, 6.15, 4.40, W, "CHARGER", [
        "PK  _id", "FK  stationId", "label  ·  connectorType", "powerKW  ·  pricePerKWh",
        "status  {available, in_use,", "        maintenance, offline}", "UQ  qrCode"])
    slot = entity(ax, 6.15, 2.70, W, "SLOT   (reservable interval)", [
        "PK  _id", "FK  chargerId", "date", "startTime  ·  endTime", "duration",
        "status  {available, booked, blocked}", "UQ  (chargerId, startTime)"])

    link(ax, ep(user, "R", 0.50), ep(notif, "L", 0.50), "1", "N")
    link(ax, ep(user, "B", 0.35), ep(veh, "T", 0.35), "1", "N")
    link(ax, ep(veh, "B", 0.35), ep(conn, "T", 0.35), "1", "1")
    link(ax, ep(user, "L", 0.72), ep(conn, "L", 0.28), "1", "N", rad=0.34)
    link(ax, ep(user, "B", 0.80), ep(resv, "T", 0.26), "1", "N")
    link(ax, ep(veh, "R", 0.32), ep(resv, "L", 0.17), "1", "N")
    link(ax, ep(stn, "B", 0.50), ep(chg, "T", 0.50), "1", "N")
    link(ax, ep(chg, "B", 0.50), ep(slot, "T", 0.50), "1", "N")
    link(ax, ep(resv, "R", 0.755), ep(slot, "L", 0.34), "1", "1", lw=1.9, color=ACCENT)
    link(ax, ep(resv, "R", 0.35), ep(chg, "L", 0.66), "N", "1", dashed=True, color=GREY)
    link(ax, ep(resv, "R", 0.11), ep(stn, "L", 0.82), "N", "1", dashed=True, color=GREY)

    ax.add_patch(Rectangle((0.15, 0.06), 8.60, 0.34, facecolor=LIGHT, edgecolor=STEEL,
                           linewidth=0.9, zorder=3))
    legend = [("PK · FK · UQ · IX", "key · reference · uniqueness · index", STEEL),
              ("amber attribute", "added in the proposed scope", ACCENT),
              ("solid connector", "enforced relationship", NAVY),
              ("dashed connector", "denormalised reference", GREY)]
    x = 0.26
    for a, b, c in legend:
        ax.text(x, 0.30, a, fontsize=6.4, color=c, fontweight="bold", va="center", zorder=5)
        ax.text(x, 0.155, b, fontsize=6.0, color=TEXT, va="center", zorder=5)
        x += 2.22
    plt.savefig(path, dpi=300, bbox_inches="tight", pad_inches=0.02, facecolor="white")
    plt.close()


# --------------------------------------------------------------- FIG 3  (6.5 x 2.95)
def fig_future(path):
    fig, ax = plt.subplots(figsize=(6.5, 2.95))
    ax.set_xlim(0, 6.5); ax.set_ylim(0, 2.95); ax.axis("off")
    hdr, rh, W = 0.185, 0.128, 1.24

    ax.text(3.25, 2.86, "Entities delivered by the proposed project", ha="center", va="center",
            fontsize=7.2, color=NAVY, fontweight="bold")
    top = {}
    for nm, at, x in [("USER", ["PK  _id", "role"], 0.35),
                      ("STATION", ["PK  _id", "name"], 1.72),
                      ("CHARGER", ["PK  _id", "status"], 3.09),
                      ("RESERVATION", ["PK  _id", "status"], 4.72)]:
        top[nm] = entity(ax, x, 2.66, W if nm != "RESERVATION" else 1.42, nm, at,
                         hdr=hdr, rh=rh, pad=0.05, fs=6.0, hfs=6.6)

    fut = [("ORGANISATION", ["PK  _id", "members", "owns stations"], "multi-branch roles", 0.10, "USER"),
           ("AUDIT_RECORD", ["PK  _id", "actor · action", "before · after"], "change history", 1.38, "CHARGER"),
           ("CHARGE_SESSION", ["PK  _id", "FK  reservation", "energyKWh"], "metered charging", 2.66, "RESERVATION"),
           ("PAYMENT", ["PK  _id", "FK  reservation", "amount"], "payment gateway", 3.94, "RESERVATION"),
           ("REDEMPTION", ["PK  _id", "FK  reservation", "redeemedAt"], "QR check-in", 5.22, "RESERVATION")]
    for nm, at, note, x, parent in fut:
        bx = entity(ax, x, 1.62, W, nm, at, hdr=hdr, rh=rh, pad=0.05, fs=5.7, hfs=6.0,
                    future=True, note=note)
        ax.add_patch(FancyArrowPatch(ep(bx, "T", 0.5), ep(top[parent], "B", 0.5), arrowstyle="-",
                                     linewidth=0.9, color=GREY, linestyle=(0, (4, 2.5)), zorder=2))

    ax.text(3.25, 0.52, "Future-ready extension points — reserved by the architecture, outside the current delivery scope",
            ha="center", va="center", fontsize=6.5, color=GREY, fontweight="bold", style="italic")
    ax.text(3.25, 0.32, "Every future entity attaches by reference to a record that already exists. None restructures the delivered",
            ha="center", va="center", fontsize=6.3, color=TEXT, style="italic")
    ax.text(3.25, 0.19, "model, and none is required for successful completion of the project.",
            ha="center", va="center", fontsize=6.3, color=TEXT, style="italic")
    plt.savefig(path, dpi=300, bbox_inches="tight", pad_inches=0.02, facecolor="white")
    plt.close()


# --------------------------------------------------------------- FIG 4  (6.5 x 3.2)
def fig_timeline(path):
    fig, ax = plt.subplots(figsize=(6.5, 3.2))
    phases = [("Phase 1 · Requirements and domain analysis", 1, 2),
              ("Phase 2 · System and database design", 2, 2),
              ("Phase 3 · Core platform: identity, network, inventory", 4, 3),
              ("Phase 4 · Reservation and QR subsystems", 6, 3),
              ("Phase 5 · Vehicle architecture, guidance, operator console", 8, 3),
              ("Phase 6 · Integrity hardening and verification", 11, 1),
              ("Phase 7 · Documentation and specification", 11, 2),
              ("Phase 8 · Evaluation, rehearsal and submission", 13, 2)]
    colors = [STEEL, STEEL, NAVY, NAVY, NAVY, ACCENT, STEEL, "#4C7A5E"]
    for i, ((name, start, dur), c) in enumerate(zip(phases, colors)):
        y = len(phases) - i
        ax.barh(y, dur, left=start, height=0.42, color=c, edgecolor="white", zorder=3)
        lbl = f"week {start}" if dur == 1 else f"weeks {start}–{start + dur - 1}"
        ax.text(start + dur + 0.16, y, lbl, va="center",
                fontsize=6.3, color=GREY, zorder=4)
        ax.text(0.9, y + 0.36, name, va="bottom", ha="left", fontsize=6.9, color=TEXT, zorder=4)
    ax.set_ylim(0.3, len(phases) + 1.0); ax.set_xlim(0.85, 16.6)
    ax.set_yticks([]); ax.set_xticks(range(1, 16))
    ax.set_xlabel("Project week", fontsize=7.0, color=TEXT)
    ax.tick_params(axis="x", labelsize=6.3, colors=GREY)
    for s in ("top", "right", "left"):
        ax.spines[s].set_visible(False)
    ax.spines["bottom"].set_color(GREY)
    ax.grid(axis="x", linestyle=":", color="#CBD6E0", zorder=0)
    plt.savefig(path, dpi=300, bbox_inches="tight", pad_inches=0.03, facecolor="white")
    plt.close()


if __name__ == "__main__":
    fig_architecture("fig1_architecture.png")
    fig_erd("fig2_erd.png")
    fig_future("fig3_future.png")
    fig_timeline("fig4_timeline.png")
    print("figures written")
