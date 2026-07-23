const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, PageBreak, ImageRun, Header, Footer, PageNumber,
  TableOfContents, SequentialIdentifier, PageOrientation, VerticalAlign, LevelFormat,
} = require("docx");

const NAVY = "1F3B57", STEEL = "33607F", GREY = "5C6B7A", ACCENT = "8A5A1F", LIGHT = "EDF2F7", RULE = "C7D3DE";
const BODY = "Calibri", HEAD = "Calibri";
const FULL = 9360;              // portrait usable width, DXA
const px = (inches) => Math.round(inches * 96);

/* ------------------------------------------------------------------ helpers */
const P = (text, o = {}) => new Paragraph({
  alignment: o.align || AlignmentType.JUSTIFIED,
  spacing: { before: o.before ?? 0, after: o.after ?? 140, line: o.line ?? 276 },
  indent: o.indent,
  border: o.border,
  children: [new TextRun({
    text, font: BODY, size: o.size || 22, bold: o.bold, italics: o.italics,
    color: o.color || "1A1A1A",
  })],
});

const RICH = (runs, o = {}) => new Paragraph({
  alignment: o.align || AlignmentType.JUSTIFIED,
  spacing: { before: o.before ?? 0, after: o.after ?? 140, line: o.line ?? 276 },
  children: runs.map(r => new TextRun({
    text: r.t, font: BODY, size: r.size || o.size || 22, bold: r.b, italics: r.i,
    color: r.c || "1A1A1A",
  })),
});

const H1 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_1, pageBreakBefore: true,
  spacing: { before: 0, after: 240, line: 276 },
  children: [new TextRun({ text, font: HEAD, size: 32, bold: true, color: NAVY })],
});
const H1NB = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 0, after: 240, line: 276 },
  children: [new TextRun({ text, font: HEAD, size: 32, bold: true, color: NAVY })],
});
const H2 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 280, after: 130, line: 276 },
  children: [new TextRun({ text, font: HEAD, size: 25, bold: true, color: STEEL })],
});
const H3 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_3,
  spacing: { before: 220, after: 110, line: 276 },
  children: [new TextRun({ text, font: HEAD, size: 22, bold: true, color: NAVY })],
});

const BUL = (text, o = {}) => new Paragraph({
  numbering: { reference: "bullets", level: 0 },
  alignment: AlignmentType.JUSTIFIED,
  spacing: { after: o.after ?? 70, line: 276 },
  children: [new TextRun({ text, font: BODY, size: 22, color: "1A1A1A" })],
});
const BULR = (runs) => new Paragraph({
  numbering: { reference: "bullets", level: 0 },
  alignment: AlignmentType.JUSTIFIED,
  spacing: { after: 70, line: 276 },
  children: runs.map(r => new TextRun({ text: r.t, font: BODY, size: 22, bold: r.b, italics: r.i, color: r.c || "1A1A1A" })),
});

const noBorders = {
  top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
  left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
};

/** Table with a shaded header row. rows = array of arrays of strings (or {t,b,i}) */
function T(cols, header, rows, opts = {}) {
  const total = cols.reduce((a, b) => a + b, 0);
  const cell = (content, o = {}) => new TableCell({
    width: { size: o.w, type: WidthType.DXA },
    shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: "auto" } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 70, bottom: 70, left: 110, right: 110 },
    children: (Array.isArray(content) ? content : [content]).map(c => new Paragraph({
      alignment: o.align || AlignmentType.LEFT,
      spacing: { before: 10, after: 10, line: 250 },
      children: [new TextRun({
        text: typeof c === "string" ? c : c.t,
        font: BODY, size: o.size || 19,
        bold: o.bold || (typeof c === "object" && c.b),
        italics: (typeof c === "object" && c.i),
        color: o.color || (typeof c === "object" && c.c) || "1A1A1A",
      })],
    })),
  });

  const headerRow = new TableRow({
    tableHeader: true,
    children: header.map((h, i) => cell(h, { w: cols[i], fill: NAVY, bold: true, color: "FFFFFF", size: opts.headSize || 19 })),
  });

  const bodyRows = rows.map((r, ri) => new TableRow({
    children: r.map((c, i) => cell(c, {
      w: cols[i],
      fill: ri % 2 === 1 ? LIGHT : undefined,
      size: opts.size || 19,
      align: opts.align && opts.align[i],
      bold: opts.boldCol && opts.boldCol.includes(i),
    })),
  }));

  return new Table({
    columnWidths: cols,
    width: { size: total, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 6, color: NAVY },
      bottom: { style: BorderStyle.SINGLE, size: 6, color: NAVY },
      left: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      right: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: RULE },
    },
    rows: [headerRow, ...bodyRows],
  });
}

const tableCaption = (n, text) => new Paragraph({
  style: "Caption", alignment: AlignmentType.LEFT,
  spacing: { before: 120, after: 220 },
  children: [
    new TextRun({ text: "Table ", font: BODY, size: 18, bold: true, color: NAVY }),
    new SequentialIdentifier("Table"),
    new TextRun({ text: "  ·  " + text, font: BODY, size: 18, color: GREY }),
  ],
});
const figCaption = (text) => new Paragraph({
  style: "Caption", alignment: AlignmentType.CENTER,
  spacing: { before: 120, after: 220 },
  children: [
    new TextRun({ text: "Figure ", font: BODY, size: 18, bold: true, color: NAVY }),
    new SequentialIdentifier("Figure"),
    new TextRun({ text: "  ·  " + text, font: BODY, size: 18, color: GREY }),
  ],
});

function figure(file, widthIn) {
  const dim = { fig1: [5.44, 2.73], fig2: [7.01, 4.93], fig3: [5.08, 2.77], fig4: [5.21, 2.86] };
  const key = file.startsWith("fig1") ? "fig1" : file.startsWith("fig2") ? "fig2" : file.startsWith("fig3") ? "fig3" : "fig4";
  const [w, h] = dim[key];
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 160, after: 0 },
    children: [new ImageRun({
      type: "png",
      data: fs.readFileSync(path.join(__dirname, "..", "figures", file)),
      transformation: { width: px(widthIn), height: px(widthIn * h / w) },
    })],
  });
}

const SPACER = (n = 1) => Array.from({ length: n }, () => new Paragraph({ spacing: { after: 0 }, children: [] }));
const RULEP = () => new Paragraph({
  spacing: { before: 60, after: 200 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: NAVY, space: 1 } },
  children: [],
});

/* ------------------------------------------------------------------ front matter */
const cover = [
  ...SPACER(2),
  new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 60 },
    children: [new TextRun({ text: "[ UNIVERSITY NAME ]", font: HEAD, size: 28, bold: true, color: NAVY })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 40 },
    children: [new TextRun({ text: "[ Faculty of Engineering  ·  Department of Computer Science ]", font: HEAD, size: 22, color: STEEL })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 700 },
    children: [new TextRun({ text: "[ Bachelor of Science in Software Engineering ]", font: HEAD, size: 22, color: STEEL })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 200 },
    children: [new TextRun({ text: "SOFTWARE ENGINEERING CAPSTONE PROJECT PROPOSAL", font: HEAD, size: 24, bold: true, color: GREY, characterSpacing: 30 })],
  }),
  RULEP(),
  new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 120 },
    children: [new TextRun({ text: "ChargeHub", font: HEAD, size: 60, bold: true, color: NAVY })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 100 },
    children: [new TextRun({
      text: "An Electric Vehicle Charging Station Reservation Platform",
      font: HEAD, size: 30, bold: true, color: "1A1A1A",
    })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 200 },
    children: [new TextRun({
      text: "with a Conflict-Free Reservation Guarantee and a Manufacturer-Agnostic Vehicle Integration Architecture",
      font: HEAD, size: 24, italics: true, color: STEEL,
    })],
  }),
  RULEP(),
  ...SPACER(3),
  new Table({
    columnWidths: [3000, 4400],
    width: { size: 7400, type: WidthType.DXA },
    alignment: AlignmentType.CENTER,
    borders: noBorders,
    rows: [
      ["Submitted by", "Malik Halimeh"],
      ["Student identifier", "[ Student ID ]"],
      ["Supervisor", "[ Supervisor Name ]"],
      ["Academic year", "[ Academic Year ]"],
      ["Date of submission", "July 2026"],
      ["Document version", "1.0  ·  Project Proposal"],
    ].map(([k, v]) => new TableRow({
      children: [
        new TableCell({
          width: { size: 3000, type: WidthType.DXA }, borders: noBorders,
          margins: { top: 50, bottom: 50, left: 0, right: 120 },
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT, spacing: { after: 0 },
            children: [new TextRun({ text: k, font: BODY, size: 21, color: GREY })],
          })],
        }),
        new TableCell({
          width: { size: 4400, type: WidthType.DXA }, borders: noBorders,
          margins: { top: 50, bottom: 50, left: 120, right: 0 },
          children: [new Paragraph({
            spacing: { after: 0 },
            children: [new TextRun({ text: v, font: BODY, size: 21, bold: true, color: "1A1A1A" })],
          })],
        }),
      ],
    })),
  }),
  new Paragraph({ children: [new PageBreak()] }),
];

const abstract = [
  H1NB("Abstract"),
  P("Electric vehicle adoption continues to outpace the deployment of public charging infrastructure, and the consequence is felt at the bay rather than on the map. A driver can locate a charging station, travel to it, and still find every connector occupied, because availability is discovered on arrival rather than secured in advance. The operator of a charging network faces the inverse problem: demand is invisible until it appears, maintenance cannot be communicated ahead of time, and utilisation is estimated rather than measured."),
  P("This proposal presents ChargeHub, a multi-station reservation platform that converts charger availability from an expectation into a commitment. A driver browses a network of stations, filters by the connector type their vehicle uses, reserves a specific charger for a specific half-hour interval, and travels holding a reservation code. An operator publishes bookable inventory, manages charger availability, resolves reservation issues, and reports on usage from a dedicated console."),
  P("The project is defined by two engineering contributions rather than by feature count. The first is correctness under contention: a reservable interval is a finite, discrete resource, and the platform guarantees — through an indivisible claim operation supported by a uniqueness constraint in the database — that exactly one reservation can ever hold it. The second is manufacturer independence: because no universal application programming interface exists for electric vehicle data, the platform communicates with vehicles exclusively through a single uniform provider interface resolved at runtime, so that supporting an additional manufacturer requires one new implementation rather than changes throughout the system."),
  P("The proposed system will be delivered as two applications built on a single web framework — a server-rendered client and a headless application programming interface service — over a document database of nine collections. The document defines the problem, the objectives, the committed scope, the architecture, the data model, the functional and non-functional requirements, the development methodology, the risk profile, and the schedule. A dedicated chapter describes future enhancements, including live manufacturer telemetry, payment processing, energy metering and hardware integration. These are deliberately supported by the proposed architecture but are explicitly not required for the successful completion of the project."),
  new Paragraph({ spacing: { before: 200, after: 60 }, children: [new TextRun({ text: "Keywords", font: BODY, size: 22, bold: true, color: NAVY })] }),
  P("electric vehicle charging; reservation systems; concurrency control; data integrity; service-oriented architecture; provider abstraction; document databases; web engineering.", { italics: true }),
  new Paragraph({ children: [new PageBreak()] }),

  H1NB("Acknowledgements"),
  P("[ Placeholder — to be completed prior to final submission. ]", { italics: true, color: GREY }),
  ...SPACER(1),
  P("[ This section will acknowledge the project supervisor for guidance throughout the design and development of the system, the academic staff of the department for their instruction and feedback, and family and colleagues for their support during the course of the project. ]", { italics: true, color: GREY }),
  new Paragraph({ children: [new PageBreak()] }),

  H1NB("Table of Contents"),
  P("This document uses automatic fields. To populate the contents and the lists below, select the whole document and press F9 in Microsoft Word.", { italics: true, size: 19, color: GREY, after: 240 }),
  new TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-3" }),
  new Paragraph({ children: [new PageBreak()] }),

  H1NB("List of Figures"),
  new TableOfContents("Figures", { hyperlink: true, captionLabel: "Figure" }),
  ...SPACER(1),
  H1NB("List of Tables"),
  new TableOfContents("Tables", { hyperlink: true, captionLabel: "Table" }),
];

/* ------------------------------------------------------------------ chapters 1-8 */
const ch1 = [
  H1("1.  Introduction"),
  H2("1.1  Overview"),
  P("ChargeHub is a proposed web-based reservation platform for an operator of multiple electric vehicle charging branches. It addresses a specific and increasingly common failure of everyday experience: a driver arrives at a charging station and finds no free connector, having had no way to secure one in advance. The platform allows a driver to reserve a named charger for a named time interval, and gives the operator the tools to publish, manage and measure that bookable capacity."),
  P("The system is deliberately scoped as a reservation platform rather than as a complete charging-network management suite. It reserves time at a charger; it does not process payment, meter energy, or control charging hardware. These boundaries are stated explicitly throughout this document, and each is revisited in Chapter 18 as a supported future extension rather than as an omission."),
  H2("1.2  Purpose of this document"),
  P("This proposal defines what the project will build, why the problem is worth solving, how the system will be structured, and how the work will be sequenced and evaluated. It is intended to be read by the project supervisor and the examining committee before implementation begins, and to serve afterwards as the reference against which the delivered system is assessed. Detailed interface contracts, database field definitions and test procedures are deliberately excluded; they belong to the System Specification, which will accompany the final submission."),
  H2("1.3  Structure of this document"),
  P("Chapters 2 to 4 establish the domain, the problem and the motivation. Chapter 5 states the objectives and the criteria by which each will be judged. Chapter 6 fixes the scope. Chapters 7 to 10 present the proposed solution, the system overview, the architecture and the data model, the last of which includes the entity relationship diagram. Chapters 11 and 12 state the functional and non-functional requirements. Chapters 13 to 17 cover the technology stack, the development methodology, the risk profile, the expected deliverables and the schedule. Chapter 18 describes future enhancements and their status, and Chapter 19 concludes."),
];

const ch2 = [
  H1("2.  Background"),
  H2("2.1  The charging context"),
  P("Charging an electric vehicle differs from refuelling a conventional one in two respects that matter for system design. First, it takes substantially longer, so a charging bay is occupied for a period measured in tens of minutes rather than in minutes. Second, compatibility is not universal: a charger exposes a particular connector standard — commonly CCS, CHAdeMO or Type 2 — and a vehicle can only use a charger that matches its own. A driver therefore needs to know not merely that a station exists, but that a compatible connector will be free at a usable time."),
  P("Because occupancy is long, contention is high relative to the number of physical bays. A station with a small number of chargers can be effectively unavailable for hours even though it appears on a map as present and operational. Public charging information services generally report location, connector type and, at best, a live occupancy signal. Live occupancy answers the question “is it free now”, which is of limited value to a driver who is thirty minutes away."),
  H2("2.2  Existing approaches"),
  P("Three approaches are common in practice. The first is unmanaged walk-up access, in which availability is discovered on arrival; this is simple to operate and offers the driver no certainty at all. The second is live status reporting, in which an application displays current occupancy; this improves information without changing the underlying contention, and its accuracy decays over the duration of a journey. The third is reservation, in which a specific bay is held for a specific driver for a specific period. Reservation is the only approach of the three that transfers certainty to the driver before travel, and it is the approach this project adopts."),
  P("Reservation, however, introduces an engineering obligation that the other two do not. If the system permits two drivers to hold the same interval, it has replaced an honest uncertainty with a false promise, which is worse than the problem it set out to solve. The integrity of the reservation is therefore not a quality attribute of this system; it is the system's primary functional requirement."),
  H2("2.3  Vehicle data fragmentation"),
  P("A reservation platform becomes considerably more useful when it knows the state of the vehicle: a driver whose battery is low needs different guidance from one whose battery is nearly full. There is, however, no universal interface for electric vehicle data. Each manufacturer exposes battery level, range, location and charging state through its own ecosystem, with its own authorisation flow, its own data shapes and its own operational constraints. A platform that integrates directly with one manufacturer acquires that manufacturer's model throughout its codebase, and must be substantially rewritten to support a second."),
  P("This fragmentation is a structural characteristic of the domain rather than a temporary inconvenience, and it therefore deserves an architectural response rather than an incremental one. The response adopted by this project is described in Section 7.3 and is one of the project's two principal contributions."),
];

const ch3 = [
  H1("3.  Problem Statement"),
  H2("3.1  The driver's problem"),
  P("A driver approaching a public charging network cannot establish, before travelling, that a compatible charger will be available on arrival. Availability is discovered at the bay, after the journey has been made and after the alternative options have been passed. When the bay is occupied the driver waits for an unpredictable period, queues behind other waiting vehicles, or continues to another station with the same uncertainty and a lower battery than before."),
  H2("3.2  The operator's problem"),
  P("An operator running several charging branches has no digital mechanism for shaping or observing demand. Capacity cannot be offered ahead of time, so demand that could have been distributed across the day arrives unmanaged. A charger taken out of service for maintenance cannot be communicated to drivers before they travel. Utilisation is inferred from anecdote rather than measured, and demand that failed to convert leaves no record at all, because a driver who arrives, finds the bay occupied and leaves is invisible to the operator."),
  H2("3.3  The concurrency problem"),
  P("Any system that resolves the two problems above by allocating bookable intervals inherits a classical concurrency problem. A reservable interval is a finite, discrete and non-shareable resource, and multiple clients may attempt to claim the same interval at effectively the same moment. An implementation that reads the interval, tests whether it is free and then writes the reservation contains a window between the test and the write in which a second request can pass the same test. The result is two drivers holding one bay — the precise failure the platform exists to prevent, now underwritten by an explicit promise."),
  P("The problem is therefore not to display availability, which is straightforward, but to allocate it correctly under contention, and to do so in a way that does not depend on the good behaviour of the application code alone."),
  H2("3.4  The integration problem"),
  P("Guidance based on vehicle state requires vehicle data, and vehicle data is only obtainable through manufacturer-specific interfaces that differ in authorisation, structure and availability. The problem is to obtain the benefit of that data without allowing any single manufacturer's model to propagate through the platform, and without making the addition of a second manufacturer a structural change."),
  H2("3.5  Consolidated statement"),
  RICH([
    { t: "The problem this project addresses is that charger availability is currently an expectation rather than a commitment. Converting it into a commitment requires a reservation system whose central allocation is provably correct under concurrent access, whose availability data is accurate and reproducible, and whose vehicle integration is independent of any single manufacturer.", b: true },
  ], { after: 160 }),
];

const ch4 = [
  H1("4.  Motivation"),
  H2("4.1  Practical motivation"),
  P("The number of electric vehicles in service continues to grow faster than the number of public charging points, which means contention at existing infrastructure increases rather than eases over the life of this system. Reservation is the mechanism by which a scarce and slow-to-release resource becomes a predictable service, and it benefits both parties: the driver gains certainty before travelling, and the operator gains a forward view of demand and a means of communicating maintenance in advance."),
  H2("4.2  Technical motivation"),
  P("The absence of a universal vehicle data interface makes manufacturer independence a genuine design problem rather than a matter of tidy code organisation. Treating that independence as an explicit architectural deliverable — a single interface, a runtime registry of implementations, and a persisted manufacturer identity — produces a system in which an integration is an addition rather than a rewrite. Demonstrating that property, with one real manufacturer implementation written against the published interface and a simulated implementation used for development, is a more durable outcome than a single hard-wired integration would be."),
  H2("4.3  Engineering motivation"),
  P("The reservation transaction is a well-defined instance of a problem that appears throughout software engineering: correct allocation of a finite resource among competing requestors. It admits a clear correct solution, a clear incorrect solution that appears to work under casual testing, and an unambiguous demonstration of the difference. Building the correct solution, placing the guarantee in the layer that can enforce it for every client, and being able to demonstrate a rejected duplicate claim is a concrete and assessable engineering contribution."),
  H2("4.4  Academic motivation"),
  P("The project exercises the full breadth of a software engineering curriculum in a single coherent system: requirements analysis, data modelling, service architecture, concurrency control, authentication and authorisation, interface design, and the discipline of scoping honestly. It also requires the student to distinguish between what a system does and what a system claims to do — a distinction this proposal maintains deliberately, and which Chapter 18 formalises."),
];

const ch5 = [
  H1("5.  Project Objectives"),
  H2("5.1  Primary objective"),
  RICH([{ t: "To design and implement a multi-station electric vehicle charging reservation platform in which a reserved interval is guaranteed to exactly one driver, availability is published and measured accurately, and vehicle integration is architecturally independent of any individual manufacturer.", b: true }], { after: 200 }),
  H2("5.2  Specific objectives"),
  P("The primary objective decomposes into eight specific objectives, each stated with the criterion by which its achievement will be judged."),
  T([620, 3600, 5140],
    ["Ref", "Objective", "Success criterion"],
    [
      ["O1", "Guarantee conflict-free reservation", "Two simultaneous claims on one interval result in exactly one reservation; the second is rejected by a database constraint, not only by application logic."],
      ["O2", "Enable self-service reservation", "A registered driver completes a reservation through a guided sequence in under two minutes on a mobile device."],
      ["O3", "Publish availability before travel", "Every active station is publicly viewable with live counts of free chargers, filterable by connector type and charging speed, without authentication."],
      ["O4", "Bridge the physical and digital network", "Scanning a charger's printed code resolves to that charger's live status and pre-selects it in the reservation sequence."],
      ["O5", "Provide operator control of capacity", "An operator can publish bookable inventory for a date range, change charger availability, and resolve reservations without developer involvement."],
      ["O6", "Achieve manufacturer independence", "A new manufacturer is supported by adding one implementation of the provider interface and one registry entry, with no change to route handlers, data models or interface screens."],
      ["O7", "Report accurately and reproducibly", "Every reported monetary figure is reproducible after a subsequent price change and is explicitly labelled as an estimate while payment processing is out of scope."],
      ["O8", "Protect driver data", "All private records are scoped to their owner; credentials are stored only as hashes; the service holds only the database privileges its operations require."],
    ],
    { boldCol: [0] }),
  tableCaption(1, "Specific objectives and their success criteria."),
];

const ch6 = [
  H1("6.  Project Scope"),
  H2("6.1  Committed scope"),
  P("The committed scope is the set of capabilities the project undertakes to deliver and against which it should be assessed. It is summarised below by subsystem."),
  T([2300, 7060],
    ["Subsystem", "Committed capability"],
    [
      ["Identity and access", "Driver registration and credential sign-in; two roles, driver and operator; protected areas; self-service profile management; revocable sessions."],
      ["Station discovery", "Public catalogue of active stations with address, geographic position, amenities, operating hours and imagery; live counts of available chargers; filtering by connector type and charging speed."],
      ["Charger catalogue", "Chargers belonging to stations, carrying connector type, power rating, unit price, availability status and a unique printed identifier."],
      ["Bookable inventory", "Discrete reservable intervals of thirty minutes, published by the operator across a date range, generated idempotently so that publication may be repeated safely."],
      ["Reservation", "Guided selection of station, charger, interval and vehicle; connector compatibility marking; cost estimation; indivisible claim; unique reservation code; cancellation with release of the interval."],
      ["Confirmation artefacts", "Reservation code, generated code image and downloadable calendar entry."],
      ["Vehicle management", "Per-driver vehicle garage with strict ownership isolation; connector type drives compatibility across the platform."],
      ["Vehicle integration architecture", "A uniform provider interface, a runtime registry, a simulated implementation for development, and one implementation written against a real manufacturer interface."],
      ["Guidance", "Charging recommendations derived from battery level, connector compatibility and distance; a deterministic assistant that answers from live platform data."],
      ["Messaging", "A per-driver message store with read and mark-as-read behaviour."],
      ["Operator console", "Dashboard with operational metrics and charts; network and charger management; reservation search and resolution; inventory publication; registered driver list; date-ranged reporting with export."],
      ["Public information", "Home page, guidance on how the service works, frequently asked questions, contact, terms and privacy pages."],
    ]),
  tableCaption(2, "Committed scope by subsystem."),
  H2("6.2  Explicitly out of scope"),
  P("The following are not part of the committed scope and will not be delivered by this project. They are listed here so that the boundary is unambiguous, and each is revisited in Chapter 18."),
  BUL("Payment processing, refunds and settled revenue. Reservations will carry a cost estimate only."),
  BUL("Energy metering and charging session records. The platform reserves time at a charger; it does not measure delivered energy."),
  BUL("Direct control of, or status reporting from, charging hardware. Charger availability is declared by the operator."),
  BUL("Live telemetry from manufacturer services. The integration architecture will be delivered and exercised through the simulated provider."),
  BUL("Automatic generation and external delivery of messages by electronic mail, short message service or push notification."),
  BUL("Scheduled background execution, and the capabilities that depend on it, including automatic inventory extension and reservation reminders."),
  BUL("Redemption of the reservation code at the bay as a check-in action."),
  BUL("Map-based station discovery, native mobile applications, and interfaces in languages other than English."),
  BUL("Delegated permissions for individual branch operators; the platform provides a single operator role."),
  H2("6.3  Assumptions"),
  BUL("The operator maintains an accurate catalogue of stations and chargers and publishes bookable inventory ahead of demand."),
  BUL("Drivers access the platform through a modern web browser on a desktop or mobile device with network connectivity."),
  BUL("Charger availability reported by the operator is the authoritative source of availability for the duration of this project."),
  BUL("A managed database service is available for development, evaluation and demonstration."),
  H2("6.4  Constraints"),
  BUL("The project is delivered by a single student developer within a fixed academic term."),
  BUL("Live manufacturer integration depends on external account approval that cannot be guaranteed within the project period; the architecture is therefore designed so that this dependency does not block delivery."),
  BUL("Both applications are implemented on a single web framework, so that the project does not carry the cost of an additional server technology."),
];

const ch7 = [
  H1("7.  Proposed Solution"),
  H2("7.1  Solution concept"),
  P("ChargeHub converts charger availability into a commitment by making capacity explicit and claimable. Every reservable interval at every charger exists as a discrete record before any driver reserves it. Reserving is therefore not a calculation over free time but the claiming of a specific, already-published unit of capacity. This choice makes availability a simple query, makes publication an operator-controlled and repeatable action, and — most importantly — reduces the reservation to the allocation of a single identifiable record, which is what allows the correctness guarantee described below."),
  H2("7.2  The reservation guarantee"),
  P("The platform's central commitment is that a reserved interval belongs to exactly one driver. Two mechanisms deliver it together."),
  P("The first is an indivisible claim. The transition of the interval from available to reserved, and the creation of the reservation that holds it, will occur as a single operation that either succeeds completely or does not occur at all. A request that arrives after the interval has been taken receives an explicit conflict response rather than a second reservation."),
  P("The second is a uniqueness constraint in the database on the reservation's reference to its interval. This places the guarantee in the layer that enforces it for every client and every code path, so that the correctness of the system does not rest on the correctness of the application logic alone. The two mechanisms are complementary: the first makes the correct outcome the normal outcome, and the second makes the incorrect outcome impossible."),
  P("This design is testable in a way that a purely procedural solution is not. Two simultaneous claims on one interval must produce one reservation and one rejection, and this will be demonstrated as part of the project's evaluation."),
  H2("7.3  Manufacturer-agnostic vehicle integration"),
  P("Because manufacturers expose vehicle data through incompatible interfaces, the platform will communicate with vehicles only through a single uniform interface defining the operations the platform actually needs: establish a connection, release a connection, read battery level, read remaining range, read location, read charging state and read vehicle identity."),
  P("Concrete implementations of that interface are resolved at run time from a registry keyed by manufacturer identity, and the manufacturer identity is persisted with each vehicle connection record. Two implementations will be delivered: a simulated provider that returns realistic values, used for development and demonstration, and one provider written against a real manufacturer's published interface. Supporting an additional manufacturer consists of writing one implementation and adding one registry entry; no route handler, data model or interface screen changes."),
  P("Critically, this layer resides in the application service rather than in the client, because manufacturer integration requires server-held credentials and token renewal. Placing it there is what makes the independence claim structurally true rather than merely stated."),
  H2("7.4  The physical bridge"),
  P("Each charger carries a unique identifier rendered as a printed code at the bay. Scanning it resolves publicly to that charger's live status — availability, connector type, power rating and unit price — and offers to begin a reservation with the station and charger already selected. This is the shortest path in the system from the physical network to a completed reservation, and it requires no prior knowledge of the platform."),
  P("A reservation also produces a code, presented on screen and as a generated image, which identifies the reservation to the driver and to staff. Automated redemption of that code at the bay is outside the committed scope and is discussed in Chapter 18."),
  H2("7.5  Guidance"),
  P("Two features help a driver choose. The recommendation component assesses, for each of the driver's vehicles, whether charging is becoming urgent based on battery level, then ranks stations by distance and selects the highest-powered compatible charger at the nearest qualifying station. The assistant answers natural-language questions — about the driver's reservations, the nearest station, the fastest available charger, current availability and charging advice — by performing real queries against live platform data."),
  P("The assistant is deterministic by design. It does not generate free text from a language model, and it therefore cannot state anything that is not present in the platform's data. This is presented as a deliberate design position rather than a limitation; the option to phrase the same grounded results using a language model is discussed in Chapter 18."),
  H2("7.6  Operator control"),
  P("The operator console gives the operator direct control of the variables that determine service: which chargers are available, how much bookable capacity exists and over what period, and how individual reservations are resolved. It also provides the measurement the operator currently lacks, through operational metrics, charts of reservation activity and per-station utilisation, and date-ranged reports that can be exported for external analysis."),
];

const ch8 = [
  H1("8.  System Overview"),
  H2("8.1  Users and roles"),
  T([1700, 3200, 4460],
    ["Role", "Description", "Principal responsibilities"],
    [
      ["Driver", "An electric vehicle owner using the public and authenticated areas of the platform.", "Discover stations; maintain a vehicle garage; reserve, review and cancel reservations; consult guidance."],
      ["Operator", "Staff of the charging network with administrative authority over the whole network.", "Maintain the station and charger catalogue; publish bookable inventory; set charger availability; resolve reservations; produce reports."],
      ["Visitor", "An unauthenticated user, including one arriving by scanning a code at a bay.", "Browse stations and charger status; view public information; register in order to reserve."],
    ]),
  tableCaption(3, "User roles and responsibilities."),
  H2("8.2  The driver journey"),
  P("A visitor discovers the network publicly, either by browsing stations and filtering by the connector their vehicle uses, or by scanning the code on a charger and arriving directly at that bay's status page. To reserve, they register an account and add a vehicle; the vehicle's connector type then governs compatibility throughout the platform. They may optionally connect the vehicle to its manufacturer so that battery level and range are reflected in the interface."),
  P("The driver chooses a station themselves, asks the assistant, or consults recommendations, then proceeds through a guided sequence: station, charger, interval, vehicle, confirmation. Incompatible chargers are marked, and an estimated cost is shown before the commitment is made. On confirmation the driver receives a reservation code, a code image and a calendar entry, travels to the station and charges. Reservations can be reviewed and cancelled at any time, and cancelling returns the interval to the available pool for another driver."),
  H2("8.3  The operator journey"),
  P("The operator signs in to a dashboard summarising reservation volume over several periods, active chargers against total chargers, estimated revenue and registered drivers, together with charts of reservation activity, reservation status distribution and per-station utilisation. From the network view they inspect every station and charger and set charger availability directly."),
  P("The operator then publishes bookable inventory for a charger across a date range. Because publication is idempotent, it may be repeated over overlapping ranges without creating duplicates. This is the operator's most consequential recurring action, since inventory does not extend itself within the committed scope. Reservation search and status adjustment support day-to-day customer resolution, and the reporting screen produces date-ranged summaries for export."),
  H2("8.4  Subsystem summary"),
  P("The platform comprises twelve subsystems: identity and access, station discovery, charger catalogue, bookable inventory, reservation, confirmation artefacts, vehicle management, vehicle integration, recommendations, assistant, messaging, and the operator console with its reporting function. Their dependency structure is straightforward. Identity underpins everything except public discovery. Stations contain chargers, which contain intervals. The reservation is the transactional centre of the system, referencing the driver, the vehicle, the interval, the charger and the station, and it is the sole source of the operator's analytics and reporting."),
];

/* ------------------------------------------------------------------ chapter 9 */
const ch9 = [
  H1("9.  High-Level Architecture"),
  H2("9.1  Architectural overview"),
  P("The system adopts a three-tier architecture: a server-rendered client application, a headless application programming interface service, and a managed document database. The two application tiers are implemented on the same web framework, which removes an additional server technology from the project without collapsing the boundary between them."),
  figure("fig1_architecture.png", 6.2),
  figCaption("High-level system architecture and the boundaries between tiers."),
  H2("9.2  Separation of responsibilities"),
  P("The client application holds no database access whatsoever. Every read and every write crosses the service boundary. This is the single most consequential structural decision in the architecture: it keeps the service reusable by any future client, including a native mobile application or a third-party integration, and it prevents data-access logic from accumulating in the presentation layer."),
  P("The service is organised in layers. Route handlers remain thin and are responsible for parsing the request, authorising it and delegating; domain services hold business rules; data models describe the persisted structures. Cross-cutting concerns — authorisation, response shaping and cross-origin handling — are each implemented once and used by every operation, which is what makes it practical to introduce a change such as boundary validation uniformly."),
  H2("9.3  Request flow"),
  P("A driver signs in through the client, which delegates credential verification to the service and stores the credential the service issues. Every subsequent data operation attaches that credential as a bearer token and crosses to the service, which verifies it, establishes the caller's identity and role, authorises the specific operation, and delegates to a service or model. Responses return in a uniform shape, and errors return a uniform contract of status codes so that the client can distinguish an authorisation failure from a validation failure from a conflict."),
  H2("9.4  Security architecture"),
  BULR([{ t: "Credential storage. ", b: true }, { t: "Passwords are stored only as cryptographic hashes and are never returned by any operation." }]),
  BULR([{ t: "Session credentials. ", b: true }, { t: "The service issues a signed bearer credential carrying identity and role, with a bounded lifetime and the ability to be invalidated before expiry." }]),
  BULR([{ t: "Authorisation. ", b: true }, { t: "Two tiers — any authenticated driver, and the operator role — are applied per operation. Private records are additionally scoped to their owner as part of the operation itself rather than by a separate preceding check." }]),
  BULR([{ t: "Input validation. ", b: true }, { t: "Requests are validated at the service boundary, so that validation does not exist solely in the layer the client controls, and write operations accept only the fields they are intended to change." }]),
  BULR([{ t: "Database privilege. ", b: true }, { t: "The service authenticates to the database with read and write authority over a single database only, matching the privileges its operations actually require." }]),
  BULR([{ t: "Public surface. ", b: true }, { t: "Station, charger and availability information is deliberately readable without authentication, since a driver must be able to assess the network before registering. No unauthenticated operation exposes infrastructure state or bulk personal data." }]),
  H2("9.5  Key design decisions"),
  T([2500, 3400, 3460],
    ["Decision", "Rationale", "Consequence"],
    [
      ["A single framework for both applications", "Avoids a second server technology and a second deployment model for a project of this size.", "Lower operational cost; the client/service boundary is preserved by discipline rather than by technology."],
      ["No database access in the client", "Keeps the service reusable by future clients and prevents data logic leaking into the presentation layer.", "Every operation must be exposed deliberately through the service interface."],
      ["Pre-materialised bookable intervals", "Availability becomes a simple query, and reservation becomes the claim of one identifiable record.", "Inventory must be published ahead of demand; publication is made idempotent to keep this safe."],
      ["Provider layer in the service", "Manufacturer integration requires server-held credentials and renewal, which cannot run in a browser.", "Manufacturer independence is structural rather than nominal."],
      ["Uniqueness constraint on the reservation's interval", "Places the platform's central guarantee in the layer that enforces it for all clients.", "The guarantee survives application defects and future code paths."],
      ["Denormalised references on the reservation", "Avoids repeated multi-step resolution when listing reservations.", "A small, deliberate duplication accepted for read efficiency."],
    ]),
  tableCaption(4, "Principal architectural decisions and their consequences."),
];

/* ------------------------------------------------------------------ chapter 10 (with landscape ERD) */
const ch10a = [
  H1("10.  Data Model and Entity Relationship Diagram"),
  H2("10.1  Modelling approach"),
  P("The platform stores its data in a document database. The model favours explicit references between collections over deep nesting, because the principal entities — drivers, vehicles, stations, chargers, intervals and reservations — have independent lifecycles and are queried independently. Structures without an independent identity, such as a station's geographic position, its operating hours and its list of amenities, are embedded within their parent document."),
  P("Nine collections are proposed. Their attributes, keys, constraints and relationships are shown in the entity relationship diagram on the following page. Attributes shown in amber are those introduced specifically to support the guarantees described in this proposal."),
];

const erdPage = [
  figure("fig2_erd.png", 8.6),
  figCaption("Entity relationship diagram for the proposed system. The reservation is the transactional hub; its one-to-one relationship with a reservable interval is the invariant the platform exists to guarantee."),
];

const ch10b = [
  H2("10.2  Entities"),
  T([2150, 7210],
    ["Entity", "Purpose"],
    [
      ["USER", "Identity and authorisation root. Anchors every private record in the system and carries the role that distinguishes a driver from an operator."],
      ["VEHICLE", "A driver's electric vehicle. Its connector type governs charger compatibility; its battery level and range inform guidance."],
      ["VEHICLE_CONNECTION", "The link between a vehicle and a manufacturer's data service, holding the manufacturer identity and the credentials that would authorise access."],
      ["STATION", "A physical charging location with address, geographic position, amenities, operating hours and imagery."],
      ["CHARGER", "An individual charge point belonging to a station, carrying connector type, power rating, unit price, availability status and the unique identifier printed at the bay."],
      ["SLOT", "A discrete reservable interval at a charger. The unit of bookable capacity and the resource the platform allocates."],
      ["RESERVATION", "The transactional record holding one interval for one driver, with its own code, lifecycle and cost basis."],
      ["NOTIFICATION", "A per-driver message store with a typed classification and a read state."],
      ["SITE_CONTENT", "Presentation content for the public home page. The only entity with no relationships."],
    ],
    { boldCol: [0] }),
  tableCaption(5, "Proposed entities and their purpose."),
  H2("10.3  Relationships and cardinality"),
  T([3400, 1500, 4460],
    ["Relationship", "Cardinality", "Notes"],
    [
      ["USER to VEHICLE", "1 : N", "A driver may register several vehicles."],
      ["USER to RESERVATION", "1 : N", "Ownership of every reservation is scoped to the driver who created it."],
      ["USER to NOTIFICATION", "1 : N", "Messages are private to their recipient."],
      ["USER to VEHICLE_CONNECTION", "1 : N", "Denormalised for direct owner scoping without traversal."],
      ["VEHICLE to VEHICLE_CONNECTION", "1 : 1", "Enforced by a uniqueness constraint so that concurrent connection attempts cannot fork credential state."],
      ["VEHICLE to RESERVATION", "1 : N", "The vehicle is recorded with the reservation and must belong to the requesting driver."],
      ["STATION to CHARGER", "1 : N", "Strict containment matching the physical network."],
      ["CHARGER to SLOT", "1 : N", "Each charger has its own published intervals."],
      ["SLOT to RESERVATION", "1 : 1", "The platform's central invariant, enforced by a uniqueness constraint."],
      ["CHARGER, STATION to RESERVATION", "1 : N", "Denormalised references retained so that listing reservations does not require multi-step resolution."],
    ]),
  tableCaption(6, "Relationships and cardinality in the proposed model."),
  P("No many-to-many relationship appears in the model, and none is required. Every relationship is either hierarchical or one-to-one. The reservation, although it references five other entities, is not a junction: it is a first-class transaction with its own identity, code, lifecycle and financial attributes."),
  H2("10.4  Integrity constraints"),
  P("Five constraints are proposed at the database level, each chosen because the property it protects must hold regardless of which code path performs the write."),
  BULR([{ t: "Reservation to interval, unique. ", b: true }, { t: "The constraint that makes the platform's central promise enforceable rather than merely intended." }]),
  BULR([{ t: "Charger and interval start, unique. ", b: true }, { t: "Makes inventory publication idempotent, so that an operator may repeat publication over an overlapping range without creating duplicate capacity." }]),
  BULR([{ t: "Connection to vehicle, unique. ", b: true }, { t: "Guarantees a single manufacturer connection per vehicle." }]),
  BULR([{ t: "Account electronic mail address, unique. ", b: true }, { t: "Prevents duplicate registration." }]),
  BULR([{ t: "Reservation code and charger identifier, unique. ", b: true }, { t: "Guarantees that a code presented by a driver, or scanned at a bay, resolves to exactly one record." }]),
  P("A geospatial index is proposed on the station's position. Distance-based ranking in the committed scope is computed in the service; the index is provisioned so that proximity querying can later be introduced as a change of query rather than a change of schema."),
  H2("10.5  A model designed for extension"),
  P("Three characteristics of the model are chosen with future capability in mind and are worth stating explicitly, because they are what make the enhancements in Chapter 18 additive rather than structural."),
  BUL("The manufacturer identity persisted on a vehicle connection is the same set of values used by the provider registry, so an additional manufacturer requires no schema change."),
  BUL("Station operating hours are modelled and stored even though inventory publication in the committed scope uses a fixed daily window, so that hours-driven publication requires no migration."),
  BUL("The message store is complete and self-contained, so that automatic message generation, when introduced, adds a producer rather than a schema."),
  P("The entities anticipated by future work, and the points at which they attach to the delivered model, are shown below."),
  figure("fig3_future.png", 6.2),
  figCaption("Future-ready extension points and their attachment to the proposed model."),
];

/* ------------------------------------------------------------------ chapters 11-12 */
const ch11 = [
  H1("11.  Functional Requirements"),
  P("Requirements are grouped by the actor they serve. Each is stated as an obligation on the delivered system and is testable."),
  H2("11.1  Driver requirements"),
  T([760, 3200, 5400],
    ["Ref", "Requirement", "Description"],
    [
      ["FR-D1", "Registration", "A visitor shall create an account with name, electronic mail address and password. Passwords shall be stored only as hashes."],
      ["FR-D2", "Authentication", "A registered driver shall sign in and receive a session valid for a bounded period."],
      ["FR-D3", "Station discovery", "A visitor shall browse all active stations with live counts of available chargers, without authentication."],
      ["FR-D4", "Filtering", "A visitor shall filter stations by connector type and by charging speed."],
      ["FR-D5", "Station detail", "A visitor shall view a station's address, position, amenities, operating hours and full charger list."],
      ["FR-D6", "Code resolution", "Scanning a charger's printed code shall resolve publicly to that charger's live status and offer to begin a reservation with it pre-selected."],
      ["FR-D7", "Vehicle management", "A driver shall add, amend and remove vehicles. All vehicle records shall be visible and modifiable only by their owner."],
      ["FR-D8", "Manufacturer connection", "A driver shall link a vehicle to a manufacturer identity and request a refresh of its battery level and range."],
      ["FR-D9", "Reservation", "A driver shall select a station, a compatible charger, an available interval and one of their own vehicles, and confirm a reservation."],
      ["FR-D10", "Compatibility marking", "Chargers incompatible with the selected vehicle's connector shall be visibly marked before selection."],
      ["FR-D11", "Cost estimation", "An estimated cost shall be presented before the reservation is confirmed, and labelled as an estimate."],
      ["FR-D12", "Confirmation artefacts", "On confirmation the driver shall receive a unique reservation code, a code image and a downloadable calendar entry."],
      ["FR-D13", "Reservation management", "A driver shall view upcoming, past and cancelled reservations and cancel an upcoming reservation."],
      ["FR-D14", "Cancellation release", "Cancelling a reservation shall return its interval to the available pool."],
      ["FR-D15", "Recommendations", "The system shall recommend, for each of the driver's vehicles, the most suitable compatible charger based on battery level and distance."],
      ["FR-D16", "Assistant", "The system shall answer natural-language questions about reservations, availability, nearest and fastest chargers and charging advice, using live platform data only."],
      ["FR-D17", "Messages", "A driver shall read their messages and mark one or all as read."],
    ],
    { boldCol: [0] }),
  tableCaption(7, "Functional requirements — driver."),
  H2("11.2  Operator requirements"),
  T([760, 3200, 5400],
    ["Ref", "Requirement", "Description"],
    [
      ["FR-O1", "Protected console", "The operator console shall be reachable only by an authenticated user holding the operator role."],
      ["FR-O2", "Operational dashboard", "The console shall present reservation volume over several periods, active and total chargers, estimated revenue and registered driver count."],
      ["FR-O3", "Activity charts", "The console shall present reservation activity over time, reservation status distribution and per-station utilisation."],
      ["FR-O4", "Network management", "The operator shall view every station and charger and create and amend catalogue records."],
      ["FR-O5", "Availability control", "The operator shall set the availability status of any charger."],
      ["FR-O6", "Inventory publication", "The operator shall publish reservable intervals for a charger over a date range; repeating publication shall not create duplicates."],
      ["FR-O7", "Reservation resolution", "The operator shall search and filter all reservations and adjust reservation status within the permitted lifecycle."],
      ["FR-O8", "Driver list", "The operator shall view and search registered drivers."],
      ["FR-O9", "Reporting", "The operator shall produce a summary for a chosen date range, including volume, estimated revenue, cancellation rate and per-station breakdown."],
      ["FR-O10", "Export", "The operator shall export the report to a portable delimited file with monetary values labelled as estimates."],
    ],
    { boldCol: [0] }),
  tableCaption(8, "Functional requirements — operator."),
  H2("11.3  System requirements"),
  T([760, 3200, 5400],
    ["Ref", "Requirement", "Description"],
    [
      ["FR-S1", "Exclusive claim", "The transition of an interval to reserved and the creation of its reservation shall occur as a single indivisible operation."],
      ["FR-S2", "Constraint backing", "A uniqueness constraint in the database shall make a second reservation on the same interval impossible."],
      ["FR-S3", "Conflict response", "A request for an interval already taken shall receive an explicit conflict response and shall not create a reservation."],
      ["FR-S4", "Ownership verification", "A reservation shall be created only with a vehicle belonging to the requesting driver."],
      ["FR-S5", "Field discipline", "Every write operation shall accept only the fields it is intended to change."],
      ["FR-S6", "Lifecycle enforcement", "Reservation status shall change only along permitted transitions; a cancelled reservation shall not return to confirmed once its interval has been released."],
      ["FR-S7", "Cost basis", "Each reservation shall record the unit price and power rating applied at the time it was made, so that its cost remains reproducible after later price changes."],
      ["FR-S8", "Estimate labelling", "Every monetary figure presented or exported shall be labelled as an estimate while payment processing remains out of scope."],
      ["FR-S9", "Inventory consistency", "Every interval marked reserved shall correspond to exactly one live reservation, and every live reservation shall hold exactly one interval."],
      ["FR-S10", "Session invalidation", "The service shall be able to invalidate a session credential it has issued before that credential expires."],
      ["FR-S11", "Provider resolution", "Vehicle connection and refresh operations shall obtain data only through a provider resolved at run time from the registry."],
    ],
    { boldCol: [0] }),
  tableCaption(9, "Functional requirements — system."),
];

const ch12 = [
  H1("12.  Non-Functional Requirements"),
  T([760, 2000, 6600],
    ["Ref", "Attribute", "Requirement"],
    [
      ["NFR-1", "Correctness", "The reservation allocation shall be correct under concurrent access, verified by a test in which simultaneous claims on one interval produce exactly one reservation."],
      ["NFR-2", "Data integrity", "Every reference between records shall resolve; the invariant between reserved intervals and live reservations shall hold exactly."],
      ["NFR-3", "Confidentiality", "Private records shall be accessible only to their owner or to the operator role. Credentials shall never be transmitted in readable form."],
      ["NFR-4", "Least privilege", "The service shall hold only the database privileges its operations require."],
      ["NFR-5", "Idempotence", "Inventory publication shall be repeatable without duplication or loss."],
      ["NFR-6", "Usability", "A registered driver shall complete a reservation in under two minutes on a mobile device without instruction."],
      ["NFR-7", "Responsiveness", "All screens shall adapt to desktop and mobile viewports. The code-scan landing page shall be designed for narrow screens, since it is reached by a phone camera."],
      ["NFR-8", "Discoverability", "Public pages shall be server-rendered with descriptive metadata so that the network is indexable by search engines."],
      ["NFR-9", "Consistency", "The interface shall use a single design system of shared tokens and components across public, driver and operator areas."],
      ["NFR-10", "Maintainability", "Business rules shall reside in service modules rather than in request handlers, and cross-cutting concerns shall be implemented once."],
      ["NFR-11", "Extensibility", "Support for an additional manufacturer shall require one new provider implementation and one registry entry, with no other change."],
      ["NFR-12", "Portability", "The service shall be usable by any client capable of presenting a bearer credential, including a future mobile application."],
      ["NFR-13", "Accessibility", "Screens shall use semantic structure, labelled form controls and keyboard-operable interaction. No formal conformance claim is made within this project."],
      ["NFR-14", "Observability", "Failures shall be recorded on the server with sufficient context for diagnosis, and shall not expose internal detail to the client."],
    ],
    { boldCol: [0] }),
  tableCaption(10, "Non-functional requirements."),
];

/* ------------------------------------------------------------------ chapters 13-17 */
const ch13 = [
  H1("13.  Technology Stack"),
  T([2000, 2600, 4760],
    ["Layer", "Technology", "Justification"],
    [
      ["Client application", "Next.js with React", "Server rendering for public discoverability; route grouping cleanly separates public, driver and operator areas; a single framework across both tiers."],
      ["Application service", "Next.js, headless", "Provides routing, request handling and deployment for the service without introducing a second server technology into the project."],
      ["Language", "TypeScript", "Static typing across both applications; models and interface contracts are checked at compile time."],
      ["Database", "MongoDB (managed service)", "The document model matches naturally nested station, charger and interval data; uniqueness constraints and geospatial indexing are available natively."],
      ["Data access", "Mongoose object modelling", "Schema definition, referential population and index declaration in one place, close to the models they describe."],
      ["Session management", "NextAuth with a service-issued credential", "Session handling in the client combined with a portable credential the service can verify independently of any client."],
      ["Password hashing", "bcrypt", "Established adaptive hashing with a tunable work factor."],
      ["Validation", "Zod schemas", "One schema definition usable at the service boundary and in client forms."],
      ["Styling", "Tailwind CSS with design tokens", "A consistent visual system without a separate component framework."],
      ["Charting", "Recharts", "Declarative charts for the operator dashboard, consistent with the component model."],
      ["Code generation", "QR code library", "Generation of the charger and reservation code images."],
      ["Version control", "Git with a hosted repository", "Branch-per-feature history and a reviewable record of the work."],
    ]),
  tableCaption(11, "Proposed technology stack and justification."),
  H2("13.1  Deliberate exclusions"),
  P("The following are deliberately not adopted, and the reasons are recorded so that the choices are visible: a global client state library, because component-local and session state are sufficient at this scale; a payment gateway, because payment processing is out of scope; a scheduling service, because the committed scope contains no background execution; a mapping library, because map-based discovery is a future enhancement; and a language model provider, because the assistant is deterministic by design."),
];

const ch14 = [
  H1("14.  Development Methodology"),
  H2("14.1  Approach"),
  P("The project follows an iterative and incremental methodology. Requirements and architecture are established first, because the data model and the reservation guarantee constrain everything built afterwards. Development then proceeds in vertical increments, each delivering a working slice through all three tiers rather than a horizontal layer, so that every increment is demonstrable and testable in its own right."),
  P("The approach is chosen for a single-developer project with a fixed deadline and a supervisor review cycle. A fully sequential method would defer all integration risk to the end; a fully agile method with short formal ceremonies would impose overhead disproportionate to a team of one. Iterative increments with supervisor checkpoints at the end of each phase provide feedback without that overhead."),
  H2("14.2  Development phases"),
  T([1400, 3200, 4760],
    ["Phase", "Focus", "Principal activities"],
    [
      ["1", "Requirements and domain analysis", "Domain study; actor and use-case identification; requirements elicitation and specification; success criteria."],
      ["2", "System and database design", "Architecture definition; entity relationship model; constraint and index design; interface contract design."],
      ["3", "Core platform", "Identity and access; station and charger catalogue; bookable inventory publication; public discovery."],
      ["4", "Reservation and code subsystems", "Guided reservation sequence; indivisible claim and constraint; confirmation artefacts; charger code resolution."],
      ["5", "Vehicle, guidance and operator console", "Vehicle garage; provider interface, registry and implementations; recommendations; assistant; operator console and reporting."],
      ["6", "Integrity hardening and verification", "Concurrency verification; boundary validation; ownership and lifecycle enforcement; data consistency checks; security review."],
      ["7", "Documentation and specification", "System specification; interface documentation; user guidance; this proposal updated to final form."],
      ["8", "Evaluation and submission", "Functional and usability evaluation; demonstration rehearsal; final report and submission."],
    ],
    { boldCol: [0] }),
  tableCaption(12, "Development phases and principal activities."),
  H2("14.3  Verification approach"),
  P("Verification is treated as project work rather than as an activity that follows it. Each phase carries an explicit exit criterion, and a phase is not considered complete until that criterion is demonstrated."),
  BUL("Reservation correctness is verified by concurrent claim testing: simultaneous claims on one interval must yield exactly one reservation and one explicit rejection."),
  BUL("Data isolation is verified by attempting cross-account access to vehicles, reservations and messages, each of which must be refused."),
  BUL("Inventory consistency is verified by reconciliation: the number of intervals marked reserved must equal the number of intervals held by live reservations."),
  BUL("Reproducibility of reported figures is verified by comparing a reported total before and after an operator price change; the historical figure must not move."),
  BUL("Interface behaviour is verified by walking the complete driver and operator journeys on both desktop and mobile viewports."),
  H2("14.4  Development practice"),
  P("Work is tracked in a version-controlled repository with one branch per feature and descriptive commits, so that the history itself documents the sequence of development. Business rules are placed in service modules rather than in request handlers, both for testability and so that future cross-cutting behaviour has an obvious place to attach. Documentation is updated at the end of each phase rather than at the end of the project, to prevent the specification drifting from the delivered system."),
];

const ch15 = [
  H1("15.  Risk Assessment"),
  P("Risks are assessed by likelihood and by impact on the project's ability to meet its objectives. The mitigation column states the action already planned into the schedule rather than an intention."),
  T([2500, 900, 900, 5060],
    ["Risk", "Likelihood", "Impact", "Mitigation"],
    [
      ["Reservation allocation proves incorrect under concurrency", "Low", "Critical", "The guarantee is placed in the database as a uniqueness constraint rather than relying on application logic alone; concurrent claim testing is an explicit exit criterion of Phase 6."],
      ["Manufacturer integration cannot be validated within the project period", "High", "Low", "The architecture, not the integration, is the deliverable. The simulated provider exercises every path end to end, and the dependency is disclosed rather than concealed."],
      ["Guidance features consume data of limited fidelity while integration is simulated", "High", "Low", "The simulated nature of vehicle telemetry is stated in the interface, in the documentation and during evaluation."],
      ["Scope expands during development", "Medium", "High", "Chapter 6 fixes the committed scope and Chapter 18 holds every additional idea as an explicitly optional enhancement subject to remaining time."],
      ["Bookable inventory is exhausted during evaluation", "Medium", "High", "Inventory publication is verified as a standing item on the pre-demonstration checklist, since inventory does not extend itself within the committed scope."],
      ["Data reset before demonstration discards prepared state", "Medium", "High", "Reset procedures are documented with their consequences, and any reset is followed by a defined re-preparation sequence."],
      ["Security misconfiguration of the database or service", "Medium", "High", "Least-privilege database credentials, boundary validation and a security review are scheduled explicitly within Phase 6."],
      ["Single-developer capacity and illness", "Medium", "Medium", "Buffer is reserved in the final phase; optional enhancements are ranked so that scope is reduced from a known list rather than improvised."],
      ["Managed database service interruption", "Low", "Medium", "Local development configuration and regular exports of evaluation data are maintained."],
      ["Underestimated effort in the operator console", "Medium", "Medium", "The console is scheduled in Phase 5 with reporting last, so that reduced functionality degrades reporting depth rather than operational control."],
    ]),
  tableCaption(13, "Risk assessment matrix."),
  H2("15.1  Principal risks"),
  P("Two risks deserve particular attention. The first is the correctness of the reservation allocation, which is the only risk in the table whose impact is rated critical: if the platform allows a double allocation it has failed at its primary purpose, and the failure is not visible under casual testing. This is why the guarantee is placed in the database and why its verification is an explicit exit criterion rather than an assumed property."),
  P("The second is the external dependency on manufacturer integration, which is rated high in likelihood and deliberately low in impact. The project's contribution is the architecture that makes integration a configuration step, and that contribution is delivered and demonstrable whether or not access to a live manufacturer account is granted within the academic term. Structuring the work so that an uncontrollable external dependency cannot block the deliverable is itself a design decision."),
];

const ch16 = [
  H1("16.  Expected Deliverables"),
  T([2600, 6760],
    ["Deliverable", "Description"],
    [
      ["Client application", "A responsive, server-rendered web application comprising the public information and discovery pages, the authentication pages, the driver area including the reservation sequence and vehicle garage, and the operator console."],
      ["Application service", "A headless programming interface covering identity, stations, chargers, inventory, reservations, vehicles, vehicle connections, recommendations, the assistant, messages, code resolution, site content and operator statistics."],
      ["Database implementation", "The nine-collection model with its uniqueness constraints, supporting indexes and geospatial index, together with a data preparation script for evaluation."],
      ["Vehicle provider layer", "The uniform provider interface, the runtime registry, a simulated implementation and one implementation written against a real manufacturer interface."],
      ["Verification evidence", "Results of concurrency, isolation, consistency and reproducibility verification, including the concurrent claim demonstration."],
      ["System specification", "Detailed entity definitions, interface contracts, workflow descriptions and design decisions."],
      ["Final project report", "The completed academic report including design rationale, implementation account, evaluation and critical reflection."],
      ["Demonstration", "A prepared walkthrough of the driver journey, the code-scan path, the reservation guarantee, the operator console and the extension architecture."],
      ["Source repository", "The complete version-controlled history of the work with configuration and setup documentation."],
    ],
    { boldCol: [0] }),
  tableCaption(14, "Expected deliverables."),
];

const ch17 = [
  H1("17.  Project Timeline"),
  P("The schedule below is indicative and assumes a fourteen-week development period alongside concurrent coursework. Phases overlap where an activity does not depend on the completion of the preceding one; documentation in particular runs alongside the final development phases rather than after them."),
  figure("fig4_timeline.png", 6.2),
  figCaption("Indicative project schedule across the development period."),
  H2("17.1  Milestones"),
  T([1200, 4100, 4060],
    ["Week", "Milestone", "Evidence of completion"],
    [
      ["2", "Requirements baseline agreed", "Requirements and success criteria reviewed with the supervisor."],
      ["3", "Architecture and data model fixed", "Entity relationship model, constraint set and interface contracts approved."],
      ["6", "Core platform operating", "Identity, catalogue, inventory publication and public discovery demonstrable end to end."],
      ["8", "Reservation guarantee demonstrable", "A concurrent claim on one interval is rejected; the complete reservation journey operates."],
      ["10", "Feature-complete against committed scope", "Vehicle architecture, guidance and operator console operating; all functional requirements addressed."],
      ["11", "Integrity and security verification complete", "All Phase 6 exit criteria met and recorded."],
      ["12", "Specification complete", "System specification and interface documentation finalised."],
      ["14", "Submission", "Final report, source repository and demonstration prepared and delivered."],
    ],
    { boldCol: [0] }),
  tableCaption(15, "Project milestones and evidence of completion."),
];

/* ------------------------------------------------------------------ chapter 18: future enhancements */
const ch18 = [
  H1("18.  Future Enhancements"),
  H2("18.1  Status of this chapter"),
  P("The capabilities described in this chapter are architectural extensions of the proposed system. Their status is defined precisely as follows, and this definition applies to every item in the chapter without exception."),
  RICH([
    { t: "These enhancements are intentionally supported by the proposed architecture. They are not mandatory for the successful completion of the current project. They may be implemented before submission if sufficient development time remains once the committed scope in Chapter 6 is complete and verified. Otherwise they remain part of the planned future roadmap, and their absence is a scope decision rather than an incompleteness.", b: true },
  ], { after: 160 }),
  P("None of these capabilities is claimed as implemented, and none should be read as a commitment of this project. They are documented here because the architecture reserves space for each of them, and because that reservation is itself a design outcome: it is what prevents each future capability from requiring the delivered system to be rebuilt."),
  H2("18.2  Enhancements and their attachment points"),
  T([2500, 3600, 3260],
    ["Enhancement", "Existing structure it attaches to", "Nature of the work"],
    [
      ["Live manufacturer integration", "The uniform provider interface, the runtime registry and the persisted manufacturer identity.", "Replace the simulated provider with a live one; add credential renewal and protection."],
      ["Additional vehicle manufacturers", "The same registry; the manufacturer identity values are already modelled.", "One provider implementation and one registry entry per manufacturer."],
      ["Improved recommendation intelligence", "The existing recommendation component and the provisioned geospatial index.", "Add driver position, availability awareness and historical preference to the existing ranking."],
      ["Automatic and smart messaging", "The message store, which is complete and self-contained.", "Introduce a producer that raises messages from platform events; add delivery channels."],
      ["Payment gateway", "The reservation record and its captured cost basis.", "Add a transaction entity; replace estimated figures with settled ones."],
      ["Hardware and protocol integration", "The charger availability attribute.", "Introduce machine-reported status with a defined precedence over operator-declared status."],
      ["Advanced analytics", "The reservation record and published inventory.", "Introduce database-side aggregation, true utilisation measurement and demand forecasting."],
      ["Reservation code redemption", "The existing code resolution path.", "Add a redemption record and a reservation state transition at the bay."],
      ["Scheduled execution", "Inventory publication and reservation lifecycle.", "Introduce a scheduling mechanism enabling automatic publication, reminders and closure."],
      ["Map-based discovery", "The stored geographic position and geospatial index.", "Add a map interface; convert distance ranking to a spatial query."],
      ["Multi-branch operator roles", "The account role attribute.", "Introduce an organisation entity and delegated permissions."],
      ["Localisation", "The presentation layer.", "Externalise interface text and add right-to-left support."],
    ],
    { boldCol: [0] }),
  tableCaption(16, "Future enhancements and the structures that support them."),
  H2("18.3  Notes on selected enhancements"),
  H3("18.3.1  Live manufacturer integration"),
  P("The provider interface delivered by this project defines every operation a live integration requires, and one implementation will be written against a real manufacturer's published interface. What the project does not undertake is the exchange of live credentials with that manufacturer, because it depends on external account approval outside the student's control. Should approval be obtained during the project period, the integration would consist of supplying credentials and selecting the live provider rather than modifying the system. One precondition is recorded here deliberately: credentials must be protected at rest before any live credential is stored, never afterwards."),
  H3("18.3.2  Improved recommendation intelligence"),
  P("The recommendation component in the committed scope ranks by battery urgency, connector compatibility and distance from a fixed reference position. Three improvements are anticipated and none requires redesign: accepting the driver's actual position, which converts distance ranking into a spatial query against an index already provisioned; consulting published inventory so that a recommendation reflects genuinely bookable capacity; and incorporating historical preference. Each changes the inputs to the ranking rather than the ranking itself."),
  H3("18.3.3  Smart notifications"),
  P("The message store, its typed classification and its read behaviour are part of the committed scope. What is not is automatic generation: within this project, messages are not raised by platform events. The enhancement introduces a producer that raises messages when a reservation is confirmed or cancelled, when a battery falls low or when a reservation approaches, together with delivery beyond the application itself. Time-based messages additionally require the scheduling mechanism described in the same table."),
  H3("18.3.4  Payment, metering and hardware"),
  P("These three form a single coherent direction and are best considered together. Payment processing would attach a transaction record to the reservation and would replace estimated revenue with settled revenue. Energy metering would introduce a charging session capturing actual start, finish and delivered energy. Hardware integration would allow the charger itself to report availability. Metering is the pivotal capability of the three: once a session is measured, revenue becomes actual rather than estimated, availability becomes observed rather than declared, and utilisation becomes physical rather than inferred."),
  H3("18.3.5  Advanced analytics"),
  P("Reporting in the committed scope summarises reservation volume, estimated revenue, cancellation rate and per-station distribution over a chosen date range. The anticipated extensions are utilisation measured against published capacity rather than inferred from reservation counts, aggregation performed within the database rather than in the application, scheduled delivery of formatted reports, and demand forecasting. The last of these depends on metering, and is therefore the furthest of the enhancements from the delivered system."),
  H2("18.4  Conditions for inclusion"),
  P("If development time remains after the committed scope is complete and verified, enhancements will be considered in order of the value they add relative to the risk they introduce, and only where an enhancement can be completed and verified in full. A partially implemented enhancement is worse than an absent one, because it creates a discrepancy between what the system appears to offer and what it can be relied upon to do. Any enhancement adopted during the project will be reported in the final submission as delivered scope, and any enhancement not adopted will remain documented here as roadmap."),
];

const ch19 = [
  H1("19.  Conclusion"),
  P("This proposal has presented ChargeHub, a multi-station electric vehicle charging reservation platform intended to convert charger availability from an expectation into a commitment. The problem it addresses is concrete and increasingly common: drivers cannot secure a compatible charger before travelling, and operators cannot shape, communicate or measure the demand that results."),
  P("The proposed solution is a three-tier system comprising a server-rendered client, a headless application service and a document database of nine collections, delivering a complete driver journey from discovery through reservation to cancellation, and an operator console covering catalogue management, capacity publication, reservation resolution and reporting."),
  P("Two contributions distinguish the project from a conventional booking application. The first is correctness under contention: a reservable interval is allocated by an indivisible claim supported by a uniqueness constraint in the database, so that the platform's central promise is enforced by the layer that can guarantee it for every client and can be demonstrated by a rejected duplicate claim. The second is manufacturer independence: because no universal interface exists for electric vehicle data, the platform communicates with vehicles only through a uniform provider interface resolved at run time, so that supporting a further manufacturer is an addition rather than a redesign."),
  P("The scope has been fixed deliberately and stated without ambiguity. The system will not process payments, meter energy, control hardware, or generate messages automatically, and the assistant will answer only from data the platform holds. Each of these boundaries is revisited in Chapter 18 as an enhancement the architecture supports and reserves space for, explicitly not required for the successful completion of the project, and to be undertaken only if development time remains once the committed scope is complete and verified."),
  P("What the project offers, therefore, is not a large feature count but a system whose central guarantee is correct and provable, whose reported figures are reproducible, whose integration architecture is independent of any single external party, and whose stated scope matches what it delivers."),
];

const refs = [
  H1("References"),
  P("[ Placeholder — to be completed in accordance with the departmental citation style prior to final submission. ]", { italics: true, color: GREY }),
  ...SPACER(1),
  P("The final reference list will include sources in the following categories:", { after: 120 }),
  BUL("Electric vehicle adoption and public charging infrastructure statistics."),
  BUL("Charging connector standards and their characteristics."),
  BUL("Concurrency control and transaction isolation in database systems."),
  BUL("Document database data modelling, indexing and constraint design."),
  BUL("Web application architecture, service design and authentication practice."),
  BUL("Manufacturer fleet and vehicle data interface documentation."),
  BUL("Software engineering methodology, requirements engineering and risk management."),
  ...SPACER(2),
  new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { before: 400 },
    border: { top: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 10 } },
    children: [new TextRun({ text: "End of Project Proposal", font: BODY, size: 20, italics: true, color: GREY })],
  }),
];

/* ------------------------------------------------------------------ document assembly */
const portraitPage = {
  size: { width: 12240, height: 15840 },
  margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
};
const landscapePage = {
  size: { width: 12240, height: 15840, orientation: PageOrientation.LANDSCAPE },
  margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
};

const makeHeader = () => new Header({
  children: [new Paragraph({
    alignment: AlignmentType.RIGHT,
    spacing: { after: 60 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 6 } },
    children: [new TextRun({ text: "ChargeHub  ·  Software Engineering Project Proposal", font: BODY, size: 17, color: GREY })],
  })],
});
const makeFooter = () => new Footer({
  children: [new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "Page ", font: BODY, size: 17, color: GREY }),
               new TextRun({ children: [PageNumber.CURRENT], font: BODY, size: 17, color: GREY })],
  })],
});

const doc = new Document({
  creator: "Malik Halimeh",
  title: "ChargeHub — Software Engineering Project Proposal",
  description: "Project proposal for an EV charging station reservation platform.",
  styles: {
    default: {
      document: { run: { font: BODY, size: 22, color: "1A1A1A" }, paragraph: { spacing: { line: 276 } } },
    },
    paragraphStyles: [
      { id: "Caption", name: "Caption", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: BODY, size: 18, color: GREY, italics: false },
        paragraph: { spacing: { before: 100, after: 220 } } },
    ],
  },
  numbering: {
    config: [{
      reference: "bullets",
      levels: [{
        level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 400, hanging: 220 } },
                 run: { color: STEEL } },
      }],
    }],
  },
  sections: [
    { properties: { page: portraitPage, titlePage: false }, children: [...cover, ...abstract] },
    { properties: { page: portraitPage }, headers: { default: makeHeader() }, footers: { default: makeFooter() },
      children: [...ch1, ...ch2, ...ch3, ...ch4, ...ch5, ...ch6, ...ch7, ...ch8, ...ch9, ...ch10a] },
    { properties: { page: landscapePage }, headers: { default: makeHeader() }, footers: { default: makeFooter() },
      children: erdPage },
    { properties: { page: portraitPage }, headers: { default: makeHeader() }, footers: { default: makeFooter() },
      children: [...ch10b, ...ch11, ...ch12, ...ch13, ...ch14, ...ch15, ...ch16, ...ch17, ...ch18, ...ch19, ...refs] },
  ],
});

const OUT = "C:\\Users\\malik\\Desktop\\DigitalHub\\EVCharging-System\\EVCharging-System\\docs\\ChargeHub_Project_Proposal.docx";
Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(OUT, buf);
  console.log("WROTE " + OUT + "  (" + Math.round(buf.length / 1024) + " KB)");
});
