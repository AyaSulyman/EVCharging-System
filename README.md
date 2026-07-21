# ⚡ ChargeHub — EV Charging Station Reservation System

A full-stack EV charging reservation platform for a company operating multiple
charging branches. Drivers discover stations, check **live** charger
availability, reserve time slots, manage their vehicles, get **battery-aware
recommendations**, and access chargers via **QR codes**. Admins manage
stations, chargers, bookings, slots, and view reports.

Built with **Next.js 14 (App Router)**, **TypeScript**, **Tailwind CSS**,
**MongoDB/Mongoose**, and **NextAuth**.

---

## ✨ Features

**For drivers**
- Browse stations with live "X of Y chargers free" availability
- Filter stations by connector type (CCS / CHAdeMO / Type 2) and charging speed
- 4-step booking wizard (Station → Charger → Time slot → Confirm)
- Booking confirmation with **QR code** + add-to-calendar (`.ics`)
- Manage bookings (upcoming / past / cancelled, with cancel)
- Add vehicles and **connect them via a provider** (Tesla-ready architecture)
- **Battery-aware recommendations** — combines battery %, range, location, and
  live availability to suggest the best charger
- In-app **AI assistant** grounded in real database data
- Notifications

**For admins**
- Dashboard with KPIs and charts (bookings over time, status split, utilization)
- Manage stations & chargers (status, pricing)
- Bookings management (search, filter, update status)
- Generate booking slots (rolling availability)
- Users list
- **Reports** with date-range filtering and **CSV export**

**Under the hood**
- **Vehicle Provider architecture** — a single `VehicleProvider` interface with
  swappable implementations (`TeslaProvider`, `MockProvider`). Adding a new
  manufacturer means adding one provider, not rewriting the app. See
  [`src/providers`](src/providers).
- **Double-booking prevention** — a unique compound index on
  `(chargerId, startTime)` plus an atomic `findOneAndUpdate` slot claim, so two
  users can never grab the same slot.
- Auth with NextAuth (credentials + JWT sessions) and route protection via
  middleware.

---

## 🧱 Tech stack

| Layer      | Choice                                        |
| ---------- | --------------------------------------------- |
| Framework  | Next.js 14 (App Router, Server Components)    |
| Language   | TypeScript (strict)                           |
| Styling    | Tailwind CSS (custom design system)           |
| Database   | MongoDB + Mongoose                            |
| Auth       | NextAuth (Credentials provider, JWT)          |
| Charts     | Recharts                                      |
| Icons      | lucide-react                                  |
| Validation | Zod                                           |

> We intentionally use **Next.js full-stack** (API routes + server actions)
> rather than a separate Express server — for this scope it removes a whole
> layer without losing anything.

---

## 🚀 Getting started

### Prerequisites
- **Node.js 18.17+**
- **MongoDB** — either a local install (`mongod`) or a free
  [MongoDB Atlas](https://www.mongodb.com/atlas) cluster

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
Copy the example env file and fill in your values:
```bash
cp .env.example .env.local
```
Then edit `.env.local`:
```
MONGODB_URI=mongodb://localhost:27017/chargehub
NEXTAUTH_SECRET=<run: openssl rand -base64 32>
NEXTAUTH_URL=http://localhost:3000
```
> If you use MongoDB Atlas, paste your `mongodb+srv://…` connection string as
> `MONGODB_URI` instead.

### 3. Seed the database
This creates the stations, chargers, demo users, vehicles, slots, and sample
bookings:
```bash
npm run seed
```

### 4. Run the app
```bash
npm run dev
```
Open **http://localhost:3000**.

---

## 🔑 Demo accounts

After seeding, log in with:

| Role  | Email                  | Password    |
| ----- | ---------------------- | ----------- |
| User  | `user@chargehub.com`   | `User123!`  |
| Admin | `admin@chargehub.com`  | `Admin123!` |

The admin panel is at **/admin** (visible in the account menu when logged in as
the admin).

---

## 📁 Project structure

```
src/
├── app/
│   ├── (public)/       # Homepage, stations, FAQ, about, contact, legal, QR
│   ├── (auth)/         # Login, register
│   ├── (dashboard)/    # Dashboard, booking, vehicles, recommendations, profile
│   ├── (admin)/        # Admin dashboard, stations, bookings, slots, reports
│   ├── api/            # Route handlers (bookings, vehicles, chat, etc.)
│   └── layout.tsx      # Root layout
├── components/         # UI, layout, station, booking, admin, chat components
├── lib/                # db, auth, session, data helpers, utils, validations
├── models/             # Mongoose schemas
├── providers/          # Vehicle provider interface + Tesla/Mock implementations
├── seed/               # Database seed script
├── types/              # Shared TypeScript types
└── middleware.ts       # Route protection
```

---

## 🔌 About the Tesla / vehicle integration

The platform is designed to talk to real EV manufacturer APIs through the
**provider interface** in [`src/providers`](src/providers). The `TeslaProvider`
is written against Tesla's Fleet API shape (connect, battery level, range,
location, charge state).

**Honest note:** full end-to-end Tesla validation requires access to a real
Tesla account and vehicle to authorize OAuth. Where a live vehicle isn't
available, the `MockProvider` returns realistic data so the full flow —
connection, sync, recommendations — is demonstrable. The architecture is the
deliverable; swapping in verified live credentials is a configuration step, not
a redesign.

---

## 🤖 About the AI assistant

The chat widget answers questions using **real database lookups** (your
bookings, nearest station, charger availability, pricing, recommendations) — it
does not make things up. If you set an optional `OPENAI_API_KEY` in `.env.local`,
it uses the model to phrase answers over that same data; without a key it falls
back to intent matching, so the feature works out of the box.

---

## 📜 Available scripts

| Script          | Description                        |
| --------------- | ---------------------------------- |
| `npm run dev`   | Start the dev server               |
| `npm run build` | Production build                   |
| `npm run start` | Run the production build           |
| `npm run seed`  | Seed / reset the database          |
| `npm run lint`  | Lint                               |

---

## 📝 Notes

- `node_modules` is **not** included in this archive — run `npm install` first.
- Re-running `npm run seed` **wipes and recreates** the seed data.
- Slots are seeded ~14 days ahead; use the admin **Slots** page to generate more.
