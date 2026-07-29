/**
 * ChargeHub presentation deck generator.
 *
 * Palette is the product's OWN design system (docs/09 tokens), not a generic template:
 * primary #0E7A5F, volt #F5A524, ink #101915, canvas #F5F8F6. The deck should look like the app.
 *
 * Every number in here is verified — see docs/DEMO_READINESS_REPORT.md. Nothing is invented.
 */
const pptxgen = require("pptxgenjs");

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.3 x 7.5 — set BEFORE any slide is added
pres.author = "Malik, Abdel Aziz, Aya";
pres.title = "ChargeHub — EV Charging Reservation Platform";

/* ---------------------------------------------------------------- palette */
const C = {
  primary: "0E7A5F",
  dark: "0A5C48",
  light: "E7F3EF",
  volt: "F5A524",
  voltLight: "FEF3DE",
  ink: "101915",
  inkSoft: "5B6B64",
  canvas: "F5F8F6",
  line: "E3EAE6",
  white: "FFFFFF",
};
const H = "Cambria";
const B = "Calibri";

/* ---------------------------------------------------------------- helpers */

function titleBar(slide, text, kicker) {
  if (kicker) {
    slide.addText(kicker.toUpperCase(), {
      x: 0.6, y: 0.34, w: 12.1, h: 0.28,
      fontFace: B, fontSize: 12, bold: true, color: C.primary, charSpacing: 2, margin: 0,
    });
  }
  slide.addText(text, {
    x: 0.6, y: kicker ? 0.64 : 0.5, w: 12.1, h: 0.75,
    fontFace: H, fontSize: 34, bold: true, color: C.ink, margin: 0,
  });
}

/** Rounded card with a subtle tint — the deck's one repeated motif. */
function card(slide, x, y, w, h, fill) {
  slide.addShape(pres.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.08,
    fill: { color: fill || C.white },
    line: { color: C.line, width: 1 },
    shadow: { type: "outer", angle: 90, blur: 6, offset: 1, color: "101915", opacity: 0.06 },
  });
}

/** Icon glyph inside a filled circle — the second half of the motif. */
function iconCircle(slide, x, y, glyph, bg, fg, size) {
  const d = size || 0.52;
  slide.addShape(pres.ShapeType.ellipse, {
    x, y, w: d, h: d, fill: { color: bg || C.primary }, line: { color: bg || C.primary },
  });
  slide.addText(glyph, {
    x, y, w: d, h: d, align: "center", valign: "middle",
    fontFace: B, fontSize: d > 0.6 ? 20 : 16, bold: true, color: fg || C.white, margin: 0,
  });
}

function sectionSlide(n, title, subtitle, points) {
  const s = pres.addSlide();
  s.background = { color: C.ink };
  s.addText(`SECTION ${n}`, {
    x: 0.9, y: 2.2, w: 5, h: 0.3,
    fontFace: B, fontSize: 13, bold: true, color: C.volt, charSpacing: 3, margin: 0,
  });
  s.addText(title, {
    x: 0.9, y: 2.6, w: 7.2, h: 1.3,
    fontFace: H, fontSize: 42, bold: true, color: C.white, margin: 0,
  });
  s.addText(subtitle, {
    x: 0.9, y: 3.95, w: 6.8, h: 0.9,
    fontFace: B, fontSize: 16, color: "C9D6D0", margin: 0,
  });
  if (points) {
    const items = points.map((p, i) => ({
      text: p, options: { bullet: true, breakLine: i !== points.length - 1 },
    }));
    s.addText(items, {
      x: 8.6, y: 2.6, w: 4.1, h: 2.4,
      fontFace: B, fontSize: 13, color: "C9D6D0", paraSpaceAfter: 8, margin: 0,
    });
  }
  return s;
}

function statCard(slide, x, y, w, value, label, accent) {
  card(slide, x, y, w, 1.5);
  slide.addText(value, {
    x: x + 0.15, y: y + 0.18, w: w - 0.3, h: 0.7,
    fontFace: H, fontSize: 40, bold: true, color: accent || C.primary, align: "center", margin: 0,
  });
  slide.addText(label, {
    x: x + 0.15, y: y + 0.92, w: w - 0.3, h: 0.45,
    fontFace: B, fontSize: 11, color: C.inkSoft, align: "center", margin: 0,
  });
}

function speaker(slide, who) {
  slide.addText(who, {
    x: 11.0, y: 6.95, w: 1.75, h: 0.3,
    fontFace: B, fontSize: 10, color: C.inkSoft, align: "right", margin: 0,
  });
}

/* ================================================================ 1. TITLE */
{
  const s = pres.addSlide();
  s.background = { color: C.ink };
  s.addShape(pres.ShapeType.ellipse, {
    x: 9.6, y: -1.4, w: 5.6, h: 5.6, fill: { color: C.dark }, line: { color: C.dark },
  });
  s.addShape(pres.ShapeType.ellipse, {
    x: 11.1, y: 4.4, w: 3.4, h: 3.4, fill: { color: "16241E" }, line: { color: "16241E" },
  });
  iconCircle(s, 0.9, 1.5, "⚡", C.volt, C.ink, 0.8);
  s.addText("ChargeHub", {
    x: 0.9, y: 2.5, w: 9, h: 1.15,
    fontFace: H, fontSize: 60, bold: true, color: C.white, margin: 0,
  });
  s.addText("Smart reservations for electric vehicle charging stations", {
    x: 0.9, y: 3.6, w: 8.4, h: 0.5,
    fontFace: B, fontSize: 19, color: "9FB3AA", margin: 0,
  });
  s.addText(
    "Malik Halimeh  ·  Abdel Aziz  ·  Aya Sulyman",
    { x: 0.9, y: 5.5, w: 8, h: 0.35, fontFace: B, fontSize: 14, bold: true, color: C.volt, margin: 0 }
  );
  s.addText("Final Project Presentation", {
    x: 0.9, y: 5.9, w: 8, h: 0.35, fontFace: B, fontSize: 12, color: "7E918A", margin: 0,
  });
  s.addNotes("All three presenters on stage. Malik opens.");
}

/* ================================================================ 2. TEAM */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "Who built what", "The team");

  const people = [
    { n: "Malik", r: "Booking rules, optimization engine,\nreliability scoring, waitlists,\nextensions, business value", g: "M", x: 0.6 },
    { n: "Abdel Aziz", r: "Backend services, database design,\nQR workflow, operator screens,\ndeposit and refund rules", g: "A", x: 4.75 },
    { n: "Aya", r: "Customer journey, interface design,\nhow pages are rendered,\nanalytics dashboards, recorded demo", g: "Y", x: 8.9 },
  ];
  people.forEach((p) => {
    card(s, p.x, 1.85, 3.8, 3.1);
    iconCircle(s, p.x + 0.35, 2.2, p.g, C.primary, C.white, 0.75);
    s.addText(p.n, {
      x: p.x + 0.35, y: 3.1, w: 3.1, h: 0.4,
      fontFace: H, fontSize: 22, bold: true, color: C.ink, margin: 0,
    });
    s.addText(p.r, {
      x: p.x + 0.35, y: 3.55, w: 3.1, h: 1.3,
      fontFace: B, fontSize: 12, color: C.inkSoft, margin: 0,
    });
  });
  s.addText("Everything shown today runs on real code and a real database. Nothing is a mock-up.", {
    x: 0.6, y: 5.35, w: 12.1, h: 0.4,
    fontFace: B, fontSize: 14, italic: true, color: C.primary, margin: 0,
  });
  speaker(s, "Malik");
}

/* ================================================================ SECTION 1 */
sectionSlide(1, "Introduction", "What we built, and who it is for.", [
  "The product in one line",
  "Three kinds of user",
  "Why it is not just a booking form",
]).addNotes("Malik. 45 seconds.");

/* ================================================================ 3. WHAT IT IS */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "A charging station is a shop with very few seats", "Introduction");

  card(s, 0.6, 1.9, 5.9, 3.6, C.light);
  s.addText("The idea", {
    x: 0.95, y: 2.15, w: 5.2, h: 0.4, fontFace: H, fontSize: 20, bold: true, color: C.dark, margin: 0,
  });
  s.addText(
    [
      { text: "Charging a car takes 15 minutes to 2 hours.", options: { bullet: true, breakLine: true } },
      { text: "A station has only a handful of chargers.", options: { bullet: true, breakLine: true } },
      { text: "If a driver arrives and every charger is busy, that driver is simply lost.", options: { bullet: true, breakLine: true } },
      { text: "ChargeHub lets drivers book a charger in advance, and helps the station serve as many people as possible.", options: { bullet: true, breakLine: false } },
    ],
    { x: 0.95, y: 2.6, w: 5.2, h: 2.7, fontFace: B, fontSize: 14, color: C.ink, paraSpaceAfter: 10, margin: 0 }
  );

  const users = [
    { g: "D", t: "Driver", d: "Books a charger, pays a small deposit, arrives and charges." },
    { g: "O", t: "Station operator", d: "Scans the driver in, starts and ends sessions, handles problems." },
    { g: "M", t: "Manager", d: "Sees how busy the stations are and how well the system is working." },
  ];
  users.forEach((u, i) => {
    const y = 1.9 + i * 1.24;
    card(s, 6.8, y, 5.9, 1.06);
    iconCircle(s, 7.05, y + 0.27, u.g, C.primary, C.white, 0.52);
    s.addText(u.t, {
      x: 7.72, y: y + 0.18, w: 4.8, h: 0.32, fontFace: B, fontSize: 15, bold: true, color: C.ink, margin: 0,
    });
    s.addText(u.d, {
      x: 7.72, y: y + 0.5, w: 4.8, h: 0.45, fontFace: B, fontSize: 12, color: C.inkSoft, margin: 0,
    });
  });
  speaker(s, "Malik");
  s.addNotes("Keep it plain. A charging station is a shop with very few seats.");
}

/* ================================================================ SECTION 2 */
sectionSlide(2, "The problem", "What goes wrong today, and what it costs.", [
  "Double bookings",
  "Empty chargers",
  "People who never turn up",
  "Manual work for staff",
]).addNotes("Malik. 1 minute.");

/* ================================================================ 4. PROBLEM */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "Four problems, all expensive", "The problem");

  const probs = [
    { g: "1", t: "Two drivers, one charger", d: "Without a strict rule, two people can book the same charger at the same time. One of them drives to the station for nothing." },
    { g: "2", t: "Chargers sitting empty", d: "A driver finishes early or cancels. That time is free again — but nobody knows, so it is wasted." },
    { g: "3", t: "People who never arrive", d: "A booking that nobody uses blocks a charger someone else wanted, and the station earns nothing." },
    { g: "4", t: "Staff doing it by hand", d: "Deciding who gets which charger, and when, is slow and inconsistent when a person does it under pressure." },
  ];
  probs.forEach((p, i) => {
    const x = 0.6 + (i % 2) * 6.15;
    const y = 1.9 + Math.floor(i / 2) * 1.95;
    card(s, x, y, 5.95, 1.75);
    iconCircle(s, x + 0.3, y + 0.32, p.g, C.volt, C.ink, 0.5);
    s.addText(p.t, {
      x: x + 0.95, y: y + 0.22, w: 4.8, h: 0.35, fontFace: B, fontSize: 15, bold: true, color: C.ink, margin: 0,
    });
    s.addText(p.d, {
      x: x + 0.95, y: y + 0.6, w: 4.8, h: 1.0, fontFace: B, fontSize: 12, color: C.inkSoft, margin: 0,
    });
  });
  s.addText("Our goal: serve the most drivers possible, be fair, and never sell the same charger twice.", {
    x: 0.6, y: 5.95, w: 12.1, h: 0.4,
    fontFace: B, fontSize: 15, bold: true, italic: true, color: C.primary, margin: 0,
  });
  speaker(s, "Malik");
}

/* ================================================================ SECTION 3 */
sectionSlide(3, "How the system is built", "Two applications, one database, and a rule the database enforces.", [
  "Front end and back end",
  "14 collections",
  "An append-only history",
]).addNotes("Abdel Aziz takes over here.");

/* ================================================================ 5. ARCHITECTURE */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "Two applications, one database", "Architecture");

  // Row 1 — clients
  const clients = [
    { t: "Driver app", d: "Book, pay, QR code, offers" },
    { t: "Operator app", d: "Scan, check in, sessions" },
    { t: "Manager app", d: "Analytics and optimizer" },
  ];
  clients.forEach((c, i) => {
    const x = 0.6 + i * 4.1;
    card(s, x, 1.8, 3.85, 0.95, C.light);
    s.addText(c.t, { x: x + 0.2, y: 1.92, w: 3.4, h: 0.3, fontFace: B, fontSize: 14, bold: true, color: C.dark, margin: 0 });
    s.addText(c.d, { x: x + 0.2, y: 2.22, w: 3.4, h: 0.4, fontFace: B, fontSize: 11, color: C.inkSoft, margin: 0 });
  });
  s.addText("Next.js  ·  React  ·  one web app", {
    x: 0.6, y: 2.82, w: 12.1, h: 0.26, fontFace: B, fontSize: 10, italic: true, color: C.inkSoft, align: "center", margin: 0,
  });

  s.addText("↓", { x: 0.6, y: 3.05, w: 12.1, h: 0.3, fontFace: B, fontSize: 18, color: C.primary, align: "center", margin: 0 });

  // Row 2 — API
  card(s, 0.6, 3.4, 12.1, 1.15, C.white);
  s.addText("Back end — business rules live here", {
    x: 0.9, y: 3.52, w: 5.5, h: 0.32, fontFace: B, fontSize: 15, bold: true, color: C.ink, margin: 0,
  });
  s.addText("Booking · Deposits · Optimizer · Reliability · Extensions · Incidents · Notifications", {
    x: 0.9, y: 3.85, w: 11.5, h: 0.32, fontFace: B, fontSize: 12, color: C.inkSoft, margin: 0,
  });
  s.addText("53 API endpoints — the screens never talk to the database directly", {
    x: 0.9, y: 4.15, w: 11.5, h: 0.3, fontFace: B, fontSize: 11, italic: true, color: C.primary, margin: 0,
  });

  s.addText("↓", { x: 0.6, y: 4.6, w: 12.1, h: 0.3, fontFace: B, fontSize: 18, color: C.primary, align: "center", margin: 0 });

  // Row 3 — data
  const data = [
    { t: "MongoDB — 14 collections", d: "Bookings, chargers, occupancy, requests, offers, incidents" },
    { t: "History that is never edited", d: "Every event is added, never changed. Scores are recalculated from it." },
  ];
  data.forEach((d, i) => {
    const x = 0.6 + i * 6.15;
    card(s, x, 4.95, 5.95, 1.1, C.voltLight);
    s.addText(d.t, { x: x + 0.25, y: 5.08, w: 5.4, h: 0.32, fontFace: B, fontSize: 14, bold: true, color: C.ink, margin: 0 });
    s.addText(d.d, { x: x + 0.25, y: 5.4, w: 5.4, h: 0.55, fontFace: B, fontSize: 11, color: C.inkSoft, margin: 0 });
  });
  speaker(s, "Abdel Aziz");
}

/* ================================================================ 6. THE INDEX */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "The one rule the database enforces itself", "Architecture");

  s.addText(
    "We split charger time into 15-minute blocks. Each block can be owned by only one booking — and the database refuses the second one.",
    { x: 0.6, y: 1.75, w: 12.1, h: 0.5, fontFace: B, fontSize: 15, color: C.ink, margin: 0 }
  );

  // Timeline visual
  const blocks = ["15:00", "15:15", "15:30", "15:45", "16:00", "16:15"];
  blocks.forEach((b, i) => {
    const x = 0.85 + i * 2.0;
    const taken = i < 4;
    s.addShape(pres.ShapeType.roundRect, {
      x, y: 2.5, w: 1.85, h: 0.85, rectRadius: 0.06,
      fill: { color: taken ? C.primary : C.white },
      line: { color: taken ? C.primary : C.line, width: 1 },
    });
    s.addText(b, {
      x, y: 2.5, w: 1.85, h: 0.85, align: "center", valign: "middle",
      fontFace: B, fontSize: 13, bold: true, color: taken ? C.white : C.inkSoft, margin: 0,
    });
  });
  s.addText("Anna's booking, 15:00–16:00  ·  four blocks", {
    x: 0.85, y: 3.42, w: 7.6, h: 0.3, fontFace: B, fontSize: 11, italic: true, color: C.primary, margin: 0,
  });

  card(s, 0.6, 4.0, 5.95, 1.5, C.voltLight);
  s.addText("Ben tries 15:30–16:30", {
    x: 0.9, y: 4.15, w: 5.3, h: 0.32, fontFace: B, fontSize: 15, bold: true, color: C.ink, margin: 0,
  });
  s.addText("He needs the 15:30 and 15:45 blocks. Anna already owns them, so the database rejects it. Not our code — the database.", {
    x: 0.9, y: 4.5, w: 5.3, h: 0.9, fontFace: B, fontSize: 12, color: C.inkSoft, margin: 0,
  });

  card(s, 6.75, 4.0, 5.95, 1.5, C.light);
  s.addText("Ben tries 16:00–17:00", {
    x: 7.05, y: 4.15, w: 5.3, h: 0.32, fontFace: B, fontSize: 15, bold: true, color: C.dark, margin: 0,
  });
  s.addText("Nobody owns those blocks. Accepted. Two bookings can sit back to back with no gap wasted.", {
    x: 7.05, y: 4.5, w: 5.3, h: 0.9, fontFace: B, fontSize: 12, color: C.inkSoft, margin: 0,
  });

  s.addText("Why this matters: application code can be bypassed by a future feature. A database rule cannot.", {
    x: 0.6, y: 5.75, w: 12.1, h: 0.4, fontFace: B, fontSize: 14, bold: true, italic: true, color: C.primary, margin: 0,
  });
  speaker(s, "Abdel Aziz");
  s.addNotes("This is the single most important slide in the technical half. Two browsers, same charger — one wins.");
}

/* ================================================================ SECTION 4 */
sectionSlide(4, "How pages are rendered", "Next.js gives us three ways to build a page. We chose per page, on purpose.", [
  "Server-rendered",
  "Static",
  "Browser-rendered",
]).addNotes("Aya. Ninety seconds — this is a required section.");

/* ================================================================ 7. RENDERING MODES */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "Three ways to build a page", "Rendering");

  const modes = [
    { k: "SSR", t: "Server-rendered", d: "The server builds the page fresh for every visitor.", w: "When the data changes constantly and must be right now.", c: C.primary },
    { k: "SSG", t: "Static", d: "The page is built once, when we deploy, and reused.", w: "When the content is the same for everyone and rarely changes.", c: C.volt },
    { k: "CSR", t: "Browser-rendered", d: "A light shell loads, then the browser fetches the data.", w: "When the page needs the user's login and lots of clicking.", c: "5B6B64" },
  ];
  modes.forEach((m, i) => {
    const x = 0.6 + i * 4.1;
    card(s, x, 1.85, 3.85, 3.7);
    s.addShape(pres.ShapeType.roundRect, {
      x: x + 0.3, y: 2.15, w: 1.1, h: 0.5, rectRadius: 0.06, fill: { color: m.c }, line: { color: m.c },
    });
    s.addText(m.k, {
      x: x + 0.3, y: 2.15, w: 1.1, h: 0.5, align: "center", valign: "middle",
      fontFace: B, fontSize: 15, bold: true, color: m.k === "SSG" ? C.ink : C.white, margin: 0,
    });
    s.addText(m.t, {
      x: x + 0.3, y: 2.8, w: 3.3, h: 0.35, fontFace: H, fontSize: 18, bold: true, color: C.ink, margin: 0,
    });
    s.addText(m.d, {
      x: x + 0.3, y: 3.2, w: 3.3, h: 0.9, fontFace: B, fontSize: 12, color: C.inkSoft, margin: 0,
    });
    s.addText("We use it when:", {
      x: x + 0.3, y: 4.15, w: 3.3, h: 0.28, fontFace: B, fontSize: 11, bold: true, color: C.primary, margin: 0,
    });
    s.addText(m.w, {
      x: x + 0.3, y: 4.45, w: 3.3, h: 0.95, fontFace: B, fontSize: 12, color: C.ink, margin: 0,
    });
  });
  s.addText("We also have time-based refresh (ISR) configured, but it is currently unused — we tell every request to fetch fresh data.", {
    x: 0.6, y: 5.8, w: 12.1, h: 0.4, fontFace: B, fontSize: 12, italic: true, color: C.inkSoft, margin: 0,
  });
  speaker(s, "Aya");
}

/* ================================================================ 8. RENDERING TABLE */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "Every page, and why", "Rendering");

  const rows = [
    ["Home, Stations, Station detail", "SSR", "A driver — and Google — must see real availability in the first response."],
    ["QR landing page", "SSR", "Never cached. Showing a bay as free when it was taken 30 seconds ago is the one failure we exist to prevent."],
    ["Manager and operator screens", "SSR", "They read live data and are behind a login, so there is nothing to cache."],
    ["About, FAQ, Terms, Privacy", "SSG", "Same for everyone and changes rarely. Built once."],
    ["Booking wizard, My bookings,\nOffers, Waitlist, Notifications", "CSR", "Needs the login token and many steps of interaction. A static shell loads instantly, then data arrives."],
  ];

  let y = 1.8;
  rows.forEach((r) => {
    const h = r[0].includes("\n") ? 1.0 : 0.82;
    card(s, 0.6, y, 12.1, h);
    s.addText(r[0], {
      x: 0.85, y: y + 0.12, w: 3.5, h: h - 0.24, fontFace: B, fontSize: 12, bold: true, color: C.ink, valign: "middle", margin: 0,
    });
    const badge = r[1] === "SSR" ? C.primary : r[1] === "SSG" ? C.volt : "5B6B64";
    s.addShape(pres.ShapeType.roundRect, {
      x: 4.5, y: y + (h - 0.42) / 2, w: 0.85, h: 0.42, rectRadius: 0.06, fill: { color: badge }, line: { color: badge },
    });
    s.addText(r[1], {
      x: 4.5, y: y + (h - 0.42) / 2, w: 0.85, h: 0.42, align: "center", valign: "middle",
      fontFace: B, fontSize: 12, bold: true, color: r[1] === "SSG" ? C.ink : C.white, margin: 0,
    });
    s.addText(r[2], {
      x: 5.6, y: y + 0.12, w: 6.9, h: h - 0.24, fontFace: B, fontSize: 12, color: C.inkSoft, valign: "middle", margin: 0,
    });
    y += h + 0.14;
  });
  speaker(s, "Aya");
  s.addNotes("Say the QR line out loud — it ties rendering back to the business problem.");
}

/* ================================================================ SECTION 5 */
sectionSlide(5, "What we built", "Twelve working parts, all verified against a real database.", [
  "Booking and deposits",
  "Sessions and QR",
  "Optimizer and waitlists",
  "Analytics",
]).addNotes("Abdel Aziz — you cover what was built; Aya returns for the demo.");

/* ================================================================ 9. FEATURES */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "Twelve working parts", "Features");

  const feats = [
    ["Booking", "Pick a charger and a length from 15 to 120 minutes."],
    ["Deposit", "A small deposit holds the booking. 10 minutes to pay."],
    ["QR check-in", "The driver shows a code. The operator scans it."],
    ["Charging session", "Start and end are separate, recorded steps."],
    ["Late arrival", "On time, early, within grace, late, or no-show."],
    ["Early departure", "Leave early and the remaining time goes back on sale."],
    ["Extensions", "Ask for more time. Granted only if it really fits."],
    ["Overstay", "Still charging past your end time — three warning levels."],
    ["Waitlists", "No space now? Keep your place and get offered a slot."],
    ["Optimizer", "Chooses who gets which charger, and explains why."],
    ["Reliability", "A score built from what each driver actually did."],
    ["Incidents & delays", "A broken charger, and the knock-on delay it causes."],
  ];
  feats.forEach((f, i) => {
    const x = 0.6 + (i % 3) * 4.1;
    const y = 1.8 + Math.floor(i / 3) * 1.2;
    card(s, x, y, 3.85, 1.05);
    s.addText(f[0], {
      x: x + 0.25, y: y + 0.13, w: 3.4, h: 0.3, fontFace: B, fontSize: 14, bold: true, color: C.primary, margin: 0,
    });
    s.addText(f[1], {
      x: x + 0.25, y: y + 0.44, w: 3.4, h: 0.52, fontFace: B, fontSize: 11, color: C.inkSoft, margin: 0,
    });
  });
  speaker(s, "Abdel Aziz");
}

/* ============================================ 14b. NOT IN THE DEMO */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "Also built — but not in today's demo", "Features");

  s.addText("The demo shows three stories end to end. These parts all work too, and we did not want you to think they are missing.", {
    x: 0.6, y: 1.72, w: 12.1, h: 0.4, fontFace: B, fontSize: 14, color: C.ink, margin: 0,
  });

  const rest = [
    ["Camera QR scanner", "The operator can scan the code with a camera, not just type it."],
    ["Cancel with a live refund quote", "You see exactly what you get back before you confirm."],
    ["Connect your car", "Read the battery level and suggest a charger that fits the journey."],
    ["Booking at the desk", "Staff can create a reservation for someone standing in front of them."],
    ["Reports with CSV export", "Pick a date range and download it."],
    ["Behaviour profiles", "Lateness, cancellations and no-show patterns per driver, not just a score."],
    ["Publish charger time", "An operator opens up bookable time from the admin screen."],
    ["Remove someone's access", "Their login stops working straight away, not at the next sign-in."],
    ["Ask for two stations at once", "\"Either of these two sites is fine\" is a single request."],
  ];
  rest.forEach((r, i) => {
    const x = 0.6 + (i % 3) * 4.1;
    const y = 2.3 + Math.floor(i / 3) * 1.35;
    card(s, x, y, 3.85, 1.2);
    s.addText(r[0], {
      x: x + 0.25, y: y + 0.15, w: 3.4, h: 0.32, fontFace: B, fontSize: 13.5, bold: true, color: C.primary, margin: 0,
    });
    s.addText(r[1], {
      x: x + 0.25, y: y + 0.48, w: 3.4, h: 0.62, fontFace: B, fontSize: 11, color: C.inkSoft, margin: 0,
    });
  });

  s.addText("Showing all of this properly would take far longer than we have. So we chose depth over breadth: three stories, proven fully.", {
    x: 0.6, y: 6.35, w: 12.1, h: 0.4, fontFace: B, fontSize: 13.5, bold: true, italic: true, color: C.primary, margin: 0,
  });
  speaker(s, "Abdel Aziz");
  s.addNotes("Abdel Aziz. 40 seconds. Do not read all nine. Pick three, then say the line at the bottom: we chose depth over breadth.");
}

/* ================================================================ SECTION 6 */
sectionSlide(6, "The thinking behind it", "How the system decides — and why it can explain itself.", [
  "How the optimizer chooses",
  "Reliability",
  "Deposits and fairness",
]).addNotes("Malik takes the optimizer and reliability (3:10). Abdel Aziz takes the deposit and refund rules (1:00) — they are enforced in the backend he built.");

/* ================================================================ 10. OPTIMIZER */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "How the optimizer decides", "Business logic");

  s.addText("A driver says \"about 30 minutes, any time between 2pm and 6pm\". The system looks at every possible slot and scores each one.", {
    x: 0.6, y: 1.72, w: 12.1, h: 0.45, fontFace: B, fontSize: 14, color: C.ink, margin: 0,
  });

  const factors = [
    ["Station use", "Does this keep the free time in usable blocks?"],
    ["Preference", "How close is it to the time they actually wanted?"],
    ["Waiting time", "Have they been waiting a long time already?"],
    ["Priority", "Are they standing at the desk, or recovering from our fault?"],
    ["Reliability", "How likely are they to actually turn up?"],
  ];
  factors.forEach((f, i) => {
    const x = 0.6 + i * 2.45;
    card(s, x, 2.3, 2.3, 1.75);
    iconCircle(s, x + 0.89, 2.5, String(i + 1), C.primary, C.white, 0.5);
    s.addText(f[0], {
      x: x + 0.15, y: 3.05, w: 2.0, h: 0.3, fontFace: B, fontSize: 12, bold: true, color: C.ink, align: "center", margin: 0,
    });
    s.addText(f[1], {
      x: x + 0.15, y: 3.35, w: 2.0, h: 0.62, fontFace: B, fontSize: 10, color: C.inkSoft, align: "center", margin: 0,
    });
  });

  card(s, 0.6, 4.3, 5.95, 1.75, C.light);
  s.addText("It is not artificial intelligence", {
    x: 0.9, y: 4.45, w: 5.3, h: 0.32, fontFace: B, fontSize: 15, bold: true, color: C.dark, margin: 0,
  });
  s.addText("It is a fixed set of rules with fixed weights. The same situation always gives the same answer, and we can always say why. A manager can be shown the reason in plain words.", {
    x: 0.9, y: 4.8, w: 5.3, h: 1.1, fontFace: B, fontSize: 12, color: C.inkSoft, margin: 0,
  });

  card(s, 6.75, 4.3, 5.95, 1.75, C.voltLight);
  s.addText("We prove it helps", {
    x: 7.05, y: 4.45, w: 5.3, h: 0.32, fontFace: B, fontSize: 15, bold: true, color: C.ink, margin: 0,
  });
  s.addText("Every run also calculates what plain \"first come, first served\" would have achieved on the same data. If the optimizer does not beat it, the number says so.", {
    x: 7.05, y: 4.8, w: 5.3, h: 1.1, fontFace: B, fontSize: 12, color: C.inkSoft, margin: 0,
  });
  speaker(s, "Malik");
}

/* ================================================================ 11. OFFERS + RELIABILITY */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "Holding a charger, and remembering behaviour", "Business logic");

  card(s, 0.6, 1.85, 5.95, 2.1, C.white);
  iconCircle(s, 0.9, 2.1, "⏱", C.volt, C.ink, 0.5);
  s.addText("The 5-minute hold", {
    x: 1.55, y: 2.15, w: 4.7, h: 0.35, fontFace: H, fontSize: 19, bold: true, color: C.ink, margin: 0,
  });
  s.addText("When we offer a driver a charger, we really hold it for 5 minutes. Nobody else can book it. Accepting cannot fail.\n\nThe same 5 minutes whether the booking is 15 minutes or 2 hours — otherwise the most valuable bookings would be the most expensive to offer.", {
    x: 0.9, y: 2.65, w: 5.4, h: 1.2, fontFace: B, fontSize: 12, color: C.inkSoft, margin: 0,
  });

  card(s, 6.75, 1.85, 5.95, 2.1, C.white);
  iconCircle(s, 7.05, 2.1, "★", C.primary, C.white, 0.5);
  s.addText("Reliability score", {
    x: 7.7, y: 2.15, w: 4.7, h: 0.35, fontFace: H, fontSize: 19, bold: true, color: C.ink, margin: 0,
  });
  s.addText("Everyone starts at 100. Turning up adds a point. Arriving late, cancelling late, or not turning up takes points away.\n\nIt is recalculated from the history every time — never a running total that could drift.", {
    x: 7.05, y: 2.65, w: 5.4, h: 1.2, fontFace: B, fontSize: 12, color: C.inkSoft, margin: 0,
  });

  s.addText("From our demo data — four drivers, same system, very different behaviour:", {
    x: 0.6, y: 4.15, w: 12.1, h: 0.35, fontFace: B, fontSize: 14, bold: true, color: C.ink, margin: 0,
  });
  statCard(s, 0.6, 4.6, 2.9, "100", "Always turns up", C.primary);
  statCard(s, 3.68, 4.6, 2.9, "83", "Occasionally late", C.primary);
  statCard(s, 6.76, 4.6, 2.9, "0", "Chronically late", C.volt);
  statCard(s, 9.84, 4.6, 2.86, "0", "Frequent no-shows", C.volt);

  s.addText("A low score never blocks anyone from booking. It only changes who gets the better slot when two people want the same one.", {
    x: 0.6, y: 6.2, w: 12.1, h: 0.35, fontFace: B, fontSize: 12, italic: true, color: C.primary, margin: 0,
  });
  speaker(s, "Malik");
}

/* ================================================================ 12. DEPOSIT + FAIRNESS */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "The deposit, and being fair about it", "Business logic");

  const rules = [
    ["Cancel more than 24 hours ahead", "Full refund", C.primary],
    ["Cancel less than 24 hours ahead", "Deposit kept", C.volt],
    ["Never turned up", "Deposit kept", C.volt],
    ["Our charger broke", "Full refund", C.primary],
    ["Maintenance or a station problem", "Full refund", C.primary],
    ["We moved your booking", "Full refund", C.primary],
  ];
  rules.forEach((r, i) => {
    const x = 0.6 + (i % 2) * 6.15;
    const y = 1.85 + Math.floor(i / 2) * 0.95;
    card(s, x, y, 5.95, 0.8);
    s.addText(r[0], {
      x: x + 0.25, y: y + 0.05, w: 3.9, h: 0.7, fontFace: B, fontSize: 13, color: C.ink, valign: "middle", margin: 0,
    });
    s.addShape(pres.ShapeType.roundRect, {
      x: x + 4.2, y: y + 0.19, w: 1.55, h: 0.42, rectRadius: 0.06, fill: { color: r[2] }, line: { color: r[2] },
    });
    s.addText(r[1], {
      x: x + 4.2, y: y + 0.19, w: 1.55, h: 0.42, align: "center", valign: "middle",
      fontFace: B, fontSize: 10, bold: true, color: r[2] === C.volt ? C.ink : C.white, margin: 0,
    });
  });

  card(s, 0.6, 4.85, 12.1, 1.35, C.light);
  s.addText("Our fault always wins over the clock", {
    x: 0.95, y: 5.0, w: 11.4, h: 0.35, fontFace: B, fontSize: 16, bold: true, color: C.dark, margin: 0,
  });
  s.addText("If the problem was ours, the driver is refunded even inside the 24-hour window, and their reliability score is not touched. Only staff can mark a problem as our fault — a driver who could do that would refund themselves every time.", {
    x: 0.95, y: 5.38, w: 11.4, h: 0.75, fontFace: B, fontSize: 12.5, color: C.inkSoft, margin: 0,
  });
  s.addText("Payments are simulated. No card details are ever accepted, stored, or shown anywhere in this system.", {
    x: 0.6, y: 6.35, w: 12.1, h: 0.35, fontFace: B, fontSize: 12, bold: true, italic: true, color: C.volt, margin: 0,
  });
  speaker(s, "Abdel Aziz");
  s.addNotes("Abdel Aziz — the refund rules are enforced in one backend service, and only staff can set the operator-fault flag. Say the simulated-payments line out loud before anyone asks.");
}

/* ================================================================ SECTION 7 */
sectionSlide(7, "Recorded demonstrations", "Three scenarios, each recorded end to end on the real system.", [
  "Anna's full journey",
  "Waitlist promotion",
  "Reliability scoring",
  "A broken charger",
]).addNotes("Three recorded videos, 3:00 each. Each presenter narrates their own live over playback. Nothing here is performed live.");

/* ================================================================ 13. DEMO MAP */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "Three stories, recorded end to end", "Demo");

  s.addText("Each of us recorded one story on the real system, alone, at a different station. We narrate them live.", {
    x: 0.6, y: 1.72, w: 12.1, h: 0.4, fontFace: B, fontSize: 14, color: C.ink, margin: 0,
  });

  const stories = [
    { who: "Malik", site: "Downtown", t: "The contested afternoon",
      d: "Two drivers reach for the same charger. One is refused by the database. Then a driver who is flexible describes a window instead, and the system plans everyone at once — and shows its reasoning.",
      p: "One block, one owner · back-to-back bookings · five-factor scoring · first-come-first-served comparison · a held offer" },
    { who: "Abdel Aziz", site: "Airport", t: "The station that broke",
      d: "A driver books, pays, and is checked in from her code. Then a charger fails. The system works out who is affected and how far the delay reaches — and stops there.",
      p: "QR check-in · arrival classified automatically · incident lifecycle · delay recommended, never applied · our-fault refund · station scope" },
    { who: "Aya", site: "Marina", t: "Nothing is wasted",
      d: "One driver is turned away because nothing is free. Another finishes early. Within a minute the freed time is sold to the driver who was waiting.",
      p: "Waitlist kept alive · early departure returns capacity · automatic promotion · extensions granted, partly granted and refused · 31 measurements" },
  ];
  stories.forEach((st, i) => {
    const y = 2.3 + i * 1.42;
    card(s, 0.6, y, 12.1, 1.3);
    s.addShape(pres.ShapeType.roundRect, {
      x: 0.85, y: y + 0.2, w: 1.55, h: 0.4, rectRadius: 0.06,
      fill: { color: C.primary }, line: { color: C.primary },
    });
    s.addText(st.who, {
      x: 0.85, y: y + 0.2, w: 1.55, h: 0.4, align: "center", valign: "middle",
      fontFace: B, fontSize: 11, bold: true, color: C.white, margin: 0,
    });
    s.addText(st.site, {
      x: 0.85, y: y + 0.66, w: 1.55, h: 0.28, align: "center",
      fontFace: B, fontSize: 10, color: C.inkSoft, margin: 0,
    });
    s.addText(st.t, {
      x: 2.6, y: y + 0.14, w: 9.9, h: 0.3, fontFace: B, fontSize: 14.5, bold: true, color: C.ink, margin: 0,
    });
    s.addText(st.d, {
      x: 2.6, y: y + 0.44, w: 9.9, h: 0.5, fontFace: B, fontSize: 11, color: C.inkSoft, margin: 0,
    });
    s.addText(st.p, {
      x: 2.6, y: y + 0.96, w: 9.9, h: 0.26, fontFace: B, fontSize: 10, italic: true, color: C.primary, margin: 0,
    });
  });

  s.addText("Nothing was staged. Every click ran against the same database the dashboards read from.", {
    x: 0.6, y: 6.7, w: 12.1, h: 0.35, fontFace: B, fontSize: 13, bold: true, italic: true, color: C.primary, margin: 0,
  });
  speaker(s, "Aya");
  s.addNotes("Aya introduces all three, then hands to Malik whose video plays first. Do not read the proof lines — they are there for the examiners to read.");
}


/* ================================================================ SECTION 8 */
sectionSlide(8, "Results", "What works, and how we know.", [
  "182 automatic checks",
  "31 measurements",
  "Real data behind them",
]).addNotes("Aya takes the results, then Malik for the business value, then Aya again for what is not built.");

/* ================================================================ 14. RESULTS */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "How we know it works", "Results");

  statCard(s, 0.6, 1.85, 2.9, "182", "automatic checks pass", C.primary);
  statCard(s, 3.68, 1.85, 2.9, "31", "measurements on the dashboard", C.primary);
  statCard(s, 6.76, 1.85, 2.9, "10", "repeatable demo scenarios", C.primary);
  statCard(s, 9.84, 1.85, 2.86, "0", "double bookings possible", C.volt);

  card(s, 0.6, 3.6, 5.95, 2.6);
  s.addText("Checks, not opinions", {
    x: 0.9, y: 3.78, w: 5.3, h: 0.35, fontFace: H, fontSize: 19, bold: true, color: C.ink, margin: 0,
  });
  s.addText(
    [
      { text: "Two bookings that overlap — the second is refused", options: { bullet: true, breakLine: true } },
      { text: "Two bookings back to back — both accepted", options: { bullet: true, breakLine: true } },
      { text: "A held charger cannot be booked by anyone else", options: { bullet: true, breakLine: true } },
      { text: "Accepting an offer late gives a new offer, not an error", options: { bullet: true, breakLine: true } },
      { text: "Leaving early really puts the time back on sale", options: { bullet: true, breakLine: false } },
    ],
    { x: 0.9, y: 4.2, w: 5.3, h: 1.9, fontFace: B, fontSize: 12, color: C.inkSoft, paraSpaceAfter: 7, margin: 0 }
  );

  card(s, 6.75, 3.6, 5.95, 2.6, C.light);
  s.addText("What the dashboard measures", {
    x: 7.05, y: 3.78, w: 5.3, h: 0.35, fontFace: H, fontSize: 19, bold: true, color: C.dark, margin: 0,
  });
  s.addText(
    [
      { text: "How full the chargers are", options: { bullet: true, breakLine: true } },
      { text: "How often drivers get the time they asked for", options: { bullet: true, breakLine: true } },
      { text: "How long people wait before being served", options: { bullet: true, breakLine: true } },
      { text: "How many waitlisted drivers are eventually served", options: { bullet: true, breakLine: true } },
      { text: "How much time comes back from early departures", options: { bullet: true, breakLine: false } },
    ],
    { x: 7.05, y: 4.2, w: 5.3, h: 1.9, fontFace: B, fontSize: 12, color: C.inkSoft, paraSpaceAfter: 7, margin: 0 }
  );
  speaker(s, "Aya");
}

/* ================================================================ 15. BUSINESS VALUE */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "What this is worth to a station", "Results");

  const vals = [
    ["More drivers served", "Freed time is offered to someone waiting within a minute, instead of sitting empty until someone happens to look."],
    ["Fewer wasted trips", "Nobody drives to a station for a charger that was already taken. The database makes that impossible."],
    ["Fewer no-shows", "A deposit gives a reason to turn up or cancel early. Cancelling early is always free."],
    ["Less staff work", "The system decides who gets which charger and explains the reason. Staff step in only when they want to."],
    ["Fair treatment", "Waiting longer helps you. A low score never blocks you — it only breaks ties."],
    ["Decisions on evidence", "Managers see where capacity is short and why people are waiting, per station."],
  ];
  vals.forEach((v, i) => {
    const x = 0.6 + (i % 2) * 6.15;
    const y = 1.85 + Math.floor(i / 2) * 1.5;
    card(s, x, y, 5.95, 1.32);
    iconCircle(s, x + 0.28, y + 0.4, "✓", C.primary, C.white, 0.5);
    s.addText(v[0], {
      x: x + 0.95, y: y + 0.16, w: 4.8, h: 0.32, fontFace: B, fontSize: 14.5, bold: true, color: C.ink, margin: 0,
    });
    s.addText(v[1], {
      x: x + 0.95, y: y + 0.5, w: 4.8, h: 0.72, fontFace: B, fontSize: 11.5, color: C.inkSoft, margin: 0,
    });
  });
  speaker(s, "Malik");
}

/* ================================================================ SECTION 9 */
sectionSlide(9, "What comes next", "Honest about what is not built yet.", [
  "Real payments",
  "Email and phone alerts",
  "A real check-out signal",
]).addNotes("Aya. Keep it short and honest — three properly, one sentence for the rest.");

/* ================================================================ 16. FUTURE */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "What we would build next", "Future work");

  const next = [
    ["Real card payments", "The connection point is already built and the money records already exist. It is a swap, not a rebuild."],
    ["Email and phone alerts", "Messages work inside the app today. Sending them by email or SMS is the next step."],
    ["A real check-out signal", "Today we assume the driver leaves when charging stops. A sensor or a second scan would tell us for certain."],
    ["Holding time for overstays", "We detect someone charging past their end time, but we do not yet reserve extra time for them automatically."],
    ["Per-station tuning", "Every station uses the same scoring weights. A busy city site and a quiet one could be tuned differently."],
    ["Bookings across two slots", "A very long charge that spans two separate free periods is not supported yet."],
  ];
  next.forEach((n, i) => {
    const x = 0.6 + (i % 2) * 6.15;
    const y = 1.85 + Math.floor(i / 2) * 1.5;
    card(s, x, y, 5.95, 1.32, i < 2 ? C.light : C.white);
    s.addText(n[0], {
      x: x + 0.28, y: y + 0.16, w: 5.4, h: 0.32, fontFace: B, fontSize: 14.5, bold: true, color: i < 2 ? C.dark : C.ink, margin: 0,
    });
    s.addText(n[1], {
      x: x + 0.28, y: y + 0.5, w: 5.4, h: 0.72, fontFace: B, fontSize: 11.5, color: C.inkSoft, margin: 0,
    });
  });
  speaker(s, "Aya");
  s.addNotes("Aya. Do not read all six — take the first three properly, then one sentence for the rest. The check-out signal is the honest one to dwell on.");
}

/* ================================================================ SECTION 10 */
sectionSlide(10, "What we learned", "Six lessons we could only have learned by building this.", [
  "Guarantees belong in the database",
  "History beats counters",
  "Verification finds what reading cannot",
]).addNotes("All three presenters share this section.");

/* ================================================================ 17. LESSONS 1 */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "Lessons — the design ones", "Learning");

  const les = [
    ["Preventing double bookings belongs in the database, not in our code",
     "We first tried to check for clashes in the application. That check can always be skipped by a feature written later, and two requests arriving at the same moment can both pass it. Moving the rule into a database constraint made it impossible to break — including by code that does not exist yet."],
    ["Charger time had to be modelled as small blocks",
     "We started with fixed 30-minute slots. Real charging is 15 minutes to 2 hours. Splitting time into 15-minute blocks let us support any length while keeping one simple rule: one block, one owner. Getting the boundary wrong once made every back-to-back booking impossible — which taught us to test the edges, not the middle."],
    ["Scores must be rebuilt from history, never counted up as you go",
     "A running total drifts. If one update is missed or repeated, the number is wrong forever and nobody can tell. Recalculating the reliability score from the recorded history every time means a repeated event cannot double-count and a lost one repairs itself."],
  ];
  les.forEach((l, i) => {
    const y = 1.8 + i * 1.62;
    card(s, 0.6, y, 12.1, 1.45);
    iconCircle(s, 0.9, y + 0.45, String(i + 1), C.primary, C.white, 0.55);
    s.addText(l[0], {
      x: 1.65, y: y + 0.14, w: 10.8, h: 0.34, fontFace: B, fontSize: 15, bold: true, color: C.ink, margin: 0,
    });
    s.addText(l[1], {
      x: 1.65, y: y + 0.5, w: 10.8, h: 0.85, fontFace: B, fontSize: 11.5, color: C.inkSoft, margin: 0,
    });
  });
  speaker(s, "Abdel Aziz");
}

/* ================================================================ 18. LESSONS 2 */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "Lessons — the ones that surprised us", "Learning");

  const les = [
    ["Side effects belong in separate listeners, not in the main flow",
     "Notifications and re-planning read a record of what happened rather than being called directly from the booking code. A driver cancelling must never fail because a message could not be written. This also meant we could add notifications months later with no change to the booking flow at all."],
    ["Work that nobody triggers still has to run",
     "Deposits expiring, no-shows, holds running out — nothing causes these. Time does. We learned that a system like this needs background jobs, and that if they are not running the product looks broken even though every line of code is correct."],
    ["Testing the logic is not the same as testing the wiring",
     "Every one of our 182 checks passed while half the dashboard showed no data. The logic was right; nothing had ever fed it. We now write a check that would fail if two correct pieces disagreed — that habit found four real problems that reading the code had missed."],
  ];
  les.forEach((l, i) => {
    const y = 1.8 + i * 1.62;
    card(s, 0.6, y, 12.1, 1.45, i === 2 ? C.voltLight : C.white);
    iconCircle(s, 0.9, y + 0.45, String(i + 4), i === 2 ? C.volt : C.primary, i === 2 ? C.ink : C.white, 0.55);
    s.addText(l[0], {
      x: 1.65, y: y + 0.14, w: 10.8, h: 0.34, fontFace: B, fontSize: 15, bold: true, color: C.ink, margin: 0,
    });
    s.addText(l[1], {
      x: 1.65, y: y + 0.5, w: 10.8, h: 0.85, fontFace: B, fontSize: 11.5, color: C.inkSoft, margin: 0,
    });
  });
  speaker(s, "Malik");
  s.addNotes("Lesson 6 is the strongest one. Say the number out loud: 182 checks passing while the dashboard was empty.");
}

/* ================================================================ SECTION 11 */
{
  const s = pres.addSlide();
  s.background = { color: C.ink };
  s.addShape(pres.ShapeType.ellipse, {
    x: 10.2, y: -1.0, w: 4.8, h: 4.8, fill: { color: C.dark }, line: { color: C.dark },
  });
  s.addText("In one sentence", {
    x: 0.9, y: 1.5, w: 6, h: 0.35,
    fontFace: B, fontSize: 13, bold: true, color: C.volt, charSpacing: 3, margin: 0,
  });
  s.addText(
    "ChargeHub turns a charging station from first-come-first-served into a system that plans — and can always explain its decision.",
    { x: 0.9, y: 2.0, w: 8.6, h: 1.8, fontFace: H, fontSize: 30, bold: true, color: C.white, margin: 0 }
  );

  const closing = [
    ["Nothing is a mock-up", "Every screen reads a real database."],
    ["Nothing double-books", "The database itself refuses it."],
    ["Nothing is unexplained", "Every decision stores its reason."],
  ];
  closing.forEach((c, i) => {
    const x = 0.9 + i * 3.95;
    s.addShape(pres.ShapeType.roundRect, {
      x, y: 4.3, w: 3.65, h: 1.15, rectRadius: 0.08,
      fill: { color: "16241E" }, line: { color: "24382F", width: 1 },
    });
    s.addText(c[0], {
      x: x + 0.25, y: 4.45, w: 3.2, h: 0.3, fontFace: B, fontSize: 13, bold: true, color: C.volt, margin: 0,
    });
    s.addText(c[1], {
      x: x + 0.25, y: 4.78, w: 3.2, h: 0.55, fontFace: B, fontSize: 11.5, color: "9FB3AA", margin: 0,
    });
  });

  s.addText("Thank you — questions welcome", {
    x: 0.9, y: 6.0, w: 8, h: 0.45, fontFace: H, fontSize: 24, bold: true, color: C.white, margin: 0,
  });
  s.addText("Malik  ·  Abdel Aziz  ·  Aya", {
    x: 0.9, y: 6.5, w: 8, h: 0.3, fontFace: B, fontSize: 12, color: "7E918A", margin: 0,
  });
  s.addNotes("Malik leads Q&A. Abdel Aziz takes database, implementation and money questions. Aya takes interface, rendering, analytics and scope questions.");
}

/* ======================================================= SECTION 12 (EXTRA TIME) */
sectionSlide(12, "If you can spare five more minutes", "Four things we built that did not fit the time we were given.", [
  "Surviving our own failures",
  "Bounded waiting",
  "What we watch automatically",
  "Under the surface",
]).addNotes("EXTRA TIME ONLY. Do not advance past the closing slide unless the examiners agreed. If the answer is no, stop there and take questions.");

/* ============================================== 9b. UNFILMABLE — SAFETY */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "Built to survive its own failures", "Extra time");

  s.addText(
    "Four decisions you cannot see on a screen — because each one only shows itself when something goes wrong.",
    { x: 0.6, y: 1.72, w: 12.1, h: 0.4, fontFace: B, fontSize: 14, italic: true, color: C.inkSoft, margin: 0 }
  );

  const items = [
    ["We chose which way it breaks",
     "The booking is written first, the time claimed second. A crash mid-way leaves a booking holding nothing — which our repair tool finds. The other order would leave time held by nothing: invisible to every query, bookable by nobody."],
    ["History is added to, never edited",
     "Every event is appended. Scores and reports are recalculated from that history rather than stored, so a repeated event cannot double-count and a lost one repairs itself on the next read."],
    ["Messages cannot be sent twice",
     "Each notification carries a key the database refuses to duplicate. Run the worker twice and you get zero new messages, not two copies of every message."],
    ["Side effects cannot break a booking",
     "Notifications and re-planning read a record of what happened instead of being called from the booking code. A driver cancelling can never fail because a message could not be written."],
  ];
  items.forEach((it, i) => {
    const x = 0.6 + (i % 2) * 6.15;
    const y = 2.3 + Math.floor(i / 2) * 1.95;
    card(s, x, y, 5.95, 1.75);
    iconCircle(s, x + 0.3, y + 0.32, String(i + 1), C.primary, C.white, 0.5);
    s.addText(it[0], {
      x: x + 0.95, y: y + 0.2, w: 4.8, h: 0.36, fontFace: B, fontSize: 14.5, bold: true, color: C.ink, margin: 0,
    });
    s.addText(it[1], {
      x: x + 0.95, y: y + 0.58, w: 4.8, h: 1.05, fontFace: B, fontSize: 11.5, color: C.inkSoft, margin: 0,
    });
  });

  s.addText("None of this is demonstrable without deliberately breaking the system — which is exactly why it is worth stating.", {
    x: 0.6, y: 6.3, w: 12.1, h: 0.4, fontFace: B, fontSize: 13.5, bold: true, italic: true, color: C.primary, margin: 0,
  });
  speaker(s, "Abdel Aziz");
  s.addNotes("EXTRA TIME ONLY. Abdel Aziz. 45 seconds. These four cannot appear in any video — a crash, a corrupted projection and a duplicate message are all things you would have to cause on purpose. Say that out loud; it is the point of the slide.");
}

/* ============================================= 17b. UNFILMABLE — BOUNDS */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "Every wait in the system is bounded", "Extra time");

  s.addText(
    "Nothing waits forever, and no single customer can hold capacity indefinitely. Each of these is a named constant, not a guess.",
    { x: 0.6, y: 1.72, w: 12.1, h: 0.4, fontFace: B, fontSize: 14, color: C.ink, margin: 0 }
  );

  const bounds = [
    ["10 min", "to pay a deposit", "Then the bay returns to sale automatically"],
    ["5 min", "an offer is held", "Same for a 15-minute booking or a two-hour one"],
    ["3", "offers per request", "After three ignored, the system stops volunteering"],
    ["2", "extensions per booking", "So one driver cannot creep through an afternoon"],
    ["250 ms", "to repair a plan", "A booking screen must never wait on the optimizer"],
    ["0.60", "reliability floor", "The worst record still keeps 60% of a slot's value"],
  ];
  bounds.forEach((b, i) => {
    const x = 0.6 + (i % 3) * 4.1;
    const y = 2.35 + Math.floor(i / 3) * 1.85;
    card(s, x, y, 3.85, 1.62, i === 5 ? C.voltLight : C.white);
    s.addText(b[0], {
      x: x + 0.25, y: y + 0.16, w: 3.4, h: 0.5, fontFace: H, fontSize: 28, bold: true,
      color: i === 5 ? C.ink : C.primary, margin: 0,
    });
    s.addText(b[1], {
      x: x + 0.25, y: y + 0.68, w: 3.4, h: 0.3, fontFace: B, fontSize: 12.5, bold: true, color: C.ink, margin: 0,
    });
    s.addText(b[2], {
      x: x + 0.25, y: y + 0.98, w: 3.4, h: 0.55, fontFace: B, fontSize: 11, color: C.inkSoft, margin: 0,
    });
  });

  s.addText("Why it matters: a held charger is frozen stock. Every one of these numbers exists to stop one customer's indecision costing another customer a bay.", {
    x: 0.6, y: 6.15, w: 12.1, h: 0.45, fontFace: B, fontSize: 13.5, bold: true, italic: true, color: C.primary, margin: 0,
  });
  speaker(s, "Malik");
  s.addNotes("EXTRA TIME ONLY. Malik. 45 seconds. Do not read all six — take the 5-minute hold and the 3-offer cap, then say the closing line. These are unfilmable: showing the 3-offer cap live would take fifteen minutes of waiting.");
}

/* ================================================ E3. WHAT WE WATCH */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "What the system watches without being asked", "Extra time");

  const items = [
    ["Overstaying a booked slot", "A session still charging past its end time is found by a periodic sweep and escalated through three levels — warning, escalated, alerted. No hardware, no sensor, nobody reporting it. Staff know before the next customer complains."],
    ["Incident analytics", "Total incidents, incidents by type, average resolution time, charger-failure and station-outage frequency, and how many reservations each touched — read only from incident records, never from bookings."],
    ["Delay analytics", "Total propagated delays, average delay, reservations affected per incident, the deepest cascade, and recovery success rate — a fourth separate source again."],
    ["Four sources, no overlap", "Schedule quality, reliability, incidents and delays are each computed independently. None recomputes what another already answers, so two dashboards cannot quietly disagree."],
  ];
  items.forEach((it, i) => {
    const y = 1.8 + i * 1.28;
    card(s, 0.6, y, 12.1, 1.14, i === 3 ? C.light : C.white);
    iconCircle(s, 0.9, y + 0.31, String(i + 1), i === 3 ? C.volt : C.primary, i === 3 ? C.ink : C.white, 0.52);
    s.addText(it[0], { x: 1.6, y: y + 0.14, w: 10.9, h: 0.32, fontFace: B, fontSize: 14.5, bold: true, color: C.ink, margin: 0 });
    s.addText(it[1], { x: 1.6, y: y + 0.47, w: 10.9, h: 0.6, fontFace: B, fontSize: 11.5, color: C.inkSoft, margin: 0 });
  });
  speaker(s, "Abdel Aziz");
  s.addNotes("EXTRA TIME ONLY. Abdel Aziz. 60 seconds. The point is that nobody triggers any of this. Time does.");
}

/* ================================================ E4. UNDER THE SURFACE */
{
  const s = pres.addSlide();
  s.background = { color: C.canvas };
  titleBar(s, "Two more things under the surface", "Extra time");

  card(s, 0.6, 1.85, 5.95, 2.4, C.white);
  iconCircle(s, 0.9, 2.1, "$", C.primary, C.white, 0.5);
  s.addText("The full deposit arithmetic", { x: 1.55, y: 2.15, w: 4.7, h: 0.35, fontFace: H, fontSize: 18, bold: true, color: C.ink, margin: 0 });
  s.addText("Beyond the 24-hour rule: every deposit, refund and forfeiture is recorded with its reason and the cutoff that applied, snapshotted per reservation so a later policy change cannot rewrite an old decision. One service enforces it — used by the app, the desk and the background sweeps alike. There is no second copy of the rules to fall out of step.", {
    x: 0.9, y: 2.62, w: 5.4, h: 1.5, fontFace: B, fontSize: 11.5, color: C.inkSoft, margin: 0 });

  card(s, 6.75, 1.85, 5.95, 2.4, C.white);
  iconCircle(s, 7.05, 2.1, "⚡", C.volt, C.ink, 0.5);
  s.addText("Manufacturer-agnostic vehicles", { x: 7.7, y: 2.15, w: 4.7, h: 0.35, fontFace: H, fontSize: 18, bold: true, color: C.ink, margin: 0 });
  s.addText("There is no universal API for electric cars. So the platform talks to a vehicle through one uniform interface resolved at runtime from a registry: supporting a new manufacturer is one implementation plus one registry entry, and nothing else changes. We run it end to end against a simulated provider — the architecture is real, the readings are generated.", {
    x: 7.05, y: 2.62, w: 5.4, h: 1.5, fontFace: B, fontSize: 11.5, color: C.inkSoft, margin: 0 });

  card(s, 0.6, 4.5, 12.1, 1.5, C.voltLight);
  s.addText("Why these were the ones we cut", { x: 0.95, y: 4.68, w: 11.4, h: 0.35, fontFace: B, fontSize: 15, bold: true, color: C.ink, margin: 0 });
  s.addText("Not because they are unfinished, but because each is a supporting decision rather than the argument itself. Given twenty minutes we would rather prove that two people cannot book the same charger than explain how we would connect to a Tesla.", {
    x: 0.95, y: 5.06, w: 11.4, h: 0.8, fontFace: B, fontSize: 12.5, color: C.inkSoft, margin: 0 });
  speaker(s, "Malik");
  s.addNotes("EXTRA TIME ONLY. Malik. 60 seconds. Say the closing line. Being able to explain what you cut, and why, reads as judgement rather than omission.");
}

/* ================================================ E5. EXTENDED CLOSE */
{
  const s = pres.addSlide();
  s.background = { color: C.ink };
  s.addShape(pres.ShapeType.ellipse, { x: 10.2, y: -1.0, w: 4.8, h: 4.8, fill: { color: C.dark }, line: { color: C.dark } });
  s.addText("Thank you for the extra time", { x: 0.9, y: 2.2, w: 8.6, h: 0.9, fontFace: H, fontSize: 36, bold: true, color: C.white, margin: 0 });
  s.addText("Everything in this section runs on the same real code and the same real database as everything before it.", {
    x: 0.9, y: 3.2, w: 8.2, h: 0.8, fontFace: B, fontSize: 16, color: "C9D6D0", margin: 0 });
  s.addText("Now we would genuinely like your questions.", { x: 0.9, y: 4.5, w: 8.4, h: 0.5, fontFace: H, fontSize: 24, bold: true, color: C.volt, margin: 0 });
  s.addText("Malik  ·  Abdel Aziz  ·  Aya", { x: 0.9, y: 5.9, w: 8, h: 0.3, fontFace: B, fontSize: 12, color: "7E918A", margin: 0 });
  s.addNotes("EXTRA TIME ONLY. Malik closes and opens questions with the same warmth as the base ending.");
}

pres.writeFile({ fileName: process.env.OUT || "ChargeHub-Presentation.pptx" }).then((f) => {
  console.log("Wrote", f);
});
