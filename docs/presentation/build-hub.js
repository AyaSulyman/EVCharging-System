/**
 * Builds scripts-hub.html by extracting the <main> of each presenter script.
 *
 * WHY GENERATED RATHER THAN HAND-WRITTEN. The three scripts are the source of truth and have already
 * been re-timed twice. A hand-copied hub would silently drift the moment one of them changes, and a
 * presenter reading a stale copy is worse than no hub at all. Re-run this after editing any script:
 *
 *     node build-hub.js
 */
const fs = require("fs");
const path = require("path");

const PEOPLE = [
  { key: "malik", file: "script-malik.html", name: "Malik", accent: "malik",
    role: "Reservation logic · optimization · business value",
    time: "8:15", owns: "Opens and closes the talk. The problem, the optimizer, reliability, business value, the final lesson, and the request for extra time.",
    qa: "Leads Q&A. Booking rules, optimizer, reliability, business value." },
  { key: "abdelaziz", file: "script-abdelaziz.html", name: "Abdel Aziz", accent: "aziz",
    role: "Architecture · database · operator side",
    time: "7:00", owns: "Architecture and the database rule, what was built, what is not in the demo, the deposit rules, and the design lessons.",
    qa: "Database, back end, operator side, deposits and refunds." },
  { key: "aya", file: "script-aya.html", name: "Aya", accent: "aya",
    role: "Page rendering · customer journey · demo · analytics",
    time: "6:45", owns: "How pages are rendered, the results and analytics, and what comes next. Narrates the capacity-recovery video.",
    qa: "Screens, customer journey, rendering, analytics, what is not built." },
];


/**
 * Splits a presenter's <main> into its individual `<div class="seg">` blocks and reads the leading
 * slide number out of each heading, so all three scripts can be merged into one slide-ordered view.
 *
 * Segments with no slide number in the heading — the video beats, the extra-time ask, the Q&A block —
 * cannot be placed on the slide axis, so they are kept in their author's own order and appended after
 * the numbered ones rather than being dropped or guessed at.
 */
function splitSegments(body) {
  const parts = body.split('<div class="seg">').slice(1);
  return parts.map((raw) => {
    const html = '<div class="seg">' + raw;
    const head = (html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [, ""])[1];
    const m = head.match(/Slides?\s*(\d+)/);
    const title = head.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return { html, order: m ? Number(m[1]) : Number.POSITIVE_INFINITY, title };
  });
}

function extractMain(html) {
  const m = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (!m) throw new Error("no <main> found");
  return m[1].trim();
}

const panels = PEOPLE.map((p) => {
  const src = fs.readFileSync(path.join(__dirname, p.file), "utf8");
  return { ...p, body: extractMain(src) };
});


/* Merge every segment from all three scripts into one slide-ordered timeline. */
const CLS = { malik: "m", aziz: "z", aya: "y" };
const merged = [];
panels.forEach((p) => {
  splitSegments(p.body).forEach((seg, i) => {
    merged.push({ ...seg, owner: p.name, cls: CLS[p.accent], tie: i });
  });
});
merged.sort((a, b) => {
  if (a.order !== b.order) return a.order - b.order;
  if (a.owner !== b.owner) return a.owner.localeCompare(b.owner);
  return a.tie - b.tie;
});
const mergedHtml = merged
  .map((x) => {
    const label = x.order === Number.POSITIVE_INFINITY ? "no slide" : "slide " + x.order;
    return `<div class="${x.cls} merged-item">
  <div class="merged-tag"><span class="merged-who">${x.owner}</span><span class="merged-slide">${label}</span></div>
  ${x.html}
</div>`;
  })
  .join("\n");

const total = "22:00";

const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ChargeHub — All Presenter Scripts</title>
<style>
  :root[data-theme="light"] {
    --bg:#F4F7F9; --panel:#FFFFFF; --panel-2:#EDF3F6; --line:#DBE4EA;
    --ink:#0D1A22; --soft:#4C6270; --dim:#7B8F9B;
    --primary:#0E7A5F; --primary-soft:#E4F4EF; --dark:#0A5C48;
    --volt:#B87400; --volt-soft:#FDF3E0;
    --malik:#B87400; --aziz:#1B6CA8; --aya:#7B3FBF;
    --shadow:0 1px 2px rgba(13,26,34,.06), 0 10px 24px rgba(13,26,34,.07);
  }
  :root[data-theme="dark"] {
    --bg:#0B1014; --panel:#131C22; --panel-2:#1A252D; --line:#25353F;
    --ink:#E8F1F5; --soft:#93AAB6; --dim:#637986;
    --primary:#2DD4A7; --primary-soft:#0F2A24; --dark:#2DD4A7;
    --volt:#F5A524; --volt-soft:#3A2C10;
    --malik:#F5A524; --aziz:#4EA8DE; --aya:#C77DFF;
    --shadow:0 1px 0 rgba(255,255,255,.04), 0 10px 26px rgba(0,0,0,.5);
  }
  * { box-sizing:border-box; }
  html { scroll-behavior:smooth; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:15px/1.65 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif; }

  .bar { position:sticky; top:0; z-index:60; background:color-mix(in srgb,var(--bg) 88%,transparent);
         backdrop-filter:blur(12px); border-bottom:1px solid var(--line); }
  .bar-in { max-width:1140px; margin:0 auto; padding:10px 20px; display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  .brand { font-weight:800; letter-spacing:-.02em; display:flex; align-items:center; gap:8px; }
  .brand .dot { width:9px; height:9px; border-radius:50%; background:var(--primary); box-shadow:0 0 12px var(--primary); }
  .navlinks { display:flex; gap:4px; flex-wrap:wrap; margin-left:auto; }
  .navlinks a, .toggle { display:inline-flex; align-items:center; gap:6px; min-height:38px; padding:0 12px;
    border:1px solid var(--line); border-radius:9px; background:var(--panel); color:var(--soft);
    font-size:12.5px; font-weight:600; text-decoration:none; cursor:pointer; transition:.15s; }
  .navlinks a:hover, .toggle:hover { color:var(--ink); border-color:var(--primary); }
  .navlinks a.here { color:var(--ink); border-color:var(--primary); background:var(--primary-soft); }

  header.hero { max-width:1140px; margin:0 auto; padding:34px 20px 6px; }
  .kicker { color:var(--primary); font-size:11.5px; font-weight:800; letter-spacing:.18em; text-transform:uppercase; }
  h1.title { margin:10px 0 8px; font-size:clamp(26px,4vw,38px); letter-spacing:-.03em; line-height:1.1; }
  .lede { color:var(--soft); max-width:64ch; }

  /* dashboard */
  .dash { max-width:1140px; margin:22px auto 0; padding:0 20px;
          display:grid; grid-template-columns:repeat(auto-fit,minmax(250px,1fr)); gap:14px; }
  .card { text-align:left; border:1px solid var(--line); border-radius:15px; background:var(--panel);
          padding:18px; cursor:pointer; box-shadow:var(--shadow); transition:.16s; font:inherit; color:inherit; }
  .card:hover { transform:translateY(-2px); border-color:var(--accent); }
  .card[aria-selected="true"] { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent) inset, var(--shadow); }
  .card .nm { font-size:21px; font-weight:800; letter-spacing:-.02em; color:var(--accent); }
  .card .rl { color:var(--soft); font-size:13px; margin-top:3px; }
  .card .tm { margin-top:12px; font-size:27px; font-weight:800; font-variant-numeric:tabular-nums; letter-spacing:-.03em; }
  .card .tl { font-size:10.5px; text-transform:uppercase; letter-spacing:.12em; color:var(--dim); font-weight:800; }
  .card .ow { margin-top:10px; font-size:12.5px; color:var(--soft); border-top:1px solid var(--line); padding-top:9px; }
  .m { --accent:var(--malik); } .z { --accent:var(--aziz); } .y { --accent:var(--aya); }

  .totalbar { max-width:1140px; margin:14px auto 0; padding:0 20px; color:var(--dim); font-size:13px; }

  main { max-width:1140px; margin:0 auto; padding:22px 20px 90px; }
  .panel { display:none; }
  .panel.on { display:block; animation:fade .22s ease; }
  @keyframes fade { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:none; } }
  .panel-head { display:flex; align-items:center; gap:12px; margin:0 0 4px; padding-bottom:14px; border-bottom:2px solid var(--accent); }
  .panel-head h2 { margin:0; font-size:23px; letter-spacing:-.02em; }
  .panel-head .badge { margin-left:auto; background:var(--accent); color:var(--bg); font-weight:800;
                       border-radius:999px; padding:4px 13px; font-size:13px; font-variant-numeric:tabular-nums; }
  .qa-note { margin:14px 0 0; font-size:13px; color:var(--soft); }

  /* ---- styles for the injected script markup ---- */
  .panel .seg { background:var(--panel); border:1px solid var(--line); border-radius:14px; margin:18px 0;
                overflow:hidden; box-shadow:var(--shadow); }
  .panel .seg > h2 { margin:0; padding:14px 18px; background:var(--panel-2); color:var(--ink); font-size:16px;
                     display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
  .panel .seg > h2 .meta { font-size:11.5px; font-weight:800; color:var(--accent); white-space:nowrap; }
  .panel .body { padding:18px; }
  .panel .say { border-left:3px solid var(--primary); background:var(--primary-soft); padding:11px 15px;
                margin:12px 0; border-radius:0 9px 9px 0; }
  .panel .say p { margin:0 0 9px; } .panel .say p:last-child { margin:0; }
  .panel .do { background:var(--volt-soft); border:1px solid var(--volt); border-radius:10px; padding:11px 15px; margin:12px 0; }
  .panel .do b { color:var(--volt); }
  .panel .trans { background:var(--ink); color:var(--bg); border-radius:10px; padding:11px 15px; margin:14px 0 4px; }
  .panel .trans b { color:var(--volt); }
  .panel .warn { border:1px dashed var(--volt); background:var(--volt-soft); border-radius:10px; padding:11px 15px; margin:12px 0; }
  .panel ol.steps { counter-reset:s; list-style:none; padding:0; margin:10px 0; }
  .panel ol.steps > li { counter-increment:s; position:relative; padding:12px 12px 12px 50px; margin:8px 0;
                         background:var(--bg); border:1px solid var(--line); border-radius:10px; }
  .panel ol.steps > li::before { content:counter(s); position:absolute; left:12px; top:12px; width:26px; height:26px;
                                 background:var(--accent); color:var(--bg); border-radius:8px; display:flex;
                                 align-items:center; justify-content:center; font-weight:800; font-size:13px; }
  .panel .pill { display:inline-block; background:var(--accent); color:var(--bg); border-radius:999px;
                 padding:2px 10px; font-size:11.5px; font-weight:700; }
  .panel code { background:var(--panel-2); border:1px solid var(--line); padding:1px 6px; border-radius:5px;
                font-size:12.5px; font-family:ui-monospace,Consolas,monospace; }
  .panel table { width:100%; border-collapse:collapse; margin:10px 0; font-size:13.5px; }
  .panel th, .panel td { text-align:left; padding:9px 11px; border-bottom:1px solid var(--line); vertical-align:top; }
  .panel th { background:var(--panel-2); font-size:10.5px; text-transform:uppercase; letter-spacing:.1em; color:var(--dim); }
  .panel ul { margin:8px 0 0; padding-left:20px; } .panel li { margin:4px 0; }

  .card.all { --accent:var(--volt); }
  .merged-item { position:relative; }
  .merged-tag { display:flex; align-items:center; gap:8px; margin:20px 0 -8px; }
  .merged-who { background:var(--accent); color:var(--bg); font-weight:800; font-size:11.5px;
                letter-spacing:.04em; text-transform:uppercase; border-radius:999px; padding:3px 11px; }
  .merged-slide { font-size:11.5px; font-weight:700; color:var(--dim); text-transform:uppercase; letter-spacing:.08em; }
  footer { max-width:1140px; margin:0 auto; padding:0 20px 60px; color:var(--dim); font-size:13px; }
  @media print { .bar,.dash,.totalbar { display:none; } .panel { display:block !important; } body { background:#fff; } }
</style>
</head>
<body>

<div class="bar"><div class="bar-in">
  <div class="brand"><span class="dot"></span> ChargeHub Scripts</div>
  <nav class="navlinks">
    <a href="demo-playbook.html">🎬 Demo playbook</a>
    <a class="here" href="scripts-hub.html">📑 All scripts</a>
    <a href="script-malik.html">Malik</a>
    <a href="script-abdelaziz.html">Abdel Aziz</a>
    <a href="script-aya.html">Aya</a>
    <button class="toggle" id="themeBtn" type="button">◐ Theme</button>
  </nav>
</div></div>

<header class="hero">
  <div class="kicker">Presenter scripts · all three in one place</div>
  <h1 class="title">Pick a presenter</h1>
  <p class="lede">The same scripts each of you has been rehearsing, collected so the handovers can be
  checked against each other. Every segment shows its timing and who passes to whom.</p>
</header>

<div class="dash" role="tablist">
${panels.map((p, i) => `  <button class="card ${p.accent === "malik" ? "m" : p.accent === "aziz" ? "z" : "y"}" role="tab"
          id="tab-${p.key}" aria-controls="panel-${p.key}" aria-selected="${i === 0}" data-key="${p.key}">
    <div class="nm">${p.name}</div>
    <div class="rl">${p.role}</div>
    <div class="tm">${p.time}</div>
    <div class="tl">speaking time</div>
    <div class="ow">${p.owns}</div>
  </button>`).join("\n")}
  <button class="card all" role="tab" id="tab-all" aria-controls="panel-all" aria-selected="false" data-key="all">
    <div class="nm">Everyone</div>
    <div class="rl">All three scripts merged</div>
    <div class="tm">${total}</div>
    <div class="tl">in slide order</div>
    <div class="ow">Every segment from all three presenters, sorted by slide number. Use this to rehearse the handovers.</div>
  </button>
</div>
<div class="totalbar">Total speaking time <b>${total}</b> — plus Q&amp;A. Videos add 11:30 inside that.</div>

<main>
${panels.map((p, i) => `<section class="panel ${p.accent === "malik" ? "m" : p.accent === "aziz" ? "z" : "y"} ${i === 0 ? "on" : ""}"
         id="panel-${p.key}" role="tabpanel" aria-labelledby="tab-${p.key}">
  <div class="panel-head">
    <h2>${p.name}</h2>
    <span class="badge">${p.time}</span>
  </div>
  <p class="qa-note"><b>In Q&amp;A you take:</b> ${p.qa}</p>
${p.body}
</section>`).join("\n\n")}
<section class="panel" id="panel-all" role="tabpanel" aria-labelledby="tab-all">
  <div class="panel-head" style="--accent:var(--volt)">
    <h2>Everyone, in slide order</h2>
    <span class="badge" style="background:var(--volt)">${total}</span>
  </div>
  <p class="qa-note">Every segment from all three scripts, ordered by the slide it belongs to. The
  coloured name above each block is who speaks it. Blocks with no slide number — the video beats, the
  extra-time ask, the Q&amp;A notes — come last, in their author's own order.</p>
${mergedHtml}
</section>
</main>

<footer>Generated from the three script files by <code>build-hub.js</code> — re-run it after editing any
script so this page cannot drift out of date.</footer>

<script>
  (function () {
    var root = document.documentElement, KEY = "chargehub-theme";
    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) {}
    if (saved) root.setAttribute("data-theme", saved);
    else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches)
      root.setAttribute("data-theme", "dark");

    document.getElementById("themeBtn").addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem(KEY, next); } catch (e) {}
    });

    var tabs = document.querySelectorAll(".card[role=tab]");
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        tabs.forEach(function (t) { t.setAttribute("aria-selected", String(t === tab)); });
        document.querySelectorAll(".panel").forEach(function (p) {
          p.classList.toggle("on", p.id === "panel-" + tab.dataset.key);
        });
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
  })();
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(__dirname, "scripts-hub.html"), html, "utf8");
console.log("Wrote scripts-hub.html —", panels.map((p) => `${p.name} ${p.body.length}b`).join(", "));
