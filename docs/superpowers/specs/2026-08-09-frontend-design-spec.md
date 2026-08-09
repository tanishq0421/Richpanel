# Frontend Design Specification — Schedule Configuration & Resolution Time Report

**Date:** 2026-08-09
**Status:** Draft for product-owner review
**Author:** Frontend architecture / product design
**Scope:** The two-screen internal admin tool for Richpanel schedule configuration and resolution-time reporting.
**Companion documents:** `docs/superpowers/specs/2026-08-09-schedule-resolution-report-design.md` (system design), `docs/superpowers/specs/2026-08-09-schedule-resolution-report-backend.md` (backend spec).

---

## 0. How to read this document

Section 1 records what the backend **actually does**, verified by reading `backend/app/` and by executing the domain code — not by trusting the summary. Several behaviours differ from what the API surface suggests, and three of them are load-bearing for the UI design. Section 2 lists the gaps. Everything after that is the design.

Where a claim was proven by running code it is marked **[executed]**. Where it is a reading of the code path it is marked **[inferred]**.

---

## 1. Verified backend contract

Base path `/api/v1`. Read from `backend/app/api/v1/{agents,schedules,schedule_agents,reports}/`, `backend/app/services/`, `backend/app/domain/`, `backend/alembic/versions/0001_initial_schema.py`.

### 1.1 Endpoints

| Method | Path | Success | Response body | Notes |
|---|---|---|---|---|
| GET | `/agents?limit&offset` | 200 | `[{id, name, email\|null}]` | `limit` **capped at 200**, default 50. No total count. |
| GET | `/agents/{id}/schedules` | 200 | `[{id, name}]` | Returns **all** the agent's active schedules. No 404 for an unknown agent — returns `[]`. |
| POST | `/schedules` | 201 | `{id, name, start_date, end_date\|null, shifts:[{weekday, start_hours, end_hours}]}` | |
| GET | `/schedules?limit&offset` | 200 | `[Schedule]` | Active (non-soft-deleted) only, ordered by `id`. |
| GET | `/schedules/{id}` | 200 | `Schedule` | 404 if missing or soft-deleted. |
| PUT | `/schedules/{id}` | 200 | `Schedule` | Body `{shifts:[...]}` only. **Name and dates are not editable.** Can return 409. |
| GET | `/schedules/{id}/deletion-impact` | 200 | `{schedule_id, affected_agent_ids:[int]}` | IDs only — **no names**. |
| DELETE | `/schedules/{id}` | 204 | — | Soft delete; cascades to assignments and weekday-hours rows. |
| GET | `/schedules/{id}/agents` | 200 | `[{id, name}]` | |
| POST | `/schedules/{id}/agents` | 201 | **`null`** | Body `{agent_id}`. No response model on the handler. |
| DELETE | `/schedules/{id}/agents/{agent_id}` | 204 | — | Idempotent; never 404s. |
| POST | `/reports` | 201 | `{id, ticket_start_at, ticket_end_at, agent_hours:[{agent_id, business_seconds}]}` | Returns a row for **every agent**, unpaginated. **Not idempotent** — every call inserts a report row. |
| GET | `/reports?limit&offset` | 200 | `[Report]` | `agent_hours` is **always `[]`**. |
| GET | `/reports/{id}` | 200 | `Report` | Fully populated. 404 if missing. |

### 1.2 Error envelope — there are three shapes, not one

`backend/app/main.py` registers handlers for exactly `NotFoundError → 404 not_found`, `ConflictError → 409 conflict`, `DomainValidationError → 400 validation_error`, and a catch-all `Exception → 500 internal_error`.

1. **`{"error_code": str, "message": str}`** — 400, 404, 409, 500.
2. **`{"detail": [{loc, msg, type}, ...]}`** — 422, produced by FastAPI's own `RequestValidationError` handler, which is *not* overridden. **The 422 shape does not match the documented envelope.** The client error normaliser must handle both.
3. Non-JSON / transport failure — network error, no body.

Only four `error_code` values exist. Notably, **both overlap failures collapse to `error_code: "conflict"`** — the UI cannot distinguish "this schedule self-overlaps" from "an assigned agent would double-book" from the code alone.

### 1.3 Domain rules — confirmed

- `weekday`: 0 = Monday … 6 = Sunday. `(weekday + 1) % 7` for the overnight tail, so **a Sunday overnight shift wraps onto Monday** [executed].
- `start_hours` / `end_hours` are floats in `[0, 24)`. `22.5` = 22:30.
- **Exactly one window per weekday** is enforced by the DB, not by validation: unique partial index `schedule_weekday_hours_active_uniq (schedule_id, weekday, is_overnight_tail) WHERE deleted_at IS NULL`.
- **Overnight** = `end_hours <= start_hours`. `normalize_shift()` splits it into a primary row `start → 24:00` on the owning weekday plus a tail row `00:00 → end` on the next weekday with `is_overnight_tail = true` [executed]. `recombine_shifts()` merges them back for display, so the API's `shifts` array always shows the user's original logical shift.
- **Assignment overlap** is checked per agent across their other active schedules, under a `pg_advisory_xact_lock(agent_id)` — check and write share one transaction. Editing hours on a schedule (`PUT`) re-runs this check for **every** assignee, so an edit can be rejected because of an agent you are not currently looking at.
- **All times are IST (`Asia/Kolkata`), pinned as a constant** in `app/domain/types.py`. A naive datetime sent to `POST /reports` is interpreted as IST wall-clock; an aware one is converted. Responses are IST-aware (`+05:30`).
- Business-hours computation is O(1) in window length — a multi-year window is not a performance concern.

### 1.4 Float round-trip [executed]

`timedelta(hours=h + m/60).total_seconds() / 3600` round-trips exactly to the minute for the values probed (22:30, 09:10, 09:05, 17:55, 00:01, 23:59, 06:20, 13:40). But the JSON float itself is not exact — `09:10` travels as `9.166666666666666`. **The client must round in both directions** (`Math.round(hours * 60)`), and a property test must cover all 1440 minutes.

---

## 2. Backend gaps the frontend must design around

Ordered by impact on the UI. Each has a "what the UI does today" and a "what we are asking for".

### G1 — Four inputs return **500**, not a validation error [executed for a, b, c]

`ShiftInputSchema.to_domain()` and `normalize_shift()` are called **inside the route handler / service**, so the `ValueError`s they raise escape to the catch-all handler.

| Input | Result | Correct result |
|---|---|---|
| `start_hours == end_hours` (zero-length) | **500** `internal_error` | 422 |
| `end_hours: 0` with `start_hours > 0` ("ends at midnight") | **500** — tail row would be `00:00 → 00:00`, violating `ZERO < end_time` | 422, or accept it |
| Two non-overlapping windows on one weekday (e.g. Mon 09–12 **and** Mon 14–18) | **500** — passes `find_self_overlaps`, then violates the unique index; no `IntegrityError` handler exists [inferred] | 422 `one_window_per_weekday` |
| `end_date < start_date` | **500** — DB `CheckConstraint ck_schedules_date_range` fires, unhandled [inferred] | 422 |
| `end_hours: 24` | 422 (Pydantic `end_hours < 24`) — this one is at least the right status | — |

**Consequence: a 24-hour or 24/7 schedule is not expressible.** `00:00 → 24:00` is a 422 and `09:00 → 00:00` is a 500. The closest representable full day is `00:00 → 23:59`, losing one minute per day.

**UI today:** all four are blocked client-side before the request leaves. The time picker never offers `00:00` as an *end* value when a start is set; it offers `23:59` and labels it "end of day". The week editor structurally permits only one window per weekday. The date range picker enforces `end >= start`.
**Ask:** map `ValueError` and `IntegrityError` to 422 with distinct `error_code`s, and accept `end_hours: 24` to mean end-of-day (a one-line bound change in `ShiftInputSchema` plus `WeekdayShift`).

### G2 — The 409 body identifies nothing structurally

`AssignmentOverlapError` carries `agent_id` and a list of `Overlap(a, b)` objects with full weekday/time detail. **None of it reaches the wire.** The client gets `{"error_code": "conflict", "message": "agent 42 would have 2 overlapping shift(s)"}` — and the same `error_code` for a self-overlap.

**UI today (workaround, with cost):**
1. Before every write, the client runs the *same* overlap rule locally against the form values. If the local check finds a self-overlap, we render the precise message ourselves and never send the request.
2. If the server still 409s, the client fetches the affected agent's other schedules (`GET /agents/{id}/schedules`, then `GET /schedules/{id}` for each — bounded: an agent has 1–3 schedules) and recomputes the collision client-side to name the day and hours.
3. We do **not** regex the agent id out of `message`. That string is not a contract.

Cost: 2–4 extra round trips on the failure path, and one rule implemented twice.

**Ask:**
```json
{
  "error_code": "assignment_overlap",
  "message": "…",
  "agent_id": 42,
  "conflicts": [
    { "weekday": 1,
      "existing": { "schedule_id": 7, "schedule_name": "Night Desk", "start_hours": 0.0,  "end_hours": 6.0 },
      "proposed": { "schedule_id": 9, "schedule_name": "Weekday Core","start_hours": 5.0, "end_hours": 13.0 } }
  ]
}
```
with `schedule_self_overlap` as the sibling code. This deletes the workaround entirely.

### G3 — Report rows have no agent name

`POST /reports` returns `{agent_id, business_seconds}`. Names must be joined from `GET /agents`, which is **capped at `limit=200`**. At 3 000 agents that is 15 sequential round trips before a single name can render.

**Verdict: not acceptable at scale, tolerable at seed scale.** For a seeded demo (5 agents) it is invisible. For the thousands-of-agents case the brief specifies, it is the single worst client-side cost in the app.

**UI today:** one `useAgents()` query that pages until it receives a short page, `staleTime: Infinity` (agents are seeded and immutable within a session), building a `Map<number, string>`. It is fired on app mount, not on report submit, so the paging is hidden behind the user's own typing time. The table renders `Agent #123` placeholders if the report resolves before the agent map does.
**Ask (any one):** embed `agent_name` in `agent_hours` rows (cleanest — the join already exists server-side), **or** raise the `/agents` cap, **or** add `GET /agents?ids=1,2,3`.

### G4 — `GET /reports` returns `agent_hours: []`

`report_service.list_reports()` constructs `ReportResult` without agent hours, so every history row says "zero". A UI that renders a total from the list response will lie.

**UI today:** the history rail renders **only** `id`, the ticket window and a relative timestamp. It never renders an hours figure, an agent count, or a "0". Selecting an entry issues `GET /reports/{id}` to hydrate.
**Ask:** omit the field from the list serializer entirely (so the type system forbids the mistake), or add `agent_count` and `total_business_seconds` summary fields.

### G5 — `POST /schedules/{id}/agents` returns `201` with a `null` body

The handler has no `response_model` and returns `None`. `res.json()` on an empty body throws.
**UI today:** `http.ts` treats `204`, `content-length: 0`, and a `null` JSON body as "no content" and returns `undefined`. The mutation's `onSuccess` invalidates rather than reading a payload.
**Ask:** return the created assignment, or `204`.

### G6 — No CORS middleware, and Compose puts the two apps on different origins

`backend/app/main.py` registers **no `CORSMiddleware`** (verified: the only matches in the repo are inside `site-packages`). `docker-compose.yml` publishes the frontend on `localhost:5173` and the backend on `localhost:8000`. **Every browser request would fail the CORS check.** This is a hard blocker, not a polish item. Resolution in §12.2.

### G7 — No pagination metadata

List endpoints return bare arrays. There is no `X-Total-Count`, no `next` cursor. A page-numbered pager cannot be built honestly.
**UI today:** "load more" with `hasMore = page.length === limit`. §11.4.

### G8 — No authentication of any kind

There is no auth layer. The tool must sit behind the organisation's VPN or an SSO reverse proxy; the nginx config in §12.3 sets `X-Robots-Tag: noindex` and the compose port must not be published on a public host. Flagged as a decision (§14, D14).

---

## 3. Technical stack

### 3.1 Decided (given)

| Concern | Choice |
|---|---|
| Server state | **TanStack Query v5** |
| API client | **Class-based `ApiService`** singleton over a thin `http.ts` |
| Data access | **Custom hooks only** — components never touch `apiService` |
| Query keys | Centralised `queryKeys.ts` factory |
| React Context | Cross-cutting **UI** state only (toasts, modal orchestration, theme) — never a wrapper around fetched data |
| CSS | **Tailwind CSS v4** |

### 3.2 Recommended, with justification and cost

**Build & framework — Vite 6 + React 19 + TypeScript 5.7, SPA.**
Next.js earns its keep through SSR, RSC, and route-level data loading. None of that applies: this is an authenticated internal tool with two screens, no SEO surface, and no server to run — the Docker target is explicitly a static bundle behind a web server, and `docker-compose.yml` already builds `./frontend` into an `nginx`-shaped image listening on port 80. `next build && next export` would give us a static bundle *minus* the features that justify Next, plus a heavier toolchain.
*Cost:* the existing system-design doc names "Next.js + Tailwind". This is a deliberate divergence and is raised as **D1**.
*Config:* `build.target: 'es2022'`, `sourcemap: 'hidden'`, `@tailwindcss/vite`, `rollup-plugin-visualizer`, `vite-plugin-compression2` (brotli + gzip precompression for `gzip_static`/`brotli_static`).

**Routing — TanStack Router v1.**
Chosen for typed search params. The report's ticket window belongs in the URL (shareable, back-button-correct, survives reload), and TanStack Router validates and types `?from=…&to=…` at the route boundary with a Zod-compatible `validateSearch`. React Router 7 would require hand-rolling that parsing and typing.
*Cost:* ~13 KB gz and lower team familiarity than React Router. If familiarity outweighs typed search params, React Router 7 declarative mode is an acceptable substitute (**D2**).

**Forms — React Hook Form 7 + Zod 3 + `@hookform/resolvers`.**
RHF keeps inputs uncontrolled, so a keystroke in Monday's end-time does not re-render the week editor. This is not a preference — it is the mechanism by which §11.5 is satisfied. Zod gives us one schema that both validates the form and encodes the G1 client-side guards.
*Cost:* ~11 KB gz combined (RHF ~9, Zod ~2 with tree-shaking of the used validators).

**UI primitives — React Aria Components (RAC) v1.**
This is the consequential pick, and it is driven by the date/time requirement (§10). RAC is the only unstyled primitive library that ships a mature, keyboard-complete, screen-reader-correct `DatePicker`, `DateRangePicker`, `TimeField` **and** the `Dialog` / `Popover` / `ComboBox` / `Switch` / `Tooltip` / `ListBox` we need. Choosing Radix would mean Radix + `react-day-picker` + a hand-rolled segmented time field — three sources of a11y truth instead of one, and the hand-rolled time field is exactly where a11y bugs live.
*Cost:* heavier per component than Radix (~48 KB gz for the subset used, of which ~9 KB is `@internationalized/date`), and a render-prop styling API that is more verbose than Radix's `data-state` attributes. Mitigated by lazy-loading the calendar chunk (§11.6). Tailwind integration is good: RAC exposes `data-[focused]`, `data-[selected]`, `data-[disabled]`, `data-[invalid]` for direct variant targeting.
*Explicitly rejected:* shadcn/ui as a whole. Copying its generated component set wholesale is precisely the origin of the generic admin-panel look this document is trying to avoid. We take primitives and style them from our own tokens.

**Dates — `@internationalized/date` only. No `date-fns`, no Luxon, no `moment`.**
It arrives with RAC anyway, so it is free at the margin. It gives `CalendarDate`, `Time`, `ZonedDateTime`, `parseAbsolute`, `toZoned(dt, 'Asia/Kolkata')`, and `DateFormatter` (Intl-backed — zero locale data shipped). Adding `date-fns` on top would be a second date model for no gain.
*Cost:* a less familiar API than `date-fns`. Encapsulated behind `helpers/dates.ts` so the rest of the app sees plain functions.

**Virtualisation — `@tanstack/react-virtual` v3.** §11.2.
~3 KB gz, headless, leaves the DOM and ARIA to us. `react-virtuoso` (~28 KB) is heavier and opinionated about markup; `react-window` is lighter still but its dynamic-measurement story is weak and maintenance is thin.

**Table — hand-rolled.** We need sort-by-two-columns and a substring filter. `@tanstack/react-table` is ~14 KB gz to buy features we do not use. A `useMemo` over the row array is ~15 lines. Revisit only if column config, grouping or pinning is requested.

**Toasts — `sonner`** (~4 KB gz). Accessible live-region handling, imperative API, no styling opinions we cannot override.

**Icons — `lucide-react`, per-icon named imports.** Tree-shakes to roughly 0.4 KB per icon under Rollup. The CI bundle report (§11.6) verifies this; if it ever regresses, the ~14 icons in use are inlined as local SVG components instead.

**Not used, deliberately:** Redux / Zustand / Jotai (there is no genuine client-global state — see §5.4), any animation library (§8.5), any charting library (the two visualisations are CSS-driven bars), `axios` (`fetch` plus 60 lines in `http.ts`).

### 3.3 Total dependency weight

| Package | gz |
|---|---|
| react + react-dom (19) | ~45 KB |
| react-aria-components + @internationalized/date | ~48 KB |
| @tanstack/react-query | ~13 KB |
| @tanstack/react-router | ~13 KB |
| react-hook-form + zod + resolvers | ~11 KB |
| @tanstack/react-virtual | ~3 KB |
| sonner | ~4 KB |
| lucide-react (14 icons) | ~6 KB |
| app code (estimate) | ~35 KB |
| **Initial route budget** | **≤ 180 KB gz** (calendar chunk excluded, lazy) |

---

## 4. Folder structure

Deliberately mirrors the backend's `api → services → queries → domain` layering, so a change lands in the analogous place on both sides.

| Backend layer | Frontend layer |
|---|---|
| `app/api/v1/*/router.py` | `src/pages/` + `src/features/` |
| `app/services/*.py` | `src/hooks/` |
| `app/components/*/queries.py` | `src/api/ApiService.ts` |
| `app/domain/*.py` | `src/helpers/` |

```
frontend/
├── Dockerfile                       # multi-stage: node builder → nginx runtime
├── nginx.conf                       # SPA fallback, /api proxy, cache headers, CSP
├── index.html
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
├── .eslintrc.cjs                    # includes the layer rules of §4.2
├── .dependency-cruiser.cjs          # CI enforcement of the same rules
├── .size-limit.json                 # bundle budgets (§11.6)
├── public/
│   └── fonts/                       # self-hosted woff2 (no CDN — CSP stays 'self')
│       ├── archivo-var.woff2
│       ├── instrument-sans-var.woff2
│       └── plex-mono-{400,500}-subset.woff2
└── src/
    ├── main.tsx                     # createRoot; imports styles/globals.css
    ├── App.tsx                      # QueryClientProvider, RouterProvider, contexts
    ├── config.ts                    # API_BASE_URL from import.meta.env; single source
    │
    ├── api/                         # ═══ transport + typed client ═══════════
    │   ├── http.ts                  # the ONLY module that calls fetch()
    │   ├── ApiError.ts              # typed error: status, errorCode, message, detail
    │   ├── ApiService.ts            # class ApiService — one method per endpoint
    │   ├── index.ts                 # export const apiService = new ApiService()
    │   └── types.ts                 # wire DTOs, 1:1 with backend response models
    │
    ├── hooks/                       # ═══ the ONLY consumers of apiService ═══
    │   ├── queryKeys.ts
    │   ├── useAgents.ts             # useAgents(), useAgentMap(), useAgentSchedules(id)
    │   ├── useSchedules.ts          # useSchedules(), useSchedule(id)
    │   ├── useScheduleMutations.ts  # useCreateSchedule/useUpdateScheduleHours/useDeleteSchedule
    │   ├── useAssignments.ts        # useScheduleAgents/useAssignAgent/useUnassignAgent
    │   ├── useDeletionImpact.ts     # query + prefetch helper
    │   ├── useReports.ts            # useReports/useReport/useGenerateReport
    │   └── ui/                      # non-data hooks
    │       ├── useDebouncedValue.ts
    │       ├── useHoverIntent.ts
    │       ├── useMediaQuery.ts
    │       └── usePrefersReducedMotion.ts
    │
    ├── helpers/                     # ═══ pure functions — no React, no imports up ═══
    │   ├── time.ts                  # floatHoursToHHMM / hhmmToFloatHours / minutes
    │   ├── duration.ts              # businessSecondsToHHMMSS / toDecimalHours
    │   ├── weekday.ts               # WEEKDAYS (0 = Monday), labels, short labels
    │   ├── shifts.ts                # isOvernight, durationSeconds, weekTotal,
    │   │                            #   findSelfOverlaps, findOverlaps  ← mirrors domain/overlap.py
    │   ├── dates.ts                 # IST wrappers over @internationalized/date
    │   └── format.ts                # relative time, agent count, pluralisation
    │
    ├── contexts/                    # ═══ cross-cutting UI state ONLY ════════
    │   ├── ToastContext.tsx
    │   ├── ModalContext.tsx         # imperative open/close + focus-return bookkeeping
    │   └── ThemeContext.tsx         # light/dark/system, persisted to localStorage
    │
    ├── components/                  # ═══ shared, screen-agnostic ════════════
    │   ├── layout/
    │   │   ├── AppShell.tsx
    │   │   ├── Header.tsx
    │   │   ├── NavTabs.tsx
    │   │   ├── IstClock.tsx
    │   │   └── ThemeToggle.tsx
    │   ├── modals/
    │   │   ├── Modal.tsx            # base: RAC Dialog + overlay + sizing + motion
    │   │   ├── ConfirmModal.tsx
    │   │   ├── DeletionImpactModal.tsx
    │   │   └── AssignAgentModal.tsx
    │   ├── ui/
    │   │   ├── Button.tsx  IconButton.tsx  Field.tsx  TextField.tsx
    │   │   ├── Select.tsx  ComboBox.tsx    Switch.tsx  Chip.tsx  Badge.tsx
    │   │   ├── Tooltip.tsx Popover.tsx     Skeleton.tsx
    │   │   ├── EmptyState.tsx  ErrorState.tsx  InlineAlert.tsx
    │   │   └── VisuallyHidden.tsx
    │   ├── pickers/
    │   │   ├── DateField.tsx        # segmented, typed entry
    │   │   ├── DatePicker.tsx       # DateField + lazy Calendar popover
    │   │   ├── DateRangePicker.tsx  # schedule effective range
    │   │   ├── TimeField.tsx        # segmented HH:MM, IST, 24h
    │   │   ├── TimePicker.tsx       # TimeField + 15-min ListBox popover
    │   │   └── CalendarPanel.lazy.tsx   # code-split chunk boundary
    │   └── feedback/
    │       ├── ConflictPanel.tsx    # driven by ApiError + local overlap result
    │       └── ToastViewport.tsx
    │
    ├── features/                    # ═══ screen-specific ════════════════════
    │   ├── schedules/
    │   │   ├── ScheduleListPanel.tsx
    │   │   ├── ScheduleListRow.tsx
    │   │   ├── ScheduleMiniRibbon.tsx      # 7-segment coverage glyph in the list
    │   │   ├── ScheduleDetailPanel.tsx
    │   │   ├── ScheduleDetailHeader.tsx
    │   │   ├── CreateScheduleDialog.tsx
    │   │   ├── AssignedAgentsPanel.tsx
    │   │   ├── AgentConflictExplainer.tsx  # the G2 workaround, isolated here
    │   │   └── week-ribbon/
    │   │       ├── WeekRibbon.tsx
    │   │       ├── DayRow.tsx
    │   │       ├── CoverageTrack.tsx
    │   │       ├── OvernightGhost.tsx
    │   │       ├── HourAxis.tsx
    │   │       └── weekForm.ts             # zod schema + RHF types
    │   └── reports/
    │       ├── TicketWindowBar.tsx
    │       ├── ReportSummary.tsx
    │       ├── AgentHoursTable.tsx         # virtualised ARIA grid
    │       ├── AgentHoursRow.tsx           # React.memo, primitive props only
    │       ├── ZeroCoverageGroup.tsx
    │       └── ReportHistoryRail.tsx
    │
    ├── pages/
    │   ├── SchedulesPage.tsx
    │   ├── ReportPage.tsx
    │   └── NotFoundPage.tsx
    │
    ├── routes/                      # TanStack Router route definitions
    │   ├── __root.tsx
    │   ├── schedules.tsx  schedules.$scheduleId.tsx
    │   └── reports.tsx
    │
    └── styles/
        ├── theme.css                # @theme tokens, light + dark (§7)
        └── globals.css              # @import "tailwindcss"; @property; resets
```

### 4.1 Dependency direction

```
      pages ──────► features ──────► hooks ──────► api/ApiService ──────► api/http ──────► fetch
        │               │              │                  │
        └───────────────┴──────┬───────┴──────────────────┘
                               ▼
                    components/   helpers/          ← leaves: import nothing above them
                               ▲
                        contexts/  (UI state; used by pages, features, components)
```

### 4.2 Layer rules — stated as testable constraints

Enforced by `eslint-plugin-boundaries` in the editor and `dependency-cruiser` in CI. A violation fails the build.

| # | Rule |
|---|---|
| R1 | Nothing outside `src/hooks/**` may import from `src/api/**`. |
| R2 | `src/components/**` may not import from `src/hooks/**` (except `src/hooks/ui/**`), `src/api/**`, `src/features/**`, or `src/pages/**`. |
| R3 | `src/helpers/**` may import only from `src/helpers/**` and `@internationalized/date`. It may not import `react`. |
| R4 | `src/features/schedules/**` may not import from `src/features/reports/**`, and vice versa. Anything both need is promoted to `components/` or `helpers/`. |
| R5 | `src/api/http.ts` is the only module permitted to reference `fetch`. |
| R6 | `src/contexts/**` may not import from `src/api/**` or from any `src/hooks/use*` **data** hook. This is the rule that structurally prevents a redundant `SchedulesContext`. |
| R7 | `src/pages/**` may not import from `src/api/**` and contains no `useQuery`/`useMutation` call directly — it composes features. |

### 4.3 Context policy — read this before adding a provider

TanStack Query's cache is already global. `useSchedule(id)` called in three components three levels apart returns the same cached object with no prop drilling and no provider. **Wrapping query results in a Context adds a second cache, a second invalidation path, and a re-render fan-out that the query cache was specifically designed to avoid.**

Context is therefore reserved for state that has no server representation:

| Context | Why it earns its place |
|---|---|
| `ToastContext` | Any layer can raise a toast; the viewport lives at the root. Genuine cross-cutting. |
| `ModalContext` | Modal open/close is orchestrated from list rows, detail headers and keyboard shortcuts, and needs focus-return bookkeeping at the root. |
| `ThemeContext` | One value, read by many, written by one. |

Anything else — schedules, agents, the selected schedule id, the report window — lives in the query cache or the URL. **Do not create `SchedulesContext`, `AgentsContext`, or `ReportContext`.**

### 4.4 Shared versus screen-specific

**Screen-specific (stays in `features/`):** `WeekRibbon` and its children (schedules only), `AgentHoursTable` / `AgentHoursRow` / `ZeroCoverageGroup` (reports only), `TicketWindowBar`, `ScheduleListPanel`, `AgentConflictExplainer`.

**Shared from day one (`components/`):** the whole `pickers/` family (used by the schedule date range *and* the report ticket window), `modals/` (all four modals are structurally identical), `ui/`, `layout/`, `ConflictPanel` (keyed on `ApiError`, not on the schedule domain), `feedback/`.

**Deliberately not shared yet:** the report table is virtualised and the assign-agent combobox list is virtualised, and it is tempting to extract a `VirtualList`. Resist it. The two have different row semantics (grid cells vs listbox options) and different a11y contracts. Promote only if a third consumer appears.

---

## 5. Data layer

### 5.1 `api/http.ts` — transport

Responsibilities, and nothing else: prefix the base URL, set `Accept`/`Content-Type`, serialise the body, parse the response, and normalise every failure into `ApiError`.

```ts
export type ApiErrorCode =
  | 'not_found' | 'conflict' | 'validation_error' | 'internal_error'  // from the server
  | 'unprocessable'                                                    // 422, FastAPI shape
  | 'network_error';                                                   // transport

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: ApiErrorCode,
    message: string,
    readonly fieldErrors?: Array<{ path: string; message: string }>,
  ) { super(message); this.name = 'ApiError'; }
}
```

Normalisation must handle all three shapes from §1.2, plus the G5 empty body:

```
if (!res.ok):
   body = await safeJson(res)                       // never throws
   if (body?.error_code)  → ApiError(status, body.error_code, body.message)
   if (Array.isArray(body?.detail)) → ApiError(422, 'unprocessable', summarise(detail), mapFieldErrors(detail))
   else → ApiError(status, status >= 500 ? 'internal_error' : 'validation_error', res.statusText)
if (res.status === 204 || contentLength === 0) → undefined      // G5 / DELETE
```

A `fetch` rejection (offline, DNS, abort) becomes `ApiError(0, 'network_error', …)`. Every request carries an `AbortSignal` from TanStack Query.

### 5.2 `api/ApiService.ts` — typed client

One class, one method per endpoint, no React, no caching, no retry logic. Instantiated once in `api/index.ts` as `apiService`.

```
class ApiService {
  agents.list(params)            GET  /agents
  agents.schedules(agentId)      GET  /agents/{id}/schedules
  schedules.list(params)         GET  /schedules
  schedules.get(id)              GET  /schedules/{id}
  schedules.create(body)         POST /schedules
  schedules.updateHours(id,body) PUT  /schedules/{id}
  schedules.deletionImpact(id)   GET  /schedules/{id}/deletion-impact
  schedules.remove(id)           DELETE /schedules/{id}
  assignments.list(scheduleId)   GET  /schedules/{id}/agents
  assignments.add(sid, agentId)  POST /schedules/{id}/agents
  assignments.remove(sid, aid)   DELETE /schedules/{id}/agents/{aid}
  reports.generate(body)         POST /reports
  reports.list(params)           GET  /reports
  reports.get(id)                GET  /reports/{id}
}
```

Types in `api/types.ts` mirror the backend response models exactly — `end_date: string | null`, `email: string | null`, `agent_hours: AgentHours[]`. No optimistic renaming to camelCase at this layer; the mapping to view models happens in hooks, so a wire change surfaces as a type error in exactly one file.

### 5.3 `hooks/` — the only consumers

```ts
export const queryKeys = {
  agents: {
    all:       ['agents'] as const,
    list:      () => [...queryKeys.agents.all, 'list'] as const,
    schedules: (id: number) => [...queryKeys.agents.all, id, 'schedules'] as const,
  },
  schedules: {
    all:            ['schedules'] as const,
    list:           () => [...queryKeys.schedules.all, 'list'] as const,
    detail:         (id: number) => [...queryKeys.schedules.all, id] as const,
    agents:         (id: number) => [...queryKeys.schedules.all, id, 'agents'] as const,
    deletionImpact: (id: number) => [...queryKeys.schedules.all, id, 'deletion-impact'] as const,
  },
  reports: {
    all:    ['reports'] as const,
    list:   () => [...queryKeys.reports.all, 'list'] as const,
    detail: (id: number) => [...queryKeys.reports.all, id] as const,
  },
} as const;
```

**Invalidation matrix:**

| Mutation | Invalidates | Also |
|---|---|---|
| `useCreateSchedule` | `schedules.list()` | navigate to the new detail; seed `schedules.detail(id)` from the 201 body |
| `useUpdateScheduleHours` | `schedules.detail(id)`, `schedules.list()` | on 409, invalidate nothing |
| `useDeleteSchedule` | `schedules.all`, `agents.all` (an agent's schedule set changed) | `removeQueries(schedules.detail(id))` |
| `useAssignAgent` | `schedules.agents(sid)`, `agents.schedules(agentId)`, `schedules.deletionImpact(sid)` | |
| `useUnassignAgent` | same as above | optimistic remove + undo |
| `useGenerateReport` | `reports.list()` | seed `reports.detail(id)` from the 201 body |

**Retry policy — must be set explicitly; the defaults are wrong here.**

```ts
new QueryClient({ defaultOptions: {
  queries: {
    retry: (n, err) => err instanceof ApiError && err.errorCode === 'network_error' && n < 2,
    staleTime: 30_000,
    refetchOnWindowFocus: false,      // an ops tool; refetch storms on alt-tab are noise
  },
  mutations: { retry: false },        // POST /reports is NOT idempotent — see §1.1
}});
```
Retrying a 4xx is pointless; retrying `POST /reports` would insert duplicate report rows.

`useAgents()` is special: `staleTime: Infinity`, `gcTime: Infinity`, and it pages internally until it receives a page shorter than `limit` (G3). `useAgentMap()` is a `select`-derived `Map<number, string>` memoised by the query cache, so the map is built once per fetch, not once per render.

### 5.4 Why there is no client state library

Enumerating every piece of state in the app: server data → query cache. Selected schedule → URL path param. Report window → URL search params. Sort key, filter text, zero-group expansion → `useState` local to one component. Form values → RHF. Theme, toasts, modals → three Contexts. **Nothing is left.** A store would be a wrapper around one of the above.

---

## 6. Domain helpers

Pure, React-free, unit-tested. These encode the backend's rules on the client so we can validate before sending and explain after failing.

```ts
// helpers/time.ts — the float ↔ HH:MM boundary (§1.4, G1)
minutesFromFloatHours(h: number): number          // Math.round(h * 60) — always round
floatHoursFromMinutes(m: number): number          // m / 60
formatFloatHours(h: number): string               // 22.5 → "22:30"
parseHHMM(s: string): { hours: number; minutes: number } | null
isExpressibleEnd(h: number): boolean              // false for 0 and for >= 24  (G1)

// helpers/shifts.ts — mirrors backend/app/domain/{overlap,shift_normalization}.py
isOvernight(start: number, end: number): boolean            // end <= start
shiftDurationSeconds(start: number, end: number): number    // handles the wrap
normalizeShift(s: Shift): NormalizedShift[]                 // primary + tail
findSelfOverlaps(shifts: Shift[]): Overlap[]                // pre-empts the 409
findOverlaps(existing: Norm[], proposed: Norm[]): Overlap[] // explains the 409
weekTotalSeconds(shifts: Shift[]): number

// helpers/duration.ts
businessSecondsToHHMMSS(s: number): string     // 97200 → "27:00:00"
businessSecondsToDecimalHours(s: number): number // 97200 → 27
formatDurationLong(s: number): string          // "27h 00m"

// helpers/weekday.ts — 0 = Monday, matching the backend
WEEKDAYS: readonly [{ index: 0, key: 'mon', short: 'MON', long: 'Monday' }, …]
nextWeekday(i: number): number                 // (i + 1) % 7 — the Sunday→Monday wrap

// helpers/dates.ts — thin IST layer over @internationalized/date
IST = 'Asia/Kolkata'
toIstIsoString(date: CalendarDate, time: Time): string  // "2026-08-09T10:00:00+05:30"
parseIstResponse(iso: string): ZonedDateTime
```

`findSelfOverlaps` and `findOverlaps` are a deliberate second implementation of `backend/app/domain/overlap.py`. This is duplication with a reason: it is ~20 lines of pure interval arithmetic, it lets us reject invalid input before a round trip, and it is the only way to render a specific conflict message while G2 is open. **The server remains the authority — the client check never permits a write the server would reject; it only explains and pre-empts.** When G2 lands, `findOverlaps` can be deleted; `findSelfOverlaps` stays for instant inline feedback.

---

## 7. Design language

### 7.1 Direction: **Operations Desk**

A tool a support manager has open for eight hours. Its job is to be read at a glance, edited without hesitation, and never noticed. The register is Linear / Stripe / Vercel: quiet, dense, precisely aligned, confident enough not to decorate.

**The governing principle: achromatic chrome, chromatic data.**

Every piece of furniture — navigation, panels, buttons, borders, labels, body text — is paper and graphite. Colour appears *only* where it encodes meaning: blue is coverage, red is conflict, amber is impact, grey-dotted is absence. The consequence is that **any colour on screen means something**, so the eye goes straight to it. This is also why the primary button is ink-filled rather than blue: if the "Save" button were blue, blue would stop meaning "hours".

Three further commitments, each in service of the work:

1. **No shadows, except on things that float.** Panels, cards and tables are separated by 1px hairlines, not elevation. Shadow is reserved for popovers and modals, where it signals "this is temporary and above the page". A dense screen with drop-shadowed cards reads as clutter at 13px.
2. **Four type sizes.** 11 / 13 / 15 / 20 px, plus one 28px figure on the report. Hierarchy comes from weight, colour and space, not from a nine-step scale.
3. **Contrast by width, not by style.** The display and body faces are both grotesques; they are distinguished by the display face's expanded width axis. This gives the tool a recognisable voice without a serif/sans clash competing with the data.

### 7.2 Typography

| Role | Typeface | Licence | Where |
|---|---|---|---|
| Display | **Archivo** (variable: `wght` 100–900, `wdth` 62–125) | OFL | Wordmark, screen titles, panel headings, the report headline figure |
| UI / body | **Instrument Sans** (variable) | OFL | Every label, button, table cell, field, helper text |
| Numeric | **IBM Plex Mono** (400, 500 — subset) | OFL | Every time, duration, date-in-table, and ID |

**Why these.** *Archivo* at `wdth 108–115` gives headings a slightly expanded, engineered feel — the visual equivalent of a machined label — while remaining a plain grotesque that will not fight a table. *Instrument Sans* has a tall x-height, open counters and low stroke contrast; it is one of the few contemporary grotesques that stays legible at 13px, which is this tool's working size. Its slightly squared terminals read "instrument" rather than "brochure". Neither is Inter, Roboto, Arial or a system stack. *IBM Plex Mono* is subset to `0–9 : . – + h m d ( ) %` (~4 KB per weight) and carries a slashed zero and true tabular advance, so a column of `22:30 / 22:00 / 02:30` is scanned, not read.

All three are **self-hosted** in `public/fonts/` as woff2 — no CDN, which keeps the CSP at `font-src 'self'` (§12.3) and removes a third-party dependency from a tool that may run inside a VPN with no internet egress. `font-display: swap`, with the two variable faces `<link rel="preload">`ed.

**Type scale**

| Token | Size / LH | Tracking | Face & weight | Use |
|---|---|---|---|---|
| `text-display-lg` | 28 / 32 | −0.03em | Archivo 600, wdth 112 | The single headline figure on the report |
| `text-display` | 20 / 26 | −0.02em | Archivo 600, wdth 112 | Screen title, schedule name in the detail header |
| `text-heading` | 15 / 20 | −0.01em | Archivo 600, wdth 108 | Panel and section headings |
| `text-body` | 13 / 18 | 0 | Instrument Sans 400 | Table cells, prose, helper text |
| `text-body-md` | 13 / 18 | 0 | Instrument Sans 500 | Agent names, the primary cell of a row |
| `text-label` | 11 / 14 | 0.06em, uppercase | Instrument Sans 600 | Column headers, field labels, day abbreviations |
| `text-caption` | 11 / 15 | 0 | Instrument Sans 400 | Hints, timestamps, secondary metadata |
| `text-num` | 13 / 18 | 0 | Plex Mono 400, `tnum` | Times and durations in tables and the ribbon |
| `text-num-md` | 13 / 18 | 0 | Plex Mono 500 | The hours value in the report's primary column |
| `text-num-lg` | 22 / 26 | −0.01em | Plex Mono 500 | Per-row emphasis, summary tiles |

### 7.3 Colour

Tailwind v4, CSS-first. `styles/theme.css`:

```css
@import "tailwindcss";

@theme {
  /* ── neutrals: warm paper over cool graphite ───────────────────────── */
  --color-canvas:         #F7F6F3;   /* warm paper — not #FFF; cuts glare over an 8h shift */
  --color-surface:        #FFFFFF;
  --color-sunken:         #EFEDE8;
  --color-line:           #E4E1DA;
  --color-line-strong:    #CBC7BD;
  --color-ink:            #15181C;
  --color-ink-2:          #565C64;
  --color-ink-3:          #6F757D;
  --color-invert:         #FBFAF8;   /* text on ink fills */

  /* ── semantic: the ONLY chromatic tokens ──────────────────────────── */
  --color-coverage:       #1B6FB8;   /* scheduled working hours */
  --color-coverage-fill:  #DCEBF7;
  --color-coverage-ghost: #B9D6EC;   /* overnight continuation (read-only) */

  --color-conflict:       #B4231C;   /* 409 — overlap rejected */
  --color-conflict-fill:  #FCEBE9;
  --color-conflict-line:  #F0BDB8;

  --color-impact:         #9A5B04;   /* deletion impact / destructive warning */
  --color-impact-fill:    #FDF1DC;
  --color-impact-line:    #EED6A6;

  --color-void:           #6F757D;   /* zero hours / no coverage — NOT an error colour */
  --color-void-fill:      #F1EFEA;

  --color-ok:             #1F6B45;
  --color-focus:          #1B6FB8;

  /* ── motion ───────────────────────────────────────────────────────── */
  --ease-out:    cubic-bezier(.16, 1, .3, 1);
  --ease-in-out: cubic-bezier(.4, 0, .2, 1);
  --dur-1: 90ms;  --dur-2: 140ms;  --dur-3: 220ms;

  /* ── the one shadow ───────────────────────────────────────────────── */
  --shadow-pop: 0 8px 24px -8px rgb(0 0 0 / .18), 0 0 0 1px var(--color-line);

  --radius-control: 6px;  --radius-panel: 8px;  --radius-chip: 4px;  --radius-bar: 2px;
}

@layer theme {
  :root[data-theme="dark"], :root:not([data-theme="light"]) { }
}

@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { /* tokens below */ } }
:root[data-theme="dark"] { /* same block — duplicated via a CSS custom-property set */ }
```

Dark values (applied by the same token names, so no component knows which theme it is in):

```css
--color-canvas:         #0C0E11;
--color-surface:        #14171B;
--color-sunken:         #0F1216;
--color-line:           #24282E;
--color-line-strong:    #363C44;
--color-ink:            #EBE8E2;   /* warm off-white, echoing the light theme's paper */
--color-ink-2:          #A0A6AE;
--color-ink-3:          #8A9199;
--color-invert:         #0C0E11;

--color-coverage:       #58A9EC;  --color-coverage-fill: #12293C;  --color-coverage-ghost: #1D3D56;
--color-conflict:       #FF8A7A;  --color-conflict-fill:  #351714;  --color-conflict-line:  #5B2721;
--color-impact:         #F2B451;  --color-impact-fill:    #32240C;  --color-impact-line:    #4E3A14;
--color-void:           #6E757D;  --color-void-fill:      #171A1E;
--color-ok:             #59BE8B;  --color-focus:          #58A9EC;
--shadow-pop: 0 10px 30px -10px rgb(0 0 0 / .6), 0 0 0 1px var(--color-line-strong);
```

**The inversion trick:** the primary button is `bg-ink text-invert` in both themes. In light that renders near-black on paper; in dark, paper on near-black. One rule, two correct results, and the primary action never competes with the coverage blue.

**Contrast targets** (WCAG 2.2 AA — 4.5:1 text, 3:1 UI components and graphical objects). These are design targets; the exact ratios are asserted in CI (§13.4), and any pair below target fails the build.

| Pair | Target | Notes |
|---|---|---|
| `ink` on `canvas` | ≥ 12:1 | comfortably exceeded both themes |
| `ink-2` on `canvas` / `surface` | ≥ 5.5:1 | secondary text |
| `ink-3` on `canvas` | ≥ 4.5:1 | `#6F757D` chosen specifically to clear AA — the "obvious" `#868C94` does not |
| `coverage` on `surface` | ≥ 4.5:1 | text; the *fill* only needs 3:1 against `surface` as a graphical object |
| `conflict` on `conflict-fill` | ≥ 4.5:1 | |
| `impact` on `impact-fill` | ≥ 4.5:1 | |
| `focus` ring vs both adjacent colours | ≥ 3:1 | non-text contrast |

**Colour is never the sole signal.** Conflict rows also carry an icon and text; the overnight ghost also carries a `↳` marker and a diagonal hatch; zero hours also renders `0:00:00` and a `·` where the bar would be.

### 7.4 Space and density

4px base. Permitted steps: 4, 8, 12, 16, 24, 32, 48. Nothing else.

| Element | Height |
|---|---|
| Header | 52px |
| Schedule list row | 56px (two lines: name + meta) |
| Report table row | 40px (fixed — the virtualiser depends on it) |
| Week ribbon day row | 56px collapsed, 84px when editing |
| Control (button, field) | 32px default, 28px compact |

Panel padding: 16px in dense regions, 24px in headers and empty states. Radius: 6px controls, 8px panels, 4px chips, 2px bars. Hairlines everywhere; `--shadow-pop` only on popovers and modals.

**What is dense and what breathes:** the schedule list, the report table and the assigned-agents list are dense — hairline-separated, 13px, tight. The **week ribbon breathes** — it is the one place the design spends vertical space, because it is the one place the user is thinking rather than scanning. The report's summary strip also breathes, as the landing point for the eye after a compute.

### 7.5 Motion

CSS only. No animation library — every interaction below is a transition, a keyframe, or an `@property`-animated custom property. Total motion budget: **nothing exceeds 220ms**.

| Interaction | Specification |
|---|---|
| **Conflict rejection (409)** | The offending control (assign combobox, or the day row) runs `shake`: `translateX(0,-3,3,-2,2,0)` over 180ms `--ease-in-out`, border → `--color-conflict`. Simultaneously a `ConflictPanel` expands beneath via `grid-template-rows: 0fr → 1fr` over `--dur-2`. The rejected item is **never** inserted into the list first and then removed — nothing false is ever shown. |
| **Deletion-impact reveal** | `GET /schedules/{id}/deletion-impact` is **prefetched on 200ms hover-intent or focus** of the Delete control, so the list is in cache before the click. The modal opens with content already present (no spinner). Affected-agent rows fade in and rise 4px, staggered 20ms, capped at 10 rows plus "+N more". A 3px `--color-impact` left rule runs the length of the list. |
| **Report computing** | On submit the table swaps instantly to 24 skeleton rows of the exact final height (CLS = 0). Skeletons pulse `opacity .5 → .75` over 1.4s — a low-amplitude breath, not a shimmer sweep. On success rows fade in over `--dur-2`; share bars animate `transform: scaleX(0 → 1)`, `transform-origin: left`, `--dur-3`, with `transition-delay: calc(var(--i) * 8ms)` **capped at index 20** so a 3 000-row table does not schedule 3 000 staggered transitions. Recomputing keeps the previous results at `opacity: .6` rather than blanking. |
| **Week ribbon editing** | Coverage geometry is two registered custom properties (`@property --from`, `@property --to`, `syntax: '<percentage>'`) set inline on the block. During active editing `transition: none`; on commit they transition over `--dur-2`. **The bar animates with zero React re-renders.** |
| **Overnight spill** | The moment a shift becomes overnight, the block's right edge loses its radius and gains a 2px `--color-coverage` cut at the 24:00 boundary, and the ghost segment fades into the next row over `--dur-2` with its `↳` marker. This is the single most important animation in the product: it *shows* the user what "end before start" means. |
| **Row commit confirmation** | A saved day row flashes a 2px `--color-ok` left rule, `opacity 1 → 0` over 600ms. |
| **Toast** | Slide 8px + fade over `--dur-2`. |
| **Hover / press / focus** | `--dur-1`. Press uses `transform: translateY(0.5px)`, never a scale. |

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important;
                            transition-duration: 1ms !important; scroll-behavior: auto !important; }
}
```
Reduced-motion substitutes are behavioural, not just faster: the conflict shake is replaced by a two-step `outline-color` flash; the skeleton pulse becomes a static tint; the share bars render at full width immediately.

### 7.6 The one memorable thing

**The Week Ribbon.** The weekly-hours editor is also the visualisation. Seven rows, one per day, each a full-width 24-hour track. An overnight shift visibly runs off the right edge of its own day and **reappears, hatched and read-only, at the left edge of the next day**, marked `↳ from Monday`. Nobody has to be taught what `end_hours < start_hours` means — they watch it happen. It is the thing a support manager describes to a colleague.

---

## 8. Screen 1 — Schedule Configuration

Route: `/schedules` and `/schedules/$scheduleId`.

### 8.1 Layout

Master–detail, not a card grid. The list persists so the user can move between schedules without losing their place; the detail pane is driven by the URL so a schedule is linkable.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  ◧ RICHPANEL OPS      [ Schedules ]   Reports                        IST 14:32 Mon    ◐   ?        │ 52
├────────────────────────┬───────────────────────────────────────────────────────────────────────────┤
│ SCHEDULES        + New │  Weekday Core                                    [ Edit hours ]  [ ⋯ ]    │
│ ┌────────────────────┐ │  01 Aug 2026 → open-ended  ·  5 agents  ·  45h 00m / week                 │
│ │ ⌕ filter…          │ ├───────────────────────────────────────────────────────────────────────────┤
│ └────────────────────┘ │  WEEKLY HOURS                                       All times IST (+5:30) │
│                        │        00      04      08      12      16      20      24                 │
│ ▸ Weekday Core         │  ┌─────┬───────┬───────┬───────┬───────┬───────┬───────┬──────────────────┤
│   01 Aug → open        │  │ MON │               ███████████████████      │ 09:00 → 18:00    9h 00m │
│   ▓▓▓▓▓··  5 agents    │  │ TUE │               ███████████████████      │ 09:00 → 18:00    9h 00m │
│                        │  │ WED │               ███████████████████      │ 09:00 → 18:00    9h 00m │
│   Night Desk           │  │ THU │               ███████████████████      │ 09:00 → 18:00    9h 00m │
│   01 Aug → 31 Dec      │  │ FRI │               ███████████████████      │ 09:00 → 18:00    9h 00m │
│   ··▓▓▓▓▓  2 agents    │  │ SAT │                                        │ Not working        +    │
│                        │  │ SUN │                                        │ Not working        +    │
│   Weekend Cover        │  └─────┴────────────────────────────────────────┴─────────────────────────┤
│   05 Jul → open        │  ASSIGNED AGENTS · 5                                  [ + Assign agent ]  │
│   ·····▓▓  3 agents    │  ┌──────────────────────────────────────────────────────────────────────┐ │
│                        │  │ Alice Chen      alice@richpanel.example        also: Night Desk   ×  │ │
│  ─────────────────────  │  │ Bob Martinez    bob@richpanel.example          —                  ×  │ │
│  Showing 3 · Load more │  │ …                                                                   │ │
└────────────────────────┴───────────────────────────────────────────────────────────────────────────┘
   320px                                              fluid
```

The list row's `▓▓▓▓▓··` is a **mini ribbon** — seven segments, filled proportionally to that day's coverage. It makes "which schedule covers weekends?" answerable without opening anything.

### 8.2 The Week Ribbon, in detail

Read mode is compact (56px rows). Entering edit mode expands the focused row to 84px and reveals its controls; unfocused rows stay compact. This keeps 7 rows on screen without scrolling while giving the active row room.

**A normal day, editing:**

```
┌ MON ───────────────────────────────────────────────────────────────────────────────┐
│ ◉ Working      ┌ 09:00 ┐  →  ┌ 18:00 ┐                    9h 00m          [ clear ] │
│                └───────┘     └───────┘                                              │
│   00    02    04    06    08    10    12    14    16    18    20    22    24        │
│   ├─────┴─────┴─────┼─────┴─────┴─────┼─────┴─────┴─────┼─────┴─────┴─────┤         │
│                              ████████████████████████                               │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

**An overnight day — the core interaction:**

```
┌ MON ───────────────────────────────────────────────────────────────────────────────┐
│ ◉ Working      ┌ 22:00 ┐  →  ┌ 06:00 ┐  ⟳ +1 day        8h 00m          [ clear ]  │
│                └───────┘     └───────┘   ends Tue                                   │
│   00    02    04    06    08    10    12    14    16    18    20    22    24        │
│   ├─────┴─────┴─────┼─────┴─────┴─────┼─────┴─────┴─────┼─────┴─────┴────█┤         │
│                                                              ██████████████▌        │
│                                                            (runs off the edge) ──▶  │
└─────────────────────────────────────────────────────────────────────────────────────┘
┌ TUE ───────────────────────────────────────────────────────────────────────────────┐
│ ◉ Working      ┌ 09:00 ┐  →  ┌ 18:00 ┐                    9h 00m          [ clear ] │
│   ▒▒▒▒▒▒▒▒▒▒▒▒▒▌                     ████████████████████                           │
│   ↳ 00:00–06:00 continues from Monday · edit it on Monday                           │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

The `▒▒▒` ghost is `--color-coverage-ghost` with a 45° hatch, `pointer-events: none` for dragging but focusable-by-tooltip, and it counts toward Tuesday's displayed coverage but **not** toward Tuesday's editable shift. Sunday's overnight ghost lands on **Monday** — the week wraps, matching `(weekday + 1) % 7`, and the Monday row's ghost caption reads `↳ continues from Sunday (previous week)`.

**Input model for overnight** (recommended; alternatives in **D3**):
- No mode switch, no checkbox. The user types or picks an end time earlier than the start, and the `+1 day` chip appears with `ends Tue` beneath it.
- The chip is also a **control**: clicking it toggles the interpretation where ambiguous — but there is no ambiguity here, since `end <= start` is definitionally overnight in this backend. It therefore renders as a non-interactive status chip with a tooltip, not a toggle.
- `start == end` is blocked inline before the request (G1): "Start and end must be different times."
- `00:00` is never offered as an **end** value once a start is set (G1). The picker's last option is `23:59`, labelled `23:59  end of day`. A caption explains: "A shift ending exactly at midnight is not currently supported — use 23:59."

**Copy Monday to weekdays / to all days** — a row action in the `⋯` menu of any day. Real ops behaviour, and it collapses 28 tab stops into two clicks. It explicitly does *not* offer "add a second window", so the one-window-per-weekday rule is never implied to be breakable.

### 8.3 Component inventory

| Component | Location | Notes |
|---|---|---|
| `AppShell`, `Header`, `NavTabs`, `IstClock`, `ThemeToggle` | `components/layout/` | `IstClock` renders the current IST time and weekday — the tool's standing reminder that there is no timezone picker |
| `ScheduleListPanel`, `ScheduleListRow`, `ScheduleMiniRibbon` | `features/schedules/` | list + filter + load-more |
| `ScheduleDetailPanel`, `ScheduleDetailHeader` | `features/schedules/` | header shows name, date range, agent count, weekly total |
| `WeekRibbon`, `DayRow`, `CoverageTrack`, `OvernightGhost`, `HourAxis` | `features/schedules/week-ribbon/` | |
| `AssignedAgentsPanel` | `features/schedules/` | virtualised above 100 rows |
| `AgentConflictExplainer` | `features/schedules/` | the G2 workaround, isolated so it can be deleted in one commit |
| `CreateScheduleDialog` | `features/schedules/` | name + `DateRangePicker` + initial week |
| `DeletionImpactModal`, `AssignAgentModal`, `ConfirmModal`, `Modal` | `components/modals/` | |
| `DateRangePicker`, `TimePicker`, `TimeField` | `components/pickers/` | §10 |
| `ConflictPanel`, `InlineAlert`, `EmptyState`, `ErrorState`, `Skeleton` | `components/` | |

### 8.4 States

| State | Presentation |
|---|---|
| **Loading (first paint)** | 6 skeleton list rows; detail pane shows a skeleton header + 7 skeleton ribbon rows at final height. No spinner anywhere. |
| **Empty (no schedules)** | Full detail pane: a 12%-opacity Week Ribbon preview behind an `EmptyState` — "No schedules yet. A schedule defines the working hours that resolution time is measured against." + primary "Create schedule". |
| **List filtered to nothing** | "No schedule matches *night*." + clear-filter action. Distinct from the empty state. |
| **Detail 404** (deep link to a deleted schedule) | `ErrorState`: "This schedule was deleted." + "Back to schedules". `removeQueries` on the stale key so the list is consistent. |
| **Editing / dirty** | Sticky footer: `Unsaved changes · [Discard] [Save hours]`. Router navigation blocked with a confirm; `beforeunload` guard. |
| **Saving** | Save button `aria-busy`, fields `disabled`. |
| **Save success** | Toast "Hours updated"; changed rows flash the `--color-ok` rule. |
| **409 — self-overlap** | Pre-empted client-side: `findSelfOverlaps` runs on blur, so the Save button is disabled and both offending rows carry a `--color-conflict` border plus an inline message naming the two days and the overlapping window. The request is never sent. |
| **409 — assignment overlap on save** | Cannot be pre-empted (it depends on other schedules' state). Shake + `ConflictPanel`: "This change conflicts with another schedule for **Carol Singh**." + a "Show the conflict" disclosure that fetches her other schedules and renders the exact colliding day and hours. See §8.6. |
| **409 — assignment overlap on assign** | The agent is never added to the list. The combobox shakes; the panel names the colliding schedule and day. |
| **500** (a G1 case that slipped through) | `ErrorState`: "Something went wrong saving these hours. Your changes have not been lost." + Retry + a Copy-details action carrying the request payload. Never a silent failure. |
| **Deleting — 0 agents assigned** | Lightweight `ConfirmModal`: "Delete **Weekend Cover**? No agents are assigned to it." |
| **Deleting — N agents assigned** | `DeletionImpactModal` — §8.5. |
| **Unassigning** | Optimistic removal + 5s undo toast. The undo re-POSTs; if that 409s (state changed underneath) the row is restored with an explanation. |
| **Offline** | Header banner "Offline — showing last loaded data"; mutations disabled with a tooltip. |

### 8.5 The deletion-impact flow — first-class, not a confirm dialog

The product decision is that a user must see *exactly who loses coverage* before confirming. The design treats that as the primary content of the interaction, not a warning above a button.

```
┌────────────────────────────────────────────────────────────────────────┐
│  Delete “Night Desk”?                                             ✕    │
├────────────────────────────────────────────────────────────────────────┤
│ ▌ 4 agents lose all coverage from this schedule.                       │  ← 3px --color-impact rule
│ ▌ Their resolution-time hours will be computed as zero for any window  │
│ ▌ this schedule used to cover.                                         │
│ ▌                                                                      │
│ ▌   Carol Singh        carol@richpanel.example    no other schedule  ⚠ │
│ ▌   David Okafor       david@richpanel.example    also: Weekday Core   │
│ ▌   Elena Petrova      elena@richpanel.example    no other schedule  ⚠ │
│ ▌   Frank Osei         frank@richpanel.example    also: Weekend Cover  │
│ ▌                                                                      │
│ ▌ 2 of these agents will have no schedule at all.                      │
│                                                                        │
│ ☐  I understand 4 agents lose coverage                                 │
│                                          [ Cancel ]  [ Delete schedule ]│
└────────────────────────────────────────────────────────────────────────┘
```

Design decisions here:
- **Names, not IDs.** `deletion-impact` returns `affected_agent_ids` only; we join against the cached agent map. Because `useAgents()` is `staleTime: Infinity` and loaded at mount, this join is free.
- **"No other schedule" is the real warning.** An agent who is on two schedules loses some coverage; an agent on only this one drops to zero. That distinction is what the user actually needs, and it comes from `GET /agents/{id}/schedules` — bounded by the affected count, fetched in parallel, and only for the agents shown. For counts above 25 we fetch only the visible 10 and label the rest "+N more".
- **Prefetched on hover-intent**, so the modal has content the instant it opens. No spinner in a destructive dialog.
- **The confirm gate is an acknowledgement checkbox carrying the count**, not a type-the-name field. Type-to-confirm is right for irreversible production deletions; this is a soft delete on an internal tool, and the friction should be proportionate. (**D9** if the product owner disagrees.)
- The destructive button is `--color-conflict`-bordered with an ink fill, not a saturated red block — it must not read as the page's primary action.
- If `deletion-impact` itself fails, the modal shows an error and **the delete button is disabled**. We never let the user confirm a deletion whose impact we could not show.

### 8.6 Explaining a 409 while G2 is open

```
┌ ConflictPanel ─────────────────────────────────────────────────────────┐
│ ⊘  Carol Singh can’t be assigned to “Weekday Core”.                    │
│    She’s already on “Night Desk”, and the hours overlap:               │
│                                                                        │
│      TUE  Night Desk    00:00 – 06:00   ▒▒▒▒▒▒▒                        │
│      TUE  Weekday Core  05:00 – 13:00        ████████████              │
│                              └── 1h overlap ──┘                        │
│                                                                        │
│    [ View Night Desk ]                              [ Choose another ] │
└────────────────────────────────────────────────────────────────────────┘
```

Produced by: catching the 409 → `GET /agents/{id}/schedules` → `GET /schedules/{id}` for each → `helpers/shifts.findOverlaps()` against the schedule being assigned. Two to four extra requests, all cached afterwards. When G2 ships, this panel renders directly from `error.conflicts` and `AgentConflictExplainer` is deleted.

### 8.7 Keyboard and accessibility

- **Focus order:** header nav → list filter → list rows → detail header actions → ribbon (day by day) → assigned agents → footer actions.
- **Ribbon semantics.** The visual track is `aria-hidden="true"` — it is a rendering of data that is already in the fields. Each day is a `role="group"` labelled by its day name:
  ```html
  <div role="group" aria-labelledby="day-0-label">
    <span id="day-0-label">Monday</span>
    <Switch aria-label="Monday working" />
    <TimeField label="Monday start time" />
    <TimeField label="Monday end time" />
    <span class="sr-only">Monday, working 22:00 to 06:00 the next day. 8 hours.</span>
  </div>
  ```
- The overnight ghost adds, inside the *next* day's group: `<span class="sr-only">Also covered from 00:00 to 06:00, continuing from Monday. Edit this on Monday.</span>`
- **Day-to-day movement:** `Alt+↓` / `Alt+↑` jump between day rows without tabbing through every field. Plain `Tab` still walks everything.
- **Announcements:** a `role="status"` live region announces the row total on change ("9 hours"). Conflicts go to a `role="alert"` region **and** move focus to the `ConflictPanel` heading.
- **Focus ring:** `outline: 2px solid var(--color-focus); outline-offset: 2px` — `outline`, not `box-shadow`, so it survives `overflow: hidden` on the track.
- **Modals:** RAC `Dialog` handles trap, `Esc`, and focus return. The impact modal's description is wired via `aria-describedby` so the count is announced with the title.
- **Never colour alone:** conflict rows carry `⊘` + text; the ghost carries `↳` + hatch; "not working" is a word, not an absence.
- 200% zoom and 320px reflow: no horizontal scrolling of the page; the ribbon track is the only element permitted its own horizontal scroll, and only below 640px.

### 8.8 Responsive

| Breakpoint | Behaviour |
|---|---|
| ≥ 1280px | Split view, list 320px, detail fluid. |
| 1024–1279 | List narrows to 280px; the mini-ribbon in list rows drops to 4 segments. |
| 768–1023 | List and detail become **separate routes**: `/schedules` is the list, tapping pushes `/schedules/$id` with a back affordance. |
| 640–767 | Ribbon rows stack: fields above the track. Hour axis labels thin to `00 / 06 / 12 / 18 / 24`. |
| < 640px | The track drops its labels entirely and becomes a 20px-tall proportional bar; times are read from the fields. Editing is supported but the empty state says so plainly. **Position: this is a desktop tool. Mobile is for checking, not authoring.** |

---

## 9. Screen 2 — Resolution Time Report

Route: `/reports?from=…&to=…&reportId=…` — window and selected report live in typed search params, so a result is shareable and survives reload.

### 9.1 Layout

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  ◧ RICHPANEL OPS      Schedules   [ Reports ]                        IST 14:32 Mon    ◐   ?        │
├────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ TICKET WINDOW        ┌ 09 Aug 2026 ┐ ┌ 10:00 ┐   →   ┌ 12 Aug 2026 ┐ ┌ 17:30 ┐   [ Compute ]      │
│ All times IST (+5:30)└─────────────┘ └───────┘       └─────────────┘ └───────┘   elapsed 3d 7h 30m │
├───────────────────────────────────────────────────────────────────────────┬────────────────────────┤
│                                                                           │ HISTORY                │
│   27h 00m         12 of 17 agents           79h 30m            1 260h     │ ────────────────────── │
│   highest         had coverage              elapsed            total      │ ▸ #14  09 → 12 Aug     │
│                                                                           │      2 minutes ago     │
│  ─────────────────────────────────────────────────────────────────────    │   #13  01 → 02 Aug     │
│                                                                           │      yesterday         │
│  ⌕ filter agents…                     Sort: Hours ▾        [ Export CSV ] │   #12  28 → 29 Jul     │
│ ┌────────────────────────┬──────────────────┬───────────────┬───────────┐ │   …                    │
│ │ AGENT                  │  BUSINESS HOURS  │     SHARE     │           │ │   [ Load more ]        │
│ ├────────────────────────┼──────────────────┼───────────────┼───────────┤ │                        │
│ │ Alice Chen             │  27:00:00        │ ████████████  │     ⌄     │ │                        │
│ │ Bob Martinez           │  27:00:00        │ ████████████  │     ⌄     │ │                        │
│ │ Carol Singh            │  16:00:00        │ ███████       │     ⌄     │ │                        │
│ │ David Okafor           │  09:30:00        │ ████          │     ⌄     │ │                        │
│ │ …                                                                     │ │                        │
│ └────────────────────────┴──────────────────┴───────────────┴───────────┘ │                        │
│  ⌄ 5 agents with no coverage in this window                               │                        │
└───────────────────────────────────────────────────────────────────────────┴────────────────────────┘
                                                                              280px, collapsible
```

The query bar is a **single sticky line**. This is the tool's most repeated action and it should never require scrolling to reach or a modal to open. The four summary figures sit in the one region of the screen that breathes — they are the landing point after a compute.

**No "Schedules" column.** It would require `GET /agents/{id}/schedules` per row: 3 000 requests. Instead each row has a `⌄` expander that lazily fetches that one agent's schedules on demand. This is a performance constraint driving an interaction decision, and it is the right trade — the column would be unreadable at that density anyway.

### 9.2 Row anatomy

```
│ Alice Chen                27:00:00      27.00h    ████████████████░░░░░░  │ 40px
  └ text-body-md            └ Plex Mono 500, right-aligned, tabular
                                          └ decimal, ink-3, caption size
                                                     └ share of the window's max, --color-coverage
```

Both formats shown at once (**D4** proposes this as the default): `HH:MM:SS` is what an operations user reconciles against a ticket log; the decimal is what gets pasted into a spreadsheet. The share bar is proportional to the **maximum** agent's hours, not to elapsed time — it answers "who did the most", which is the question being asked.

Zero rows: `0:00:00` in `--color-void`, a `·` in place of the bar, and by default collapsed into the group at the bottom.

### 9.3 Component inventory

| Component | Location |
|---|---|
| `TicketWindowBar` (2× `DatePicker`, 2× `TimePicker`, Compute, elapsed readout) | `features/reports/` |
| `ReportSummary` (four figures) | `features/reports/` |
| `AgentHoursTable` (virtualised ARIA grid, sort, filter) | `features/reports/` |
| `AgentHoursRow` (`React.memo`) | `features/reports/` |
| `ZeroCoverageGroup` | `features/reports/` |
| `ReportHistoryRail` | `features/reports/` |
| `DatePicker`, `TimePicker` | `components/pickers/` |
| `EmptyState`, `ErrorState`, `Skeleton`, `InlineAlert` | `components/ui/` |

### 9.4 States

| State | Presentation |
|---|---|
| **Idle** (no window yet) | Not a spinner and not a blank. A quiet instructional panel: "Choose a ticket window to see how much scheduled working time each agent had inside it." with the date fields already focused. |
| **Invalid window** (`end <= start`) | Compute is disabled; caption under the second field: "End must be after start." The 400 is pre-empted. |
| **Very large window** | Informational caption only ("elapsed 3y 2m 14d") — no block. The backend is O(1) in window length. |
| **Computing** | 24 skeleton rows at exactly 40px; Compute is `aria-busy`. Recompute keeps the previous table at `opacity: .6`. |
| **Success** | Summary + table + `role="status"`: "Report ready. 12 of 17 agents had coverage." |
| **All agents zero** | A distinct state, not an empty table: "No agent had scheduled working hours in this window." plus a **Why?** disclosure listing the two real causes — no schedule's effective date range covers this window; or no agents are assigned to any covering schedule — each linking to `/schedules`. |
| **Individual zero rows** | Grouped at the bottom behind `⌄ 5 agents with no coverage`, expandable, state persisted per session. (**D5** — the alternative is inline.) |
| **Filtered to nothing** | "No agent matches *chen*." |
| **Error 400** | `InlineAlert` above the table with the server's message; the offending field is focused. |
| **Error 500 / network** | `ErrorState` with Retry. Because mutations do not auto-retry (§5.3), a duplicate report is never silently created. |
| **Agent names still loading** (G3) | Rows render immediately with `Agent #123` in `--color-ink-3` and swap to names when the map resolves. The report is never held hostage to the name join. |
| **History rail** | Skeletons while loading; empty state "No reports yet". Each row shows **only** id, window and relative time — **never an hours figure or agent count** (G4). Selecting hydrates via `GET /reports/{id}`. |

### 9.5 Keyboard and accessibility

- The table is an ARIA grid over virtualised rows:
  ```html
  <div role="grid" aria-rowcount={total + 1} aria-label="Business hours by agent">
    <div role="row" aria-rowindex="1"> …column headers, aria-sort=… </div>
    <div role="row" aria-rowindex={index + 2}> <div role="gridcell">…</div> </div>
  ```
  `aria-rowcount` reflects the **full** row count, not the rendered window — this is the difference between a screen-reader user hearing "row 7 of 3000" and "row 7 of 24".
- **The virtualisation focus bug, handled explicitly:** arrow-key navigation to a row outside the rendered window must call `virtualizer.scrollToIndex(i)` **and wait a frame** before calling `.focus()`, or focus lands on nothing and the reader goes silent. This is a required implementation note, not an optimisation.
- Arrow keys move cell focus; `Home`/`End` to row ends; `Ctrl+Home`/`Ctrl+End` to grid start/end; `Enter` toggles the row expander.
- Column headers are `<button>`s inside `role="columnheader"` with `aria-sort="ascending|descending|none"`.
- Sorting and filtering announce results through `role="status"`: "Sorted by hours, descending." / "42 agents match."
- The share bar is `aria-hidden`; the number beside it is the accessible value.
- Zero-hours rows are marked with `aria-label="Alice Chen, no coverage in this window"` on the row, so absence is stated rather than inferred from a `0`.
- The four summary figures are a `<dl>` — `<dt>` label, `<dd>` value — so they read as pairs.

### 9.6 Responsive

| Breakpoint | Behaviour |
|---|---|
| ≥ 1440px | Full layout with the history rail open. |
| 1024–1439 | History rail collapses to a `⧉ History` button opening a sheet. |
| 768–1023 | Query bar wraps to two lines (dates, then times + Compute). Share column drops. |
| < 768px | Two columns only: agent + hours. The share bar becomes a 2px underline beneath the agent name. Summary figures stack 2×2. The report stays fully usable on mobile — unlike the ribbon, reading a report on a phone is a real scenario. |

---

## 10. Date and time pickers

Bare text inputs and native `<input type="date|time">` are both excluded. Native controls render differently in every browser, cannot be styled to the design system, offer no range mode, and their mobile pickers are inconsistent.

### 10.1 Library decision

**React Aria Components** (`react-aria-components` + `@internationalized/date`), used for `DatePicker`, `DateRangePicker`, `TimeField`, `Calendar`, `Popover`, `ListBox`.

| Alternative | Why not |
|---|---|
| `react-day-picker` v9 | Excellent calendar (~11 KB, keyboard-complete), but **no time field**. We would still hand-roll the segmented time input — the highest-risk a11y surface in this UI — and pull in `date-fns` as its peer. |
| MUI X Date Pickers | Best-in-class functionality, but drags in MUI + Emotion, fights Tailwind at every turn, and lands ~100 KB+. |
| Radix + custom | Radix has no calendar and no date/time field. Same hand-rolling problem, plus a second primitives library. |
| `flatpickr` / `air-datepicker` | Imperative, non-React, DOM-mutating; poor SR support. |
| Native inputs | Rejected per above. |

**Cost of RAC, stated plainly:** ~48 KB gz for the subset used, and a render-prop API more verbose than Radix's. Bought back by: one primitives dependency instead of three, one date model instead of two, `DateRangePicker` for free (exactly the schedule's effective range), and an a11y implementation we do not have to audit ourselves. The calendar panel is code-split (§11.6) so the initial route does not pay for it.

### 10.2 Where each is used

| Field | Component | Notes |
|---|---|---|
| Schedule `start_date` / `end_date` | `DateRangePicker` | One control, two segmented fields, one two-month calendar. `end_date` is nullable → an "Open-ended" toggle clears the end segment and disables it. Enforces `end >= start` client-side (G1). |
| Report ticket start/end **date** | `DatePicker` ×2 | Separate controls rather than a range, because each pairs with its own time field; a range picker would split the datetime across two visually distant controls. A "same day" shortcut copies the start date to the end. |
| Report ticket start/end **time** | `TimePicker` ×2 | |
| Weekday shift `start_hours` / `end_hours` | `TimePicker` ×14 | |

### 10.3 `TimeField` and `TimePicker`

**`TimeField`** — RAC `TimeField` with `granularity="minute"`, `hourCycle={24}`, `shouldForceLeadingZeros`. A segmented control: two segments, `HH` and `MM`.
- Typing: `0900` fills both segments and advances.
- `←` `→` move between segments; `↑` `↓` increment — **hour by 1, minute by 5**; `Home`/`End` jump to 00 / 59; `Backspace` clears a segment.
- Any minute value 0–59 is **typeable**. The 5-minute step is the arrow-key increment only, not a constraint. This matters: `09:07` must be enterable if that is genuinely the shift.

**`TimePicker`** = `TimeField` + a `⏱` trigger opening a `Popover` containing a `ListBox` of **15-minute** options (`00:00, 00:15, …, 23:45`), scrolled to the current value, type-ahead enabled ("14" jumps to 14:00). Mouse users pick; keyboard users type in the field and never open the popover.

**Granularity, stated:** the field accepts any minute; the popover offers 15-minute steps; arrow keys step 5 minutes. Rationale: 15 minutes covers essentially every real shift boundary in a support rota, while the field remains unrestricted for the exceptions. (**D6** if the product owner wants a hard 15- or 30-minute constraint.)

**Mapping to the wire (`float`):**
```
UI → API :  start_hours = hours + minutes / 60          // 22:30 → 22.5, 09:10 → 9.1666666666
API → UI :  const m = Math.round(float * 60);
            hours = Math.floor(m / 60);  minutes = m % 60
```
`Math.round` is mandatory in both directions — the JSON float is not exact (§1.4). `helpers/time.ts` is the only place this conversion appears, and it carries a property test over all 1440 minutes of the day.

**Constraints enforced by the picker (all from G1):**
- `00:00` is never selectable as an **end** value when a start is set. The list ends at `23:45`, and the field rejects `00:00` inline with: *"A shift ending exactly at midnight isn't supported. Use 23:59 for end of day."*
- `end == start` is rejected inline: *"Start and end must be different."*
- `24:00` is not representable at all; the field's maximum is `23:59`.

### 10.4 Overnight in a time picker — the hardest problem, solved by consequence not by mode

The failure mode of every overnight UI is asking the user to *declare* an intent ("is this overnight?") before they have expressed it. This design never asks. The user picks an end time; if it is at or before the start, the interface **immediately shows the consequence**:

1. A `⟳ +1 day` chip appears beside the end field, with `ends Tue` beneath it in caption size — the **resolved day name**, not a relative token.
2. The coverage block extends to the right edge of the day's track and loses its right radius, gaining a 2px cut at the 24:00 boundary.
3. A hatched, read-only ghost fades in at the left edge of the **next** day's track, captioned `↳ 00:00–06:00 continues from Monday · edit it on Monday`.
4. The row's duration recomputes across the boundary (22:00 → 06:00 = 8h, not −16h).
5. A live region announces: *"Overnight shift. Monday 22:00 to Tuesday 06:00. 8 hours."*

Nothing is modal, nothing is undoable-only-by-a-checkbox, and the user can see they got it right without reading a label. Rejected alternatives are recorded in **D3**.

The overnight tail is deliberately **not editable on the day it lands on**. Making it editable there would imply the next day owns two windows, which is exactly the split-shift model the backend does not support. The ghost is read-only, and its caption says where to go.

### 10.5 Picker accessibility

- Every segment is individually labelled and announced ("hour, 22", "minute, 30"). RAC handles this; we must not override `aria-label` on segments.
- The calendar popover is `role="dialog"`; the grid is `role="grid"` with `role="gridcell"` days and `aria-selected`; `PageUp`/`PageDown` change month, `Shift+PageUp/Down` change year, `Esc` closes and returns focus to the trigger.
- Invalid input sets `aria-invalid` on the group and links a `role="alert"` message via `aria-describedby`.
- Every field has a **visible** label (`text-label`) — placeholders are never the only label.
- The trigger button is labelled "Choose date" / "Choose time", not just an icon.
- All picker surfaces meet the 3:1 non-text contrast target; the selected day uses `--color-ink` fill with `--color-invert` text, and today is marked with a ring **and** a dot.

---

## 11. Performance — hard requirements

These are acceptance criteria, verified in CI, not aspirations.

| Budget | Limit |
|---|---|
| Initial route JS | ≤ 180 KB gz |
| CSS | ≤ 25 KB gz |
| Fonts (total) | ≤ 110 KB woff2 |
| LCP (local network, warm cache) | < 1.2s |
| Filter keystroke → paint, 5 000 rows | < 50ms |
| Report table scroll | 60fps, no dropped frames over 5s of continuous scroll |
| CLS on compute | 0 |

### 11.1 The scale assumption

`POST /reports` returns one row per agent, unpaginated. At 3 000 agents the JSON is ~120 KB — parseable in a few milliseconds. **The response is not the problem; rendering 3 000 rows is, and joining 3 000 names is (G3).**

### 11.2 Virtualisation

`@tanstack/react-virtual` v3, on both the report table and the assigned-agents list (above 100 rows).

```ts
const rowVirtualizer = useVirtualizer({
  count: rows.length,
  getScrollElement: () => scrollRef.current,
  estimateSize: () => 40,       // fixed — matches the CSS exactly
  overscan: 10,
});
```
- **Fixed 40px rows, no dynamic measurement.** `measureElement` forces a layout read per row and is the expensive path; a fixed height makes the offset maths arithmetic.
- Rows are absolutely positioned inside a spacer of `height: totalSize` with `transform: translateY(top)`.
- `contain: strict` on the scroll container; `content-visibility: auto` on the history rail.
- ARIA per §9.5, including the `scrollToIndex`-then-focus rule.

**Cost:** virtualised rows are not in the DOM, so browser `Ctrl+F` and naive "select all → copy" do not see them. Mitigated by the always-available **Export CSV** (generated from the in-memory rows, not the DOM) and by the in-app filter. This trade is deliberate and should be stated in the UI's help sheet.

### 11.3 Memoisation boundaries

| Boundary | Rule |
|---|---|
| `AgentHoursRow` | `React.memo`, props are **primitives only**: `name: string`, `seconds: number`, `sharePct: number`, `isZero: boolean`, `top: number`, `index: number`. |
| Never pass `virtualRow` | Its identity changes every scroll frame; passing it defeats the memo entirely. Pass `top` and `index` as numbers. |
| Callbacks | `onExpand` comes from `useCallback` with stable deps; **no inline arrows in the row map**. |
| Formatters | `businessSecondsToHHMMSS` and friends are module-scope pure functions, not recreated per render. |
| Derived rows | One `useMemo` keyed `[agentHours, agentMap, sortKey, sortDir, deferredFilter]` produces the final array. Sorting and filtering never happen inside the render loop. |
| Query subscriptions | `notifyOnChangeProps: ['data', 'error', 'isPending']` on the heavy queries, and `select` to narrow, so an unrelated cache field does not re-render the table. |
| Context | Split by cadence: `ToastContext` changes often, `ThemeContext` almost never. Never one `AppContext`. |

### 11.4 Filtering, sorting, debouncing — the right tool per case

- **Report filter (client-side, in-memory):** `useDeferredValue(query)` (React 19). The input updates at full speed; the 3 000-row list re-derives at React's leisure and is interruptible. A `setTimeout` debounce here would be strictly worse — it adds latency without making the work interruptible.
- **Debounce (250ms, `useDebouncedValue`):** used only where a keystroke would cause a **network call**. Today that is nowhere. It is specified so that when server-side filtering arrives, the tool is already there.
- **Pre-lowercased names:** the filter runs over a `string[]` of lowercased names built once per agent-map change, not `toLowerCase()` per row per keystroke.
- **Pagination (G7):** no total count exists, so `hasMore = page.length === limit`. Schedules and report history use "Load more" with `limit: 50`. The report table is **not paginated** — it is virtualised, because a report is a single logical result and paging it would break sorting.

### 11.5 The week editor must not re-render storm

Seven rows, each with a switch and two segmented time fields — a naively controlled implementation re-renders all seven on every keystroke in any of them, and the ribbon geometry with it.

1. **React Hook Form, uncontrolled**, `mode: 'onBlur'`. A keystroke does not touch React state at all.
2. **Per-row subscription**: each `DayRow` calls `useController({ control, name: 'days.3' })`. Only that row re-renders on its own change. The form root never re-renders.
3. **The cross-row dependency is scoped**: `OvernightGhost` on Tuesday subscribes with `useWatch({ control, name: 'days.1' })` — one field, inside the ghost component only. Monday's edit re-renders exactly two components: Monday's row and Tuesday's ghost.
4. **Geometry bypasses React entirely**: the coverage block's position is two registered custom properties set inline.
   ```css
   @property --from { syntax: '<percentage>'; inherits: false; initial-value: 0%; }
   @property --to   { syntax: '<percentage>'; inherits: false; initial-value: 0%; }
   .coverage { left: var(--from); right: calc(100% - var(--to)); transition: --from var(--dur-2), --to var(--dur-2); }
   ```
   Dragging on the track writes these via a ref in a `pointermove` handler — **zero React renders during a drag**, and the values are committed to RHF on `pointerup`.
5. **Validation is per-field on blur**, whole-form only on submit. `findSelfOverlaps` runs on the form's current values at blur, memoised on a serialised week key.

### 11.6 Bundle discipline

- **Route-level splitting**: each page is `React.lazy`; TanStack Router prefetches the sibling route on nav hover.
- **Calendar chunk**: `CalendarPanel.lazy.tsx` is a dynamic import loaded on first popover open, and **prefetched on field focus** (`<link rel="modulepreload">` injected), so the ~120ms cold-chunk delay is spent while the user is still typing.
- **`manualChunks`**: `react-vendor`, `query-vendor`, `aria-vendor`, `app` — so a dependency bump does not invalidate the app chunk.
- **Enforcement**: `size-limit` with `@size-limit/preset-app` in CI, using the table above; the build **fails** on regression. `rollup-plugin-visualizer` uploads a treemap artifact on every run.
- **Fonts**: subset (Plex Mono to ~20 glyphs), `woff2` only, `font-display: swap`, two `preload` links, self-hosted.
- **Icons**: per-icon `lucide-react` imports, verified in the treemap.
- **No polyfills**: `build.target: 'es2022'`; this is an internal tool on evergreen browsers.
- **React Compiler**: `eslint-plugin-react-compiler` **on** in CI (it flags the memoisation hazards in §11.3 for free). The Babel transform itself is **off for v1** — it adds a Babel pass to an otherwise esbuild/SWC pipeline and roughly doubles build time, for gains we are already getting by hand in the two places that matter. Revisit once the tool is stable.

### 11.7 Skeletons and perceived speed

Every skeleton matches its final element's exact height and column layout, so no state transition moves anything. The report table's skeleton is 24 rows of 40px — the same virtualised container, fed placeholder data. `keepPreviousData` on recompute means the user always has something true on screen. No spinner appears anywhere in the app except inside a button that the user just pressed.

---

## 12. Build and deployment

### 12.1 What already exists

`docker-compose.yml` defines a `frontend` service behind the `frontend` profile: it builds `./frontend`, passes `VITE_API_BASE_URL` as a **build arg** from `APP_BASE_URL`, expects the container to listen on **port 80**, publishes it on `FRONTEND_HOST_PORT` (default 5173), and gates startup on the backend's healthcheck. The spec below fits that contract exactly.

### 12.2 The CORS blocker (G6) and its resolution

As configured, the browser loads the app from `http://localhost:5173` and the app calls `http://localhost:8000` — a cross-origin request against a backend with **no `CORSMiddleware`**. Every call fails. Two resolutions:

**(A) Recommended — same-origin reverse proxy.** nginx in the frontend image proxies `/api/` to `http://backend:8000`. `VITE_API_BASE_URL` becomes `""` and the app issues relative `/api/v1/...` requests.
- No backend change. No CORS. No preflight round trip on every mutation.
- `APP_BASE_URL` stops mattering to the browser entirely, which also removes the build-arg-per-environment problem below.
- Implementation note: nginx resolves upstream names **once at startup**. If the backend container restarts with a new IP, a static `proxy_pass http://backend:8000` will keep hitting the dead address. Use a resolver plus a variable:
  ```nginx
  resolver 127.0.0.11 valid=10s ipv6=off;
  set $backend_upstream http://backend:8000;
  location /api/ { proxy_pass $backend_upstream; }
  ```

**(B) Add `CORSMiddleware`** to `backend/app/main.py` with an explicit origin allow-list. Required anyway if the frontend is ever served from a CDN or a different host from the API.

Recommendation: **(A)**, with (B) added later if a split-host deployment appears. Raised as **D12** because it touches the backend.

### 12.3 Dockerfile and nginx

```dockerfile
# frontend/Dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build          # → /app/dist  (includes .br/.gz precompressed assets)

FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
```

`nginx.conf` essentials:
```nginx
resolver 127.0.0.11 valid=10s ipv6=off;
server {
  listen 80;
  root /usr/share/nginx/html;

  gzip on; gzip_static on; gzip_types text/css application/javascript application/json image/svg+xml;

  location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
  location /fonts/  { add_header Cache-Control "public, max-age=31536000, immutable"; }
  location = /index.html { add_header Cache-Control "no-store"; }

  set $backend_upstream http://backend:8000;
  location /api/ { proxy_pass $backend_upstream; proxy_set_header Host $host;
                   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }

  location / { try_files $uri $uri/ /index.html; }

  add_header X-Content-Type-Options nosniff;
  add_header Referrer-Policy same-origin;
  add_header X-Robots-Tag "noindex, nofollow";
  add_header Content-Security-Policy
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'";
}
```
`font-src 'self'` is possible only because the fonts are self-hosted — a deliberate consequence of §7.2.

### 12.4 `APP_BASE_URL` — build-time versus runtime

The existing compose bakes `VITE_API_BASE_URL` at build time, with the comment "a static SPA bundle has no runtime env". That is true of the bundle, but not of the container. The trade:

- **Build-time (current):** simplest; one image per environment. Promoting a tested image from staging to production requires a rebuild, which means the artifact you tested is not the artifact you ship.
- **Runtime:** the entrypoint writes `/usr/share/nginx/html/config.js` containing `window.__APP_CONFIG__ = { apiBaseUrl: "${APP_BASE_URL}" }`, loaded by a `<script src="/config.js">` before the bundle (and served `no-store`). One image, any environment.

**Recommendation: adopt resolution (A) above and the question mostly dissolves** — with a same-origin proxy the browser needs no base URL at all, and `APP_BASE_URL` becomes a backend-only concern. Keep the build arg wired for the escape hatch. Raised as **D13**.

---

## 13. Verification

### 13.1 Unit (Vitest)
`helpers/` is pure and gets real coverage. Required tests:
- **Property test over all 1440 minutes**: `floatHoursFromMinutes → minutesFromFloatHours` is the identity. This is the direct guard on the G1/§1.4 float boundary.
- `isOvernight`, `shiftDurationSeconds` across midnight and across the Sunday→Monday week wrap.
- `findSelfOverlaps` / `findOverlaps` against the same fixtures as `backend/tests/domain/test_overlap.py`, so the two implementations are pinned to each other.
- `businessSecondsToHHMMSS` for 0, < 1h, > 24h, and > 1000h.

### 13.2 Hook and component (Vitest + Testing Library + MSW)
MSW handlers must reproduce **all three error shapes** from §1.2, plus the `null` body of G5 and the empty `agent_hours` of G4. A test asserts the history rail never renders an hours figure.

### 13.3 End-to-end (Playwright)
1. Create a schedule with an overnight Monday shift; assert the ghost renders on Tuesday and the week total is correct.
2. Assign an agent whose other schedule collides; assert 409 → the agent is **not** added → the conflict panel names the day and hours.
3. Delete a schedule with assignees; assert the impact modal lists names before the confirm is enabled, and that the impact request was already in flight before the click.
4. Compute a report; assert skeleton → results with no layout shift, and that a zero-hours agent appears in the collapsed group.
5. Keyboard-only traversal of both screens with no mouse events.

### 13.4 Continuous checks
`tsc --noEmit` · ESLint (incl. `eslint-plugin-boundaries` for §4.2 and `eslint-plugin-react-compiler`) · `dependency-cruiser` for R1–R7 · `size-limit` for §11.6 · `axe-core` via `@axe-core/playwright` on both screens in both themes · a token-contrast assertion over the §7.3 table.

---

## 14. Decisions needed from the product owner

Every genuine fork encountered. None of these has been decided unilaterally.

**D1 — Vite SPA or Next.js static export?**
The existing system-design document (`…-report-design.md` §1) names "Next.js + Tailwind CSS frontend". This spec recommends a Vite SPA.
*Options:* (a) Vite + React SPA — smaller toolchain, faster builds, matches the static-assets Docker target exactly; (b) Next.js static export — matches the existing document, familiar, but its defining features (SSR, RSC, route handlers) are unusable in a static export, so we carry the weight without the benefit.
**Recommendation: (a).** Needs an explicit amendment to the design doc.

**D2 — TanStack Router or React Router 7?**
*Options:* (a) TanStack Router — typed, validated search params, which is what makes the report window shareable and type-safe; (b) React Router 7 — more familiar, but search-param typing is hand-rolled.
**Recommendation: (a),** unless team familiarity is weighted heavily.

**D3 — How is an overnight shift entered?**
*Options:* (a) **implicit** — the user picks an end ≤ start and the UI immediately shows a `+1 day` chip, the block running off the edge, and the ghost on the next day (this spec's design); (b) an explicit **"ends next day" checkbox** that unlocks the end field — unambiguous but adds a step to every overnight shift and lets the checkbox disagree with the times; (c) **drag-only on the ribbon** — fastest for mouse users, poor for keyboard and precision.
**Recommendation: (a),** with drag on the track as a secondary affordance. It requires no instruction and cannot disagree with itself.

**D4 — Report hours format: decimal, `HH:MM:SS`, or both?**
*Options:* (a) `27:00:00` only — reconciles against ticket logs; (b) `27.00h` only — pastes into a spreadsheet; (c) **both**, primary + secondary in the same cell.
**Recommendation: (c)** — it costs one line of caption text and serves both jobs. Revisit if the column feels crowded at density.

**D5 — Agents with zero hours: show, group, or hide?**
*Options:* (a) inline in the table with `0:00:00` — honest but at 3 000 agents the zeros can swamp the signal; (b) **grouped and collapsed** at the bottom with a count (this spec's default); (c) hidden behind a filter toggle — cleanest table, but "who had no coverage?" is a genuine operational question and hiding it makes the tool less useful.
**Recommendation: (b).**

**D6 — Time picker granularity.**
*Options:* (a) **any minute typeable, 15-minute options in the popover, 5-minute arrow steps** (this spec); (b) hard 15-minute constraint — simpler, but cannot express a 09:07 shift; (c) hard 30-minute constraint.
**Recommendation: (a),** unless the business genuinely never has off-quarter boundaries.

**D7 — Should schedule name and dates become editable?**
Today `PUT /schedules/{id}` accepts `{shifts}` only, so a typo in a name or a wrong end date is unfixable except by delete-and-recreate — which destroys the assignments and, via `deletion-impact`, is the scariest action in the app.
*Options:* (a) accept the gap and label the fields "not editable" with a tooltip explaining why; (b) **extend `PUT` to accept `name`, `start_date`, `end_date`** (note: changing dates alters which schedules cover a window, and therefore changes historical report *reproducibility* — though stored reports keep their computed values); (c) add a separate `PATCH /schedules/{id}/metadata` for name only, leaving dates immutable.
**Recommendation: (b)** for name and `end_date`; treat `start_date` as immutable, since moving it backwards can retroactively create assignment overlaps that were valid when created. Backend change required.

**D8 — Paginate or virtualise the agent table?**
*Options:* (a) **virtualise** (this spec) — one logical result, sortable across the whole set, but virtualised rows are invisible to browser find and DOM copy; (b) paginate at 100/page — find-friendly, but sorting a page is misleading and the backend returns everything anyway, so paging would be purely cosmetic; (c) virtualise + Export CSV (this spec's actual position).
**Recommendation: (c).**

**D9 — How much friction on schedule deletion?**
*Options:* (a) **acknowledgement checkbox carrying the affected count** (this spec); (b) type-the-schedule-name to confirm — appropriate for irreversible production deletes, arguably heavy for a soft delete on an internal tool; (c) plain confirm — too light given the impact.
**Recommendation: (a).** Escalate to (b) if deletions are common and mistakes have been made.

**D10 — Does the report history rail ship in v1?**
`GET /reports` exists and reports are persisted, so history is nearly free — but G4 means each row can only show its window and timestamp until the endpoint returns a summary.
*Options:* (a) ship it with window + timestamp only; (b) defer until the backend returns `agent_count` / `total_business_seconds`; (c) drop history from the UI entirely.
**Recommendation: (a).** Re-running a window is cheap, and a shareable list of past windows is genuinely useful.

**D11 — 24-hour and 24/7 schedules: does the business need them?**
Per G1, a shift ending at midnight is not expressible; the closest is `23:59`, so a 24/7 schedule loses one minute per day (~7 min/week, ~0.07%).
*Options:* (a) accept the one-minute-per-day gap and say nothing; (b) accept it and surface it in the UI ("ends 23:59 — a shift to exactly midnight isn't supported"); (c) **change the backend** to accept `end_hours: 24` as end-of-day (a bounds change in `ShiftInputSchema` and `WeekdayShift`, plus letting the overnight tail be omitted when `end == 24`).
**Recommendation: (c)** if any brand runs a 24/7 desk — which, for ecommerce support, is likely. Otherwise (b).

**D12 — CORS: reverse proxy or `CORSMiddleware`?** (Blocker — nothing works until this is decided.)
*Options:* (a) **nginx proxies `/api/` to the backend**, same origin, no backend change, no preflight; (b) add `CORSMiddleware` with an origin allow-list; (c) both.
**Recommendation: (a)** now, (b) added if a split-host or CDN deployment ever appears.

**D13 — `APP_BASE_URL` at build time or runtime?**
*Options:* (a) keep the current build arg — simple, but one image per environment and the artifact you tested is not the one you ship; (b) runtime `/config.js` written by the entrypoint — one image everywhere; (c) same-origin proxy, in which case the browser needs no base URL at all.
**Recommendation: (c)** as the primary, with (a) retained as an escape hatch.

**D14 — There is no authentication. What sits in front of this?**
The backend has no auth layer, so anyone who can reach the port can delete every schedule.
*Options:* (a) VPN-only, never published to a public host; (b) an SSO reverse proxy (oauth2-proxy or equivalent) in front of nginx; (c) add auth to the backend.
**Recommendation: (a) for the take-home / internal build, (b) before any real deployment.** Explicit confirmation needed that this tool is never internet-exposed.

**D15 — Should the client re-implement the overlap rule?**
This spec duplicates `backend/app/domain/overlap.py` in `helpers/shifts.ts` to pre-empt and explain 409s (§6, §8.6) — necessary only because of G2.
*Options:* (a) **duplicate now, delete `findOverlaps` once G2 ships** (this spec); (b) do not duplicate — accept a generic "this conflicts with another schedule" message until the backend returns structured conflicts; (c) duplicate permanently for instant inline feedback even after G2.
**Recommendation: (a).** It is ~20 lines of interval arithmetic pinned to the backend's own test fixtures, and the alternative is an error message that does not tell the user what to change.

---

## Appendix A — Backend change requests, consolidated

Ordered by value to the frontend. Each is small; none blocks the UI from shipping except the first.

| # | Change | Why |
|---|---|---|
| **B1** | Register `CORSMiddleware`, **or** confirm the nginx same-origin proxy (D12) | Blocker — no request succeeds otherwise (G6) |
| **B2** | Map `ValueError` and `IntegrityError` to **422** with distinct `error_code`s | Four user-reachable inputs currently return 500 (G1) |
| **B3** | Structured 409 body: `agent_id` + `conflicts[]`, and split `error_code` into `schedule_self_overlap` / `assignment_overlap` | Deletes a 2–4-request workaround and a duplicated rule (G2) |
| **B4** | Embed `agent_name` in `POST /reports` rows (or raise the `/agents` cap, or add `?ids=`) | Removes 15 sequential requests at 3 000 agents (G3) |
| **B5** | Omit `agent_hours` from `GET /reports`, or add `agent_count` + `total_business_seconds` | The field currently reads as "zero" (G4) |
| **B6** | Accept `end_hours: 24` as end-of-day | Makes 24-hour and 24/7 schedules expressible (G1, D11) |
| **B7** | Return the created assignment (or 204) from `POST /schedules/{id}/agents` | Removes a null-body special case (G5) |
| **B8** | Add `X-Total-Count` to list endpoints | Enables honest pagination (G7) |
| **B9** | Extend `PUT /schedules/{id}` to accept `name` and `end_date` | Removes delete-and-recreate as the only way to fix a typo (D7) |
| **B10** | Override FastAPI's 422 handler to emit `{error_code, message}` | One error envelope instead of two (§1.2) |
