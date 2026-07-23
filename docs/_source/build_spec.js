const fs = require("fs"), path = require("path");
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, ImageRun, Footer, PageNumber, VerticalAlign, LevelFormat } = require("docx");

const NAVY = "1F3B57", STEEL = "33607F", GREY = "5C6B7A", LIGHT = "EDF2F7", RULE = "C7D3DE";
const F = "Calibri", SZ = 19, TSZ = 16;
const px = (i) => Math.round(i * 96);

const P = (t, o = {}) => new Paragraph({
  alignment: o.align || AlignmentType.JUSTIFIED,
  spacing: { before: o.before ?? 0, after: o.after ?? 90, line: 238 },
  shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: "auto" } : undefined,
  children: [new TextRun({ text: t, font: F, size: o.size || SZ, bold: o.bold, italics: o.italics, color: o.color || "1A1A1A" })],
});
const H1 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_1, keepNext: true, keepLines: true,
  spacing: { before: 200, after: 90, line: 238 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 2 } },
  children: [new TextRun({ text: t, font: F, size: 22, bold: true, color: NAVY })],
});
const H2 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_2, keepNext: true,
  spacing: { before: 130, after: 55, line: 238 },
  children: [new TextRun({ text: t, font: F, size: 19, bold: true, color: STEEL })],
});
const H3 = (t) => new Paragraph({
  keepNext: true, spacing: { before: 110, after: 40 },
  children: [new TextRun({ text: t, font: F, size: 17, bold: true, color: NAVY })],
});
const BUL = (runs) => new Paragraph({
  numbering: { reference: "b", level: 0 },
  alignment: AlignmentType.JUSTIFIED, spacing: { after: 30, line: 230 },
  children: (typeof runs === "string" ? [{ t: runs }] : runs).map(r =>
    new TextRun({ text: r.t, font: F, size: SZ, bold: r.b, italics: r.i, color: r.c || "1A1A1A" })),
});

function T(cols, header, rows, o = {}) {
  const cell = (c, w, opt = {}) => new TableCell({
    width: { size: w, type: WidthType.DXA },
    shading: opt.fill ? { type: ShadingType.CLEAR, fill: opt.fill, color: "auto" } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 28, bottom: 28, left: 85, right: 85 },
    children: [new Paragraph({ spacing: { before: 0, after: 0, line: 210 },
      children: [new TextRun({ text: c, font: F, size: TSZ, bold: opt.bold, italics: opt.italics, color: opt.color || "1A1A1A" })] })],
  });
  return new Table({
    columnWidths: cols, width: { size: cols.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 6, color: NAVY }, bottom: { style: BorderStyle.SINGLE, size: 6, color: NAVY },
      left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: RULE },
    },
    rows: [
      new TableRow({ tableHeader: true, children: header.map((h, i) => cell(h, cols[i], { fill: NAVY, bold: true, color: "FFFFFF" })) }),
      ...rows.map((r, ri) => new TableRow({ children: r.map((c, i) => cell(c, cols[i], {
        fill: ri % 2 === 1 ? LIGHT : undefined, bold: o.boldCol && o.boldCol.includes(i),
      })) })),
    ],
  });
}

const SCHEMA = (name, rows) => [
  H3(name),
  T([2100, 1500, 5760], ["Field", "Type", "Notes"], rows, { boldCol: [0] }),
];

const IMG = (file, w, h) => new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { before: 60, after: 30 },
  children: [new ImageRun({ type: "png", data: fs.readFileSync(path.join(__dirname, "..", "figures", file)),
    transformation: { width: px(w), height: px(h) } })],
});
const CAP = (t) => new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { after: 110 },
  children: [new TextRun({ text: t, font: F, size: 15, italics: true, color: GREY })],
});

/* ---------------------------------------------------------------- content */
const title = [
  new Paragraph({ spacing: { after: 30 },
    children: [new TextRun({ text: "SYSTEM SPECIFICATION", font: F, size: 17, bold: true, color: GREY, characterSpacing: 40 })] }),
  new Paragraph({ spacing: { after: 40 },
    children: [new TextRun({ text: "ChargeHub — EV Charging Station Reservation System", font: F, size: 32, bold: true, color: NAVY })] }),
  new Paragraph({ spacing: { after: 110 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: NAVY, space: 4 } },
    children: [new TextRun({ text: "Technical specification — multi-station network, two roles (driver, operator)", font: F, size: 19, italics: true, color: STEEL })] }),
];

const s1 = [
  H1("1.  Overview"),
  P("This document defines the scope of ChargeHub: a multi-station EV charging reservation platform covering public discovery, the reservation flow, driver account areas, the operator console, and the underlying MongoDB data model."),
  P("Drivers browse a network of stations, filter by connector type, and reserve a specific charger for a specific thirty-minute interval. Operators publish bookable inventory, control charger availability, resolve reservations and report on usage. The platform's central guarantee is that a reserved interval belongs to exactly one driver, enforced by a uniqueness constraint in the database rather than by application logic alone."),
  P("In scope: discovery, reservation, QR charger identification, vehicle management, guidance, messaging and the operator console. Out of scope: payment processing, energy metering, charging hardware control and live manufacturer telemetry. Reservations carry a cost estimate only; charger availability is operator-declared.", { size: 18 }),
];

const s2 = [
  H1("2.  Frontend pages"),
  H2("2.1  Public pages"),
  BUL("Homepage — network overview, featured content, entry points to discovery and registration"),
  BUL("Stations — catalogue of active stations with live “X of Y free” counts, filter by connector type and charging speed"),
  BUL("Station detail — address, position, amenities, operating hours, imagery, full charger list with status and price"),
  BUL("QR landing — reached by scanning a charger; shows that bay's live status and starts a reservation with it pre-selected"),
  BUL("How it works · FAQ · About / Contact · Terms · Privacy · custom 404"),
  H2("2.2  Reservation flow"),
  BUL("Login / Register"),
  BUL("Reservation wizard — four steps: station → charger → date and interval → vehicle and confirm; incompatible chargers marked; cost estimate shown"),
  BUL("Confirmation — reservation code, QR image, add-to-calendar file, full booking detail"),
  BUL("My reservations — upcoming / past / cancelled, with cancel (releases the interval)"),
  H2("2.3  Driver account"),
  BUL("Dashboard — next reservation, vehicle battery summary, quick actions"),
  BUL("Vehicles — add / edit / remove; connect a vehicle to a manufacturer and refresh its state"),
  BUL("Recommendations — best compatible charger per vehicle by battery urgency and distance"),
  BUL("Notifications — message list with read / mark-all-read"),
  BUL("Profile — name, email, phone, password"),
  H2("2.4  Operator console"),
  BUL("Dashboard — reservation volume by period, active/total chargers, estimated revenue, registered drivers, activity and utilisation charts"),
  BUL("Stations & chargers — catalogue view with per-charger availability control"),
  BUL("Reservations — search, filter and status resolution across the whole network"),
  BUL("Inventory — publish reservable intervals for a charger over a date range (idempotent)"),
  BUL("Users — registered driver list with search"),
  BUL("Reports — date-ranged summary with per-station breakdown and CSV export"),
];

const s3 = [
  H1("3.  System modules"),
  T([2250, 7110], ["Module", "Responsibility"], [
    ["Authentication", "Registration, credential sign-in, hashed passwords, signed bearer session carrying role, revocation, route protection."],
    ["User management", "Two roles (driver, operator); self-service profile; operator-side driver listing; ownership scoping of all private records."],
    ["Vehicle management", "Per-driver garage; connector type drives compatibility platform-wide; battery level and range feed guidance."],
    ["Charging stations", "Station and charger catalogue: geographic position, operating hours, amenities, pricing and availability status."],
    ["Reservation system", "Publishes bookable intervals; claims one interval indivisibly; issues a unique code; enforces the reservation lifecycle; releases the interval on cancellation."],
    ["QR & check-in", "Unique printed code per charger resolving publicly to live status and a pre-filled reservation; reservation code issued as an image. Automated redemption at the bay is a future extension."],
    ["Vehicle providers", "One uniform manufacturer interface (connect, disconnect, battery, range, location, charging state, identity) with implementations resolved at run time from a registry. Ships with a simulated provider; live telemetry is a future extension."],
    ["Recommendations & assistant", "Ranks compatible chargers by battery urgency and distance; deterministic assistant answering from live platform data only — it generates no free text and cannot state anything the platform does not hold."],
    ["Notifications", "Typed per-driver message store with read state. Automatic generation from platform events is a future extension."],
    ["Operator dashboard", "Aggregates reservations, chargers and drivers into operational metrics, charts and date-ranged reports with export."],
  ], { boldCol: [0] }),
];

const s4 = [
  H1("4.  Data model"),
  P("Nine MongoDB collections cover the full system: accounts, vehicles and their manufacturer connections, stations and chargers, reservable intervals, reservations, messages and site content. References are explicit; only structures without independent identity (position, hours, amenities) are embedded."),
  P("Two entities are named here for readability and stored under their original collection names: RESERVATION is the bookings collection, SITE_CONTENT is banners. The collections are not renamed — the model is additive only.", { size: 18 }),
  IMG("fig_erd_compact.png", 6.35, 4.30),
  CAP("ER diagram — the reservation is the transactional hub; its one-to-one relationship with a reservable interval is the system's central invariant."),
];

const s5 = [
  H1("5.  Collection schemas"),
  ...SCHEMA("USERS", [
    ["_id", "ObjectId", "Primary key"],
    ["name / phone", "string", ""],
    ["email", "string", "Unique, indexed"],
    ["passwordHash", "string", "Bcrypt hash, never returned"],
    ["role", "string", "\"admin\" | \"user\" — presented as operator / driver"],
    ["sessionGeneration", "number", "Incremented to revoke issued sessions"],
  ]),
  ...SCHEMA("VEHICLES", [
    ["_id", "ObjectId", "Primary key"],
    ["userId", "ObjectId", "FK → USERS; scopes every read and write"],
    ["make / model / year", "string, number", ""],
    ["connectorType", "string", "CCS | CHAdeMO | Type 2"],
    ["batteryCapacity", "number", "kWh"],
    ["currentBatteryLevel / estimatedRange", "number", "Provider-supplied; simulated in current scope"],
  ]),
  ...SCHEMA("VEHICLE_CONNECTIONS", [
    ["_id", "ObjectId", "Primary key"],
    ["userId / vehicleId", "ObjectId", "FK; unique together — one connection per vehicle"],
    ["provider", "string", "tesla | hyundai | bmw | mock — mirrors the provider registry"],
    ["accessToken / refreshToken", "string", "Manufacturer credentials"],
    ["externalVehicleId", "string", "Identifier at the manufacturer"],
    ["isConnected / lastSyncedAt", "boolean, date", ""],
  ]),
  ...SCHEMA("STATIONS", [
    ["_id", "ObjectId", "Primary key"],
    ["name / address", "string", ""],
    ["location", "geo", "GeoJSON Point, 2dsphere index"],
    ["amenities", "array", "e.g. [\"restroom\", \"wifi\"]"],
    ["operatingHours", "object", "Per-day open/close"],
    ["images / isActive", "array, boolean", "Deactivation replaces deletion"],
  ]),
  ...SCHEMA("CHARGERS", [
    ["_id", "ObjectId", "Primary key"],
    ["stationId", "ObjectId", "FK → STATIONS"],
    ["label / connectorType", "string", ""],
    ["powerKW / pricePerKWh", "number", ""],
    ["status", "string", "available | in_use | maintenance | offline — operator-declared"],
    ["qrCode", "string", "Unique; the identifier printed at the bay"],
  ]),
  ...SCHEMA("SLOTS  (reservable intervals)", [
    ["_id", "ObjectId", "Primary key"],
    ["chargerId", "ObjectId", "FK → CHARGERS"],
    ["startTime / endTime", "date", "Unique with chargerId — makes publication idempotent"],
    ["duration", "number", "Minutes; 30 by default"],
    ["status", "string", "available | booked | blocked | completed"],
  ]),
  ...SCHEMA("RESERVATIONS", [
    ["_id", "ObjectId", "Primary key"],
    ["userId / vehicleId", "ObjectId", "FK; the vehicle must belong to the caller"],
    ["slotId", "ObjectId", "FK → SLOTS. Unique across live reservations — the central constraint"],
    ["chargerId / stationId", "ObjectId", "FK, denormalised for read efficiency"],
    ["reservationCode", "string", "Unique, shown to the driver"],
    ["startTime / endTime", "date", "Snapshot of the claimed interval"],
    ["status", "string", "pending | confirmed | cancelled | completed | no_show — transitions enforced"],
    ["appliedUnitPrice / appliedPowerKW", "number", "Cost basis captured at claim time so totals stay reproducible"],
    ["totalAmount / paymentStatus", "number, string", "Estimate only; no payment processing in scope"],
  ]),
  ...SCHEMA("NOTIFICATIONS", [
    ["_id", "ObjectId", "Primary key"],
    ["userId", "ObjectId", "FK → USERS"],
    ["type", "string", "booking_confirmed | booking_reminder | booking_cancelled | low_battery | recommendation | system"],
    ["title / message", "string", ""],
    ["isRead / data", "boolean, object", "Payload reserved for deep links"],
  ]),
  ...SCHEMA("SITE_CONTENT", [
    ["_id", "ObjectId", "Primary key"],
    ["title / subtitle / imageUrl", "string", "Homepage presentation content"],
    ["ctaLabel / ctaHref", "string", ""],
    ["order / isActive", "number, boolean", ""],
  ]),
];

const s6 = [
  H1("6.  Implementation notes"),
  BUL([{ t: "MongoDB. ", b: true }, { t: "The document model fits nested station → charger → interval data. Five uniqueness constraints carry the system's invariants: reservation→slot, (chargerId, startTime), (userId, vehicleId), user email, and the reservation and charger codes. A 2dsphere index on station position is provisioned for proximity search." }]),
  BUL([{ t: "API service. ", b: true }, { t: "A headless REST service built on Next.js route handlers rather than a separate Express process — one framework across both tiers. Authorisation, validation and response shaping are each implemented once. Identity, users, analytics, inventory, reservations and vehicle connections delegate to domain services; recommendations and the assistant still hold their logic in the handler and are scheduled for extraction." }]),
  BUL([{ t: "React frontend. ", b: true }, { t: "React via the Next.js App Router, server-rendered for public discoverability, with route groups separating public, driver and operator areas. The client holds no database access; every read and write crosses the API boundary, keeping the service reusable by future clients." }]),
  BUL([{ t: "Authentication. ", b: true }, { t: "Bcrypt password hashing; a signed bearer credential carrying identity and role, verified per request and revocable through the session generation field. Private records are scoped to their owner as part of the operation itself, not by a preceding check." }]),
  BUL([{ t: "Reservation integrity. ", b: true }, { t: "Intervals are pre-materialised, so reserving is the claim of one identifiable record. The interval transition and the reservation creation occur as a single indivisible operation, and a unique index on the reservation's slot reference makes a second claim impossible regardless of code path. A contested claim returns an explicit conflict." }]),
  BUL([{ t: "Inventory publication. ", b: true }, { t: "Operator-triggered over a date range and idempotent — re-running skips existing intervals. Automatic rolling publication requires a scheduler and is a future extension." }]),
  BUL([{ t: "Future scalability. ", b: true }, { t: "Interval records dominate growth, so publication windows and retention are bounded. Extensions already anticipated by the model — manufacturer identities, the geospatial index, stored operating hours, the message store — attach by reference and require no restructuring." }]),
];

const s7 = [
  H1("7.  Future enhancements"),
  P("The following are planned architectural extensions. They are supported by the design described above but are not mandatory for completion of the current project, and none is implemented in the current scope.",
    { fill: LIGHT, bold: true, size: 18 }),
  T([2400, 6960], ["Enhancement", "Notes"], [
    ["Additional vehicle providers", "One implementation of the existing provider interface plus one registry entry per manufacturer; the identities are already modelled."],
    ["Real Tesla integration", "Replace the simulated provider with live fleet telemetry; requires credential protection at rest, expiry and renewal handling before any live token is stored."],
    ["Advanced AI recommendations", "Driver position, availability awareness and historical preference added to the existing ranking; optional language-model phrasing over the same grounded results, with the deterministic path retained as fallback."],
    ["Smart notifications", "A producer raising messages from platform events (reservation confirmed or cancelled, low battery), plus scheduled reminders and email / SMS / push delivery."],
    ["Payment gateway", "A transaction entity linked to the reservation, replacing estimated totals with settled revenue and enabling refunds."],
    ["Analytics enhancements", "Database-side aggregation, true utilisation measured against published inventory, scheduled report delivery and demand forecasting."],
    ["QR check-in", "Redemption of the reservation code at the bay, adding a redemption record and a reservation state transition."],
    ["Hardware integration", "Machine-reported charger status with defined precedence over the operator-declared value, and charging sessions with metered energy."],
  ], { boldCol: [0] }),
];

/* ---------------------------------------------------------------- assemble */
const doc = new Document({
  creator: "ChargeHub", title: "ChargeHub — System Specification",
  styles: { default: { document: { run: { font: F, size: SZ, color: "1A1A1A" }, paragraph: { spacing: { line: 238 } } } } },
  numbering: { config: [{ reference: "b", levels: [{ level: 0, format: LevelFormat.BULLET, text: "▪",
    alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 290, hanging: 185 } }, run: { color: STEEL, size: 16 } } }] }] },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1000, right: 1080, bottom: 900, left: 1080 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
      new TextRun({ text: "ChargeHub — System Specification  ·  ", font: F, size: 15, color: GREY }),
      new TextRun({ children: [PageNumber.CURRENT], font: F, size: 15, color: GREY }),
      new TextRun({ text: " of ", font: F, size: 15, color: GREY }),
      new TextRun({ children: [PageNumber.TOTAL_PAGES], font: F, size: 15, color: GREY })] })] }) },
    children: [...title, ...s1, ...s2, ...s3, ...s4, ...s5, ...s6, ...s7],
  }],
});

const OUT = "C:\\Users\\malik\\Desktop\\DigitalHub\\EVCharging-System\\EVCharging-System\\docs\\ChargeHub_System_Specification.docx";
Packer.toBuffer(doc).then(b => { fs.writeFileSync(OUT, b); console.log("WROTE " + OUT + " (" + Math.round(b.length / 1024) + " KB)"); });
