# How Next.js Rendering Works in ChargeHub

A reference for the rendering model this project actually uses — not Next.js in general.
Every claim below was checked against the code, and the file lists are exhaustive as of
this writing.

---

## 1. Two applications, one framework — only one of them renders

| App | Role | Renders UI? |
|---|---|---|
| `frontend/` | Client application, Next.js 14 App Router | **Yes** — everything below applies here |
| `backend/` | Headless API service, Next.js 16 App Router | **No** — it uses Route Handlers only |

The API service uses Next.js purely as an HTTP layer. It contains **15 route handler files**
under `backend/src/app/api/` and exactly one `page.tsx`, which is a static "this is the API"
notice. When we talk about rendering strategy, we are talking about `frontend/`.

This matters for the presentation: *"we used Next.js for the backend"* means we used its
routing and request handling, not its rendering.

---

## 2. The default that surprises people

In the App Router, **every component is a Server Component unless you opt out.** Adding
`"use client"` at the top of a file moves it — and everything it imports — to the browser.

So the interesting question in our codebase is never "did we make this a server component?"
It is **"why did we have to opt this one out?"**

Current split in `frontend/src`:

- **11 server-rendered pages**
- **14 client-rendered pages** (`"use client"`)
- **9 client components** (Toast, Navbar, ChatWidget, Charts, HeroSlider, StationsFilter,
  AdminSidebar, AdminChargerControls, Providers)

---

## 3. The four rendering modes present in this project

### 3.1 Static rendering — rendered once at build time

Pages with no data fetching and no dynamic configuration. Next.js renders them to HTML at
build time and serves the same HTML to everyone.

`(public)/about` · `(public)/how-it-works` · `(public)/privacy` · `(public)/terms`

These are our cheapest and fastest pages. Nothing about them changes per request.

### 3.2 Dynamic server rendering — rendered on the server, per request

The page is an `async` Server Component that awaits data before producing HTML. The user
receives a complete page; there is no loading spinner and no empty first paint.

Marked with `export const dynamic = "force-dynamic"`:

| Page | Why it must be per-request |
|---|---|
| `(public)/page.tsx` (home) | Live availability counts and homepage banners |
| `(public)/stations` | Live "X of Y chargers free" |
| `(public)/stations/[id]` | Live charger status for one station |
| `(public)/qr/[chargerId]` | A scanned bay's status must be current, never cached |
| `(dashboard)/dashboard` | The signed-in driver's own reservations |
| `(admin)/admin` | Operator metrics |
| `(admin)/admin/stations` | Charger availability |

**This is the mode that carries the product.** Station discovery and the QR landing page are
the two paths where a stale number would be actively misleading — a driver must not be shown
a free charger that was taken thirty seconds ago.

### 3.3 Client rendering — rendered in the browser after load

Pages marked `"use client"`. They render a shell, then fetch data from the API service with
the session's bearer token and fill themselves in.

Reservation wizard · confirmation · my reservations · vehicles · recommendations ·
notifications · profile · login · register · contact · FAQ · admin bookings · admin slots ·
admin users · admin reports

**Two distinct reasons drove these**, and it is worth being able to separate them:

1. **Interactivity.** The reservation wizard holds multi-step state, the vehicle garage has
   forms, the reports screen filters on the client. These need `useState`, `useEffect` and
   event handlers, none of which exist in a Server Component.
2. **The bearer token lives on the client.** `useApi()` reads the credential from the
   NextAuth session with `useSession()`, which is a client hook. Any screen fetching
   user-scoped data through that helper is therefore client-rendered.

### 3.4 Time-based revalidation (ISR) — configured, and currently inert

`lib/backend.ts` fetches homepage banners with `next: { revalidate: 60 }` — cache the
response, refresh at most once a minute.

**It has no effect right now.** The only page that calls it is the homepage, which is
`force-dynamic`, and that opts the entire route out of caching. The revalidate hint is
dead configuration.

This is not a bug — the page is correct either way — but it is a good example of how route
segment config overrides fetch-level config. If we ever want banners cached, the homepage
would need to stop being `force-dynamic`, and its live availability counts would then need
to move into a client component or a separately-revalidated segment.

---

## 4. How data reaches a page in each mode

The rule that shapes everything: **the client application holds no database access.** Every
read crosses the API boundary. What differs is *where* the fetch runs.

**Server-rendered pages** call helpers in `lib/data.ts` (public data) or use
`getBackendToken()` from `lib/session.ts` to read the session on the server and attach the
credential themselves. `lib/admin.ts` does this for operator statistics. The browser never
sees the token.

**Client-rendered pages** call `useApi()`, which pulls the token from the client session and
attaches it to `fetch`.

**Cache behaviour:** `lib/apiClient.ts` sets `cache: "no-store"` on every request, so no API
response is ever cached by Next.js. Given the product is about live availability, that is the
right default — but it does mean we currently get no caching benefit anywhere, which is a
tuning opportunity rather than a defect.

---

## 5. Route groups and layouts

Four route groups, written in parentheses so they **organise files without appearing in the
URL**:

```
(public)     → /, /stations, /qr/[chargerId], /about …
(auth)       → /login, /register
(dashboard)  → /dashboard, /book, /vehicles …
(admin)      → /admin, /admin/bookings …
```

Each group owns a `layout.tsx`, so each area gets its own shell — public gets the navbar and
footer, auth gets a centred minimal frame, dashboard gets the authenticated shell plus the
chat widget, admin gets the sidebar. The root `app/layout.tsx` wraps all of them with the
session provider and global styles.

Layouts **persist across navigation** within their group: moving between admin screens does
not re-render the sidebar.

---

## 6. Metadata and discoverability

Server rendering is what makes the public pages indexable — a crawler receives finished HTML
rather than an empty shell.

- `app/layout.tsx` — site-wide defaults
- `(public)/stations`, `/about`, `/how-it-works`, `/privacy`, `/terms` — static `metadata`
  exports
- `(public)/stations/[id]` — **`generateMetadata()`**, producing a per-station title and
  description at request time

Client-rendered pages cannot export metadata, which is a second reason the public surface is
server-rendered and the driver area is not.

---

## 7. Suspense

Used in exactly two places: the reservation wizard and the confirmation page.

Both call `useSearchParams()` — reading `?station=`, `?charger=`, `?code=` from the URL —
and Next.js requires any component doing that to sit inside a `<Suspense>` boundary. Without
it the build fails. So our use of Suspense is a **requirement of the hook**, not a
performance optimisation. Worth knowing if a mentor asks whether we are streaming: we are
not, in any meaningful sense.

---

## 8. Middleware

`frontend/src/middleware.ts` runs **before** a request reaches any page, on the edge runtime.
It guards eight route trees and redirects non-operators away from `/admin`.

Because it runs before rendering, an unauthenticated user never causes a protected page to
render at all. This is a different layer from the API service's own authorisation — the
middleware controls *navigation*, `requireAuth` controls *data*. Both exist deliberately: the
middleware alone would be trivially bypassed by calling the API directly.

---

## 9. Choosing a mode — the working rule

```
Does the page need interactivity, forms, or the client session token?
        │
        ├── yes ──────────────► "use client"
        │
        └── no
             │
             Does it show data that changes?
                     │
                     ├── yes ──► Server Component + force-dynamic
                     │
                     └── no ───► Server Component, static by default
```

---

## 10. Known inconsistencies in our own code

Honest notes, in case a mentor probes:

1. **The dead `revalidate: 60`** described in §3.4.
2. **The admin area mixes modes.** `admin/page.tsx` and `admin/stations/page.tsx` are
   server-rendered using `getBackendToken()`, while bookings, slots, users and reports are
   client-rendered using `useApi()`. Both work; the split follows whether the screen needs
   interactivity, but it was not a deliberate policy.
3. **`cache: "no-store"` everywhere** means no request is ever reused, including genuinely
   static reference data such as the station catalogue.
4. **The two apps are on different Next.js majors** (14 and 16). Route handler signatures
   differ between them — for example dynamic route params are awaited in the API service and
   not in the client app.

None of these affects correctness. They are the honest answer to "what would you improve?"

---

## 11. If this comes up in the presentation

The rendering model is worth about ninety seconds, and the strongest framing is a decision
rather than a feature list:

> "Public pages are server-rendered so a driver — and a search engine — gets real
> availability in the first response. The driver's own area is client-rendered because it
> needs the session token and multi-step interaction. The QR landing page is deliberately
> never cached, because showing a bay as free when it was taken thirty seconds ago is the
> one failure this product exists to prevent."

That answers *what* we used, *why*, and ties it back to the problem — which is more
persuasive than listing SSR, SSG and ISR as terms.
