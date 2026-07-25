# AGENTS.md — how to work on ChargeHub

**You are an AI coding assistant working on a shared, three-person team project.** Read this
before writing code. It tells you what to read, how to verify your work, and which mistakes
this codebase has already been burned by.

`CLAUDE.md` (next to this file) is the **source of truth for what the project is and the
invariants you must not break**. This file is about *how to work*. Read both.

---

## 1. Read order — do this first, every session

1. **`CLAUDE.md`** — architecture, the 12-collection data model, and §2 **non-negotiable
   invariants**. Breaking one of those is a regression even if a task appears to ask for it.
2. **`docs/PROJECT_STATE.md`** — what is done, what is half-built, what is deliberately not
   built, and what the live database has and has not had applied to it. **This is the file that
   stops you re-implementing something that already exists or "fixing" something that is
   intentional.**
3. **`backend/AGENTS.md`** — the backend's Next.js version is newer than most training data.
   Read the installed docs before using an unfamiliar API.
4. Only then, the design docs relevant to your task (`docs/RESERVATION_*.md`).

If a request contradicts an invariant in `CLAUDE.md` §2, **stop and say so**. Do not silently
work around it, and do not silently implement the contradiction. Raising it is the expected
behaviour, not an obstruction.

---

## 2. Where code goes

```
backend/    API service — Next.js 16, headless (route handlers only). Port 4000.
frontend/   Client — Next.js 14 App Router, server-rendered public pages. Port 3000.
```

**There is no package.json at the repo root.** Every `npm` command runs from `backend/` or
`frontend/`. Running one from the root makes npm search parent directories and fail with a
confusing `ENOENT ... C:\Users\<you>\package.json`. This has already cost the team time —
if a script "does not exist", check your working directory first.

Backend request flow: **route handler → domain service → model → MongoDB.**

- Handlers are thin: parse, authorise, delegate. Business logic goes in `backend/src/services/`.
- Every write goes through a Zod schema in `backend/src/validation/`. **The schema is the
  allowlist** — Zod strips undeclared fields, so a client cannot write a field the schema does
  not list. Never `Object.assign` a raw request body onto a document.
- Services throw sentinel strings (`SLOT_UNAVAILABLE`); routes map them with
  `errorResponse(err, fallback, sentinels)`. Follow this convention rather than returning
  ad-hoc responses.
- The client holds **no** database access. Every read/write crosses the API boundary.

---

## 3. Verification — what "done" means

Run these from the app directory you changed. **Do not report work as finished without them.**

```bash
npx tsc --noEmit
```
```bash
npm run lint
```

Rules the team applies:

- **`tsc --noEmit` must be clean.** No exceptions.
- **Lint must introduce no new warnings in files you touched.** The repo has 15 pre-existing
  warnings in `src/providers/` and a few routes; that count is the baseline. Check the number
  before and after.
- `frontend`'s `npm run lint` may open an interactive Next.js ESLint setup prompt — there is no
  committed `eslint.config.*` there. That is a pre-existing condition. Treat `tsc --noEmit` as
  the authoritative frontend check.
- **Verify data-integrity claims against the live database**, don't assume. The team tests by
  querying MongoDB directly. Every `ops:*` script has a dry-run mode for exactly this.
- If tests or checks fail, **say so with the output**. Never describe work as verified when it
  is not.

---

## 4. Database changes

- **Additive only.** Never rename a collection or a field that has shipped. Never drop one.
- Note the naming: the `RESERVATION` entity lives in the **`bookings`** collection and
  `SITE_CONTENT` in **`banners`**.
- A new query pattern ships with its index, declared on the schema.
- **A rename is free only before a migration has been applied.** Once data exists in the new
  shape, renaming becomes a breaking change. If you are adding fields, settle their names
  *before* anyone runs the migration.
- **Never run a migration against the live database yourself.** Write it, run the dry run,
  report the findings, and let the repo owner trigger `--apply`. Every migration must snapshot
  to `backups/<timestamp>/` before writing and verify its own exit criteria afterwards.

---

## 5. Git conventions

- **Never add an AI co-author trailer.** No `Co-Authored-By: Claude`, no
  `🤖 Generated with...`, nothing naming an assistant. Write a clear subject and body, and stop.
  This is team style and it is not negotiable.
- **Never force-push.** The history is shared. Only ever rewrite commits that have not left
  your machine.
- Conventional-commit prefixes are used: `feat(scope):`, `fix(scope):`, `docs:`, `chore:`,
  `refactor:`.
- Write commit bodies that explain **why**, not just what. The existing history is the model —
  read a few with `git log -3 --stat` before writing your first.

---

## 6. Mistakes this codebase has already made

Read these. Every one of them cost real debugging time.

| Trap | What to do instead |
|---|---|
| Running `npm run <script>` from the repo root | `cd backend` or `cd frontend` first — there is no root package.json |
| Static-importing a service into an `ops:*` script | Imports are hoisted **above** `dotenv`'s `config()`, so `config/database` throws on an empty env. Use `await import()` inside the function, as `ensure-indexes.ts` and `expire-commitments.ts` do |
| Assuming `status` and `lifecycle` on a booking are duplicates | They are not. See `CLAUDE.md` §2 — deleting either one breaks the system in a different way |
| "Harmonising" the 15-minute grace period and the 10-minute deposit window | They measure different things (crossing a city vs. tapping a phone). Both constants carry their reasoning in a comment. Leave them |
| Adding a `pre("save")` hook to a Mongoose 9 schema | Its typed hook overloads reject `"save"`. Use **default functions** instead — they also run when an older document missing the path is hydrated, which is usually what you actually wanted |
| Calling a notification/waitlist/optimizer function inline from a domain service | Those must stay **consumers** of `reservationevents`. See `CLAUDE.md` §7 |
| Promoting a reservation to confirmed from a route handler | `PENDING_PAYMENT → RESERVED` happens in exactly one function. See `CLAUDE.md` §2 |
| Building a card-entry form for the deposit flow | **Never.** No card data exists anywhere in this system. Mock outcomes come from an explicit "simulate" control |
| `requireAuth(req)` without `await` | Silently drops the auth gate. These are async |
| Using `aggregate()` and forgetting `select:false` | Aggregation bypasses it. Exclude `passwordHash`, `qrCode`, `sessionGeneration` explicitly |

---

## 7. What is real vs. simulated — never misrepresent this

The team presents this project. Claiming a capability it does not have is worse than the gap.

- **Vehicle telemetry is simulated** via `MockProvider`. The architecture is real; the data is
  generated. Connecting as **Tesla** returns an error by design (no real credentials) — use
  **Mock**.
- **Deposits are a real state machine behind a mock gateway.** The hold window, expiry, refund
  cutoff, operator-fault waiver and no-show forfeiture all genuinely work. **No money moves and
  no card data is collected.** Say "simulated payment", never "payment".
- **Notifications**: the store and the read/mark-read UI are complete, but nothing generates
  them from events yet. The samples are seeded.
- **`reservationevents` has no consumers.** Events are written; nothing reads them yet.
- **No energy metering, no charging-hardware control.** By design.
- All money figures are labelled **estimated** or **simulated**.

---

## 8. Scope discipline

- Do what was asked. If you notice something else worth fixing, mention it rather than bundling
  it in — an unrelated change hidden in a feature commit is hard for a teammate to review.
- Do not stub endpoints for features that do not exist to make a list look complete. If a
  requested capability depends on a system that has not been built, **say which one**.
- Prefer extending an existing service over creating a parallel one.
- When a design decision is genuinely the owner's call (business policy, money, UX tradeoffs),
  ask. When it is technical, decide and explain the reasoning.
