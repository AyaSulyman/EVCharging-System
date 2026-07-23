const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, ImageRun, Footer, PageNumber, VerticalAlign, LevelFormat,
} = require("docx");

const NAVY = "1F3B57", STEEL = "33607F", GREY = "5C6B7A", ACCENT = "8A5A1F", LIGHT = "EDF2F7", RULE = "C7D3DE";
const F = "Calibri";
const BODY_SZ = 19;      // 9.5pt
const TBL_SZ = 16;       // 8pt
const px = (i) => Math.round(i * 96);

const P = (text, o = {}) => new Paragraph({
  alignment: o.align || AlignmentType.JUSTIFIED,
  spacing: { before: o.before ?? 0, after: o.after ?? 90, line: o.line ?? 238 },
  children: [new TextRun({ text, font: F, size: o.size || BODY_SZ, bold: o.bold, italics: o.italics, color: o.color || "1A1A1A" })],
});

const RICH = (runs, o = {}) => new Paragraph({
  alignment: o.align || AlignmentType.JUSTIFIED,
  spacing: { before: o.before ?? 0, after: o.after ?? 90, line: o.line ?? 238 },
  border: o.border,
  shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: "auto" } : undefined,
  indent: o.indent,
  children: runs.map(r => new TextRun({ text: r.t, font: F, size: r.size || o.size || BODY_SZ, bold: r.b, italics: r.i, color: r.c || "1A1A1A" })),
});

const H = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  keepNext: true, keepLines: true,
  spacing: { before: 190, after: 90, line: 238 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 2 } },
  children: [new TextRun({ text, font: F, size: 22, bold: true, color: NAVY })],
});

const BUL = (runs, o = {}) => new Paragraph({
  numbering: { reference: "b", level: 0 },
  alignment: AlignmentType.JUSTIFIED,
  spacing: { after: o.after ?? 40, line: 232 },
  children: (typeof runs === "string" ? [{ t: runs }] : runs).map(r =>
    new TextRun({ text: r.t, font: F, size: BODY_SZ, bold: r.b, italics: r.i, color: r.c || "1A1A1A" })),
});

function T(cols, header, rows, o = {}) {
  const total = cols.reduce((a, b) => a + b, 0);
  const cell = (c, w, opt = {}) => new TableCell({
    width: { size: w, type: WidthType.DXA },
    shading: opt.fill ? { type: ShadingType.CLEAR, fill: opt.fill, color: "auto" } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 40, bottom: 40, left: 90, right: 90 },
    children: [new Paragraph({
      spacing: { before: 0, after: 0, line: 216 },
      children: [new TextRun({ text: c, font: F, size: TBL_SZ, bold: opt.bold, color: opt.color || "1A1A1A" })],
    })],
  });
  return new Table({
    columnWidths: cols,
    width: { size: total, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 6, color: NAVY },
      bottom: { style: BorderStyle.SINGLE, size: 6, color: NAVY },
      left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: RULE },
    },
    rows: [
      new TableRow({
        tableHeader: true,
        children: header.map((h, i) => cell(h, cols[i], { fill: NAVY, bold: true, color: "FFFFFF" })),
      }),
      ...rows.map((r, ri) => new TableRow({
        children: r.map((c, i) => cell(c, cols[i], {
          fill: ri % 2 === 1 ? LIGHT : undefined,
          bold: o.boldCol && o.boldCol.includes(i),
        })),
      })),
    ],
  });
}

const IMG = (file, wIn, hIn) => new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 60, after: 30 },
  children: [new ImageRun({
    type: "png",
    data: fs.readFileSync(path.join(__dirname, "..", "figures", file)),
    transformation: { width: px(wIn), height: px(hIn) },
  })],
});

const CAP = (t) => new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 0, after: 120 },
  children: [new TextRun({ text: t, font: F, size: 15, italics: true, color: GREY })],
});

/* ------------------------------------------------------------------ content */
const FULL = 9360;

const titleBlock = [
  new Paragraph({
    spacing: { after: 30 },
    children: [new TextRun({ text: "PROJECT PROPOSAL", font: F, size: 17, bold: true, color: GREY, characterSpacing: 40 })],
  }),
  new Paragraph({
    spacing: { after: 40 },
    children: [new TextRun({ text: "ChargeHub — EV Charging Station Reservation Platform", font: F, size: 34, bold: true, color: NAVY })],
  }),
  new Paragraph({
    spacing: { after: 110 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: NAVY, space: 4 } },
    children: [new TextRun({
      text: "A multi-station reservation platform with a conflict-free booking guarantee and a manufacturer-agnostic vehicle integration architecture",
      font: F, size: 19, italics: true, color: STEEL,
    })],
  }),
];

const s1 = [
  H("1.  Overview"),
  P("ChargeHub is a proposed web platform that lets electric vehicle drivers reserve a specific charger for a specific time interval across a network of charging branches, and gives the network operator the tools to publish, control and measure that bookable capacity. It converts charger availability from something a driver discovers on arrival into something they secure before travelling."),
  P("The platform reserves time at a charger. It does not process payments, meter delivered energy, or control charging hardware; these boundaries are stated explicitly in Section 4 and revisited in Section 11 as supported extensions rather than omissions."),
];

const s2 = [
  H("2.  Problem Statement"),
  P("A driver cannot establish, before travelling, that a compatible charger will be free on arrival. Charging sessions are long, so a small number of bays can be effectively unavailable for hours, and connector standards differ, so not every free charger is usable by every vehicle. Live occupancy displays answer only whether a bay is free now, which is of little value to a driver thirty minutes away."),
  P("The operator has the inverse problem: demand is invisible until it arrives, maintenance cannot be communicated ahead of time, utilisation is estimated rather than measured, and demand that fails to convert leaves no record at all."),
  RICH([{ t: "Reservation resolves both, but introduces one obligation: if the system ever allows two drivers to hold the same interval it has replaced an honest uncertainty with a false promise. Correct allocation under concurrent access is therefore the platform's primary functional requirement, not a quality attribute.", b: true }], { after: 90 }),
];

const s3 = [
  H("3.  Objectives"),
  T([3000, 6360], ["Objective", "Success criterion"], [
    ["Guarantee conflict-free reservation", "Two simultaneous claims on one interval produce exactly one reservation; the second is rejected by a database constraint, not by application logic alone."],
    ["Enable self-service reservation", "A registered driver completes a reservation in under two minutes on a mobile device."],
    ["Publish availability before travel", "Active stations are publicly viewable with live counts of free chargers, filterable by connector type and charging speed, without sign-in."],
    ["Bridge physical and digital network", "Scanning the code at a bay resolves to that charger's live status and pre-selects it for reservation."],
    ["Give the operator control of capacity", "Bookable inventory, charger availability and reservation resolution are all managed without developer involvement."],
    ["Achieve manufacturer independence", "A new vehicle manufacturer is supported by one new provider implementation and one registry entry, with no other change to the system."],
    ["Report reproducibly", "Every reported figure remains reproducible after a later price change and is labelled as an estimate while payment is out of scope."],
  ], { boldCol: [0] }),
];

const s4 = [
  H("4.  Scope"),
  T([2100, 7260], ["Area", "Included capability"], [
    ["Identity and access", "Registration and sign-in; driver and operator roles; protected areas; revocable sessions."],
    ["Discovery", "Public station catalogue with position, amenities, hours and live availability; filtering by connector and speed."],
    ["Catalogue", "Stations and chargers with connector type, power, unit price, availability status and a unique printed code."],
    ["Bookable inventory", "Discrete thirty-minute intervals published by the operator over a date range, generated idempotently."],
    ["Reservation", "Guided selection of station, charger, interval and vehicle; compatibility marking; cost estimate; indivisible claim; unique code; cancellation releasing the interval."],
    ["Vehicles", "Per-driver garage with strict ownership isolation; connector type drives compatibility platform-wide."],
    ["Vehicle integration", "Uniform provider interface, runtime registry, a simulated provider, and one provider written against a real manufacturer interface."],
    ["Guidance", "Charging recommendations from battery level, compatibility and distance; a deterministic assistant answering only from live platform data."],
    ["Operator console", "Dashboard and charts; catalogue and availability management; inventory publication; reservation resolution; date-ranged reporting with export."],
  ], { boldCol: [0] }),
  P("Explicitly out of scope: payment processing and settled revenue; energy metering and charging session records; control of or status reporting from charging hardware; live telemetry from manufacturer services; automatic generation and external delivery of messages; scheduled background execution; redemption of the reservation code at the bay; map-based discovery; native mobile applications; delegated per-branch operator permissions.",
    { before: 110, size: 18 }),
];

const s5 = [
  H("5.  Proposed Solution"),
  BUL([{ t: "Capacity as records. ", b: true }, { t: "Every reservable interval exists as a discrete record before anyone reserves it. Availability becomes a simple query, publication becomes an operator-controlled and repeatable action, and reserving reduces to claiming one identifiable record — which is what makes the guarantee below possible." }]),
  BUL([{ t: "The reservation guarantee. ", b: true }, { t: "The interval's transition to reserved and the creation of the reservation that holds it occur as a single indivisible operation, backed by a uniqueness constraint in the database on the reservation's reference to its interval. The first mechanism makes the correct outcome normal; the second makes the incorrect outcome impossible, independently of application code. It is verifiable: two simultaneous claims must yield one reservation and one explicit rejection." }]),
  BUL([{ t: "Manufacturer-agnostic vehicle integration. ", b: true }, { t: "No universal interface exists for electric vehicle data, so the platform communicates with vehicles only through one uniform interface — connect, disconnect, battery, range, location, charging state, identity — with concrete implementations resolved at run time from a registry keyed by manufacturer. The layer resides in the API service, where server-held credentials and renewal can actually run, which is what makes the independence structural rather than nominal." }]),
  BUL([{ t: "The physical bridge. ", b: true }, { t: "Each charger carries a unique printed code. Scanning it resolves publicly to that bay's live status and begins a reservation with station and charger already selected — the shortest path from the physical network to a completed booking." }]),
  BUL([{ t: "Deterministic guidance. ", b: true }, { t: "Recommendations rank compatible chargers by battery urgency and distance. The assistant answers questions by querying live platform data and generates no free text, so it cannot state anything the platform does not hold." }], { after: 90 }),
];

const s6 = [
  H("6.  System Architecture"),
  P("Three tiers: a server-rendered client, a headless API service, and a managed document database. Both application tiers use a single web framework, which removes an additional server technology without collapsing the boundary between them. The client holds no database access — every read and write crosses the service boundary, which keeps the service reusable by any future client and prevents data logic accumulating in the presentation layer.", { after: 40 }),
  IMG("fig_arch_compact.png", 6.0, 1.63),
  CAP("Figure 1  ·  Three-tier architecture and the boundary between tiers."),
  P("Security is layered: passwords stored only as hashes; a signed bearer credential carrying identity and role, invalidable before expiry; two authorisation tiers with private records scoped to their owner as part of the operation itself; validation at the service boundary so it does not exist only where the client controls it; and a database credential limited to the privileges the service actually requires.", { after: 90 }),
];

const s7 = [
  H("8.  Data Model"),
  P("Nine collections, favouring explicit references between independently queried entities over deep nesting. Structures without independent identity — a station's position, hours and amenities — are embedded in their parent. Five uniqueness constraints are placed in the database because each protects a property that must hold regardless of which code path writes: the reservation's interval reference (the central invariant), charger with interval start (making publication idempotent), connection per vehicle, account email, and the reservation and charger codes.", { after: 30 }),
  IMG("fig_erd_compact.png", 6.45, 4.37),
  CAP("Figure 2  ·  Entity relationship diagram. The reservation is the transactional hub; its one-to-one relationship with a reservable interval is the invariant the platform exists to guarantee."),
];

const s8 = [
  H("7.  Technology Stack"),
  T([2400, 6960], ["Layer", "Selection and rationale"], [
    ["Client", "Next.js with React — server rendering for public discoverability; route grouping separates public, driver and operator areas."],
    ["API service", "Next.js, headless — routing, request handling and deployment for the service without a second server technology."],
    ["Language", "TypeScript throughout, so models and contracts are checked at compile time."],
    ["Database", "MongoDB with object modelling — document structure matches nested station, charger and interval data; uniqueness and geospatial indexing are native."],
    ["Security", "bcrypt password hashing; signed bearer credentials; schema validation at the service boundary."],
    ["Interface", "Tailwind CSS with design tokens; charting and code-generation libraries for the operator dashboard and printed codes."],
  ], { boldCol: [0] }),
];

const s9 = [
  H("9.  Risk Assessment"),
  T([2700, 900, 5760], ["Risk", "Impact", "Mitigation"], [
    ["Allocation proves incorrect under concurrency", "Critical", "The guarantee is placed in the database as a uniqueness constraint rather than in application logic; concurrent claim testing is an explicit completion criterion."],
    ["Manufacturer integration cannot be validated in period", "Low", "The architecture, not the integration, is the deliverable; the simulated provider exercises every path end to end and the dependency is disclosed."],
    ["Scope expansion during development", "High", "Section 4 fixes the committed scope; Section 11 holds every further idea as explicitly optional."],
    ["Bookable inventory exhausted during evaluation", "High", "Inventory publication is a standing pre-demonstration check, since inventory does not extend itself within scope."],
    ["Security misconfiguration of service or database", "High", "Least-privilege credentials, boundary validation and a security review are scheduled work, not assumptions."],
  ], { boldCol: [0] }),
];

const s10 = [
  H("10.  Deliverables"),
  BUL("Responsive client application covering public discovery, the reservation journey, the vehicle garage and the operator console."),
  BUL("Headless API service covering identity, catalogue, inventory, reservations, vehicles and connections, guidance, messaging, code resolution and operator statistics."),
  BUL("Database implementation of the nine-collection model with its uniqueness constraints, supporting indexes and a data preparation script."),
  BUL("Vehicle provider layer: the uniform interface, the runtime registry, a simulated implementation and one written against a real manufacturer interface."),
  BUL("Verification evidence, including the concurrent claim demonstration, ownership isolation and inventory consistency checks."),
  BUL("System specification, setup documentation and a version-controlled source repository.", { after: 90 }),
];

const s11 = [
  H("11.  Future Enhancements"),
  RICH([{ t: "These are intentionally supported by the proposed architecture. They are not mandatory for successful completion of the project. They may be implemented before submission if development time remains once the scope in Section 4 is complete and verified; otherwise they remain roadmap. None is claimed as implemented.", b: true, size: 18 }],
    { fill: LIGHT, after: 100 }),
  T([2500, 3400, 3460], ["Enhancement", "Structure it attaches to", "Nature of the work"], [
    ["Live manufacturer integration", "Provider interface, registry and persisted manufacturer identity.", "Replace the simulated provider; add credential protection and renewal."],
    ["Additional manufacturers", "The same registry; identities already modelled.", "One implementation and one registry entry each."],
    ["Smarter recommendations", "Existing ranking and the provisioned geospatial index.", "Add driver position, availability awareness and historical preference."],
    ["Automatic and smart messaging", "The message store, already self-contained.", "Add a producer raising messages from platform events, plus delivery channels."],
    ["Payment gateway", "The reservation and its captured cost basis.", "Add a transaction entity; replace estimated figures with settled ones."],
    ["Energy metering and hardware", "The charger availability attribute.", "Add charging sessions and machine-reported status with defined precedence."],
    ["Advanced analytics", "Reservations and published inventory.", "Database-side aggregation, true utilisation, demand forecasting."],
    ["Code redemption at the bay", "The existing code resolution path.", "Add a redemption record and a reservation state transition."],
    ["Scheduled execution", "Inventory publication and reservation lifecycle.", "Automatic publication, reminders and lifecycle closure."],
    ["Multi-branch operator roles", "The account role attribute.", "Introduce an organisation entity and delegated permissions."],
  ], { boldCol: [0] }),
  P("Any enhancement adopted will be reported as delivered scope; any not adopted remains documented here. A partially implemented enhancement is worse than an absent one, so each will be undertaken only where it can be completed and verified in full.",
    { before: 100, size: 18 }),
];

/* ------------------------------------------------------------------ assemble */
const doc = new Document({
  creator: "ChargeHub",
  title: "ChargeHub — Project Proposal",
  description: "Condensed project proposal for an EV charging station reservation platform.",
  styles: { default: { document: { run: { font: F, size: BODY_SZ, color: "1A1A1A" }, paragraph: { spacing: { line: 238 } } } } },
  numbering: {
    config: [{
      reference: "b",
      levels: [{
        level: 0, format: LevelFormat.BULLET, text: "▪", alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 300, hanging: 190 } }, run: { color: STEEL, size: 16 } },
      }],
    }],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1000, right: 1080, bottom: 900, left: 1080 },
      },
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text: "ChargeHub — Project Proposal  ·  ", font: F, size: 15, color: GREY }),
            new TextRun({ children: [PageNumber.CURRENT], font: F, size: 15, color: GREY }),
            new TextRun({ text: " of ", font: F, size: 15, color: GREY }),
            new TextRun({ children: [PageNumber.TOTAL_PAGES], font: F, size: 15, color: GREY }),
          ],
        })],
      }),
    },
    children: [...titleBlock, ...s1, ...s2, ...s3, ...s4, ...s5, ...s6, ...s8, ...s7, ...s9, ...s10, ...s11],
  }],
});

const OUT = process.argv[2] || "C:\\Users\\malik\\Desktop\\DigitalHub\\EVCharging-System\\EVCharging-System\\docs\\ChargeHub_Proposal_Summary.docx";
Packer.toBuffer(doc).then((b) => { fs.writeFileSync(OUT, b); console.log("WROTE " + OUT + " (" + Math.round(b.length / 1024) + " KB)"); });
