# Frontend Implementation Plan — Schedule Configuration & Resolution Time Report

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-08-09
**Goal:** Implement the two-screen React frontend (Schedule Configuration, Resolution Time Report) specified in `docs/superpowers/specs/2026-08-09-frontend-design-spec.md`, against the FastAPI backend in `backend/app/`.

**Companion documents:**
- `docs/superpowers/specs/2026-08-09-frontend-design-spec.md` — the design spec. This plan implements it.
- `docs/superpowers/specs/2026-08-09-schedule-resolution-report-design.md` — system/domain design.
- `docs/superpowers/plans/2026-08-09-schedule-resolution-report-backend.md` — the backend plan (already executed). This plan matches its format.

**Architecture:** Layered SPA — `pages/` (screens, composition) → `hooks/` (server state via TanStack Query) → `api/apiService.ts` (typed client) → `api/http.ts` (the only module that calls `fetch`). `components/` and `helpers/` are **leaves**: they never import upward. `context/` holds cross-cutting **UI** state only.

**Tech Stack:** React 19 + TypeScript 5 + Vite (SPA), Tailwind CSS v4, TanStack Query v5, TanStack Router v1, React Hook Form 7 + Zod, React Aria Components v1 + `@internationalized/date`, `@tanstack/react-virtual` v3, `sonner`, `lucide-react`. **Test stack: Vitest + React Testing Library + `@testing-library/user-event` + `@testing-library/jest-dom` + MSW v2 (unit/integration), Playwright + `@axe-core/playwright` (E2E/a11y).** These are named here once and used in every task below — do not introduce a second runner or a second mocking library.

---

## 0. Read this before Task 1

### 0.1 The framework assumption — FLAGGED OPEN, decide before Task 1 ends

**This plan is written for React + TypeScript + Vite as a client-rendered SPA.** That is a *working assumption*, not a settled decision.

**Why Vite SPA is the working assumption:** the deployment target (§ Task 20) is three separate containers — frontend, backend, postgres — where the frontend container serves a **static asset bundle** from nginx and holds no Node runtime. A static bundle is exactly what Vite produces. Next.js earns its cost through SSR, React Server Components, route handlers and middleware; a `next build && next export` static export disables all of them, leaving a heavier toolchain buying nothing. There is no SEO surface (internal ops tool) and no server-side data loading requirement.

**What changes if the product owner chooses Next.js instead:**

| Area | Vite SPA (this plan) | Next.js static export |
|---|---|---|
| Tasks 1, 20, 21 | `npm create vite`, `dist/`, `@tailwindcss/vite` | `create-next-app`, `output: 'export'`, `out/`, `@tailwindcss/postcss`. `BUILD_OUTPUT_DIR` build-arg in `frontend/Dockerfile` changes `dist` → `out`. |
| Env var name | `VITE_APP_BASE_URL` | `NEXT_PUBLIC_APP_BASE_URL` — and the `args:` key in `docker-compose.yml` changes with it |
| Router (Task 13) | TanStack Router, code-based route tree | Next App Router; `useSearchParams` replaces `validateSearch`, and the report's typed `?from/?to` params must be hand-validated with the same Zod schema |
| Everything else | — | **Tasks 3–12 and 14–19 are unchanged.** `helpers/`, `api/`, `hooks/`, `components/`, and both screens are framework-agnostic React. |

**Blast radius of choosing wrong: Tasks 1, 13, 20, 21 only.** Every task in between is portable. Do not let this decision block starting — but **get it answered before Task 13**, because that is where the router lands.

**The router itself is also open.** This plan uses **TanStack Router v1** (code-based route tree, no codegen plugin) because the report screen's ticket window belongs in typed, validated search params (`?from=…&to=…&reportId=…`) so a computed report is shareable and survives reload. React Router 7 is an acceptable substitute; it costs a hand-rolled `parseSearch` + Zod validation in one file (`src/routes/reports.route.ts`). Nothing else in the plan touches the router.

### 0.2 Decisions already made — do not re-open

These are given. Do not spend a step relitigating them.

| Concern | Decision |
|---|---|
| CSS | **Tailwind CSS v4** (CSS-first `@theme` tokens) |
| Server state | **TanStack Query v5**. Nothing else. No Redux/Zustand/Jotai. |
| API client | **Class-based `ApiService` singleton**, typed method per endpoint, over a thin `http.ts` |
| Data access | **Custom hooks only.** A component that imports `apiService` is a build failure (Task 2, rule R1). |
| Query keys | Centralised `hooks/queryKeys.ts` factory |
| React Context | **Cross-cutting UI state only** — toasts, modal orchestration, theme. Never a wrapper around server state; the TanStack cache is already global. `SchedulesContext` / `AgentsContext` / `ReportContext` are forbidden (rule R6). |
| Pickers | **Real** calendar + clock components, keyboard-complete and screen-reader labelled. Native `<input type=date|time>` is excluded. |
| Deployment | **Three separate containers on different ports** — frontend, backend, postgres. Frontend calls the API **cross-origin** via `VITE_APP_BASE_URL`. |
| nginx `/api` reverse proxy | **REJECTED.** The frontend container serves static assets only. It does not proxy. `CORSMiddleware` on the backend is being added separately — assume it exists. |
| Error handling | **First-class, product-owner-mandated.** Every status and transport failure is handled explicitly. See §0.4. |
| 24-hour / 24-7 schedules | **Not supported by the backend.** The UI prevents them client-side and surfaces the server rejection cleanly if one slips through. Never a silent failure. |

### 0.3 Verified backend contract

Read directly from `backend/app/api/v1/{agents,schedules,schedule_agents,reports}/router.py` and `request_response.py`, `backend/app/main.py`, `backend/app/shared/pagination.py`, `backend/app/domain/{types,shift_normalization,overlap}.py`. **Do not trust any summary of this table — including this one — over the source.** Re-verify if the backend has moved.

Every router carries its own `prefix`, so **`/api/v1` is part of the path, not part of the base URL.** With `VITE_APP_BASE_URL=http://localhost:8000`, requests go to `http://localhost:8000/api/v1/agents`.

| Method | Path | Success | Response body | Verified notes |
|---|---|---|---|---|
| GET | `/api/v1/agents?limit&offset` | 200 | `[{id:number, name:string, email:string\|null}]` | `PaginationParams`: `limit` default 50, `ge=1`, **`le=200`**; `offset` default 0, `ge=0`. Out-of-range → **422**. No total count. |
| GET | `/api/v1/agents/{agent_id}/schedules` | 200 | `[{id, name}]` | Unknown agent returns `[]`, **not 404**. |
| POST | `/api/v1/schedules` | 201 | `{id, name, start_date, end_date\|null, shifts:[{weekday,start_hours,end_hours}]}` | Body `{name, start_date, end_date?, shifts[]}`. Dates are `YYYY-MM-DD`. |
| GET | `/api/v1/schedules?limit&offset` | 200 | `[Schedule]` | Active only. |
| GET | `/api/v1/schedules/{id}` | 200 | `Schedule` | 404 if missing/soft-deleted. |
| PUT | `/api/v1/schedules/{id}` | 200 | `Schedule` | Body is **`{shifts:[...]}` only** — `ScheduleUpdateRequest` has no other field. **Name and dates are NOT editable.** Can 409. |
| GET | `/api/v1/schedules/{id}/deletion-impact` | 200 | `{schedule_id, affected_agent_ids:number[]}` | **IDs only, no names.** |
| DELETE | `/api/v1/schedules/{id}` | 204 | *empty* | Soft delete. |
| GET | `/api/v1/schedules/{id}/agents` | 200 | `[{id, name}]` | |
| POST | `/api/v1/schedules/{id}/agents` | 201 | **`null`** | Body `{agent_id}`. Handler has **no `response_model` and returns `None`** → the body is the four bytes `null`. `res.json()` yields `null`, not a throw. Task 6 handles this. |
| DELETE | `/api/v1/schedules/{id}/agents/{agent_id}` | 204 | *empty* | Idempotent, never 404s. |
| POST | `/api/v1/reports` | 201 | `{id, ticket_start_at, ticket_end_at, agent_hours:[{agent_id, business_seconds}]}` | Body `{ticket_start_at, ticket_end_at}` (ISO datetime). One row **per agent**, unpaginated. **NOT idempotent** — every call inserts a row. |
| GET | `/api/v1/reports?limit&offset` | 200 | `[Report]` | **`agent_hours` is always `[]`** — `list_reports` never populates it. Never render an hours figure from a list row. |
| GET | `/api/v1/reports/{id}` | 200 | `Report` | Fully populated. 404 if missing. |

**Domain rules (verified in `backend/app/domain/`):**
- `weekday`: **0 = Monday … 6 = Sunday**.
- `start_hours` / `end_hours` are floats in `[0, 24)`. `22.5` = 22:30.
- **Overnight** = `end_hours <= start_hours` (`ShiftInput.crosses_midnight`). `normalize_shift()` splits it into a primary `start → 24:00` plus a tail `00:00 → end` on weekday `(weekday + 1) % 7`. **A Sunday overnight shift wraps onto Monday.**
- Exactly **one window per weekday**; enforced by a DB unique partial index, not by validation.
- Assignment overlap is checked per agent across their other active schedules. A `PUT` re-runs it for **every** assignee — an edit can be rejected because of an agent you are not looking at.
- All times are **IST (`Asia/Kolkata`)**, pinned as a constant. There is no timezone picker.

### 0.4 Error contract — verified, and it does not match the brief

`backend/app/main.py` registers handlers for exactly `NotFoundError → 404 not_found`, `ConflictError → 409 conflict`, `DomainValidationError → 400 validation_error`, and a catch-all `Exception → 500 internal_error`. All four emit **`{"error_code": str, "message": str}`**.

**It does NOT override FastAPI's `RequestValidationError` handler.** As the code stands today, a 422 arrives as FastAPI's native **`{"detail": [{"loc": [...], "msg": "...", "type": "..."}]}`** — *not* `{error_code, message, details}`. A normalisation of 422 into the `{error_code, message, details}` envelope may be landing separately (as `CORSMiddleware` is).

**Resolution — do not guess: `http.ts` normalises BOTH shapes into one `ApiError`.** Task 6 implements and tests both branches. This is strictly safer than betting on either, costs about fifteen lines, and means the frontend does not break whichever way the backend lands. **Flagged for the product owner: confirm whether the 422 normalisation is shipping.**

**Four user-reachable inputs return 500, not a validation error** (traced through `ShiftInputSchema.to_domain()` → `ShiftInput.__post_init__` and `normalize_shift()`, which are called *inside* the route handler, so their `ValueError`s hit the catch-all):

| Input | Actual backend result | Client guard (mandatory) |
|---|---|---|
| `start_hours == end_hours` | **500** (`ShiftInput.__post_init__`: "shift cannot have zero duration") | Blocked inline before send: *"Start and end must be different times."* |
| `end_hours: 0` with `start_hours > 0` | **500** (tail row would be `00:00 → 00:00`, violating `ZERO < end_time`) | `00:00` is never offered as an **end** value once a start is set. Last option is `23:59`, labelled "end of day". |
| Two windows on one weekday | **500** (unique-index `IntegrityError`, unhandled) | Structurally impossible — the week editor has exactly one row per weekday and offers no "add window". |
| `end_date < start_date` | **500** (DB `CheckConstraint`) | `DateRangePicker` enforces `end >= start`. |
| `end_hours: 24` | **422** (Pydantic `end_hours < 24`) | Field maximum is `23:59`; `24:00` is not representable. |

**Consequence, stated plainly: a 24-hour or 24/7 schedule is not expressible.** `00:00 → 24:00` is a 422 and `09:00 → 00:00` is a 500. The closest representable full day is `00:00 → 23:59`. The UI must say so — Task 16 renders the caption *"A shift ending exactly at midnight isn't supported — use 23:59 for end of day."* — and must never let the user submit one and watch it fail.

**The 409 body identifies nothing structurally.** Both an assignment overlap and a schedule self-overlap collapse to `{"error_code": "conflict", "message": "agent 42 would have 2 overlapping shift(s)"}`. The client cannot tell them apart from the code, and **must not regex the agent id out of `message`** — that string is not a contract.

*Design for what it returns today:* pre-empt self-overlap client-side with `helpers/shifts.findSelfOverlaps` so that case never reaches the wire; on a server 409, fetch the affected agent's other schedules and recompute the collision locally to name the day and hours (Task 17). *Note the improvement:* the backend already builds `Overlap(a, b)` objects with full weekday/time detail and throws them away. Asking it to return `{error_code: "assignment_overlap", agent_id, conflicts: [{weekday, existing, proposed}]}` deletes the entire workaround. Filed in §0.7 as **B3**.

### 0.5 Folder structure — use exactly this

```
frontend/
├── Dockerfile                      # already exists as a template; activated in Task 20
├── .dockerignore                   # already exists
├── .env                            # GITIGNORED. VITE_APP_BASE_URL=...        (Task 1)
├── .env.example                    # COMMITTED, documented template            (Task 1)
├── index.html
├── package.json  package-lock.json  tsconfig.json  vite.config.ts
├── eslint.config.js                # incl. boundary rules R1–R7               (Task 2)
├── .dependency-cruiser.cjs         # CI enforcement of R1–R7                  (Task 2)
├── vitest.config.ts  vitest.setup.ts
├── playwright.config.ts
├── public/fonts/                   # self-hosted woff2 — no CDN
└── src/
    ├── main.tsx                    # createRoot
    ├── App.tsx                     # QueryClientProvider + RouterProvider + contexts
    ├── config.ts                   # reads import.meta.env.VITE_APP_BASE_URL; fails loudly
    │
    ├── api/                        # ══ transport + typed client ═══════════════
    │   ├── http.ts                 # the ONLY module that calls fetch(); exports ApiError
    │   ├── apiService.ts           # class ApiService + `export const apiService`
    │   └── types.ts                # wire DTOs, 1:1 with backend response models
    │
    ├── hooks/                      # ══ the ONLY consumers of apiService ═══════
    │   ├── queryKeys.ts
    │   ├── queries/                # useAgents, useAgentMap, useAgentSchedules,
    │   │                           #   useSchedules, useSchedule, useScheduleAgents,
    │   │                           #   useDeletionImpact, useReports, useReport
    │   ├── mutations/              # useCreateSchedule, useUpdateScheduleHours,
    │   │                           #   useDeleteSchedule, useAssignAgent,
    │   │                           #   useUnassignAgent, useGenerateReport
    │   └── ui/                     # useDebouncedValue, useOnlineStatus, useHoverIntent
    │
    ├── context/                    # ══ cross-cutting UI state ONLY ════════════
    │   ├── ToastContext.tsx
    │   ├── ModalContext.tsx
    │   └── ThemeContext.tsx
    │
    ├── components/                 # ══ shared leaves — never import upward ════
    │   ├── layout/                 # AppShell, Header, NavTabs, IstClock, ThemeToggle
    │   ├── ui/                     # Button, Field, TextField, Switch, Chip, Badge,
    │   │                           #   Skeleton, EmptyState, VisuallyHidden
    │   ├── modals/                 # Modal, ConfirmModal, DeletionImpactModal,
    │   │                           #   AssignAgentModal
    │   ├── datetime/               # DateField, DatePicker, DateRangePicker,
    │   │                           #   TimeField, TimePicker, CalendarPanel.lazy
    │   └── feedback/               # ErrorBoundary, ErrorState, InlineAlert,
    │                               #   ConflictPanel, ToastViewport, OfflineBanner
    │
    ├── helpers/                    # ══ pure functions — no React, no imports up ═
    │   ├── time.ts  duration.ts  weekday.ts  shifts.ts  dates.ts  format.ts
    │   └── errorPresentation.ts
    │
    ├── pages/
    │   ├── schedules/              # SchedulesPage + its screen-specific components
    │   │   └── week-ribbon/
    │   └── reports/                # ReportPage + its screen-specific components
    │
    ├── routes/                     # TanStack Router route definitions
    └── styles/                     # theme.css, globals.css
```

**Deviations from the design spec's §4 tree, and why:** the spec proposed `contexts/`, `components/pickers/` and a top-level `features/`. This plan uses the mandated `context/`, `components/datetime/` and folds screen-specific components under `pages/{schedules,reports}/`. `api/ApiError.ts` and `api/index.ts` are folded into `api/http.ts` and `api/apiService.ts` respectively. **Where the two documents disagree on folder names, this plan wins; where they disagree on behaviour, the spec wins.**

### 0.6 Dependency direction — testable constraints, enforced in CI

```
pages ──► hooks ──► api/apiService ──► api/http ──► fetch
  │         │
  └─────────┴────────► components/   helpers/   ← leaves: import nothing above them
                              ▲
                        context/   (UI state only)
```

| # | Rule | Enforced by |
|---|---|---|
| R1 | Nothing outside `src/hooks/**` may import from `src/api/**`. | dependency-cruiser + ESLint |
| R2 | `src/components/**` may not import from `src/api/**`, `src/pages/**`, or `src/hooks/**` *except* `src/hooks/ui/**`. | dependency-cruiser |
| R3 | `src/helpers/**` may import only from `src/helpers/**` and `@internationalized/date`. **It may not import `react`.** | dependency-cruiser |
| R4 | `src/pages/schedules/**` may not import from `src/pages/reports/**`, and vice versa. Anything both need is promoted to `components/` or `helpers/`. | dependency-cruiser |
| R5 | `src/api/http.ts` is the **only** module permitted to reference `fetch`. | ESLint `no-restricted-globals` |
| R6 | `src/context/**` may not import from `src/api/**` or from `src/hooks/queries/**` or `src/hooks/mutations/**`. *This is the rule that structurally prevents a redundant `SchedulesContext`.* | dependency-cruiser |
| R7 | `src/pages/**` may not import `@tanstack/react-query` directly — no bare `useQuery`/`useMutation` in a page. It composes hooks. | dependency-cruiser |

Task 2 makes each of these fail a real build, and proves it with a deliberately-violating fixture.

### 0.7 Backend change requests raised by this plan

None of these blocks the frontend from shipping. Each is filed for the product owner.

| # | Change | Why |
|---|---|---|
| **B1** | Confirm `CORSMiddleware` is registered with `VITE_APP_BASE_URL`'s origin in the allow-list | Cross-origin is the chosen deployment. Nothing works without it. Assumed to exist. |
| **B2** | Map `ValueError` / `IntegrityError` to **422** with distinct `error_code`s | Four user-reachable inputs currently return **500** (§0.4) |
| **B3** | Structured 409: `{error_code: 'assignment_overlap'\|'schedule_self_overlap', agent_id, conflicts[]}` | Deletes a 2–4-request client workaround and a duplicated rule |
| **B4** | Embed `agent_name` in `POST /reports` rows (or raise the `/agents` 200 cap, or add `?ids=`) | At 3 000 agents the name join is 15 sequential requests |
| **B5** | Omit `agent_hours` from `GET /reports`, or add `agent_count` + `total_business_seconds` | The field currently reads as "zero" |
| **B6** | Accept `end_hours: 24` as end-of-day | Makes 24-hour / 24-7 schedules expressible at all |
| **B7** | Return `204` (or the created assignment) from `POST /schedules/{id}/agents` | Removes a `null`-body special case |
| **B8** | Add `X-Total-Count` to list endpoints | Enables honest pagination instead of `hasMore = page.length === limit` |
| **B10** | Override FastAPI's 422 handler to emit `{error_code, message, details}` | One error envelope instead of two (§0.4) |

### 0.8 Flagged-open decisions — do NOT decide these while implementing

Surface these to the product owner. Where a task must proceed, it proceeds on the stated default and isolates the choice to one file.

| # | Question | Default this plan uses | Isolated to |
|---|---|---|---|
| **F1** | **Framework: Vite SPA or Next.js?** | Vite SPA (§0.1) | Tasks 1, 13, 20, 21 |
| **F2** | **Router: TanStack Router or React Router 7?** | TanStack Router v1 | Task 13 (`src/routes/`) |
| **F3** | **Report hours format: decimal, `HH:MM:SS`, or both?** | Both — `27:00:00` primary, `27.00h` secondary caption | `AgentHoursRow.tsx` |
| **F4** | **Zero-hour agents: shown inline, grouped, or hidden?** | Grouped and collapsed at the bottom with a count | `AgentHoursTable.tsx` |
| **F5** | **Time granularity** — any minute typeable / 15-min popover options / 5-min arrow steps, or a hard 15- or 30-minute constraint? | Any minute typeable; 15-min popover; 5-min arrow steps | `components/datetime/TimePicker.tsx` |
| **F6** | **Pagination vs virtualisation threshold** — report table is virtualised, not paged (backend returns everything, and paging would break cross-set sorting). Lists use "Load more" at `limit: 50`. Assigned-agents list virtualises above 100 rows. Confirm the 100 threshold. | Virtualise the report table; `limit: 50` load-more elsewhere | `AgentHoursTable.tsx`, `hooks/queries/` |
| **F7** | **Authentication — there is none today.** Anyone who can reach the port can delete every schedule. VPN-only? SSO reverse proxy? Backend auth? | No auth; `X-Robots-Tag: noindex`; **must not be published on a public host** | Task 20 |
| **F8** | **`VITE_APP_BASE_URL` at build time or runtime?** See §0.9 — this is a real question because of the three-container deployment. | **Build-time inlining** (matches the existing Dockerfile/compose contract), with the runtime path documented as a one-task swap | Tasks 1, 20 |
| **F9** | Is the 422 envelope being normalised to `{error_code, message, details}` (§0.4)? | Handle **both** shapes | Task 6 |

### 0.9 Environment files — per-service, and the `VITE_` prefix trap

**Env files live per service, not at the repo root.** The frontend reads **`frontend/.env` and nothing else**. There is a matching `backend/.env` / `backend/.env.example` pair; `docker-compose.yml` points each service's `env_file:` at its own directory. Do not plan around, read from, or write to a shared root `.env`.

**⚠ The `VITE_` prefix is not optional.** Vite only exposes variables whose names begin with `VITE_` to client code. A variable named `APP_BASE_URL` is **silently `undefined`** in the browser bundle — no warning, no build error, just a `fetch` to `undefined/api/v1/agents` at runtime. The frontend's variable is therefore **`VITE_APP_BASE_URL`**, and `src/config.ts` **throws at module load** if it is missing or empty, so the failure is loud and immediate rather than a mystery 404 an hour later.

**⚠ Vite inlines env vars at BUILD time.** `import.meta.env.VITE_APP_BASE_URL` is not read at runtime — it is textually substituted into the bundle during `npm run build`. In a containerised static build this means **the API URL is baked into the image**, so promoting the image you tested from staging to production requires a rebuild — the artifact you ship is not the artifact you tested. The alternative is a runtime `config.js` written by the container entrypoint (`window.__APP_CONFIG__ = { apiBaseUrl: "${APP_BASE_URL}" }`, served `no-store`, loaded before the bundle), read by `src/config.ts` with the build-time value as fallback. **This plan defaults to build-time inlining** because it matches the existing `frontend/Dockerfile` and `docker-compose.yml` build-arg contract, and one environment is all that exists today. **Filed as F8** — if more than one environment ever appears, switch; `src/config.ts` is the only file that changes.

---

## Global constraints

- All frontend code lives under `/Users/tanishq/Desktop/Richpanel/frontend/`. All commands below `cd` there explicitly — never rely on a persisted working directory.
- **No placeholders.** Every step has complete, runnable code. If a step's code references a symbol, that symbol exists by then.
- **TDD is not optional.** Every task: write the failing test → *run it and see the stated failure* → write the implementation → run and see the stated pass count → commit. A step that says "Expected: FAIL — …" is a step you must actually run and observe.
- Every component that can render a failure **must** specify its error states. A task whose UI has no error path is a task with a bug.
- `helpers/` never imports React. `components/` never imports `apiService`. Enforced by Task 2, not by good intentions.
- Package versions below are pinned by **major**. If a major has moved on by implementation time, take the current stable major and re-run that task's tests — nothing here depends on a minor version.
- Commit messages are given verbatim. Do not add a `Co-Authored-By` trailer.

---

### Task 1: Project setup — Vite + React + TypeScript + Tailwind v4 + TanStack Query + test stack + env

**Files:**
- Create: `frontend/package.json`, `frontend/package-lock.json`, `frontend/index.html`, `frontend/tsconfig.json`, `frontend/tsconfig.node.json`, `frontend/vite.config.ts`, `frontend/vitest.config.ts`, `frontend/vitest.setup.ts`
- Create: `frontend/.env`, `frontend/.env.example`
- Create: `frontend/src/main.tsx`, `frontend/src/App.tsx`, `frontend/src/config.ts`, `frontend/src/styles/globals.css`
- Create: `frontend/src/config.test.ts`, `frontend/src/smoke.test.tsx`
- Modify: `/Users/tanishq/Desktop/Richpanel/.gitignore` (verify only — likely no change needed)

**Interfaces:**
- Produces: a runnable dev server; `npm run build` → `frontend/dist/`; `npm test` running Vitest with jsdom + React Testing Library + `@testing-library/jest-dom` matchers; `src/config.ts` exporting **`API_BASE_URL: string`** (trailing slashes stripped, throws at module load if `VITE_APP_BASE_URL` is unset/empty).
- Every later task depends on `API_BASE_URL` and on the test stack named here. No task introduces a second test runner.

- [ ] **Step 1: Scaffold the Vite project and install dependencies**

Run:
```bash
cd /Users/tanishq/Desktop/Richpanel/frontend && \
npm create vite@latest . -- --template react-ts --overwrite && \
npm install
```
Expected: `package.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `tsconfig*.json`, `vite.config.ts` created alongside the existing `Dockerfile` and `.dockerignore`. `node_modules/` populated.

If `npm create` refuses because the directory is non-empty, scaffold into a temp dir and move the files in — `Dockerfile` and `.dockerignore` must survive:
```bash
cd /Users/tanishq/Desktop/Richpanel && \
npm create vite@latest /tmp/rp-fe -- --template react-ts && \
cp -R /tmp/rp-fe/. frontend/ && rm -rf /tmp/rp-fe && \
cd frontend && npm install
```

Then add runtime and dev dependencies:
```bash
cd /Users/tanishq/Desktop/Richpanel/frontend && \
npm install \
  @tanstack/react-query@^5 \
  @tanstack/react-router@^1 \
  @tanstack/react-virtual@^3 \
  react-aria-components@^1 \
  @internationalized/date@^3 \
  react-hook-form@^7 \
  zod@^3 \
  @hookform/resolvers@^3 \
  sonner@^2 \
  lucide-react@^0.4 && \
npm install -D \
  tailwindcss@^4 @tailwindcss/vite@^4 \
  vitest@^3 @vitest/coverage-v8 jsdom \
  @testing-library/react@^16 @testing-library/dom@^10 \
  @testing-library/user-event@^14 @testing-library/jest-dom@^6 \
  msw@^2 \
  dependency-cruiser@^16 \
  @tanstack/react-query-devtools@^5
```
Expected: all packages resolve and install. If `sonner@^2` does not exist yet, use `sonner@^1` — the imperative API used in Task 10 is identical.

**Package justification (asked for explicitly):**

| Package | Approx. gz | Why this one |
|---|---|---|
| `react-aria-components` + `@internationalized/date` | ~48 KB (of which ~9 KB is the date package) | **The pickers decision.** RAC is the only unstyled primitive library shipping a mature, keyboard-complete, screen-reader-correct `DatePicker`, `DateRangePicker`, `TimeField`, `Calendar` **and** the `Dialog`/`Popover`/`ComboBox`/`ListBox` this app needs — one a11y source of truth instead of three. Radix has **no** calendar and **no** date/time field, so choosing it means Radix + `react-day-picker` + a hand-rolled segmented time input, and a hand-rolled segmented time input is precisely where a11y bugs live. MUI X drags in MUI + Emotion (~100 KB+) and fights Tailwind. `flatpickr` is imperative and DOM-mutating with poor SR support. **Tailwind integration is first-class:** RAC exposes `data-[focused]`, `data-[selected]`, `data-[disabled]`, `data-[invalid]` for direct variant targeting. The calendar panel is code-split (Task 14) so the initial route does not pay for it. `@internationalized/date` arrives with RAC anyway — it is free at the margin, and it is why this plan adds **no** `date-fns`/Luxon/moment. |
| `@tanstack/react-virtual` | ~3 KB | **The virtualisation decision.** Headless — it computes offsets and leaves the DOM and ARIA to us, which matters because the report table is an ARIA grid with a real `aria-rowcount`. `react-virtuoso` (~28 KB) is heavier and opinionated about markup; `react-window` is lighter but its dynamic-measurement story is weak and maintenance is thin. |
| `react-hook-form` + `zod` + `@hookform/resolvers` | ~11 KB | Uncontrolled inputs are the *mechanism* by which the Week Ribbon avoids a re-render storm (Task 16), not a preference. One Zod schema both validates the form and encodes the §0.4 client guards. |
| `sonner` | ~4 KB | Accessible live-region handling and an imperative API, with no styling opinions we cannot override. |
| `lucide-react` | ~0.4 KB per icon | Per-icon named imports tree-shake under Rollup. |

**Deliberately NOT installed:** Redux/Zustand/Jotai (Task 8 §"why no store"), `axios` (`fetch` plus ~90 lines in `http.ts`), `@tanstack/react-table` (~14 KB to buy sorting we write in 15 lines of `useMemo`), any animation library, any charting library, shadcn/ui as a component set.

- [ ] **Step 2: Write the failing config test**

```ts
// frontend/src/config.test.ts
import { describe, expect, it, vi, afterEach } from 'vitest';

async function loadConfig(value: string | undefined) {
  vi.resetModules();
  vi.stubEnv('VITE_APP_BASE_URL', value as string);
  return import('./config');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('config', () => {
  it('exposes the API base URL from VITE_APP_BASE_URL', async () => {
    const { API_BASE_URL } = await loadConfig('http://localhost:8000');
    expect(API_BASE_URL).toBe('http://localhost:8000');
  });

  it('strips trailing slashes so path joining never doubles them', async () => {
    const { API_BASE_URL } = await loadConfig('http://localhost:8000///');
    expect(API_BASE_URL).toBe('http://localhost:8000');
  });

  it('throws loudly when the variable is missing, rather than fetching undefined/...', async () => {
    await expect(loadConfig(undefined)).rejects.toThrow(/VITE_APP_BASE_URL/);
  });

  it('throws when the variable is present but empty', async () => {
    await expect(loadConfig('   ')).rejects.toThrow(/VITE_APP_BASE_URL/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/config.test.ts`
Expected: FAIL — `Failed to resolve import "./config"` (the module does not exist yet), or `No test suite found` if the Vitest config is also missing. Both are the expected pre-implementation failure.

- [ ] **Step 4: Write the configuration files**

```jsonc
// frontend/package.json  — replace the "scripts" block with exactly this
{
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "typecheck": "tsc --noEmit",
    "lint:arch": "depcruise src --config .dependency-cruiser.cjs",
    "e2e": "playwright test"
  }
}
```
Leave the generated `name`, `version`, `type: "module"`, `dependencies` and `devDependencies` untouched.

```ts
// frontend/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    // Internal tool on evergreen browsers — no polyfill weight.
    target: 'es2022',
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        // Split so a dependency bump does not invalidate the app chunk.
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'query-vendor': ['@tanstack/react-query'],
          'aria-vendor': ['react-aria-components', '@internationalized/date'],
        },
      },
    },
  },
  server: { port: 5173, strictPort: true },
});
```

```ts
// frontend/vitest.config.ts
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
      css: false,
      restoreMocks: true,
      // Anything slower than this is a hung fetch, not a slow test.
      testTimeout: 10_000,
      coverage: { provider: 'v8', reporter: ['text', 'html'] },
    },
  }),
);
```

```ts
// frontend/vitest.setup.ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll, vi } from 'vitest';

// Every test runs with a base URL, so config.ts never throws inside a test
// that is not specifically about config.ts.
beforeAll(() => {
  vi.stubEnv('VITE_APP_BASE_URL', 'http://localhost:8000');
});

afterEach(() => {
  cleanup();
});

// jsdom implements neither of these, and both are used by React Aria and by
// the virtualiser. Without them, every picker and table test throws.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
```

```jsonc
// frontend/tsconfig.json  — replace wholesale
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"],
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "vitest.setup.ts", "vite.config.ts", "vitest.config.ts"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

`noUncheckedIndexedAccess: true` is deliberate: the report table indexes arrays by virtual-row index and the week editor indexes `days[weekday]`. Both are exactly where an off-by-one produces `undefined` at runtime, and this flag turns that into a compile error.

- [ ] **Step 5: Write the env files and verify they are ignored correctly**

```bash
# frontend/.env.example  — COMMITTED. This is the documented template.
# ════════════════════════════════════════════════════════════════════════════
# Richpanel FRONTEND — environment template
# ════════════════════════════════════════════════════════════════════════════
#
#   cp .env.example .env
#
# This file belongs to the frontend service ONLY. The backend has its own
# backend/.env / backend/.env.example pair. There is deliberately no shared
# root .env — docker-compose.yml points each service's `env_file:` at its own
# directory.
#
# ⚠ THE `VITE_` PREFIX IS MANDATORY.
#   Vite exposes ONLY variables beginning with `VITE_` to client code. A
#   variable named APP_BASE_URL would be silently `undefined` in the browser
#   bundle — no warning, no build error, just a request to
#   `undefined/api/v1/agents` at runtime. src/config.ts throws at module load
#   if this is missing, so the failure is immediate and legible.
#
# ⚠ THIS VALUE IS INLINED AT BUILD TIME, NOT READ AT RUNTIME.
#   `npm run build` textually substitutes it into the bundle. The containerised
#   image therefore has the API URL baked in; changing it requires a rebuild.
#   See the plan's §0.9 / F8 for the runtime-config alternative.
# ════════════════════════════════════════════════════════════════════════════

# Origin of the backend API. NO trailing slash, NO /api/v1 suffix — every
# router in the backend carries its own `/api/v1/...` prefix, so the client
# appends the full path itself.
#
# Local (backend published on the host):   http://localhost:8000
# Staging/production: the real external API origin, e.g. https://api.richpanel.example
#
# NOTE: the browser calls this CROSS-ORIGIN. The frontend container serves
# static assets only and does NOT reverse-proxy /api. The backend must allow
# this frontend's origin in CORSMiddleware.
VITE_APP_BASE_URL=http://localhost:8000
```

```bash
# frontend/.env  — GITIGNORED. Per-developer, never committed.
VITE_APP_BASE_URL=http://localhost:8000
```

Verify the ignore rules actually cover the per-service file — the root `.gitignore` already has `.env`, `.env.*`, `!.env.example`, and those patterns are unanchored so they match at any depth:
```bash
cd /Users/tanishq/Desktop/Richpanel && \
git check-ignore -v frontend/.env && \
git check-ignore -v frontend/.env.example; echo "exit=$?"
```
Expected: the first command prints a match against `.gitignore:6:.env`. The second prints **nothing** and `exit=1`, meaning `.env.example` is **not** ignored and will be committed. If `frontend/.env` is *not* matched, add `frontend/.env` to the root `.gitignore` before continuing — **do not proceed with an untracked-but-committable env file.**

- [ ] **Step 6: Write `src/config.ts`, the global stylesheet, and the app entry**

```ts
// frontend/src/config.ts
/**
 * The single source of truth for where the API lives.
 *
 * Vite inlines `import.meta.env.VITE_APP_BASE_URL` at BUILD time (see
 * frontend/.env.example). The `VITE_` prefix is what makes it visible to
 * client code at all — a variable named APP_BASE_URL would be `undefined`
 * here with no warning whatsoever.
 *
 * We throw at module load rather than defaulting, because a default would
 * turn a misconfigured deployment into a silent 404 storm at runtime. Failing
 * on the first import is the cheapest possible feedback.
 */
const raw = import.meta.env.VITE_APP_BASE_URL as string | undefined;

if (!raw || raw.trim() === '') {
  throw new Error(
    'VITE_APP_BASE_URL is not set. Copy frontend/.env.example to frontend/.env. ' +
      'Note the VITE_ prefix is mandatory — Vite does not expose unprefixed ' +
      'variables to client code.',
  );
}

/** API origin, no trailing slash. Paths already carry their own `/api/v1`. */
export const API_BASE_URL: string = raw.trim().replace(/\/+$/, '');

/** Every request aborts after this. Distinguished from a network failure. */
export const REQUEST_TIMEOUT_MS = 20_000;
```

```css
/* frontend/src/styles/globals.css */
@import "tailwindcss";

/* Design tokens land here in Task 11. This file exists now so the Tailwind
   pipeline is proven end-to-end by the Task 1 smoke test. */

html,
body,
#root {
  height: 100%;
}

body {
  margin: 0;
  -webkit-font-smoothing: antialiased;
}
```

```tsx
// frontend/src/App.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Replaced in Task 8 by the shared, explicitly-configured client. Inline here
// only so Task 1 can prove the provider mounts.
const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <main className="p-6">
        <h1 className="text-xl font-semibold">Richpanel Ops</h1>
      </main>
    </QueryClientProvider>
  );
}
```

```tsx
// frontend/src/main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root is missing from index.html');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

Delete the Vite template leftovers so they do not sit in the tree pretending to be ours:
```bash
cd /Users/tanishq/Desktop/Richpanel/frontend && \
rm -f src/App.css src/index.css src/assets/react.svg public/vite.svg
```

- [ ] **Step 7: Write the smoke test that proves the whole stack is wired**

```tsx
// frontend/src/smoke.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('app smoke test', () => {
  it('renders inside a QueryClientProvider without throwing', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Richpanel Ops' })).toBeInTheDocument();
  });
});
```

This single test proves five things at once: React 19 renders, TypeScript compiles under `strict`, jsdom is the environment, `@testing-library/jest-dom` matchers are registered (`toBeInTheDocument`), and `QueryClientProvider` mounts.

- [ ] **Step 8: Run all of this task's tests to verify they pass**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npm test`
Expected: PASS — **5 passed** (4 in `config.test.ts`, 1 in `smoke.test.tsx`).

- [ ] **Step 9: Verify the build and the dev server for real**

Run:
```bash
cd /Users/tanishq/Desktop/Richpanel/frontend && npm run build && ls -la dist/
```
Expected: `tsc --noEmit` reports no errors, Vite writes `dist/index.html` plus `dist/assets/*.js` and `dist/assets/*.css`. **A CSS file must be present** — its absence means the Tailwind plugin is not wired.

Then verify the dev server actually serves:
```bash
cd /Users/tanishq/Desktop/Richpanel/frontend && (npm run dev &) && sleep 4 && \
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:5173/ && \
pkill -f "vite" || true
```
Expected: `200`.

- [ ] **Step 10: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/ && git commit -m "feat(frontend): project setup with Vite, React, TypeScript, Tailwind v4, TanStack Query and the Vitest test stack"
```

---

### Task 2: Architecture constraints — dependency-cruiser rules R1–R7 as a build gate

**Files:**
- Create: `frontend/.dependency-cruiser.cjs`
- Create: `frontend/src/{api,hooks/{queries,mutations,ui},context,components/{layout,ui,modals,datetime,feedback},helpers,pages/{schedules,reports},routes,styles}/.gitkeep`
- Test: `frontend/src/architecture.test.ts`

**Interfaces:**
- Produces: `npm run lint:arch`, exiting non-zero on any violation of R1–R7 (§0.6); the full folder skeleton every later task writes into.
- Consumes: nothing. This task depends only on Task 1.

The point of this task is that the layering in §0.6 is **checkable**, not aspirational. A reviewer should never have to notice that a component imported `apiService` — the build should have already refused.

- [ ] **Step 1: Write the failing architecture test**

```ts
// frontend/src/architecture.test.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

const FRONTEND_ROOT = new URL('..', import.meta.url).pathname;
const VIOLATION_DIR = `${FRONTEND_ROOT}src/components/__arch_fixture__`;

function runDepCruise(): { ok: boolean; output: string } {
  try {
    const output = execFileSync(
      'npx',
      ['depcruise', 'src', '--config', '.dependency-cruiser.cjs'],
      { cwd: FRONTEND_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { ok: true, output };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

afterEach(() => {
  rmSync(VIOLATION_DIR, { recursive: true, force: true });
});

describe('architecture constraints', () => {
  it('passes on the real source tree', () => {
    const { ok, output } = runDepCruise();
    expect(output).not.toMatch(/error/i);
    expect(ok).toBe(true);
  });

  it('R2: fails the build when a component imports apiService', () => {
    mkdirSync(VIOLATION_DIR, { recursive: true });
    writeFileSync(
      `${VIOLATION_DIR}/Offender.tsx`,
      "import { apiService } from '../../api/apiService';\nexport const x = apiService;\n",
    );
    const { ok, output } = runDepCruise();
    expect(ok).toBe(false);
    expect(output).toMatch(/no-api-outside-hooks/);
  });

  it('R3: fails the build when a helper imports react', () => {
    const helperViolation = `${FRONTEND_ROOT}src/helpers/__arch_fixture__.ts`;
    writeFileSync(helperViolation, "import { useState } from 'react';\nexport const x = useState;\n");
    try {
      const { ok, output } = runDepCruise();
      expect(ok).toBe(false);
      expect(output).toMatch(/helpers-are-pure/);
    } finally {
      rmSync(helperViolation, { force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/architecture.test.ts`
Expected: FAIL — all three cases fail with dependency-cruiser reporting a missing configuration file (`.dependency-cruiser.cjs` does not exist yet).

- [ ] **Step 3: Create the folder skeleton**

```bash
cd /Users/tanishq/Desktop/Richpanel/frontend/src && \
mkdir -p api hooks/queries hooks/mutations hooks/ui context \
         components/layout components/ui components/modals components/datetime components/feedback \
         helpers pages/schedules/week-ribbon pages/reports routes styles && \
for d in api hooks/queries hooks/mutations hooks/ui context \
         components/layout components/ui components/modals components/datetime components/feedback \
         helpers pages/schedules pages/schedules/week-ribbon pages/reports routes; do touch "$d/.gitkeep"; done && \
find . -name .gitkeep | sort
```
Expected: 14 `.gitkeep` paths listed. Each is deleted by the task that puts a real file in that folder.

- [ ] **Step 4: Write the dependency-cruiser configuration**

```js
// frontend/.dependency-cruiser.cjs
/**
 * The layering of the plan's §0.6, expressed as a build gate.
 *
 *   pages -> hooks -> api/apiService -> api/http -> fetch
 *   components/ and helpers/ are leaves: they import nothing above themselves.
 *
 * Every rule below has a `comment` that names the rule id from the plan, so a
 * failure message tells the implementer which constraint they crossed and why
 * it exists — not just that a graph edge was disallowed.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-api-outside-hooks',
      comment:
        'R1/R2: only src/hooks/** may import src/api/**. Components and pages ' +
        'talk to the server through custom hooks so that caching, retries and ' +
        'error normalisation live in exactly one layer.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/(hooks/|api/|main\\.tsx$|App\\.tsx$)' },
      to: { path: '^src/api/' },
    },
    {
      name: 'components-are-leaves',
      comment:
        'R2: src/components/** may not import pages, api, or data hooks. Only ' +
        'src/hooks/ui/** (non-data hooks) is allowed. A shared component that ' +
        'fetches is not shared — it is a feature in the wrong folder.',
      severity: 'error',
      from: { path: '^src/components/' },
      to: { path: '^src/(pages/|api/|hooks/(queries|mutations)/)' },
    },
    {
      name: 'helpers-are-pure',
      comment:
        'R3: src/helpers/** is pure TypeScript. No React, no api, no hooks, no ' +
        'components. This is what makes every helper trivially unit-testable ' +
        'and is why Tasks 3-5 need no test renderer at all.',
      severity: 'error',
      from: { path: '^src/helpers/' },
      to: { pathNot: '^(src/helpers/|@internationalized/date)' },
    },
    {
      name: 'screens-do-not-cross-import',
      comment:
        'R4: pages/schedules and pages/reports may not import each other. ' +
        'Anything both need is promoted to components/ or helpers/.',
      severity: 'error',
      from: { path: '^src/pages/schedules/' },
      to: { path: '^src/pages/reports/' },
    },
    {
      name: 'screens-do-not-cross-import-reverse',
      comment: 'R4, the other direction.',
      severity: 'error',
      from: { path: '^src/pages/reports/' },
      to: { path: '^src/pages/schedules/' },
    },
    {
      name: 'context-holds-no-server-state',
      comment:
        'R6: src/context/** may not import api or data hooks. The TanStack ' +
        'Query cache is already global; wrapping it in a Context adds a second ' +
        'cache, a second invalidation path, and a re-render fan-out the cache ' +
        'exists to avoid. This rule is what structurally prevents someone ' +
        'adding SchedulesContext.',
      severity: 'error',
      from: { path: '^src/context/' },
      to: { path: '^src/(api/|hooks/(queries|mutations)/)' },
    },
    {
      name: 'pages-compose-hooks-not-queries',
      comment:
        'R7: a page may not call useQuery/useMutation directly. It composes ' +
        'the custom hooks in src/hooks/**, so a query key or retry policy is ' +
        'never redefined at a call site.',
      severity: 'error',
      from: { path: '^src/pages/' },
      to: { path: 'node_modules/@tanstack/react-query' },
    },
    {
      name: 'no-circular',
      comment: 'A cycle means the layering above is already broken somewhere.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      comment: 'Dead modules rot. Delete them or wire them up.',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$',
          '(^|/)(vite|vitest|playwright)\\.config\\.ts$',
          '^src/main\\.tsx$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Test files are excluded on purpose: a test SHOULD be able to import
    // apiService to build an MSW fixture. Note this list must NOT mention the
    // architecture test's __arch_fixture__ directories — `exclude` removes
    // modules from the graph entirely, so excluding them would make the
    // Task 2 violation cases silently pass.
    exclude: { path: '(\\.test\\.tsx?$|/__tests__/|/test/)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require'] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
```

- [ ] **Step 5: Run the architecture tests to verify they pass**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/architecture.test.ts`
Expected: PASS — **3 passed**. The first case proves the real tree is clean; the second and third prove the gate actually bites.

- [ ] **Step 6: Verify the npm script and the full suite**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npm run lint:arch && npm test`
Expected: `lint:arch` prints `no dependency violations found` (orphan warnings on `.gitkeep`-only folders are acceptable and disappear as tasks fill them). `npm test` reports **8 passed** (5 from Task 1, 3 here).

- [ ] **Step 7: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/ && git commit -m "feat(frontend): enforce layer boundaries with dependency-cruiser and scaffold the source tree"
```

---

### Task 3: `helpers/time.ts` — the float ↔ HH:MM boundary

**Files:**
- Create: `frontend/src/helpers/time.ts`
- Test: `frontend/src/helpers/time.test.ts`

**Interfaces:**
- Produces: `minutesFromFloatHours`, `floatHoursFromMinutes`, `formatFloatHours`, `parseHHMM`, `floatHoursFromHHMM`, `isExpressibleEndHours`, `MINUTES_PER_DAY`.
- Consumed by: `helpers/shifts.ts` (Task 4), `components/datetime/TimePicker.tsx` (Task 14), the week ribbon (Task 16).
- Imports **nothing**. Pure arithmetic. This is the single place in the app where the wire's `float` meets the UI's `HH:MM`.

**Why this is its own task and its own file.** The backend stores time-of-day as a `timedelta` and serialises it as `total_seconds() / 3600`. That round-trips to the minute, but the JSON float is **not exact**: `09:10` travels as `9.166666666666666`. Any code that does `Math.floor(h)` and `(h % 1) * 60` will produce `9` and `9.999999` → `09:09`. **`Math.round` is mandatory in both directions**, and the property test below over all 1440 minutes of the day is the guard that keeps it that way.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/helpers/time.test.ts
import { describe, expect, it } from 'vitest';
import {
  MINUTES_PER_DAY,
  floatHoursFromHHMM,
  floatHoursFromMinutes,
  formatFloatHours,
  isExpressibleEndHours,
  minutesFromFloatHours,
  parseHHMM,
} from './time';

describe('minutesFromFloatHours', () => {
  it('converts the spec example exactly', () => {
    expect(minutesFromFloatHours(22.5)).toBe(1350); // 22:30
  });

  it('rounds the inexact float the backend actually sends for 09:10', () => {
    // 9.166666666666666 is what JSON carries. Math.floor-based arithmetic
    // yields 09:09 here; this is the exact bug the rounding prevents.
    expect(minutesFromFloatHours(9.166666666666666)).toBe(550);
  });

  it('handles both ends of the day', () => {
    expect(minutesFromFloatHours(0)).toBe(0);
    expect(minutesFromFloatHours(23.983333333333334)).toBe(1439); // 23:59
  });
});

describe('float <-> minutes round trip', () => {
  it('is the identity for all 1440 minutes of the day', () => {
    for (let m = 0; m < MINUTES_PER_DAY; m += 1) {
      expect(minutesFromFloatHours(floatHoursFromMinutes(m))).toBe(m);
    }
  });

  it('survives a JSON serialise/parse cycle for all 1440 minutes', () => {
    for (let m = 0; m < MINUTES_PER_DAY; m += 1) {
      const overTheWire = JSON.parse(JSON.stringify(floatHoursFromMinutes(m))) as number;
      expect(minutesFromFloatHours(overTheWire)).toBe(m);
    }
  });
});

describe('formatFloatHours', () => {
  it('formats with a leading zero and 24-hour clock', () => {
    expect(formatFloatHours(22.5)).toBe('22:30');
    expect(formatFloatHours(9.166666666666666)).toBe('09:10');
    expect(formatFloatHours(0)).toBe('00:00');
    expect(formatFloatHours(23.983333333333334)).toBe('23:59');
  });
});

describe('parseHHMM', () => {
  it('parses valid 24-hour times', () => {
    expect(parseHHMM('22:30')).toEqual({ hours: 22, minutes: 30 });
    expect(parseHHMM('09:07')).toEqual({ hours: 9, minutes: 7 });
    expect(parseHHMM('0:05')).toEqual({ hours: 0, minutes: 5 });
  });

  it('rejects anything that is not a real time of day', () => {
    expect(parseHHMM('24:00')).toBeNull();
    expect(parseHHMM('22:60')).toBeNull();
    expect(parseHHMM('22')).toBeNull();
    expect(parseHHMM('')).toBeNull();
    expect(parseHHMM('ab:cd')).toBeNull();
  });
});

describe('floatHoursFromHHMM', () => {
  it('produces a value the backend accepts', () => {
    expect(floatHoursFromHHMM('22:30')).toBe(22.5);
    expect(floatHoursFromHHMM('nonsense')).toBeNull();
  });
});

describe('isExpressibleEndHours', () => {
  // Guards the two backend 500s documented in the plan's section 0.4.
  it('rejects 00:00 as an end value, because the backend 500s on it', () => {
    expect(isExpressibleEndHours(0)).toBe(false);
  });

  it('rejects 24 and above, because Pydantic requires end_hours < 24', () => {
    expect(isExpressibleEndHours(24)).toBe(false);
    expect(isExpressibleEndHours(25)).toBe(false);
  });

  it('accepts every other value in the day, including 23:59', () => {
    expect(isExpressibleEndHours(23.983333333333334)).toBe(true);
    expect(isExpressibleEndHours(0.25)).toBe(true);
    expect(isExpressibleEndHours(18)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/helpers/time.test.ts`
Expected: FAIL — `Failed to resolve import "./time" from "src/helpers/time.test.ts"`.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/helpers/time.ts
/**
 * The float <-> HH:MM boundary.
 *
 * The backend serialises time-of-day as `timedelta.total_seconds() / 3600`,
 * so 22:30 arrives as 22.5 and 09:10 arrives as 9.166666666666666. The value
 * round-trips to the minute, but ONLY if both directions round. Truncating
 * (Math.floor(h), (h % 1) * 60) turns 09:10 into 09:09.
 *
 * Pure module. No React, no imports.
 */

export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/** Wire float -> whole minutes since midnight. ALWAYS rounds. */
export function minutesFromFloatHours(hours: number): number {
  return Math.round(hours * MINUTES_PER_HOUR);
}

/** Whole minutes since midnight -> wire float. */
export function floatHoursFromMinutes(minutes: number): number {
  return minutes / MINUTES_PER_HOUR;
}

/** Wire float -> "HH:MM", 24-hour, zero-padded. 22.5 -> "22:30". */
export function formatFloatHours(hours: number): string {
  const total = minutesFromFloatHours(hours);
  const h = Math.floor(total / MINUTES_PER_HOUR);
  const m = total % MINUTES_PER_HOUR;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const HHMM = /^(\d{1,2}):(\d{2})$/;

/** "22:30" -> { hours: 22, minutes: 30 }. Null for anything that is not a
 *  real time of day — including "24:00", which the backend rejects. */
export function parseHHMM(value: string): { hours: number; minutes: number } | null {
  const match = HHMM.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23) return null;
  if (minutes < 0 || minutes > 59) return null;

  return { hours, minutes };
}

/** "22:30" -> 22.5, ready for the wire. Null if unparseable. */
export function floatHoursFromHHMM(value: string): number | null {
  const parsed = parseHHMM(value);
  if (!parsed) return null;
  return floatHoursFromMinutes(parsed.hours * MINUTES_PER_HOUR + parsed.minutes);
}

/**
 * Can this value legally be a shift's END?
 *
 * Two backend failures are encoded here (plan section 0.4):
 *   - end_hours === 0 with a non-zero start produces an overnight TAIL row of
 *     00:00 -> 00:00, which violates `ZERO < end_time` in WeekdayShift and
 *     escapes as a 500. So 00:00 is never offered as an end value.
 *   - end_hours >= 24 fails Pydantic's `end_hours < 24` with a 422.
 *
 * Consequence, which the UI must state rather than hide: a shift ending
 * exactly at midnight is not expressible. The closest full day is 00:00-23:59.
 */
export function isExpressibleEndHours(hours: number): boolean {
  if (!Number.isFinite(hours)) return false;
  const minutes = minutesFromFloatHours(hours);
  return minutes > 0 && minutes < MINUTES_PER_DAY;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/helpers/time.test.ts`
Expected: PASS — **13 passed**.

- [ ] **Step 5: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/src/helpers/ && git commit -m "feat(frontend): add time helpers for the float to HH:MM boundary with a 1440-minute property test"
```

---
### Task 4: `helpers/weekday.ts` + `helpers/shifts.ts` — overnight, normalisation, overlap

**Files:**
- Create: `frontend/src/helpers/weekday.ts`, `frontend/src/helpers/shifts.ts`
- Test: `frontend/src/helpers/weekday.test.ts`, `frontend/src/helpers/shifts.test.ts`

**Interfaces:**
- Produces: `WEEKDAYS`, `nextWeekday`, `weekdayLabel`, `weekdayShortLabel`; and `Shift`, `NormalizedShift`, `Overlap`, `isOvernight`, `shiftDurationMinutes`, `normalizeShift`, `normalizeWeek`, `findSelfOverlaps`, `findOverlaps`, `weekTotalMinutes`.
- Consumes: `helpers/time.ts` (Task 3).
- Consumed by: the Week Ribbon (Task 16), the conflict explainer (Task 17), schedule list mini-ribbons.

**Why the client re-implements the backend's overlap rule.** `helpers/shifts.ts` is a deliberate second implementation of `backend/app/domain/{shift_normalization,overlap}.py`. This is duplication *with a reason*: it is ~30 lines of interval arithmetic; it lets the UI reject a self-overlap before a round trip (which matters, because a self-overlap and an assignment overlap are indistinguishable in the 409 body — §0.4); and it is the only way to name the colliding day and hours while B3 is open. **The server remains the authority.** The client check never *permits* a write the server would reject — it only pre-empts and explains. When B3 ships, `findOverlaps` can be deleted and `findSelfOverlaps` stays for instant inline feedback.

**Everything here works in whole minutes, not floats.** Comparing `9.166666666666666 < 9.166666666666667` is a coin flip; comparing `550 < 550` is not. Floats cross this boundary once, in `normalizeShift`.

- [ ] **Step 1: Write the failing weekday test**

```ts
// frontend/src/helpers/weekday.test.ts
import { describe, expect, it } from 'vitest';
import { WEEKDAYS, nextWeekday, weekdayLabel, weekdayShortLabel } from './weekday';

describe('WEEKDAYS', () => {
  it('is Monday-first, matching the backend where 0 = Monday', () => {
    expect(WEEKDAYS).toHaveLength(7);
    expect(WEEKDAYS[0]).toEqual({ index: 0, key: 'mon', short: 'MON', long: 'Monday' });
    expect(WEEKDAYS[6]).toEqual({ index: 6, key: 'sun', short: 'SUN', long: 'Sunday' });
  });
});

describe('nextWeekday', () => {
  it('advances within the week', () => {
    expect(nextWeekday(0)).toBe(1);
    expect(nextWeekday(5)).toBe(6);
  });

  it('wraps Sunday onto Monday, matching (weekday + 1) % 7', () => {
    expect(nextWeekday(6)).toBe(0);
  });
});

describe('labels', () => {
  it('resolves both forms', () => {
    expect(weekdayLabel(1)).toBe('Tuesday');
    expect(weekdayShortLabel(1)).toBe('TUE');
  });

  it('throws on an out-of-range index rather than rendering undefined', () => {
    expect(() => weekdayLabel(7)).toThrow(/weekday/i);
    expect(() => weekdayLabel(-1)).toThrow(/weekday/i);
  });
});
```

- [ ] **Step 2: Write the failing shifts test**

```ts
// frontend/src/helpers/shifts.test.ts
import { describe, expect, it } from 'vitest';
import {
  findOverlaps,
  findSelfOverlaps,
  isOvernight,
  normalizeShift,
  normalizeWeek,
  shiftDurationMinutes,
  weekTotalMinutes,
} from './shifts';
import type { Shift } from './shifts';

const shift = (weekday: number, start_hours: number, end_hours: number): Shift => ({
  weekday,
  start_hours,
  end_hours,
});

describe('isOvernight', () => {
  // Backend rule: ShiftInput.crosses_midnight is `end_time <= start_time`.
  it('is true when the end is strictly before the start', () => {
    expect(isOvernight(22, 6)).toBe(true);
  });

  it('is true when end equals start, matching the backend inequality', () => {
    expect(isOvernight(9, 9)).toBe(true);
  });

  it('is false for a normal same-day shift', () => {
    expect(isOvernight(9, 18)).toBe(false);
  });

  it('is true when the end is midnight', () => {
    expect(isOvernight(22, 0)).toBe(true);
  });
});

describe('shiftDurationMinutes', () => {
  it('measures a same-day shift', () => {
    expect(shiftDurationMinutes(9, 18)).toBe(540);
  });

  it('measures across midnight without going negative', () => {
    expect(shiftDurationMinutes(22, 6)).toBe(480); // 8h, not -16h
  });

  it('measures the inexact-float case correctly', () => {
    expect(shiftDurationMinutes(9.166666666666666, 18)).toBe(530); // 09:10 -> 18:00
  });
});

describe('normalizeShift', () => {
  it('leaves a same-day shift as one row', () => {
    expect(normalizeShift(shift(0, 9, 18))).toEqual([
      { weekday: 0, startMinutes: 540, endMinutes: 1080, isOvernightTail: false },
    ]);
  });

  it('splits an overnight shift into a primary ending at 24:00 and a tail on the next day', () => {
    expect(normalizeShift(shift(0, 22, 6))).toEqual([
      { weekday: 0, startMinutes: 1320, endMinutes: 1440, isOvernightTail: false },
      { weekday: 1, startMinutes: 0, endMinutes: 360, isOvernightTail: true },
    ]);
  });

  it('wraps a Sunday overnight tail onto Monday', () => {
    expect(normalizeShift(shift(6, 23, 5))).toEqual([
      { weekday: 6, startMinutes: 1380, endMinutes: 1440, isOvernightTail: false },
      { weekday: 0, startMinutes: 0, endMinutes: 300, isOvernightTail: true },
    ]);
  });
});

describe('findSelfOverlaps', () => {
  it('finds nothing for a clean weekday-only week', () => {
    const week = [shift(0, 9, 18), shift(1, 9, 18), shift(2, 9, 18)];
    expect(findSelfOverlaps(week)).toEqual([]);
  });

  it('catches an overnight tail colliding with the next day own shift', () => {
    // Monday 22:00-06:00 leaves a Tuesday 00:00-06:00 tail, which collides
    // with a Tuesday 05:00-13:00 shift. The backend returns 409 "conflict"
    // for this; we catch it before the request leaves.
    const conflicts = findSelfOverlaps([shift(0, 22, 6), shift(1, 5, 13)]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.weekday).toBe(1);
    expect(conflicts[0]?.a.isOvernightTail).toBe(true);
  });

  it('catches the Sunday tail colliding with Monday', () => {
    const conflicts = findSelfOverlaps([shift(6, 23, 5), shift(0, 4, 12)]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.weekday).toBe(0);
  });

  it('does not report a tail that ends exactly when the next shift starts', () => {
    // Half-open intervals: 00:00-06:00 and 06:00-14:00 do NOT overlap.
    expect(findSelfOverlaps([shift(0, 22, 6), shift(1, 6, 14)])).toEqual([]);
  });
});

describe('findOverlaps', () => {
  it('pairs an existing schedule against a proposed one', () => {
    const existing = normalizeWeek([shift(1, 0, 6)]);
    const proposed = normalizeWeek([shift(1, 5, 13)]);
    const conflicts = findOverlaps(existing, proposed);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ weekday: 1, overlapMinutes: 60 });
  });

  it('reports nothing when the two never share a weekday', () => {
    expect(findOverlaps(normalizeWeek([shift(0, 9, 18)]), normalizeWeek([shift(2, 9, 18)]))).toEqual([]);
  });
});

describe('weekTotalMinutes', () => {
  it('sums a five-day week', () => {
    const week = [0, 1, 2, 3, 4].map((d) => shift(d, 9, 18));
    expect(weekTotalMinutes(week)).toBe(2700); // 45h
  });

  it('counts an overnight shift once, not twice', () => {
    expect(weekTotalMinutes([shift(0, 22, 6)])).toBe(480);
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/helpers/weekday.test.ts src/helpers/shifts.test.ts`
Expected: FAIL — `Failed to resolve import "./weekday"` and `Failed to resolve import "./shifts"`.

- [ ] **Step 4: Write `helpers/weekday.ts`**

```ts
// frontend/src/helpers/weekday.ts
/**
 * Weekday convention, pinned to the backend: 0 = Monday .. 6 = Sunday
 * (Python's datetime.weekday()). Every index in this app is that index.
 * There is no other convention anywhere; do not introduce one.
 */

export interface WeekdayDescriptor {
  readonly index: number;
  readonly key: string;
  readonly short: string;
  readonly long: string;
}

export const WEEKDAYS: readonly WeekdayDescriptor[] = [
  { index: 0, key: 'mon', short: 'MON', long: 'Monday' },
  { index: 1, key: 'tue', short: 'TUE', long: 'Tuesday' },
  { index: 2, key: 'wed', short: 'WED', long: 'Wednesday' },
  { index: 3, key: 'thu', short: 'THU', long: 'Thursday' },
  { index: 4, key: 'fri', short: 'FRI', long: 'Friday' },
  { index: 5, key: 'sat', short: 'SAT', long: 'Saturday' },
  { index: 6, key: 'sun', short: 'SUN', long: 'Sunday' },
] as const;

/** The backend's `(weekday + 1) % 7`. This is why a Sunday overnight shift
 *  lands its tail on Monday — the week wraps. */
export function nextWeekday(weekday: number): number {
  return (weekday + 1) % 7;
}

function descriptor(weekday: number): WeekdayDescriptor {
  const found = WEEKDAYS[weekday];
  if (!found) throw new RangeError(`weekday must be 0-6, got ${weekday}`);
  return found;
}

export function weekdayLabel(weekday: number): string {
  return descriptor(weekday).long;
}

export function weekdayShortLabel(weekday: number): string {
  return descriptor(weekday).short;
}
```

- [ ] **Step 5: Write `helpers/shifts.ts`**

```ts
// frontend/src/helpers/shifts.ts
/**
 * Mirrors backend/app/domain/shift_normalization.py and overlap.py.
 *
 * This duplication is deliberate and scoped (see the plan's Task 4 preamble):
 * the 409 body carries no structure, so without a local copy of the rule the
 * UI cannot tell the user WHICH day collided. The server stays authoritative;
 * this never permits a write the server would reject.
 *
 * All comparisons are in whole minutes. Floats cross the boundary exactly
 * once, in normalizeShift.
 */
import { MINUTES_PER_DAY, minutesFromFloatHours } from './time';
import { nextWeekday } from './weekday';

/** The wire shape: one logical, possibly-midnight-crossing shift. */
export interface Shift {
  readonly weekday: number;
  readonly start_hours: number;
  readonly end_hours: number;
}

/** A same-day interval, as the backend stores it. */
export interface NormalizedShift {
  readonly weekday: number;
  readonly startMinutes: number;
  readonly endMinutes: number;
  readonly isOvernightTail: boolean;
}

export interface Overlap {
  readonly weekday: number;
  readonly a: NormalizedShift;
  readonly b: NormalizedShift;
  readonly overlapMinutes: number;
}

/** Backend rule: `end_time <= start_time`. Note the `<=` — a zero-length
 *  shift counts as overnight here, and is rejected separately by the form. */
export function isOvernight(startHours: number, endHours: number): boolean {
  return minutesFromFloatHours(endHours) <= minutesFromFloatHours(startHours);
}

/** Duration in minutes, wrapping correctly across midnight. */
export function shiftDurationMinutes(startHours: number, endHours: number): number {
  const start = minutesFromFloatHours(startHours);
  const end = minutesFromFloatHours(endHours);
  return end > start ? end - start : MINUTES_PER_DAY - start + end;
}

/**
 * Split one logical shift into the 1 or 2 same-day rows the backend persists.
 * Overnight becomes: primary `start -> 24:00` on the owning weekday, plus a
 * tail `00:00 -> end` on (weekday + 1) % 7 flagged as a tail.
 */
export function normalizeShift(shift: Shift): NormalizedShift[] {
  const start = minutesFromFloatHours(shift.start_hours);
  const end = minutesFromFloatHours(shift.end_hours);

  if (end > start) {
    return [{ weekday: shift.weekday, startMinutes: start, endMinutes: end, isOvernightTail: false }];
  }

  return [
    { weekday: shift.weekday, startMinutes: start, endMinutes: MINUTES_PER_DAY, isOvernightTail: false },
    { weekday: nextWeekday(shift.weekday), startMinutes: 0, endMinutes: end, isOvernightTail: true },
  ];
}

export function normalizeWeek(shifts: readonly Shift[]): NormalizedShift[] {
  return shifts.flatMap(normalizeShift);
}

/** Half-open intervals on the same weekday: [aStart, aEnd) vs [bStart, bEnd).
 *  09:00-12:00 and 12:00-18:00 do NOT overlap. */
function overlapMinutes(a: NormalizedShift, b: NormalizedShift): number {
  if (a.weekday !== b.weekday) return 0;
  const start = Math.max(a.startMinutes, b.startMinutes);
  const end = Math.min(a.endMinutes, b.endMinutes);
  return end > start ? end - start : 0;
}

/**
 * Every colliding pair WITHIN one schedule's own week, after normalisation.
 * The realistic case is an overnight tail landing on a day that already has
 * its own shift. Running this on blur is what keeps the self-overlap 409 off
 * the wire entirely.
 */
export function findSelfOverlaps(shifts: readonly Shift[]): Overlap[] {
  const normalized = normalizeWeek(shifts);
  const conflicts: Overlap[] = [];

  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      const a = normalized[i]!;
      const b = normalized[j]!;
      const minutes = overlapMinutes(a, b);
      if (minutes > 0) conflicts.push({ weekday: a.weekday, a, b, overlapMinutes: minutes });
    }
  }
  return conflicts;
}

/**
 * Every colliding pair BETWEEN an agent's existing schedules and a proposed
 * one. Used only to explain a server 409 after the fact (plan section 0.4).
 * Delete this function when backend change B3 lands.
 */
export function findOverlaps(
  existing: readonly NormalizedShift[],
  proposed: readonly NormalizedShift[],
): Overlap[] {
  const conflicts: Overlap[] = [];
  for (const a of existing) {
    for (const b of proposed) {
      const minutes = overlapMinutes(a, b);
      if (minutes > 0) conflicts.push({ weekday: a.weekday, a, b, overlapMinutes: minutes });
    }
  }
  return conflicts;
}

/** Total scheduled minutes in a week. An overnight shift counts once. */
export function weekTotalMinutes(shifts: readonly Shift[]): number {
  return shifts.reduce((total, s) => total + shiftDurationMinutes(s.start_hours, s.end_hours), 0);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/helpers/`
Expected: PASS — **31 passed** (13 from Task 3, 5 weekday, 13 shifts).

- [ ] **Step 7: Pin the client rule to the backend's own fixtures**

Open `backend/tests/domain/test_overlap.py` and `backend/tests/domain/test_shift_normalization.py`. For **every** case there, confirm an equivalent case exists in `shifts.test.ts`. Add any that are missing. These two implementations must stay pinned to each other — that is the whole justification for duplicating the rule.

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/helpers/shifts.test.ts`
Expected: PASS, with a case count greater than or equal to the backend's.

- [ ] **Step 8: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/src/helpers/ && git commit -m "feat(frontend): add weekday and shift helpers mirroring the backend overlap and normalisation rules"
```

---

### Task 5: `helpers/duration.ts`, `helpers/dates.ts`, `helpers/format.ts`

**Files:**
- Create: `frontend/src/helpers/duration.ts`, `frontend/src/helpers/dates.ts`, `frontend/src/helpers/format.ts`
- Test: `frontend/src/helpers/duration.test.ts`, `frontend/src/helpers/dates.test.ts`, `frontend/src/helpers/format.test.ts`

**Interfaces:**
- Produces: `businessSecondsToHHMMSS`, `businessSecondsToDecimalHours`, `formatDurationLong`, `formatMinutesLong`; `IST`, `toIstIsoString`, `parseIstIso`, `formatIstDate`, `formatIstDateTime`, `elapsedLabel`, `istNow`; `formatRelativeTime`, `pluralise`, `formatCount`.
- Consumes: `helpers/time.ts`; `@internationalized/date` (the only third-party import any helper is allowed).
- Consumed by: the report screen (Task 18), the schedule detail header (Task 17), `TicketWindowBar`, `ReportHistoryRail`.

**No `date-fns`, no Luxon, no moment.** `@internationalized/date` arrives with React Aria Components anyway, so it is free at the margin, and it is the same date model the pickers use. Adding a second date library would mean two models for zero gain. `Intl` does the formatting, so no locale data ships.

- [ ] **Step 1: Write the failing duration test**

```ts
// frontend/src/helpers/duration.test.ts
import { describe, expect, it } from 'vitest';
import {
  businessSecondsToDecimalHours,
  businessSecondsToHHMMSS,
  formatDurationLong,
  formatMinutesLong,
} from './duration';

describe('businessSecondsToHHMMSS', () => {
  it('formats zero as a real value, not a dash', () => {
    expect(businessSecondsToHHMMSS(0)).toBe('0:00:00');
  });

  it('formats under an hour', () => {
    expect(businessSecondsToHHMMSS(1_800)).toBe('0:30:00');
  });

  it('does NOT wrap past 24 hours - business hours accumulate', () => {
    expect(businessSecondsToHHMMSS(97_200)).toBe('27:00:00');
  });

  it('handles thousands of hours', () => {
    expect(businessSecondsToHHMMSS(3_600_000)).toBe('1000:00:00');
  });

  it('keeps seconds precision', () => {
    expect(businessSecondsToHHMMSS(3_661)).toBe('1:01:01');
  });
});

describe('businessSecondsToDecimalHours', () => {
  it('rounds to two places for spreadsheet paste', () => {
    expect(businessSecondsToDecimalHours(97_200)).toBe(27);
    expect(businessSecondsToDecimalHours(1_800)).toBe(0.5);
    expect(businessSecondsToDecimalHours(3_661)).toBe(1.02);
  });
});

describe('formatDurationLong', () => {
  it('reads as prose for screen readers and headers', () => {
    expect(formatDurationLong(97_200)).toBe('27h 00m');
    expect(formatDurationLong(0)).toBe('0h 00m');
    expect(formatDurationLong(1_800)).toBe('0h 30m');
  });
});

describe('formatMinutesLong', () => {
  it('formats the week ribbon row totals', () => {
    expect(formatMinutesLong(540)).toBe('9h 00m');
    expect(formatMinutesLong(2_700)).toBe('45h 00m');
  });
});
```

- [ ] **Step 2: Write the failing dates test**

```ts
// frontend/src/helpers/dates.test.ts
import { CalendarDate, Time } from '@internationalized/date';
import { describe, expect, it } from 'vitest';
import { IST, elapsedLabel, formatIstDate, formatIstDateTime, parseIstIso, toIstIsoString } from './dates';

describe('IST', () => {
  it('is the single pinned zone, matching the backend constant', () => {
    expect(IST).toBe('Asia/Kolkata');
  });
});

describe('toIstIsoString', () => {
  it('produces an offset-bearing ISO string the backend parses as IST', () => {
    const iso = toIstIsoString(new CalendarDate(2026, 8, 9), new Time(10, 0));
    expect(iso).toBe('2026-08-09T10:00:00+05:30');
  });

  it('emits no bracketed zone suffix - Pydantic rejects that', () => {
    const iso = toIstIsoString(new CalendarDate(2026, 8, 9), new Time(17, 30));
    expect(iso).not.toContain('[');
  });
});

describe('parseIstIso', () => {
  it('reads the +05:30 responses the backend returns', () => {
    const parsed = parseIstIso('2026-08-09T10:00:00+05:30');
    expect(parsed.year).toBe(2026);
    expect(parsed.hour).toBe(10);
  });

  it('converts a UTC response into IST wall-clock rather than displaying UTC', () => {
    const parsed = parseIstIso('2026-08-09T04:30:00Z');
    expect(parsed.hour).toBe(10);
    expect(parsed.minute).toBe(0);
  });
});

describe('formatters', () => {
  it('formats a date for the detail header', () => {
    expect(formatIstDate('2026-08-01T00:00:00+05:30')).toBe('01 Aug 2026');
  });

  it('formats a plain YYYY-MM-DD date field', () => {
    expect(formatIstDate('2026-08-01')).toBe('01 Aug 2026');
  });

  it('formats a datetime for the history rail', () => {
    expect(formatIstDateTime('2026-08-09T10:00:00+05:30')).toBe('09 Aug 2026, 10:00');
  });
});

describe('elapsedLabel', () => {
  it('describes the ticket window span', () => {
    expect(elapsedLabel('2026-08-09T10:00:00+05:30', '2026-08-12T17:30:00+05:30')).toBe('3d 7h 30m');
  });

  it('omits days when the window is short', () => {
    expect(elapsedLabel('2026-08-09T10:00:00+05:30', '2026-08-09T12:00:00+05:30')).toBe('2h 00m');
  });

  it('returns null for an inverted window so the caller can disable Compute', () => {
    expect(elapsedLabel('2026-08-12T10:00:00+05:30', '2026-08-09T10:00:00+05:30')).toBeNull();
  });
});
```

- [ ] **Step 3: Write the failing format test**

```ts
// frontend/src/helpers/format.test.ts
import { describe, expect, it } from 'vitest';
import { formatCount, formatRelativeTime, pluralise } from './format';

const NOW = new Date('2026-08-09T14:00:00+05:30');

describe('formatRelativeTime', () => {
  it('reads as just now under a minute', () => {
    expect(formatRelativeTime('2026-08-09T13:59:40+05:30', NOW)).toBe('just now');
  });

  it('reads in minutes and hours', () => {
    expect(formatRelativeTime('2026-08-09T13:58:00+05:30', NOW)).toBe('2 minutes ago');
    expect(formatRelativeTime('2026-08-09T11:00:00+05:30', NOW)).toBe('3 hours ago');
  });

  it('reads as yesterday and then in days', () => {
    expect(formatRelativeTime('2026-08-08T14:00:00+05:30', NOW)).toBe('yesterday');
    expect(formatRelativeTime('2026-08-06T14:00:00+05:30', NOW)).toBe('3 days ago');
  });
});

describe('pluralise', () => {
  it('agrees with the count', () => {
    expect(pluralise(1, 'agent')).toBe('agent');
    expect(pluralise(0, 'agent')).toBe('agents');
    expect(pluralise(5, 'agent')).toBe('agents');
  });

  it('accepts an irregular plural', () => {
    expect(pluralise(2, 'entry', 'entries')).toBe('entries');
  });
});

describe('formatCount', () => {
  it('joins the number and the agreeing noun', () => {
    expect(formatCount(1, 'agent')).toBe('1 agent');
    expect(formatCount(4, 'agent')).toBe('4 agents');
  });
});
```

- [ ] **Step 4: Run all three to verify they fail**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/helpers/duration.test.ts src/helpers/dates.test.ts src/helpers/format.test.ts`
Expected: FAIL — three `Failed to resolve import` errors for `./duration`, `./dates`, `./format`.

- [ ] **Step 5: Write the implementations**

```ts
// frontend/src/helpers/duration.ts
/**
 * `business_seconds` -> human formats.
 *
 * These values are ACCUMULATED working time, not a time of day: 27 hours is a
 * legitimate result for a three-day ticket window. Nothing here may wrap at
 * 24 — that would silently turn 27:00:00 into 03:00:00 and quietly corrupt a
 * report.
 */
import { MINUTES_PER_HOUR } from './time';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

/** 97200 -> "27:00:00". Hours are unbounded; minutes and seconds are padded. */
export function businessSecondsToHHMMSS(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / SECONDS_PER_HOUR);
  const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const secs = total % SECONDS_PER_MINUTE;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/** 97200 -> 27. Two decimal places, for pasting into a spreadsheet. */
export function businessSecondsToDecimalHours(seconds: number): number {
  return Math.round((seconds / SECONDS_PER_HOUR) * 100) / 100;
}

/** 97200 -> "27h 00m". Used in prose and in screen-reader labels. */
export function formatDurationLong(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / SECONDS_PER_HOUR);
  const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

/** 540 -> "9h 00m". The week ribbon works in minutes, not seconds. */
export function formatMinutesLong(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / MINUTES_PER_HOUR);
  return `${hours}h ${String(total % MINUTES_PER_HOUR).padStart(2, '0')}m`;
}
```

```ts
// frontend/src/helpers/dates.ts
/**
 * A thin IST layer over @internationalized/date.
 *
 * The backend pins Asia/Kolkata as a hard constant (app/domain/types.py) and
 * there is no timezone picker anywhere in this product. Every date and time
 * the user sees or enters is IST wall-clock. Isolating that here means the
 * rest of the app never reasons about zones at all.
 */
import {
  CalendarDate,
  Time,
  ZonedDateTime,
  parseAbsolute,
  parseDate,
  parseZonedDateTime,
  toCalendarDateTime,
  toZoned,
} from '@internationalized/date';

/** The one zone. Matches backend/app/domain/types.py's IST constant. */
export const IST = 'Asia/Kolkata';

/**
 * Build the string sent to POST /reports.
 *
 * Emits "2026-08-09T10:00:00+05:30" — offset form, NO "[Asia/Kolkata]"
 * suffix. @internationalized/date's own toString() appends that bracketed
 * zone, which is valid IXDTF but NOT valid ISO 8601, and Pydantic rejects it.
 */
export function toIstIsoString(date: CalendarDate, time: Time): string {
  const zoned = toZoned(toCalendarDateTime(date, time), IST);
  return zoned.toString().replace(/\[.*\]$/, '');
}

/**
 * Parse any datetime the backend returns into IST wall-clock. Accepts the
 * "+05:30" form it normally sends and a "Z" form, converting rather than
 * displaying UTC.
 */
export function parseIstIso(iso: string): ZonedDateTime {
  try {
    return parseAbsolute(iso, IST);
  } catch {
    return toZoned(parseZonedDateTime(iso), IST);
  }
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: IST,
});

/** Accepts both "2026-08-01" (a `date` field) and a full datetime. */
export function formatIstDate(value: string): string {
  const instant = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? toZoned(parseDate(value), IST).toDate()
    : parseIstIso(value).toDate();
  return DATE_FORMAT.format(instant).replace(/ /g, ' ');
}

export function formatIstDateTime(value: string): string {
  const zoned = parseIstIso(value);
  const time = `${String(zoned.hour).padStart(2, '0')}:${String(zoned.minute).padStart(2, '0')}`;
  return `${formatIstDate(value)}, ${time}`;
}

/** Current IST wall-clock, for the header's standing IST reminder. */
export function istNow(): ZonedDateTime {
  return toZoned(parseAbsolute(new Date().toISOString(), IST), IST);
}

/**
 * "3d 7h 30m" for the ticket window readout. Returns null when the window is
 * inverted or empty, which is the signal the caller uses to disable Compute
 * and pre-empt the backend's 400.
 */
export function elapsedLabel(startIso: string, endIso: string): string | null {
  const start = parseIstIso(startIso).toDate().getTime();
  const end = parseIstIso(endIso).toDate().getTime();
  const deltaMs = end - start;
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return null;

  const totalMinutes = Math.floor(deltaMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  const hm = `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return days > 0 ? `${days}d ${hm}` : hm;
}
```

```ts
// frontend/src/helpers/format.ts
/** Small presentational conversions. No React, no dates library beyond Date. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "2 minutes ago" / "yesterday" / "3 days ago". `now` is injectable so the
 *  test does not depend on the wall clock. */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const delta = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(delta)) return '';
  if (delta < MINUTE) return 'just now';

  if (delta < HOUR) {
    const minutes = Math.floor(delta / MINUTE);
    return `${minutes} ${pluralise(minutes, 'minute')} ago`;
  }
  if (delta < DAY) {
    const hours = Math.floor(delta / HOUR);
    return `${hours} ${pluralise(hours, 'hour')} ago`;
  }

  const days = Math.floor(delta / DAY);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function formatCount(count: number, singular: string, plural?: string): string {
  return `${count} ${pluralise(count, singular, plural)}`;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/helpers/`
Expected: PASS — **54 passed**.

If `formatIstDate` fails on a non-breaking-space mismatch, that is `Intl` behaviour differing by ICU build, not a logic bug — the `.replace(/ /g, ' ')` normalisation above handles it. Do **not** "fix" it by loosening the assertion to a substring match.

- [ ] **Step 7: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/src/helpers/ && git commit -m "feat(frontend): add duration, IST date and formatting helpers"
```

---
### Task 6: `api/types.ts` + `api/http.ts` — transport and the typed `ApiError`

**Files:**
- Create: `frontend/src/api/types.ts`, `frontend/src/api/http.ts`
- Test: `frontend/src/api/http.test.ts`

**Interfaces:**
- Produces: the wire DTOs; `ApiError` (carrying `status`, `errorCode`, `message`, `fieldErrors`); `http.get/post/put/del`.
- Consumes: `src/config.ts` (`API_BASE_URL`, `REQUEST_TIMEOUT_MS`).
- Consumed by: `api/apiService.ts` **only**. Rule R5: this is the only module in the app permitted to reference `fetch`.

**This is the foundation of the error-handling requirement.** Every status the product owner named — 400, 404, **422 with field-level detail**, 409, 500, network failure/offline, request timeout — is normalised here into one typed object, so that no component ever inspects a raw `Response`, and no `catch` block anywhere has to guess at a body shape.

**Three response shapes must be handled, because the backend really does emit three** (§0.4):
1. `{"error_code": string, "message": string}` — 400, 404, 409, 500. Verified in `backend/app/main.py`.
2. `{"detail": [{"loc": [...], "msg": "...", "type": "..."}]}` — 422, FastAPI's own handler, **not overridden today**.
3. No JSON at all — 204, the literal `null` body from `POST /schedules/{id}/agents`, or a transport failure with no body.

**And a fourth, defensively:** if the 422 normalisation described in the brief lands (`{error_code, message, details}`), branch 1 already catches it and the `details` array is read as field errors. Handling both is ~15 lines and removes the bet entirely.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/api/http.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, http } from './http';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function jsonResponse(status: number, body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('request construction', () => {
  it('prefixes the configured base URL and keeps the /api/v1 path', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));
    await http.get('/api/v1/agents');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:8000/api/v1/agents');
  });

  it('serialises a query string and drops undefined values', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));
    await http.get('/api/v1/agents', { query: { limit: 200, offset: 0, cursor: undefined } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:8000/api/v1/agents?limit=200&offset=0');
  });

  it('sends a JSON body with the right headers', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 1 }));
    await http.post('/api/v1/schedules', { body: { name: 'Weekday Core' } });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"name":"Weekday Core"}');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('sends no content-type on a GET, so no CORS preflight is provoked', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));
    await http.get('/api/v1/agents');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('content-type')).toBeNull();
  });
});

describe('empty and null bodies', () => {
  it('returns undefined for 204 (DELETE)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(http.del('/api/v1/schedules/1')).resolves.toBeUndefined();
  });

  it('returns undefined for the literal null body POST /schedules/{id}/agents sends', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, null));
    await expect(http.post('/api/v1/schedules/1/agents', { body: { agent_id: 2 } })).resolves.toBeUndefined();
  });

  it('returns undefined for a 200 with an entirely empty body', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    await expect(http.get('/api/v1/agents')).resolves.toBeUndefined();
  });
});

describe('error envelope 1 - {error_code, message}', () => {
  it.each([
    [400, 'validation_error'],
    [404, 'not_found'],
    [409, 'conflict'],
    [500, 'internal_error'],
  ])('maps %i to errorCode %s', async (status, errorCode) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error_code: errorCode, message: 'boom' }));
    const error = await http.get('/api/v1/schedules/1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, errorCode, message: 'boom' });
  });

  it('reads field details when the backend supplies them (the normalised 422)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        error_code: 'validation_error',
        message: 'invalid shift',
        details: [{ loc: ['body', 'shifts', 0, 'end_hours'], msg: 'must be < 24' }],
      }),
    );
    const error = (await http.post('/api/v1/schedules', { body: {} }).catch((e: unknown) => e)) as ApiError;
    expect(error.fieldErrors).toEqual([{ path: 'shifts.0.end_hours', message: 'must be < 24' }]);
  });
});

describe('error envelope 2 - FastAPI 422 {detail: [...]}', () => {
  it('normalises the native shape the backend emits today', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        detail: [
          { loc: ['body', 'shifts', 0, 'end_hours'], msg: 'Input should be less than 24', type: 'less_than' },
          { loc: ['body', 'name'], msg: 'Field required', type: 'missing' },
        ],
      }),
    );
    const error = (await http.post('/api/v1/schedules', { body: {} }).catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(422);
    expect(error.errorCode).toBe('unprocessable');
    expect(error.fieldErrors).toEqual([
      { path: 'shifts.0.end_hours', message: 'Input should be less than 24' },
      { path: 'name', message: 'Field required' },
    ]);
    // The summary must name a field, not say "Unprocessable Entity".
    expect(error.message).toMatch(/end_hours/);
  });

  it('handles a string detail', async () => {
    fetchMock.mockResolvedValue(jsonResponse(422, { detail: 'nope' }));
    const error = (await http.get('/api/v1/agents').catch((e: unknown) => e)) as ApiError;
    expect(error.message).toBe('nope');
  });
});

describe('error envelope 3 - no usable body', () => {
  it('does not throw a parse error on an HTML error page', async () => {
    fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 502 }));
    const error = (await http.get('/api/v1/agents').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.errorCode).toBe('internal_error');
  });
});

describe('transport failures', () => {
  it('maps a fetch rejection to network_error with status 0', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = (await http.get('/api/v1/agents').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.errorCode).toBe('network_error');
    expect(error.isRetryable).toBe(true);
  });

  it('maps an exceeded deadline to timeout, distinctly from a network failure', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    const pending = http.get('/api/v1/agents').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(21_000);
    const error = (await pending) as ApiError;
    expect(error.errorCode).toBe('timeout');
    expect(error.isRetryable).toBe(true);
  });

  it('rethrows a caller abort as-is, so TanStack Query can cancel cleanly', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    const pending = http.get('/api/v1/agents', { signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    const error = (await pending) as Error;
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error.name).toBe('AbortError');
  });
});

describe('ApiError', () => {
  it('is a real Error with a usable name and stack', () => {
    const error = new ApiError(409, 'conflict', 'overlap');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ApiError');
    expect(error.stack).toBeDefined();
  });

  it('marks only transport failures as retryable - a 500 is not retried blindly', () => {
    expect(new ApiError(500, 'internal_error', 'x').isRetryable).toBe(false);
    expect(new ApiError(409, 'conflict', 'x').isRetryable).toBe(false);
    expect(new ApiError(0, 'network_error', 'x').isRetryable).toBe(true);
  });

  it('finds a field error by path for form mapping', () => {
    const error = new ApiError(422, 'unprocessable', 'x', [
      { path: 'shifts.0.end_hours', message: 'bad' },
    ]);
    expect(error.fieldErrorFor('shifts.0.end_hours')).toBe('bad');
    expect(error.fieldErrorFor('name')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/api/http.test.ts`
Expected: FAIL — `Failed to resolve import "./http" from "src/api/http.test.ts"`.

- [ ] **Step 3: Write `api/types.ts`**

```ts
// frontend/src/api/types.ts
/**
 * Wire DTOs, 1:1 with the backend's Pydantic response models. Read from
 * backend/app/api/v1/*/request_response.py — do not "improve" these names.
 *
 * snake_case is preserved deliberately. Renaming to camelCase here would mean
 * a wire change surfaces as a silently-wrong value; keeping the wire shape
 * means it surfaces as a type error in exactly one file. Mapping to view
 * models, where it is needed at all, happens in hooks.
 */

/** GET /api/v1/agents */
export interface Agent {
  id: number;
  name: string;
  email: string | null;
}

/** GET /api/v1/agents/{id}/schedules, GET /api/v1/schedules/{id}/agents */
export interface NamedRef {
  id: number;
  name: string;
}

/** One logical, possibly-midnight-crossing shift. `start_hours` / `end_hours`
 *  are floats in [0, 24); 22.5 is 22:30. `weekday` is 0 = Monday. */
export interface WireShift {
  weekday: number;
  start_hours: number;
  end_hours: number;
}

export interface Schedule {
  id: number;
  name: string;
  /** "YYYY-MM-DD" */
  start_date: string;
  /** "YYYY-MM-DD", or null for open-ended */
  end_date: string | null;
  shifts: WireShift[];
}

export interface ScheduleCreateBody {
  name: string;
  start_date: string;
  end_date?: string | null;
  shifts: WireShift[];
}

/**
 * PUT /api/v1/schedules/{id}.
 * `ScheduleUpdateRequest` has exactly one field. Name and dates are NOT
 * editable through this endpoint — do not add them here hoping it works.
 */
export interface ScheduleUpdateBody {
  shifts: WireShift[];
}

/** GET /api/v1/schedules/{id}/deletion-impact — IDs only, no names. */
export interface DeletionImpact {
  schedule_id: number;
  affected_agent_ids: number[];
}

export interface AgentHours {
  agent_id: number;
  business_seconds: number;
}

export interface Report {
  id: number;
  /** IST-aware ISO 8601, e.g. "2026-08-09T10:00:00+05:30" */
  ticket_start_at: string;
  ticket_end_at: string;
  /**
   * WARNING: always `[]` on GET /api/v1/reports (list). `list_reports()`
   * never populates it. Only POST /api/v1/reports and GET
   * /api/v1/reports/{id} return real rows. Never render an hours figure or
   * an agent count from a list response.
   */
  agent_hours: AgentHours[];
}

export interface ReportGenerateBody {
  ticket_start_at: string;
  ticket_end_at: string;
}

/** limit is capped at 200 server-side (PaginationParams: ge=1, le=200). */
export interface PaginationQuery {
  limit?: number;
  offset?: number;
}

export const AGENTS_PAGE_LIMIT_MAX = 200;
export const DEFAULT_PAGE_LIMIT = 50;
```

- [ ] **Step 4: Write `api/http.ts`**

```ts
// frontend/src/api/http.ts
/**
 * The ONLY module in this application permitted to call fetch (rule R5).
 *
 * Its entire job: prefix the base URL, serialise, parse, and normalise EVERY
 * failure into one typed ApiError. No caching, no retries, no React. Callers
 * above this line never see a Response object and never guess at a body shape.
 */
import { API_BASE_URL, REQUEST_TIMEOUT_MS } from '@/config';

export type ApiErrorCode =
  /* from the backend's own envelope (app/main.py) */
  | 'not_found'
  | 'conflict'
  | 'validation_error'
  | 'internal_error'
  /* FastAPI's native 422 */
  | 'unprocessable'
  /* client-side transport classifications */
  | 'network_error'
  | 'timeout'
  | 'unknown';

export interface FieldError {
  /** Dotted path into the request body, e.g. "shifts.0.end_hours". */
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly errorCode: ApiErrorCode;
  readonly fieldErrors: readonly FieldError[];

  constructor(
    status: number,
    errorCode: ApiErrorCode,
    message: string,
    fieldErrors: readonly FieldError[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errorCode = errorCode;
    this.fieldErrors = fieldErrors;
    // Required so `instanceof ApiError` survives the ES5 class-extends
    // downlevelling some toolchains still apply.
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  /**
   * Only transport failures are worth retrying. A 4xx will fail identically
   * on the second attempt, and retrying a POST /reports would insert a
   * duplicate report row — the endpoint is not idempotent.
   */
  get isRetryable(): boolean {
    return this.errorCode === 'network_error' || this.errorCode === 'timeout';
  }

  /** Look up a validation message to attach to a specific form control. */
  fieldErrorFor(path: string): string | undefined {
    return this.fieldErrors.find((f) => f.path === path)?.message;
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_BASE_URL}${path}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/** Never throws. An error page that is not JSON must not become a parse crash. */
async function safeParse(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** ["body", "shifts", 0, "end_hours"] -> "shifts.0.end_hours" */
function locToPath(loc: unknown): string {
  if (!Array.isArray(loc)) return '';
  const parts = loc.map(String);
  const head = parts[0];
  const rest = head === 'body' || head === 'query' || head === 'path' ? parts.slice(1) : parts;
  return rest.join('.');
}

function toFieldErrors(raw: unknown): FieldError[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const entry = item as { loc?: unknown; msg?: unknown; message?: unknown };
      const message = typeof entry.msg === 'string' ? entry.msg : String(entry.message ?? '');
      return { path: locToPath(entry.loc), message };
    })
    .filter((f) => f.message !== '');
}

/** A summary that names the offending field, so a toast is never just
 *  "Unprocessable Entity". */
function summarise(fieldErrors: readonly FieldError[]): string {
  const first = fieldErrors[0];
  if (!first) return 'The request was rejected as invalid.';
  const label = first.path === '' ? 'request' : first.path;
  const suffix = fieldErrors.length > 1 ? ` (+${fieldErrors.length - 1} more)` : '';
  return `${label}: ${first.message}${suffix}`;
}

const CODE_BY_STATUS: Record<number, ApiErrorCode> = {
  400: 'validation_error',
  404: 'not_found',
  409: 'conflict',
  422: 'unprocessable',
};

function codeForStatus(status: number): ApiErrorCode {
  if (status >= 500) return 'internal_error';
  return CODE_BY_STATUS[status] ?? 'unknown';
}

async function toApiError(response: Response): Promise<ApiError> {
  const body = await safeParse(response);
  const record = (body ?? {}) as Record<string, unknown>;

  // Shape 1: the backend's own envelope, from app/main.py's handlers. Also
  // catches a normalised 422 carrying `details`.
  if (typeof record.error_code === 'string') {
    const fieldErrors = toFieldErrors(record.details);
    const message =
      typeof record.message === 'string' && record.message !== ''
        ? record.message
        : response.statusText;
    return new ApiError(response.status, record.error_code as ApiErrorCode, message, fieldErrors);
  }

  // Shape 2: FastAPI's native RequestValidationError body, which main.py does
  // NOT currently override.
  if (Array.isArray(record.detail)) {
    const fieldErrors = toFieldErrors(record.detail);
    return new ApiError(response.status, 'unprocessable', summarise(fieldErrors), fieldErrors);
  }
  if (typeof record.detail === 'string') {
    return new ApiError(response.status, codeForStatus(response.status), record.detail);
  }

  // Shape 3: no usable body — a proxy error page, an empty 502, anything.
  return new ApiError(
    response.status,
    codeForStatus(response.status),
    response.statusText || `Request failed with status ${response.status}`,
  );
}

/**
 * One deadline per request, combined with the caller's signal.
 *
 * Built by hand rather than with AbortSignal.timeout/any so the behaviour is
 * identical in jsdom and so a timeout stays distinguishable from a caller
 * cancellation — TanStack Query aborts queries routinely, and those must not
 * be reported to the user as failures.
 */
function createDeadline(caller?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  const onCallerAbort = () => controller.abort();
  if (caller) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener('abort', onCallerAbort, { once: true });
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    },
  };
}

async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const { query, body, signal } = options;
  const deadline = createDeadline(signal);

  const headers = new Headers({ accept: 'application/json' });
  // Set only when there is a body: an unnecessary content-type on a GET turns
  // a simple cross-origin request into a preflighted one for no reason.
  if (body !== undefined) headers.set('content-type', 'application/json');

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: deadline.signal,
      mode: 'cors',
      credentials: 'omit',
    });
  } catch (cause) {
    if (deadline.didTimeout()) {
      throw new ApiError(
        0,
        'timeout',
        `The request took longer than ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s and was cancelled.`,
      );
    }
    // A cancellation the CALLER asked for. Rethrow untouched so TanStack
    // Query treats it as a cancellation, not an error to surface.
    if (signal?.aborted) throw cause;

    throw new ApiError(
      0,
      'network_error',
      'Could not reach the server. Check your connection and try again.',
    );
  } finally {
    deadline.cleanup();
  }

  if (!response.ok) throw await toApiError(response);

  // 204, an empty body, or the literal `null` that POST
  // /schedules/{id}/agents returns (its handler has no response_model).
  if (response.status === 204) return undefined as T;
  const parsed = await safeParse(response);
  return (parsed === null ? undefined : parsed) as T;
}

export const http = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'body'>) => request<T>('GET', path, options),
  post: <T>(path: string, options?: RequestOptions) => request<T>('POST', path, options),
  put: <T>(path: string, options?: RequestOptions) => request<T>('PUT', path, options),
  del: <T>(path: string, options?: Omit<RequestOptions, 'body'>) => request<T>('DELETE', path, options),
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/api/http.test.ts`
Expected: PASS — **20 passed**.

- [ ] **Step 6: Verify the layering still holds**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npm run lint:arch && npm run typecheck`
Expected: no dependency violations, no type errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/src/api/ && git commit -m "feat(frontend): add http transport with typed ApiError normalising all three backend error shapes plus timeout and network failure"
```

---

### Task 7: `api/apiService.ts` — the typed client

**Files:**
- Create: `frontend/src/api/apiService.ts`
- Create: `frontend/src/test/mswServer.ts`, `frontend/src/test/handlers.ts`
- Modify: `frontend/vitest.setup.ts` (start/stop the MSW server)
- Test: `frontend/src/api/apiService.test.ts`

**Interfaces:**
- Produces: `class ApiService` and the singleton `export const apiService = new ApiService()`, with one typed method per endpoint; and the MSW test server + default handlers used by every later hook and component test.
- Consumes: `api/http.ts`, `api/types.ts`.
- Consumed by: `src/hooks/**` **only** (rule R1).

`ApiService` holds no caching, no retry logic and no React. Those belong in the hook layer. Its value is that the fourteen endpoint shapes are written down exactly once, so a backend change surfaces as a type error in one file.

- [ ] **Step 1: Write the MSW server and default handlers**

```ts
// frontend/src/test/mswServer.ts
import { setupServer } from 'msw/node';
import { defaultHandlers } from './handlers';

export const mswServer = setupServer(...defaultHandlers);
```

```ts
// frontend/src/test/handlers.ts
import { HttpResponse, http as mswHttp } from 'msw';
import type { Agent, Report, Schedule } from '@/api/types';

export const API = 'http://localhost:8000/api/v1';

export const AGENTS: Agent[] = [
  { id: 1, name: 'Alice Chen', email: 'alice@richpanel.example' },
  { id: 2, name: 'Bob Martinez', email: 'bob@richpanel.example' },
  { id: 3, name: 'Carol Singh', email: null },
];

export const WEEKDAY_CORE: Schedule = {
  id: 1,
  name: 'Weekday Core',
  start_date: '2026-08-01',
  end_date: null,
  shifts: [0, 1, 2, 3, 4].map((weekday) => ({ weekday, start_hours: 9, end_hours: 18 })),
};

export const NIGHT_DESK: Schedule = {
  id: 2,
  name: 'Night Desk',
  start_date: '2026-08-01',
  end_date: '2026-12-31',
  shifts: [{ weekday: 0, start_hours: 22, end_hours: 6 }],
};

export const REPORT: Report = {
  id: 14,
  ticket_start_at: '2026-08-09T10:00:00+05:30',
  ticket_end_at: '2026-08-12T17:30:00+05:30',
  agent_hours: [
    { agent_id: 1, business_seconds: 97_200 },
    { agent_id: 2, business_seconds: 97_200 },
    { agent_id: 3, business_seconds: 0 },
  ],
};

/** Reusable error responses. Every test that needs a failure path overrides a
 *  handler with one of these rather than inventing its own body shape. */
export const errors = {
  /** The backend's own envelope, from app/main.py. */
  envelope: (status: number, error_code: string, message: string) =>
    HttpResponse.json({ error_code, message }, { status }),
  /** FastAPI's NATIVE 422, which main.py does not override today. */
  fastapiValidation: (loc: (string | number)[], msg: string) =>
    HttpResponse.json({ detail: [{ loc, msg, type: 'value_error' }] }, { status: 422 }),
  /** A body-less 502, as a proxy would emit. */
  badGateway: () => new HttpResponse('<html>502</html>', { status: 502 }),
};

export const defaultHandlers = [
  mswHttp.get(`${API}/agents`, ({ request }) => {
    const offset = Number(new URL(request.url).searchParams.get('offset') ?? 0);
    return HttpResponse.json(offset === 0 ? AGENTS : []);
  }),
  mswHttp.get(`${API}/agents/:agentId/schedules`, () => HttpResponse.json([{ id: 2, name: 'Night Desk' }])),

  mswHttp.get(`${API}/schedules`, () => HttpResponse.json([WEEKDAY_CORE, NIGHT_DESK])),
  mswHttp.get(`${API}/schedules/:id`, ({ params }) =>
    params.id === '1'
      ? HttpResponse.json(WEEKDAY_CORE)
      : HttpResponse.json(NIGHT_DESK),
  ),
  mswHttp.post(`${API}/schedules`, () => HttpResponse.json(WEEKDAY_CORE, { status: 201 })),
  mswHttp.put(`${API}/schedules/:id`, () => HttpResponse.json(WEEKDAY_CORE)),
  mswHttp.get(`${API}/schedules/:id/deletion-impact`, ({ params }) =>
    HttpResponse.json({ schedule_id: Number(params.id), affected_agent_ids: [1, 3] }),
  ),
  mswHttp.delete(`${API}/schedules/:id`, () => new HttpResponse(null, { status: 204 })),

  mswHttp.get(`${API}/schedules/:id/agents`, () =>
    HttpResponse.json([
      { id: 1, name: 'Alice Chen' },
      { id: 2, name: 'Bob Martinez' },
    ]),
  ),
  // Mirrors the real handler exactly: 201 with a literal `null` body.
  mswHttp.post(`${API}/schedules/:id/agents`, () => HttpResponse.json(null, { status: 201 })),
  mswHttp.delete(`${API}/schedules/:id/agents/:agentId`, () => new HttpResponse(null, { status: 204 })),

  mswHttp.post(`${API}/reports`, () => HttpResponse.json(REPORT, { status: 201 })),
  // Mirrors the real list serializer: agent_hours is ALWAYS empty here.
  mswHttp.get(`${API}/reports`, () => HttpResponse.json([{ ...REPORT, agent_hours: [] }])),
  mswHttp.get(`${API}/reports/:id`, () => HttpResponse.json(REPORT)),
];
```

Wire the server into the global setup:

```ts
// frontend/vitest.setup.ts  — APPEND to the existing file
import { afterAll, afterEach as afterEachHook, beforeAll as beforeAllHook } from 'vitest';
import { mswServer } from './src/test/mswServer';

beforeAllHook(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterEachHook(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());
```

`onUnhandledRequest: 'error'` is deliberate: a request to a URL no handler covers should fail the test loudly, not silently hit the network.

- [ ] **Step 2: Write the failing test**

```ts
// frontend/src/api/apiService.test.ts
import { describe, expect, it } from 'vitest';
import { API, NIGHT_DESK, REPORT, errors } from '@/test/handlers';
import { mswServer } from '@/test/mswServer';
import { http as mswHttp } from 'msw';
import { ApiError } from './http';
import { apiService } from './apiService';

describe('agents', () => {
  it('lists agents with pagination', async () => {
    const agents = await apiService.agents.list({ limit: 200, offset: 0 });
    expect(agents).toHaveLength(3);
    expect(agents[0]).toEqual({ id: 1, name: 'Alice Chen', email: 'alice@richpanel.example' });
  });

  it('preserves a null email rather than coercing it to an empty string', async () => {
    const agents = await apiService.agents.list();
    expect(agents[2]?.email).toBeNull();
  });

  it('lists an agent schedules', async () => {
    await expect(apiService.agents.schedules(1)).resolves.toEqual([{ id: 2, name: 'Night Desk' }]);
  });
});

describe('schedules', () => {
  it('gets one, preserving the overnight shift as a single logical row', async () => {
    const schedule = await apiService.schedules.get(2);
    expect(schedule.shifts).toEqual([{ weekday: 0, start_hours: 22, end_hours: 6 }]);
    expect(schedule.end_date).toBe('2026-12-31');
  });

  it('creates a schedule', async () => {
    const created = await apiService.schedules.create({
      name: 'Weekday Core',
      start_date: '2026-08-01',
      end_date: null,
      shifts: [{ weekday: 0, start_hours: 9, end_hours: 18 }],
    });
    expect(created.id).toBe(1);
  });

  it('updates hours and sends ONLY the shifts key', async () => {
    let sent: unknown;
    mswServer.use(
      mswHttp.put(`${API}/schedules/:id`, async ({ request }) => {
        sent = await request.json();
        return Response.json(NIGHT_DESK);
      }),
    );
    await apiService.schedules.updateHours(2, { shifts: [{ weekday: 0, start_hours: 22, end_hours: 6 }] });
    expect(Object.keys(sent as object)).toEqual(['shifts']);
  });

  it('reads the deletion impact', async () => {
    await expect(apiService.schedules.deletionImpact(1)).resolves.toEqual({
      schedule_id: 1,
      affected_agent_ids: [1, 3],
    });
  });

  it('deletes and resolves to undefined on 204', async () => {
    await expect(apiService.schedules.remove(1)).resolves.toBeUndefined();
  });

  it('surfaces a 404 as a typed ApiError', async () => {
    mswServer.use(
      mswHttp.get(`${API}/schedules/:id`, () => errors.envelope(404, 'not_found', 'schedule 99 not found')),
    );
    const error = (await apiService.schedules.get(99).catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.errorCode).toBe('not_found');
  });

  it('surfaces a 409 conflict on an hours edit', async () => {
    mswServer.use(
      mswHttp.put(`${API}/schedules/:id`, () =>
        errors.envelope(409, 'conflict', 'agent 3 would have 2 overlapping shift(s)'),
      ),
    );
    const error = (await apiService.schedules
      .updateHours(1, { shifts: [] })
      .catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(409);
    expect(error.errorCode).toBe('conflict');
  });

  it('surfaces the 500 the backend really returns for a zero-length shift', async () => {
    mswServer.use(
      mswHttp.post(`${API}/schedules`, () =>
        errors.envelope(500, 'internal_error', 'internal server error'),
      ),
    );
    const error = (await apiService.schedules
      .create({ name: 'x', start_date: '2026-08-01', shifts: [{ weekday: 0, start_hours: 9, end_hours: 9 }] })
      .catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(500);
    expect(error.isRetryable).toBe(false);
  });
});

describe('assignments', () => {
  it('lists assignees', async () => {
    await expect(apiService.assignments.list(1)).resolves.toHaveLength(2);
  });

  it('assigns without choking on the null body', async () => {
    await expect(apiService.assignments.add(1, 3)).resolves.toBeUndefined();
  });

  it('unassigns idempotently', async () => {
    await expect(apiService.assignments.remove(1, 3)).resolves.toBeUndefined();
  });
});

describe('reports', () => {
  it('generates a report with one row per agent', async () => {
    const report = await apiService.reports.generate({
      ticket_start_at: '2026-08-09T10:00:00+05:30',
      ticket_end_at: '2026-08-12T17:30:00+05:30',
    });
    expect(report.id).toBe(14);
    expect(report.agent_hours).toHaveLength(3);
  });

  it('returns list rows whose agent_hours is empty, matching the real serializer', async () => {
    const reports = await apiService.reports.list();
    expect(reports[0]?.agent_hours).toEqual([]);
  });

  it('hydrates a single report fully', async () => {
    await expect(apiService.reports.get(14)).resolves.toEqual(REPORT);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/api/apiService.test.ts`
Expected: FAIL — `Failed to resolve import "./apiService"`.

- [ ] **Step 4: Write the implementation**

```ts
// frontend/src/api/apiService.ts
/**
 * The typed client. One method per backend endpoint, grouped by resource.
 *
 * No caching, no retry, no React — those live in src/hooks/**. This class is
 * the single written-down description of the wire, so a backend change fails
 * to compile here and nowhere else.
 *
 * Every path carries its own `/api/v1` prefix, because every FastAPI router
 * declares one (e.g. APIRouter(prefix="/api/v1/schedules")). API_BASE_URL is
 * the ORIGIN only.
 */
import { http } from './http';
import type {
  Agent,
  DeletionImpact,
  NamedRef,
  PaginationQuery,
  Report,
  ReportGenerateBody,
  Schedule,
  ScheduleCreateBody,
  ScheduleUpdateBody,
} from './types';

const V1 = '/api/v1';

export class ApiService {
  readonly agents = {
    /** GET /api/v1/agents — `limit` is capped at 200 server-side. */
    list: (params: PaginationQuery = {}, signal?: AbortSignal): Promise<Agent[]> =>
      http.get<Agent[]>(`${V1}/agents`, { query: { ...params }, signal }),

    /** GET /api/v1/agents/{id}/schedules — returns [] for an unknown agent,
     *  never 404. */
    schedules: (agentId: number, signal?: AbortSignal): Promise<NamedRef[]> =>
      http.get<NamedRef[]>(`${V1}/agents/${agentId}/schedules`, { signal }),
  };

  readonly schedules = {
    list: (params: PaginationQuery = {}, signal?: AbortSignal): Promise<Schedule[]> =>
      http.get<Schedule[]>(`${V1}/schedules`, { query: { ...params }, signal }),

    get: (scheduleId: number, signal?: AbortSignal): Promise<Schedule> =>
      http.get<Schedule>(`${V1}/schedules/${scheduleId}`, { signal }),

    create: (body: ScheduleCreateBody, signal?: AbortSignal): Promise<Schedule> =>
      http.post<Schedule>(`${V1}/schedules`, { body, signal }),

    /** PUT accepts `{shifts}` and nothing else. Name and dates are immutable
     *  through this endpoint. Can return 409 for ANY assignee's overlap. */
    updateHours: (scheduleId: number, body: ScheduleUpdateBody, signal?: AbortSignal): Promise<Schedule> =>
      http.put<Schedule>(`${V1}/schedules/${scheduleId}`, { body, signal }),

    /** Returns agent IDs only — names must be joined from the agent map. */
    deletionImpact: (scheduleId: number, signal?: AbortSignal): Promise<DeletionImpact> =>
      http.get<DeletionImpact>(`${V1}/schedules/${scheduleId}/deletion-impact`, { signal }),

    /** Soft delete. 204, no body. */
    remove: (scheduleId: number, signal?: AbortSignal): Promise<void> =>
      http.del<void>(`${V1}/schedules/${scheduleId}`, { signal }),
  };

  readonly assignments = {
    list: (scheduleId: number, signal?: AbortSignal): Promise<NamedRef[]> =>
      http.get<NamedRef[]>(`${V1}/schedules/${scheduleId}/agents`, { signal }),

    /** 201 with a literal `null` body — the handler has no response_model.
     *  http.ts turns that into undefined; callers invalidate rather than read. */
    add: (scheduleId: number, agentId: number, signal?: AbortSignal): Promise<void> =>
      http.post<void>(`${V1}/schedules/${scheduleId}/agents`, { body: { agent_id: agentId }, signal }),

    /** Idempotent; never 404s. */
    remove: (scheduleId: number, agentId: number, signal?: AbortSignal): Promise<void> =>
      http.del<void>(`${V1}/schedules/${scheduleId}/agents/${agentId}`, { signal }),
  };

  readonly reports = {
    /** NOT idempotent — every call inserts a report row. Never auto-retry. */
    generate: (body: ReportGenerateBody, signal?: AbortSignal): Promise<Report> =>
      http.post<Report>(`${V1}/reports`, { body, signal }),

    /** WARNING: every row's `agent_hours` is []. See api/types.ts. */
    list: (params: PaginationQuery = {}, signal?: AbortSignal): Promise<Report[]> =>
      http.get<Report[]>(`${V1}/reports`, { query: { ...params }, signal }),

    get: (reportId: number, signal?: AbortSignal): Promise<Report> =>
      http.get<Report>(`${V1}/reports/${reportId}`, { signal }),
  };
}

/** The singleton. Only src/hooks/** may import this (rule R1). */
export const apiService = new ApiService();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/api/`
Expected: PASS — **36 passed** (20 from Task 6, 16 here).

- [ ] **Step 6: Run everything**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npm test && npm run lint:arch && npm run typecheck`
Expected: **98 passed**, no dependency violations, no type errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/src/api/ frontend/src/test/ frontend/vitest.setup.ts && git commit -m "feat(frontend): add typed ApiService singleton and MSW handlers mirroring the real backend responses"
```

---
### Task 8: `hooks/queryKeys.ts`, the QueryClient policy, and `hooks/queries/`

**Files:**
- Create: `frontend/src/hooks/queryKeys.ts`, `frontend/src/hooks/queryClient.ts`
- Create: `frontend/src/hooks/queries/{useAgents,useSchedules,useAssignments,useDeletionImpact,useReports}.ts`
- Create: `frontend/src/test/renderWithQuery.tsx`
- Delete: `frontend/src/hooks/queries/.gitkeep`
- Test: `frontend/src/hooks/queries/useAgents.test.tsx`, `frontend/src/hooks/queries/useSchedules.test.tsx`, `frontend/src/hooks/queryClient.test.ts`

**Interfaces:**
- Produces: `queryKeys`; `createQueryClient()`; `useAgents`, `useAgentMap`, `useAgentSchedules`, `useSchedules`, `useSchedule`, `useScheduleAgents`, `useDeletionImpact`, `usePrefetchDeletionImpact`, `useReports`, `useReport`.
- Consumes: `api/apiService.ts`, `api/http.ts` (for `ApiError` in the retry predicate).
- Consumed by: `src/pages/**` and `src/components/**` via props. **Nothing above this layer calls `useQuery` directly** (rule R7).

**Why there is no client-state library.** Enumerating every piece of state in this app: server data → the query cache. Selected schedule → a URL path param. Report window → URL search params. Sort key, filter text, zero-group expansion → `useState` local to one component. Form values → React Hook Form. Theme, toasts, modals → three Contexts (Task 10/11). **Nothing is left over.** A store would be a wrapper around one of those.

**The retry defaults are wrong for this backend and must be set explicitly.** Retrying a 4xx is pointless — it will fail identically. Retrying `POST /reports` is actively harmful: the endpoint is **not idempotent**, so a retry inserts a duplicate report row.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/hooks/queryClient.test.ts
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/http';
import { createQueryClient } from './queryClient';

function retryFn() {
  const client = createQueryClient();
  const retry = client.getDefaultOptions().queries?.retry;
  if (typeof retry !== 'function') throw new Error('queries.retry must be a predicate function');
  return retry as (failureCount: number, error: Error) => boolean;
}

describe('query retry policy', () => {
  it('retries a network failure up to twice', () => {
    const retry = retryFn();
    const error = new ApiError(0, 'network_error', 'offline');
    expect(retry(0, error)).toBe(true);
    expect(retry(1, error)).toBe(true);
    expect(retry(2, error)).toBe(false);
  });

  it('retries a timeout', () => {
    expect(retryFn()(0, new ApiError(0, 'timeout', 'slow'))).toBe(true);
  });

  it.each([
    [400, 'validation_error'],
    [404, 'not_found'],
    [409, 'conflict'],
    [422, 'unprocessable'],
    [500, 'internal_error'],
  ] as const)('never retries a %i - it would fail identically', (status, code) => {
    expect(retryFn()(0, new ApiError(status, code, 'x'))).toBe(false);
  });

  it('never retries a non-ApiError', () => {
    expect(retryFn()(0, new Error('bug in a selector'))).toBe(false);
  });
});

describe('mutation retry policy', () => {
  it('NEVER retries - POST /reports is not idempotent and would duplicate a row', () => {
    expect(createQueryClient().getDefaultOptions().mutations?.retry).toBe(false);
  });
});

describe('refetch policy', () => {
  it('does not refetch on window focus - alt-tab storms are noise in an ops tool', () => {
    expect(createQueryClient().getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
  });
});
```

```tsx
// frontend/src/hooks/queries/useAgents.test.tsx
import { waitFor } from '@testing-library/react';
import { HttpResponse, http as mswHttp } from 'msw';
import { describe, expect, it } from 'vitest';
import { API, AGENTS, errors } from '@/test/handlers';
import { mswServer } from '@/test/mswServer';
import { renderHookWithQuery } from '@/test/renderWithQuery';
import { useAgentMap, useAgents } from './useAgents';

describe('useAgents', () => {
  it('returns the agent list', async () => {
    const { result } = renderHookWithQuery(() => useAgents());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(3);
  });

  it('pages until it receives a short page, because /agents caps limit at 200', async () => {
    const pageOne = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, name: `Agent ${i + 1}`, email: null }));
    const requestedOffsets: string[] = [];
    mswServer.use(
      mswHttp.get(`${API}/agents`, ({ request }) => {
        const offset = new URL(request.url).searchParams.get('offset') ?? '0';
        requestedOffsets.push(offset);
        return HttpResponse.json(offset === '0' ? pageOne : AGENTS);
      }),
    );

    const { result } = renderHookWithQuery(() => useAgents());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(requestedOffsets).toEqual(['0', '200']);
    expect(result.current.data).toHaveLength(203);
  });

  it('surfaces a failure as a typed error rather than an empty list', async () => {
    mswServer.use(mswHttp.get(`${API}/agents`, () => errors.envelope(500, 'internal_error', 'boom')));
    const { result } = renderHookWithQuery(() => useAgents());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.errorCode).toBe('internal_error');
    expect(result.current.data).toBeUndefined();
  });
});

describe('useAgentMap', () => {
  it('builds a stable id -> name Map for joining report rows and impact IDs', async () => {
    const { result } = renderHookWithQuery(() => useAgentMap());
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.get(1)).toBe('Alice Chen');
    expect(result.current.data?.get(999)).toBeUndefined();
  });

  it('returns the same Map identity across re-renders, so memoised rows do not thrash', async () => {
    const { result, rerender } = renderHookWithQuery(() => useAgentMap());
    await waitFor(() => expect(result.current.data).toBeDefined());
    const first = result.current.data;
    rerender();
    expect(result.current.data).toBe(first);
  });
});
```

```tsx
// frontend/src/hooks/queries/useSchedules.test.tsx
import { waitFor } from '@testing-library/react';
import { http as mswHttp } from 'msw';
import { describe, expect, it } from 'vitest';
import { API, errors } from '@/test/handlers';
import { mswServer } from '@/test/mswServer';
import { renderHookWithQuery } from '@/test/renderWithQuery';
import { useSchedule, useSchedules } from './useSchedules';

describe('useSchedules', () => {
  it('lists schedules and reports whether another page may exist', async () => {
    const { result } = renderHookWithQuery(() => useSchedules());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(2);
    // No X-Total-Count exists, so hasMore is `page.length === limit` and
    // nothing else. Two rows against a limit of 50 means there is no more.
    expect(result.current.hasMore).toBe(false);
  });
});

describe('useSchedule', () => {
  it('fetches one schedule', async () => {
    const { result } = renderHookWithQuery(() => useSchedule(2));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.name).toBe('Night Desk');
  });

  it('stays idle when the id is null, so a deep link with no selection fetches nothing', async () => {
    const { result } = renderHookWithQuery(() => useSchedule(null));
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('exposes a 404 as not_found so the screen can render "this schedule was deleted"', async () => {
    mswServer.use(
      mswHttp.get(`${API}/schedules/:id`, () => errors.envelope(404, 'not_found', 'schedule 99 not found')),
    );
    const { result } = renderHookWithQuery(() => useSchedule(99));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.errorCode).toBe('not_found');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/hooks/`
Expected: FAIL — unresolved imports for `./queryClient`, `./useAgents`, `./useSchedules`, `@/test/renderWithQuery`.

- [ ] **Step 3: Write the query keys, the client policy, and the test renderer**

```ts
// frontend/src/hooks/queryKeys.ts
/**
 * Every cache key in the application. Nothing constructs a key inline.
 *
 * The hierarchy matters as much as the strings: `schedules.all` is a prefix of
 * `schedules.detail(id)`, so `invalidateQueries({ queryKey: queryKeys.schedules.all })`
 * reaches the list, every detail, every assignee list and every impact query
 * in one call — which is exactly what a delete needs.
 */
export const queryKeys = {
  agents: {
    all: ['agents'] as const,
    list: () => [...queryKeys.agents.all, 'list'] as const,
    map: () => [...queryKeys.agents.all, 'map'] as const,
    schedules: (agentId: number) => [...queryKeys.agents.all, agentId, 'schedules'] as const,
  },
  schedules: {
    all: ['schedules'] as const,
    list: (limit: number) => [...queryKeys.schedules.all, 'list', { limit }] as const,
    detail: (scheduleId: number) => [...queryKeys.schedules.all, scheduleId] as const,
    agents: (scheduleId: number) => [...queryKeys.schedules.all, scheduleId, 'agents'] as const,
    deletionImpact: (scheduleId: number) =>
      [...queryKeys.schedules.all, scheduleId, 'deletion-impact'] as const,
  },
  reports: {
    all: ['reports'] as const,
    list: (limit: number) => [...queryKeys.reports.all, 'list', { limit }] as const,
    detail: (reportId: number) => [...queryKeys.reports.all, reportId] as const,
  },
} as const;
```

```ts
// frontend/src/hooks/queryClient.ts
import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/api/http';

/**
 * The defaults are set explicitly because TanStack Query's own defaults are
 * wrong for this backend:
 *
 *   - Default retry is 3, for ANY error. Retrying a 4xx is pointless, and
 *     retrying a mutation against POST /reports (which is NOT idempotent)
 *     inserts duplicate report rows.
 *   - Default refetchOnWindowFocus is true. In a tool a support manager keeps
 *     open all day, alt-tabbing would fire a refetch storm for no benefit.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount: number, error: Error) =>
          error instanceof ApiError && error.isRetryable && failureCount < 2,
        retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 5000),
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
      mutations: {
        // Never. See above.
        retry: false,
      },
    },
  });
}
```

```tsx
// frontend/src/test/renderWithQuery.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';

/** Retries off and gcTime 0 so a failing test fails immediately and does not
 *  leak cache between cases. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function withQuery(client: QueryClient = createTestQueryClient()) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

export function renderHookWithQuery<TResult>(hook: () => TResult, client?: QueryClient) {
  return renderHook(hook, { wrapper: withQuery(client) });
}

export function renderWithQuery(ui: ReactElement, client?: QueryClient) {
  return render(ui, { wrapper: withQuery(client) });
}
```

- [ ] **Step 4: Write the query hooks**

```ts
// frontend/src/hooks/queries/useAgents.ts
import { useQuery } from '@tanstack/react-query';
import { apiService } from '@/api/apiService';
import type { ApiError } from '@/api/http';
import type { Agent } from '@/api/types';
import { AGENTS_PAGE_LIMIT_MAX } from '@/api/types';
import { queryKeys } from '../queryKeys';

/**
 * GET /api/v1/agents caps `limit` at 200 and returns no total count, so the
 * only honest way to get the whole roster is to page until a short page
 * arrives. At 3 000 agents that is 15 sequential requests.
 *
 * Mitigation, and the reason this hook is special: agents are seeded and do
 * not change within a session, so `staleTime: Infinity` means the paging
 * happens ONCE, on mount, behind the user's own typing time — not on report
 * submit, where it would be 15 round trips of dead air.
 *
 * Backend change B4 (embed `agent_name` in report rows, or raise the cap, or
 * add `?ids=`) deletes this entire hook's reason for existing.
 */
async function fetchAllAgents(signal: AbortSignal): Promise<Agent[]> {
  const all: Agent[] = [];
  let offset = 0;

  for (;;) {
    const page = await apiService.agents.list({ limit: AGENTS_PAGE_LIMIT_MAX, offset }, signal);
    all.push(...page);
    if (page.length < AGENTS_PAGE_LIMIT_MAX) return all;
    offset += AGENTS_PAGE_LIMIT_MAX;
  }
}

export function useAgents() {
  return useQuery<Agent[], ApiError>({
    queryKey: queryKeys.agents.list(),
    queryFn: ({ signal }) => fetchAllAgents(signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * id -> name, for joining report rows and deletion-impact IDs to names.
 *
 * `select` is memoised by the query cache, so the Map is built once per fetch
 * rather than once per render — which matters because the report table
 * re-renders on every filter keystroke.
 */
export function useAgentMap() {
  return useQuery<Agent[], ApiError, Map<number, string>>({
    queryKey: queryKeys.agents.list(),
    queryFn: ({ signal }) => fetchAllAgents(signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    select: (agents) => new Map(agents.map((a) => [a.id, a.name])),
  });
}

/** GET /api/v1/agents/{id}/schedules. Returns [] for an unknown agent. */
export function useAgentSchedules(agentId: number | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.agents.schedules(agentId ?? -1),
    queryFn: ({ signal }) => apiService.agents.schedules(agentId as number, signal),
    enabled: enabled && agentId !== null,
  });
}
```

```ts
// frontend/src/hooks/queries/useSchedules.ts
import { useQuery } from '@tanstack/react-query';
import { apiService } from '@/api/apiService';
import type { ApiError } from '@/api/http';
import type { Schedule } from '@/api/types';
import { DEFAULT_PAGE_LIMIT } from '@/api/types';
import { queryKeys } from '../queryKeys';

/**
 * There is no X-Total-Count and no cursor (backend change B8), so a
 * page-numbered pager cannot be built honestly. `hasMore` is
 * `page.length === limit` — the only inference the wire supports. The UI
 * renders "Load more", never "Page 3 of 7".
 */
export function useSchedules(limit: number = DEFAULT_PAGE_LIMIT) {
  const query = useQuery<Schedule[], ApiError>({
    queryKey: queryKeys.schedules.list(limit),
    queryFn: ({ signal }) => apiService.schedules.list({ limit, offset: 0 }, signal),
  });

  return { ...query, hasMore: (query.data?.length ?? 0) === limit };
}

export function useSchedule(scheduleId: number | null) {
  return useQuery<Schedule, ApiError>({
    queryKey: queryKeys.schedules.detail(scheduleId ?? -1),
    queryFn: ({ signal }) => apiService.schedules.get(scheduleId as number, signal),
    enabled: scheduleId !== null,
  });
}
```

```ts
// frontend/src/hooks/queries/useAssignments.ts
import { useQuery } from '@tanstack/react-query';
import { apiService } from '@/api/apiService';
import type { ApiError } from '@/api/http';
import type { NamedRef } from '@/api/types';
import { queryKeys } from '../queryKeys';

export function useScheduleAgents(scheduleId: number | null) {
  return useQuery<NamedRef[], ApiError>({
    queryKey: queryKeys.schedules.agents(scheduleId ?? -1),
    queryFn: ({ signal }) => apiService.assignments.list(scheduleId as number, signal),
    enabled: scheduleId !== null,
  });
}
```

```ts
// frontend/src/hooks/queries/useDeletionImpact.ts
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { apiService } from '@/api/apiService';
import type { ApiError } from '@/api/http';
import type { DeletionImpact } from '@/api/types';
import { queryKeys } from '../queryKeys';

export function useDeletionImpact(scheduleId: number | null, enabled = true) {
  return useQuery<DeletionImpact, ApiError>({
    queryKey: queryKeys.schedules.deletionImpact(scheduleId ?? -1),
    queryFn: ({ signal }) => apiService.schedules.deletionImpact(scheduleId as number, signal),
    enabled: enabled && scheduleId !== null,
  });
}

/**
 * Prefetch on 200ms hover-intent or focus of a Delete control, so the impact
 * modal opens with content already present. A destructive dialog must never
 * show a spinner where the consequences should be.
 */
export function usePrefetchDeletionImpact() {
  const queryClient = useQueryClient();
  return useCallback(
    (scheduleId: number) =>
      queryClient.prefetchQuery({
        queryKey: queryKeys.schedules.deletionImpact(scheduleId),
        queryFn: ({ signal }) => apiService.schedules.deletionImpact(scheduleId, signal),
        staleTime: 10_000,
      }),
    [queryClient],
  );
}
```

```ts
// frontend/src/hooks/queries/useReports.ts
import { useQuery } from '@tanstack/react-query';
import { apiService } from '@/api/apiService';
import type { ApiError } from '@/api/http';
import type { Report } from '@/api/types';
import { DEFAULT_PAGE_LIMIT } from '@/api/types';
import { queryKeys } from '../queryKeys';

/** History rail rows. `agent_hours` is ALWAYS [] here — the list serializer
 *  never populates it. A row may render its id, window and timestamp, and
 *  NOTHING derived from hours. Selecting a row hydrates via useReport. */
export type ReportListRow = Omit<Report, 'agent_hours'>;

export function useReports(limit: number = DEFAULT_PAGE_LIMIT) {
  const query = useQuery<Report[], ApiError, ReportListRow[]>({
    queryKey: queryKeys.reports.list(limit),
    queryFn: ({ signal }) => apiService.reports.list({ limit, offset: 0 }, signal),
    // Strip the lying field at the boundary so the type system forbids the
    // mistake downstream rather than relying on a comment.
    select: (reports) => reports.map(({ agent_hours: _drop, ...rest }) => rest),
  });

  return { ...query, hasMore: (query.data?.length ?? 0) === limit };
}

export function useReport(reportId: number | null) {
  return useQuery<Report, ApiError>({
    queryKey: queryKeys.reports.detail(reportId ?? -1),
    queryFn: ({ signal }) => apiService.reports.get(reportId as number, signal),
    enabled: reportId !== null,
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/hooks/ && rm -f src/hooks/queries/.gitkeep`
Expected: PASS — **17 passed** (9 queryClient, 5 useAgents, 3 useSchedules — adjust the count to what the suite actually reports and record it).

- [ ] **Step 6: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/src/hooks/ frontend/src/test/ && git commit -m "feat(frontend): add query keys, explicit TanStack Query retry policy and read hooks"
```

---

### Task 9: `hooks/mutations/` — writes and the invalidation matrix

**Files:**
- Create: `frontend/src/hooks/mutations/{useScheduleMutations,useAssignmentMutations,useReportMutations}.ts`
- Delete: `frontend/src/hooks/mutations/.gitkeep`
- Test: `frontend/src/hooks/mutations/useScheduleMutations.test.tsx`, `frontend/src/hooks/mutations/useAssignmentMutations.test.tsx`, `frontend/src/hooks/mutations/useReportMutations.test.tsx`

**Interfaces:**
- Produces: `useCreateSchedule`, `useUpdateScheduleHours`, `useDeleteSchedule`, `useAssignAgent`, `useUnassignAgent`, `useGenerateReport`.
- Consumes: `api/apiService.ts`, `hooks/queryKeys.ts`.

**Invalidation matrix — implement exactly this:**

| Mutation | Invalidates | Also |
|---|---|---|
| `useCreateSchedule` | `schedules.all` | Seeds `schedules.detail(id)` from the 201 body, so navigating to the new schedule shows it without a second fetch |
| `useUpdateScheduleHours` | `schedules.detail(id)`, `schedules.all` | **On 409, invalidates nothing** — the server state did not change, and a refetch would only flicker |
| `useDeleteSchedule` | `schedules.all`, `agents.all` | `removeQueries(schedules.detail(id))` so a stale deep link cannot render a ghost |
| `useAssignAgent` | `schedules.agents(sid)`, `agents.schedules(agentId)`, `schedules.deletionImpact(sid)` | Never optimistic — a 409 must never show the agent as added first |
| `useUnassignAgent` | same three | Optimistic removal + a 5s undo toast (removal cannot 409) |
| `useGenerateReport` | `reports.list` (all limits) | Seeds `reports.detail(id)` from the 201 body |

**The asymmetry between assign and unassign is deliberate.** An assignment can be rejected by the server with a 409 that the client cannot fully predict (it depends on every *other* schedule the agent is on). Optimistically inserting the row and then yanking it back would show the user something false. A removal cannot conflict, so it is optimistic with an undo.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/hooks/mutations/useAssignmentMutations.test.tsx
import { waitFor } from '@testing-library/react';
import { HttpResponse, http as mswHttp } from 'msw';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '@/hooks/queryKeys';
import { API, errors } from '@/test/handlers';
import { mswServer } from '@/test/mswServer';
import { createTestQueryClient, renderHookWithQuery } from '@/test/renderWithQuery';
import { useAssignAgent, useUnassignAgent } from './useAssignmentMutations';

describe('useAssignAgent', () => {
  it('resolves on a 201 with a null body and invalidates the assignee list', async () => {
    const client = createTestQueryClient();
    client.setQueryData(queryKeys.schedules.agents(1), [{ id: 1, name: 'Alice Chen' }]);

    const { result } = renderHookWithQuery(() => useAssignAgent(1), client);
    result.current.mutate(3);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryState(queryKeys.schedules.agents(1))?.isInvalidated).toBe(true);
  });

  it('does NOT add the agent to the cache when the server returns 409', async () => {
    mswServer.use(
      mswHttp.post(`${API}/schedules/:id/agents`, () =>
        errors.envelope(409, 'conflict', 'agent 3 would have 2 overlapping shift(s)'),
      ),
    );
    const client = createTestQueryClient();
    const existing = [{ id: 1, name: 'Alice Chen' }];
    client.setQueryData(queryKeys.schedules.agents(1), existing);

    const { result } = renderHookWithQuery(() => useAssignAgent(1), client);
    result.current.mutate(3);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.errorCode).toBe('conflict');
    // Nothing false was ever shown.
    expect(client.getQueryData(queryKeys.schedules.agents(1))).toEqual(existing);
  });
});

describe('useUnassignAgent', () => {
  it('removes the row optimistically', async () => {
    const client = createTestQueryClient();
    client.setQueryData(queryKeys.schedules.agents(1), [
      { id: 1, name: 'Alice Chen' },
      { id: 2, name: 'Bob Martinez' },
    ]);

    const { result } = renderHookWithQuery(() => useUnassignAgent(1), client);
    result.current.mutate(2);

    await waitFor(() =>
      expect(client.getQueryData(queryKeys.schedules.agents(1))).toEqual([{ id: 1, name: 'Alice Chen' }]),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('rolls the row back when the request fails', async () => {
    mswServer.use(
      mswHttp.delete(`${API}/schedules/:id/agents/:agentId`, () =>
        errors.envelope(500, 'internal_error', 'boom'),
      ),
    );
    const client = createTestQueryClient();
    const original = [
      { id: 1, name: 'Alice Chen' },
      { id: 2, name: 'Bob Martinez' },
    ];
    client.setQueryData(queryKeys.schedules.agents(1), original);

    const { result } = renderHookWithQuery(() => useUnassignAgent(1), client);
    result.current.mutate(2);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(queryKeys.schedules.agents(1))).toEqual(original);
  });
});
```

```tsx
// frontend/src/hooks/mutations/useScheduleMutations.test.tsx
import { waitFor } from '@testing-library/react';
import { http as mswHttp } from 'msw';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '@/hooks/queryKeys';
import { API, WEEKDAY_CORE, errors } from '@/test/handlers';
import { mswServer } from '@/test/mswServer';
import { createTestQueryClient, renderHookWithQuery } from '@/test/renderWithQuery';
import { useCreateSchedule, useDeleteSchedule, useUpdateScheduleHours } from './useScheduleMutations';

describe('useCreateSchedule', () => {
  it('seeds the detail cache from the 201 body so navigation needs no refetch', async () => {
    const client = createTestQueryClient();
    const { result } = renderHookWithQuery(() => useCreateSchedule(), client);
    result.current.mutate({
      name: 'Weekday Core',
      start_date: '2026-08-01',
      end_date: null,
      shifts: [{ weekday: 0, start_hours: 9, end_hours: 18 }],
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(queryKeys.schedules.detail(1))).toEqual(WEEKDAY_CORE);
  });
});

describe('useUpdateScheduleHours', () => {
  it('invalidates the detail on success', async () => {
    const client = createTestQueryClient();
    client.setQueryData(queryKeys.schedules.detail(1), WEEKDAY_CORE);
    const { result } = renderHookWithQuery(() => useUpdateScheduleHours(1), client);
    result.current.mutate({ shifts: [{ weekday: 0, start_hours: 10, end_hours: 19 }] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryState(queryKeys.schedules.detail(1))?.isInvalidated).toBe(true);
  });

  it('invalidates NOTHING on a 409 - the server state did not change', async () => {
    mswServer.use(
      mswHttp.put(`${API}/schedules/:id`, () => errors.envelope(409, 'conflict', 'overlap')),
    );
    const client = createTestQueryClient();
    client.setQueryData(queryKeys.schedules.detail(1), WEEKDAY_CORE);
    const { result } = renderHookWithQuery(() => useUpdateScheduleHours(1), client);
    result.current.mutate({ shifts: [] });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryState(queryKeys.schedules.detail(1))?.isInvalidated).toBe(false);
  });
});

describe('useDeleteSchedule', () => {
  it('removes the detail query so a stale deep link cannot render a ghost', async () => {
    const client = createTestQueryClient();
    client.setQueryData(queryKeys.schedules.detail(1), WEEKDAY_CORE);
    const { result } = renderHookWithQuery(() => useDeleteSchedule(), client);
    result.current.mutate(1);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(queryKeys.schedules.detail(1))).toBeUndefined();
  });
});
```

```tsx
// frontend/src/hooks/mutations/useReportMutations.test.tsx
import { waitFor } from '@testing-library/react';
import { http as mswHttp } from 'msw';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '@/hooks/queryKeys';
import { API, REPORT } from '@/test/handlers';
import { mswServer } from '@/test/mswServer';
import { createTestQueryClient, renderHookWithQuery } from '@/test/renderWithQuery';
import { useGenerateReport } from './useReportMutations';

describe('useGenerateReport', () => {
  it('seeds the detail cache from the 201 body', async () => {
    const client = createTestQueryClient();
    const { result } = renderHookWithQuery(() => useGenerateReport(), client);
    result.current.mutate({
      ticket_start_at: '2026-08-09T10:00:00+05:30',
      ticket_end_at: '2026-08-12T17:30:00+05:30',
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(queryKeys.reports.detail(14))).toEqual(REPORT);
  });

  it('does not retry - a retry would insert a DUPLICATE report row', async () => {
    let calls = 0;
    mswServer.use(
      mswHttp.post(`${API}/reports`, () => {
        calls += 1;
        return Response.error();
      }),
    );
    const { result } = renderHookWithQuery(() => useGenerateReport());
    result.current.mutate({
      ticket_start_at: '2026-08-09T10:00:00+05:30',
      ticket_end_at: '2026-08-12T17:30:00+05:30',
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/hooks/mutations/`
Expected: FAIL — unresolved imports for all three mutation modules.

- [ ] **Step 3: Write the implementations**

```ts
// frontend/src/hooks/mutations/useScheduleMutations.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService } from '@/api/apiService';
import type { ApiError } from '@/api/http';
import type { Schedule, ScheduleCreateBody, ScheduleUpdateBody } from '@/api/types';
import { queryKeys } from '../queryKeys';

export function useCreateSchedule() {
  const queryClient = useQueryClient();
  return useMutation<Schedule, ApiError, ScheduleCreateBody>({
    mutationFn: (body) => apiService.schedules.create(body),
    onSuccess: (created) => {
      // Seed from the 201 body: navigating to the new schedule must not
      // trigger a second round trip for data we already hold.
      queryClient.setQueryData(queryKeys.schedules.detail(created.id), created);
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all });
    },
  });
}

export function useUpdateScheduleHours(scheduleId: number) {
  const queryClient = useQueryClient();
  return useMutation<Schedule, ApiError, ScheduleUpdateBody>({
    mutationFn: (body) => apiService.schedules.updateHours(scheduleId, body),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.schedules.detail(scheduleId), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedules.detail(scheduleId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all });
    },
    // Note the absence of onError invalidation. A 409 means the write was
    // REJECTED, so the server state is exactly what the cache already holds.
    // Invalidating would refetch identical data and flicker the ribbon while
    // the user is reading the conflict explanation.
  });
}

export function useDeleteSchedule() {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, number>({
    mutationFn: (scheduleId) => apiService.schedules.remove(scheduleId),
    onSuccess: (_data, scheduleId) => {
      // remove, not invalidate: the row is gone, and a refetch would 404.
      queryClient.removeQueries({ queryKey: queryKeys.schedules.detail(scheduleId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all });
      // A deleted schedule changes every affected agent's schedule set.
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
    },
  });
}
```

```ts
// frontend/src/hooks/mutations/useAssignmentMutations.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService } from '@/api/apiService';
import type { ApiError } from '@/api/http';
import type { NamedRef } from '@/api/types';
import { queryKeys } from '../queryKeys';

function invalidateAssignment(
  queryClient: ReturnType<typeof useQueryClient>,
  scheduleId: number,
  agentId: number,
) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.schedules.agents(scheduleId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.agents.schedules(agentId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.schedules.deletionImpact(scheduleId) });
}

/**
 * Deliberately NOT optimistic.
 *
 * The server rejects an assignment with 409 when the agent's OTHER schedules
 * overlap — state this client does not necessarily hold. Showing the agent as
 * added and then removing them would display something false. The row appears
 * only after the server has accepted it.
 */
export function useAssignAgent(scheduleId: number) {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, number>({
    mutationFn: (agentId) => apiService.assignments.add(scheduleId, agentId),
    onSuccess: (_data, agentId) => invalidateAssignment(queryClient, scheduleId, agentId),
  });
}

/**
 * Optimistic, because an unassignment cannot conflict. Paired with a 5s undo
 * toast at the call site; the rollback below covers the transport failing.
 */
export function useUnassignAgent(scheduleId: number) {
  const queryClient = useQueryClient();
  const key = queryKeys.schedules.agents(scheduleId);

  return useMutation<void, ApiError, number, { previous: NamedRef[] | undefined }>({
    mutationFn: (agentId) => apiService.assignments.remove(scheduleId, agentId),
    onMutate: async (agentId) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<NamedRef[]>(key);
      queryClient.setQueryData<NamedRef[]>(key, (rows) => rows?.filter((r) => r.id !== agentId));
      return { previous };
    },
    onError: (_error, _agentId, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: (_data, _error, agentId) => invalidateAssignment(queryClient, scheduleId, agentId),
  });
}
```

```ts
// frontend/src/hooks/mutations/useReportMutations.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService } from '@/api/apiService';
import type { ApiError } from '@/api/http';
import type { Report, ReportGenerateBody } from '@/api/types';
import { queryKeys } from '../queryKeys';

/**
 * POST /api/v1/reports is NOT idempotent — every call inserts a report row.
 * `retry: false` is inherited from createQueryClient()'s mutation defaults and
 * must never be overridden here. A "helpful" retry on a flaky network would
 * silently create duplicate reports the user did not ask for.
 */
export function useGenerateReport() {
  const queryClient = useQueryClient();
  return useMutation<Report, ApiError, ReportGenerateBody>({
    mutationFn: (body) => apiService.reports.generate(body),
    onSuccess: (report) => {
      queryClient.setQueryData(queryKeys.reports.detail(report.id), report);
      void queryClient.invalidateQueries({ queryKey: queryKeys.reports.all });
    },
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/hooks/ && rm -f src/hooks/mutations/.gitkeep`
Expected: PASS — **25 passed** (17 from Task 8, 8 here).

- [ ] **Step 5: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/src/hooks/ && git commit -m "feat(frontend): add schedule, assignment and report mutations with the invalidation matrix"
```

---
### Task 10: The shared error-handling layer

**Files:**
- Create: `frontend/src/helpers/errorPresentation.ts`
- Create: `frontend/src/context/ToastContext.tsx`
- Create: `frontend/src/components/feedback/{ErrorBoundary,ErrorState,InlineAlert,OfflineBanner,ToastViewport}.tsx`
- Create: `frontend/src/hooks/ui/useOnlineStatus.ts`
- Test: `frontend/src/helpers/errorPresentation.test.ts`, `frontend/src/components/feedback/ErrorBoundary.test.tsx`, `frontend/src/components/feedback/ErrorState.test.tsx`

**Interfaces:**
- Produces: `describeError(error) → ErrorPresentation`, `mapFieldErrorsToForm(error, mapPath)`; `ToastProvider` + `useToast()`; `ErrorBoundary`, `ErrorState`, `InlineAlert`, `OfflineBanner`, `ToastViewport`; `useOnlineStatus()`.
- Consumes: `api/http.ts` (type-only import of `ApiError` — permitted, see note), `helpers/`.
- Consumed by: **every** screen from Task 16 onward.

> **Ordering note.** The brief lists "error layer wiring" after the two screens. This plan builds the *layer* here, before the screens, because a screen cannot specify its error states against a layer that does not exist yet — and then **Task 19 is a dedicated end-to-end audit** that wires the boundary at the root and proves every status is handled on both screens. Layer first, audit last.

> **A note on rule R1.** `errorPresentation.ts` lives in `helpers/` and needs the `ApiError` type. Rule R3 forbids helpers importing from `api/`. Resolve this by having `errorPresentation.ts` accept a **structural** input (`{ status, errorCode, message, fieldErrors }`) rather than importing the class — which also makes it trivially testable with plain objects. Do not weaken R3.

**Placement rules — this is the contract every later task follows.**

| Error | Where it appears | Why |
|---|---|---|
| **422 / 400 with field details** | **Inline, on the offending form control**, via `mapFieldErrorsToForm` → RHF `setError`. Focus moves to the first offending field. **Never a toast.** | The user must see which input to change. A toast puts the message as far from the control as the screen allows. |
| **400 without field details** | `InlineAlert` at the top of the form, offending field focused if identifiable | Same reason, less information |
| **409 conflict** | `ConflictPanel` adjacent to the control that caused it, plus a shake, plus `role="alert"`. **Never a toast.** | It needs explanation, not notification. The rejected item is never inserted into the list first. |
| **404 on the primary route resource** | Full-pane `ErrorState` — "This schedule was deleted." + "Back to schedules" | The screen has no subject; there is nothing else to show |
| **404 on a secondary/background query** | Inline empty or error state in that panel only | The rest of the screen is still valid |
| **500** | `ErrorState` in the panel that owns the action, with **Retry** and **Copy details** (the request payload). Never silent. | The user's work must not appear to have vanished |
| **network_error / offline** | Persistent `OfflineBanner` in the header; mutations disabled with a tooltip. A one-off transient failure of a user-initiated action also gets a toast with Retry. | A banner states an ongoing condition; a toast reports an event |
| **timeout** | Toast with Retry | An event, and retrying is genuinely the right next action |
| **Unhandled render error** | Full-page `ErrorBoundary` with Reload | A crashed tree cannot be trusted to render its own inline error |

**Toast is for events the user does not need to act on in place. Everything actionable is inline, next to the thing to act on.** If in doubt, inline.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/helpers/errorPresentation.test.ts
import { describe, expect, it } from 'vitest';
import { describeError, mapFieldErrorsToForm } from './errorPresentation';

const err = (
  status: number,
  errorCode: string,
  message = 'msg',
  fieldErrors: { path: string; message: string }[] = [],
) => ({ status, errorCode, message, fieldErrors });

describe('describeError placement', () => {
  it('places a 422 inline and marks it as having field errors', () => {
    const p = describeError(err(422, 'unprocessable', 'x', [{ path: 'name', message: 'required' }]));
    expect(p.placement).toBe('field');
    expect(p.retryable).toBe(false);
  });

  it('places a 409 inline as a conflict, never as a toast', () => {
    const p = describeError(err(409, 'conflict', 'agent 3 would have 2 overlapping shift(s)'));
    expect(p.placement).toBe('conflict');
    expect(p.title).toMatch(/conflict/i);
  });

  it('places a 404 as a full pane state', () => {
    expect(describeError(err(404, 'not_found')).placement).toBe('pane');
  });

  it('places a 500 as a pane state that offers retry', () => {
    const p = describeError(err(500, 'internal_error'));
    expect(p.placement).toBe('pane');
    expect(p.retryable).toBe(true);
    expect(p.detailCopyable).toBe(true);
  });

  it('places a network failure as a banner', () => {
    expect(describeError(err(0, 'network_error')).placement).toBe('banner');
  });

  it('places a timeout as a toast that offers retry', () => {
    const p = describeError(err(0, 'timeout'));
    expect(p.placement).toBe('toast');
    expect(p.retryable).toBe(true);
  });

  it('never surfaces a raw server message for a 500 - it says "internal server error"', () => {
    const p = describeError(err(500, 'internal_error', 'internal server error'));
    expect(p.title).not.toBe('internal server error');
    expect(p.description).toMatch(/have not been lost|try again/i);
  });

  it('recognises the 500 the backend returns for an unsupported 24-hour shift', () => {
    const p = describeError(err(500, 'internal_error'), { operation: 'save-hours' });
    expect(p.description).toMatch(/midnight|not supported|23:59/i);
  });
});

describe('mapFieldErrorsToForm', () => {
  it('maps a wire path onto the form control that owns it', () => {
    const mapped = mapFieldErrorsToForm(
      err(422, 'unprocessable', 'x', [{ path: 'shifts.0.end_hours', message: 'must be < 24' }]),
      (path) => (path === 'shifts.0.end_hours' ? 'days.0.end' : null),
    );
    expect(mapped).toEqual([{ field: 'days.0.end', message: 'must be < 24' }]);
  });

  it('drops paths the form does not own, so RHF never sets an error on a phantom field', () => {
    const mapped = mapFieldErrorsToForm(
      err(422, 'unprocessable', 'x', [{ path: 'mystery', message: 'no' }]),
      () => null,
    );
    expect(mapped).toEqual([]);
  });

  it('returns nothing when there are no field errors', () => {
    expect(mapFieldErrorsToForm(err(500, 'internal_error'), () => 'x')).toEqual([]);
  });
});
```

```tsx
// frontend/src/components/feedback/ErrorBoundary.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): never {
  throw new Error('render exploded');
}

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeInTheDocument();
  });

  it('catches a render error and offers recovery instead of a white screen', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
    spy.mockRestore();
  });

  it('lets the user retry without a full page reload', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error('once');
      return <p>recovered</p>;
    }
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    shouldThrow = false;
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
    spy.mockRestore();
  });
});
```

```tsx
// frontend/src/components/feedback/ErrorState.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ErrorState } from './ErrorState';

const notFound = { status: 404, errorCode: 'not_found', message: 'schedule 99 not found', fieldErrors: [] };
const serverError = { status: 500, errorCode: 'internal_error', message: 'internal server error', fieldErrors: [] };

describe('ErrorState', () => {
  it('announces itself to assistive technology', () => {
    render(<ErrorState error={notFound} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('offers no retry for a 404 - retrying a deleted resource is pointless', () => {
    render(<ErrorState error={notFound} onRetry={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('offers retry and copy-details for a 500', async () => {
    const onRetry = vi.fn();
    render(<ErrorState error={serverError} onRetry={onRetry} requestPayload={{ shifts: [] }} />);
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /copy details/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/helpers/errorPresentation.test.ts src/components/feedback/`
Expected: FAIL — unresolved imports for `./errorPresentation`, `./ErrorBoundary`, `./ErrorState`.

- [ ] **Step 3: Write `helpers/errorPresentation.ts`**

```ts
// frontend/src/helpers/errorPresentation.ts
/**
 * The single decision point for how an error is shown.
 *
 * Takes a STRUCTURAL shape rather than importing ApiError, so helpers/ stays
 * free of any dependency on api/ (rule R3) and so this is testable with plain
 * objects. Every ApiError satisfies this shape.
 */

export interface ErrorLike {
  readonly status: number;
  readonly errorCode: string;
  readonly message: string;
  readonly fieldErrors?: readonly { path: string; message: string }[];
}

export type ErrorPlacement =
  | 'field' /* inline, on the offending control */
  | 'conflict' /* inline ConflictPanel beside the control */
  | 'inline' /* InlineAlert at the top of the form */
  | 'pane' /* full-panel ErrorState */
  | 'banner' /* persistent header banner */
  | 'toast'; /* transient notification */

export interface ErrorPresentation {
  placement: ErrorPlacement;
  title: string;
  description: string;
  retryable: boolean;
  /** Offer a "Copy details" action carrying the request payload. */
  detailCopyable: boolean;
}

export interface DescribeOptions {
  /** Lets a call site sharpen the copy, e.g. 'save-hours' explains the
   *  24-hour-shift limitation that the generic 500 text cannot. */
  operation?: 'save-hours' | 'create-schedule' | 'assign-agent' | 'generate-report';
}

export function describeError(error: ErrorLike, options: DescribeOptions = {}): ErrorPresentation {
  const hasFieldErrors = (error.fieldErrors?.length ?? 0) > 0;

  switch (error.errorCode) {
    case 'network_error':
      return {
        placement: 'banner',
        title: 'You appear to be offline',
        description:
          'Showing the last loaded data. Changes cannot be saved until the connection returns.',
        retryable: true,
        detailCopyable: false,
      };

    case 'timeout':
      return {
        placement: 'toast',
        title: 'The server took too long to respond',
        description: 'Nothing was changed. Try again.',
        retryable: true,
        detailCopyable: false,
      };

    case 'not_found':
      return {
        placement: 'pane',
        title: 'This item no longer exists',
        description: 'It may have been deleted. Go back and pick another.',
        // Retrying a deleted resource returns the same 404 forever.
        retryable: false,
        detailCopyable: false,
      };

    case 'conflict':
      return {
        placement: 'conflict',
        title: 'Scheduling conflict',
        // The server message names an agent id but is NOT a contract — it is
        // shown as supporting text only, never parsed.
        description: error.message,
        retryable: false,
        detailCopyable: false,
      };

    case 'unprocessable':
    case 'validation_error':
      return {
        placement: hasFieldErrors ? 'field' : 'inline',
        title: 'Some values need fixing',
        description: error.message,
        retryable: false,
        detailCopyable: false,
      };

    case 'internal_error':
    default:
      return {
        placement: 'pane',
        // Never echo "internal server error" at the user — it tells them
        // nothing and reads as a leak.
        title: 'Something went wrong',
        description:
          options.operation === 'save-hours'
            ? 'Your changes have not been lost. Note that a shift ending exactly at midnight, ' +
              'a zero-length shift, or a second window on one day are not supported by the ' +
              'server — use 23:59 for end of day.'
            : 'Your changes have not been lost. Try again, or copy the details and report it.',
        retryable: true,
        detailCopyable: true,
      };
  }
}

/**
 * Turn wire field paths into form field names.
 *
 * `mapPath` is supplied by the form, because only the form knows that the
 * wire's `shifts.0.end_hours` is its `days.0.end` control. Paths the form does
 * not own are dropped rather than guessed — setting an RHF error on a
 * non-existent field silently does nothing and hides the real problem.
 */
export function mapFieldErrorsToForm(
  error: ErrorLike,
  mapPath: (wirePath: string) => string | null,
): { field: string; message: string }[] {
  return (error.fieldErrors ?? [])
    .map((f) => ({ field: mapPath(f.path), message: f.message }))
    .filter((f): f is { field: string; message: string } => f.field !== null);
}
```

- [ ] **Step 4: Write the feedback components and the toast context**

```tsx
// frontend/src/components/feedback/ErrorBoundary.tsx
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * The last line of defence. A render error anywhere below this becomes a
 * legible panel with two ways out, instead of a blank white page.
 *
 * Class component because React still offers no hook equivalent of
 * componentDidCatch.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console -- this is the only place a crash is recorded
    console.error('Unhandled render error', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div
        role="alert"
        className="m-6 rounded-panel border border-line bg-surface p-6 text-body text-ink"
      >
        <h2 className="text-heading">Something went wrong</h2>
        <p className="mt-2 text-ink-2">
          This part of the page failed to render. Your data has not been changed.
        </p>
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={this.reset}
            className="h-8 rounded-control bg-ink px-3 text-invert"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="h-8 rounded-control border border-line px-3"
          >
            Reload the page
          </button>
        </div>
      </div>
    );
  }
}
```

```tsx
// frontend/src/components/feedback/ErrorState.tsx
import { describeError, type ErrorLike } from '@/helpers/errorPresentation';

interface Props {
  error: ErrorLike;
  onRetry?: () => void;
  /** Included in "Copy details" so a bug report carries what was sent. */
  requestPayload?: unknown;
  operation?: Parameters<typeof describeError>[1] extends { operation?: infer O } ? O : never;
}

/** A full-panel failure. Used for 404 on a route's primary resource and for
 *  500s. Never used for a validation error — those go on the control. */
export function ErrorState({ error, onRetry, requestPayload, operation }: Props) {
  const presentation = describeError(error, { operation });

  const copyDetails = () => {
    const details = JSON.stringify(
      { status: error.status, error_code: error.errorCode, message: error.message, requestPayload },
      null,
      2,
    );
    void navigator.clipboard?.writeText(details);
  };

  return (
    <div role="alert" className="flex flex-col items-start gap-3 p-6 text-body">
      <h2 className="text-heading text-ink">{presentation.title}</h2>
      <p className="max-w-prose text-ink-2">{presentation.description}</p>
      <div className="flex gap-3">
        {presentation.retryable && onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="h-8 rounded-control bg-ink px-3 text-invert"
          >
            Retry
          </button>
        ) : null}
        {presentation.detailCopyable ? (
          <button
            type="button"
            onClick={copyDetails}
            className="h-8 rounded-control border border-line px-3 text-ink-2"
          >
            Copy details
          </button>
        ) : null}
      </div>
    </div>
  );
}
```

```tsx
// frontend/src/components/feedback/InlineAlert.tsx
import type { ReactNode } from 'react';

type Tone = 'conflict' | 'impact' | 'info';

const TONE_CLASS: Record<Tone, string> = {
  conflict: 'border-conflict-line bg-conflict-fill text-conflict',
  impact: 'border-impact-line bg-impact-fill text-impact',
  info: 'border-line bg-sunken text-ink-2',
};

/** An inline message attached to a form or a panel. Carries an icon slot as
 *  well as colour, because colour is never the sole signal. */
export function InlineAlert({
  tone = 'info',
  icon,
  children,
}: {
  tone?: Tone;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-control border px-3 py-2 text-body ${TONE_CLASS[tone]}`}
    >
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      <div>{children}</div>
    </div>
  );
}
```

```ts
// frontend/src/hooks/ui/useOnlineStatus.ts
import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/**
 * navigator.onLine only proves the machine has *a* network, not that the API
 * is reachable — so this is a hint, not a verdict. The authoritative offline
 * signal is an ApiError with errorCode 'network_error'. This hook exists to
 * disable mutations pre-emptively rather than to diagnose.
 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true, // assume online during SSR/first paint
  );
}
```

```tsx
// frontend/src/components/feedback/OfflineBanner.tsx
import { useOnlineStatus } from '@/hooks/ui/useOnlineStatus';

/** Persistent, because being offline is an ongoing condition rather than an
 *  event. A toast would scroll away while the condition persisted. */
export function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-impact-line bg-impact-fill px-4 py-1 text-caption text-impact"
    >
      <span aria-hidden="true">⚠</span>
      Offline — showing last loaded data. Changes cannot be saved.
    </div>
  );
}
```

```tsx
// frontend/src/context/ToastContext.tsx
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { toast as sonnerToast } from 'sonner';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastApi {
  success: (message: string, action?: ToastAction) => void;
  error: (message: string, action?: ToastAction) => void;
  info: (message: string, action?: ToastAction) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Cross-cutting UI state, and one of exactly three Contexts in this app. It
 * qualifies because any layer can raise a toast while the viewport lives at
 * the root. It holds NO server data — rule R6 forbids importing api/ or a
 * data hook here, which is what structurally prevents this file growing into
 * a second cache.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const raise = useCallback(
    (kind: 'success' | 'error' | 'info', message: string, action?: ToastAction) => {
      sonnerToast[kind](message, action ? { action: { label: action.label, onClick: action.onClick } } : undefined);
    },
    [],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message, action) => raise('success', message, action),
      error: (message, action) => raise('error', message, action),
      info: (message, action) => raise('info', message, action),
    }),
    [raise],
  );

  return <ToastContext.Provider value={api}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside a ToastProvider');
  return api;
}
```

```tsx
// frontend/src/components/feedback/ToastViewport.tsx
import { Toaster } from 'sonner';

/** Sonner handles the live-region announcement; we only supply placement and
 *  let the theme tokens do the styling. */
export function ToastViewport() {
  return <Toaster position="bottom-right" closeButton toastOptions={{ duration: 5000 }} />;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/helpers/errorPresentation.test.ts src/components/feedback/`
Expected: PASS — **17 passed** (11 errorPresentation, 3 ErrorBoundary, 3 ErrorState).

- [ ] **Step 6: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/src/ && git commit -m "feat(frontend): add the shared error-handling layer with placement rules, error boundary and toast context"
```

---

### Task 11: Design tokens, theme, and `ThemeContext`

**Files:**
- Create: `frontend/src/styles/theme.css`
- Modify: `frontend/src/styles/globals.css`
- Create: `frontend/src/context/ThemeContext.tsx`, `frontend/src/components/layout/ThemeToggle.tsx`
- Create: `frontend/public/fonts/` (self-hosted woff2)
- Test: `frontend/src/context/ThemeContext.test.tsx`, `frontend/src/styles/contrast.test.ts`

**Interfaces:**
- Produces: the `@theme` token set (both themes) that every component class in Tasks 12–18 references; `ThemeProvider`, `useTheme()`, `ThemeToggle`.
- Consumed by: every component. **No component hardcodes a hex value or a font stack.**

**The governing principle: achromatic chrome, chromatic data.** Navigation, panels, buttons, borders, labels and body text are paper and graphite. Colour appears **only** where it encodes meaning — blue is coverage, red is conflict, amber is impact, grey is absence. The consequence is that any colour on screen means something, so the eye goes straight to it. It is also why the primary button is ink-filled rather than blue: if Save were blue, blue would stop meaning "hours".

Two commitments that follow: **no shadows except on things that float** (hairlines separate panels; `--shadow-pop` is reserved for popovers and modals), and **four type sizes** — hierarchy comes from weight, colour and space, not a nine-step scale.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/context/ThemeContext.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeProvider, useTheme } from './ThemeContext';

function Probe() {
  const { theme, setTheme } = useTheme();
  return (
    <>
      <span data-testid="theme">{theme}</span>
      <button type="button" onClick={() => setTheme('dark')}>
        go dark
      </button>
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeContext', () => {
  it('defaults to system', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
  });

  it('stamps data-theme on the root so CSS can win in both directions', async () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'go dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('persists the choice across mounts', async () => {
    const { unmount } = render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'go dark' }));
    unmount();

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
  });

  it('throws outside a provider rather than silently rendering the wrong theme', () => {
    expect(() => render(<Probe />)).toThrow(/ThemeProvider/);
  });
});
```

```ts
// frontend/src/styles/contrast.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Contrast is an acceptance criterion, not an aspiration. This test parses the
 * token values straight out of theme.css and asserts the WCAG 2.2 AA ratios
 * from the design spec, so a "small tweak" to a colour fails the build.
 */
const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

function token(name: string, block: 'light' | 'dark'): string {
  const source =
    block === 'light'
      ? css.slice(0, css.indexOf('/* DARK-TOKENS */'))
      : css.slice(css.indexOf('/* DARK-TOKENS */'));
  const match = new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(source);
  if (!match?.[1]) throw new Error(`token ${name} not found in the ${block} block`);
  return match[1];
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const PAIRS: [string, string, number][] = [
  ['--color-ink', '--color-canvas', 12],
  ['--color-ink-2', '--color-surface', 5.5],
  ['--color-ink-3', '--color-canvas', 4.5],
  ['--color-coverage', '--color-surface', 4.5],
  ['--color-conflict', '--color-conflict-fill', 4.5],
  ['--color-impact', '--color-impact-fill', 4.5],
];

describe.each(['light', 'dark'] as const)('%s theme contrast', (block) => {
  it.each(PAIRS)('%s on %s meets %s:1', (fg, bg, target) => {
    expect(ratio(token(fg, block), token(bg, block))).toBeGreaterThanOrEqual(target);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/context/ThemeContext.test.tsx src/styles/contrast.test.ts`
Expected: FAIL — unresolved `./ThemeContext`, and `ENOENT` for `theme.css`.

- [ ] **Step 3: Write `styles/theme.css`**

```css
/* frontend/src/styles/theme.css */
@import "tailwindcss";

/* ══ Operations Desk ═══════════════════════════════════════════════════════
   Achromatic chrome, chromatic data. Every chromatic token below encodes
   meaning; nothing is decorative. If you are reaching for a colour and cannot
   say what it MEANS, use a neutral.
   ═══════════════════════════════════════════════════════════════════════ */

@theme {
  /* ── neutrals: warm paper over cool graphite ─────────────────────────── */
  --color-canvas:        #F7F6F3;  /* warm paper, not #FFF — cuts glare over an 8h shift */
  --color-surface:       #FFFFFF;
  --color-sunken:        #EFEDE8;
  --color-line:          #E4E1DA;
  --color-line-strong:   #CBC7BD;
  --color-ink:           #15181C;
  --color-ink-2:         #4B5158;
  --color-ink-3:         #63696F;  /* chosen to clear AA on canvas; the obvious #868C94 does NOT */
  --color-invert:        #FBFAF8;

  /* ── semantic: the ONLY chromatic tokens ─────────────────────────────── */
  --color-coverage:      #175E9E;  /* scheduled working hours */
  --color-coverage-fill: #DCEBF7;
  --color-coverage-ghost:#B9D6EC;  /* overnight continuation, read-only */

  --color-conflict:      #A81E17;  /* 409 — a write was rejected */
  --color-conflict-fill: #FCEBE9;
  --color-conflict-line: #F0BDB8;

  --color-impact:        #8A5104;  /* deletion impact / destructive warning */
  --color-impact-fill:   #FDF1DC;
  --color-impact-line:   #EED6A6;

  --color-void:          #63696F;  /* zero hours / no coverage — NOT an error colour */
  --color-void-fill:     #F1EFEA;

  --color-ok:            #1F6B45;
  --color-focus:         #175E9E;

  /* ── type ────────────────────────────────────────────────────────────── */
  --font-display: "Archivo", ui-sans-serif, system-ui, sans-serif;
  --font-sans:    "Instrument Sans", ui-sans-serif, system-ui, sans-serif;
  --font-mono:    "IBM Plex Mono", ui-monospace, monospace;

  --text-display-lg: 1.75rem;  --text-display-lg--line-height: 2rem;
  --text-display:    1.25rem;  --text-display--line-height:    1.625rem;
  --text-heading:    0.9375rem;--text-heading--line-height:    1.25rem;
  --text-body:       0.8125rem;--text-body--line-height:       1.125rem;
  --text-label:      0.6875rem;--text-label--line-height:      0.875rem;
  --text-caption:    0.6875rem;--text-caption--line-height:    0.9375rem;

  /* ── motion: nothing exceeds 220ms ───────────────────────────────────── */
  --ease-out:    cubic-bezier(.16, 1, .3, 1);
  --ease-in-out: cubic-bezier(.4, 0, .2, 1);

  /* ── the ONE shadow. Popovers and modals only. ───────────────────────── */
  --shadow-pop: 0 8px 24px -8px rgb(0 0 0 / .18), 0 0 0 1px var(--color-line);

  --radius-control: 6px;
  --radius-panel:   8px;
  --radius-chip:    4px;
  --radius-bar:     2px;
}

/* DARK-TOKENS
   Same token NAMES, so no component ever knows which theme it is in. The
   viewer's toggle stamps data-theme on the root and must win in both
   directions — hence the explicit [data-theme="light"] guard on the media
   query and the standalone [data-theme="dark"] block. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --color-canvas:        #0C0E11;
    --color-surface:       #14171B;
    --color-sunken:        #0F1216;
    --color-line:          #24282E;
    --color-line-strong:   #363C44;
    --color-ink:           #EBE8E2;
    --color-ink-2:         #A8AEB6;
    --color-ink-3:         #939AA2;
    --color-invert:        #0C0E11;

    --color-coverage:      #6FB6EF;  --color-coverage-fill: #12293C;  --color-coverage-ghost: #1D3D56;
    --color-conflict:      #FF9E90;  --color-conflict-fill: #351714;  --color-conflict-line:  #5B2721;
    --color-impact:        #F5C170;  --color-impact-fill:   #32240C;  --color-impact-line:    #4E3A14;
    --color-void:          #939AA2;  --color-void-fill:     #171A1E;
    --color-ok:            #6BCB98;  --color-focus:         #6FB6EF;

    --shadow-pop: 0 10px 30px -10px rgb(0 0 0 / .6), 0 0 0 1px var(--color-line-strong);
  }
}

:root[data-theme="dark"] {
  --color-canvas:        #0C0E11;
  --color-surface:       #14171B;
  --color-sunken:        #0F1216;
  --color-line:          #24282E;
  --color-line-strong:   #363C44;
  --color-ink:           #EBE8E2;
  --color-ink-2:         #A8AEB6;
  --color-ink-3:         #939AA2;
  --color-invert:        #0C0E11;

  --color-coverage:      #6FB6EF;  --color-coverage-fill: #12293C;  --color-coverage-ghost: #1D3D56;
  --color-conflict:      #FF9E90;  --color-conflict-fill: #351714;  --color-conflict-line:  #5B2721;
  --color-impact:        #F5C170;  --color-impact-fill:   #32240C;  --color-impact-line:    #4E3A14;
  --color-void:          #939AA2;  --color-void-fill:     #171A1E;
  --color-ok:            #6BCB98;  --color-focus:         #6FB6EF;

  --shadow-pop: 0 10px 30px -10px rgb(0 0 0 / .6), 0 0 0 1px var(--color-line-strong);
}

/* The coverage-block geometry, animated without a single React render.
   Set as inline custom properties by a ref in the ribbon's pointer handler;
   @property is what makes them interpolable. */
@property --from { syntax: '<percentage>'; inherits: false; initial-value: 0%; }
@property --to   { syntax: '<percentage>'; inherits: false; initial-value: 0%; }

/* Reduced-motion substitutes are BEHAVIOURAL, not merely faster: the conflict
   shake becomes an outline flash, the skeleton pulse becomes a static tint,
   and share bars render at full width immediately. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
    scroll-behavior: auto !important;
  }
}
```

Update `globals.css` to import the theme and self-host the fonts:

```css
/* frontend/src/styles/globals.css */
@import "./theme.css";

/* Self-hosted so the CSP can stay `font-src 'self'` and so the tool works
   inside a VPN with no internet egress. Subset IBM Plex Mono to the ~20
   glyphs actually used: 0-9 : . - + h m d ( ) % */
@font-face {
  font-family: "Archivo";
  src: url("/fonts/archivo-var.woff2") format("woff2-variations");
  font-weight: 100 900;
  font-display: swap;
}
@font-face {
  font-family: "Instrument Sans";
  src: url("/fonts/instrument-sans-var.woff2") format("woff2-variations");
  font-weight: 400 700;
  font-display: swap;
}
@font-face {
  font-family: "IBM Plex Mono";
  src: url("/fonts/plex-mono-400-subset.woff2") format("woff2");
  font-weight: 400;
  font-display: swap;
}

html, body, #root { height: 100%; }

body {
  margin: 0;
  background: var(--color-canvas);
  color: var(--color-ink);
  font-family: var(--font-sans);
  font-size: var(--text-body);
  -webkit-font-smoothing: antialiased;
}

/* outline, not box-shadow: a ring drawn with box-shadow is clipped by the
   `overflow: hidden` on the ribbon's coverage track. */
:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}

/* Every time and duration is tabular, so a column of 22:30 / 02:30 / 09:05 is
   scanned rather than read. */
.tabular { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
```

Download the three fonts (all OFL) into `frontend/public/fonts/`. If network egress is unavailable at implementation time, the `@font-face` blocks degrade to the declared fallbacks and nothing breaks — but record it as a follow-up rather than deleting the rules.

- [ ] **Step 4: Write `ThemeContext.tsx` and `ThemeToggle.tsx`**

```tsx
// frontend/src/context/ThemeContext.tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark' | 'system';

interface ThemeApi {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeApi | null>(null);
const STORAGE_KEY = 'richpanel.theme';

function readStored(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/** One value, read by many, written by one — which is exactly what Context is
 *  for, and why this is one of only three providers in the app. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStored);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.dataset.theme = theme;
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const api = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={api}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeApi {
  const api = useContext(ThemeContext);
  if (!api) throw new Error('useTheme must be used inside a ThemeProvider');
  return api;
}
```

```tsx
// frontend/src/components/layout/ThemeToggle.tsx
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type Theme } from '@/context/ThemeContext';

const ORDER: Theme[] = ['system', 'light', 'dark'];
const ICON = { system: Monitor, light: Sun, dark: Moon } as const;
const LABEL = { system: 'Match system theme', light: 'Light theme', dark: 'Dark theme' } as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const Icon = ICON[theme];
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] as Theme;

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`${LABEL[theme]}. Switch to ${LABEL[next].toLowerCase()}.`}
      className="grid h-8 w-8 place-items-center rounded-control text-ink-2 hover:bg-sunken hover:text-ink"
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/context/ src/styles/`
Expected: PASS — **16 passed** (4 ThemeContext, 12 contrast: 6 pairs × 2 themes).

If a contrast pair fails, **darken or lighten the token until it passes — do not lower the target.** These are AA minimums, and the whole point of asserting them in CI is that they cannot be quietly negotiated away.

- [ ] **Step 6: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/src/ frontend/public/ && git commit -m "feat(frontend): add Operations Desk design tokens, dark theme and contrast assertions"
```

---
### Task 12: `components/ui/` — the primitives

**Files:**
- Create: `frontend/src/components/ui/{Button,IconButton,Field,TextField,Switch,Chip,Badge,Skeleton,EmptyState,VisuallyHidden}.tsx`
- Delete: `frontend/src/components/ui/.gitkeep`
- Test: `frontend/src/components/ui/primitives.test.tsx`

**Interfaces:**
- Produces: the styled primitives every screen composes from. All are **leaves** — no data, no hooks beyond `hooks/ui/**`.
- Consumes: React Aria Components, the Task 11 tokens.

**Explicitly rejected: adopting shadcn/ui's component set wholesale.** Copying a generated component library in is precisely the origin of the generic admin-panel look this design is avoiding. Primitives come from RAC; the styling comes from our own tokens.

Every primitive obeys: **32px default control height** (28px compact), **hairline borders not shadows**, `rounded-control`, and a **visible label** — a placeholder is never the only label.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/ui/primitives.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Badge } from './Badge';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { Skeleton } from './Skeleton';
import { Switch } from './Switch';
import { TextField } from './TextField';
import { VisuallyHidden } from './VisuallyHidden';

describe('Button', () => {
  it('is a real button and fires', async () => {
    const onPress = vi.fn();
    render(<Button onPress={onPress}>Save hours</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Save hours' }));
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('does not fire while disabled', async () => {
    const onPress = vi.fn();
    render(
      <Button onPress={onPress} isDisabled>
        Save hours
      </Button>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('exposes a busy state to assistive tech instead of only spinning', () => {
    render(<Button isPending>Save hours</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
  });
});

describe('TextField', () => {
  it('has a VISIBLE label wired to the input, not a placeholder standing in for one', () => {
    render(<TextField label="Schedule name" value="" onChange={vi.fn()} />);
    const input = screen.getByLabelText('Schedule name');
    expect(input).toBeInTheDocument();
    expect(screen.getByText('Schedule name')).toBeVisible();
  });

  it('links an error message via aria-describedby and marks the field invalid', () => {
    render(<TextField label="Schedule name" value="" onChange={vi.fn()} errorMessage="Required" />);
    const input = screen.getByLabelText('Schedule name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Required')).toBeInTheDocument();
  });
});

describe('Switch', () => {
  it('toggles by keyboard', async () => {
    const onChange = vi.fn();
    render(<Switch isSelected={false} onChange={onChange} aria-label="Monday working" />);
    await userEvent.tab();
    await userEvent.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('EmptyState', () => {
  it('explains and offers an action rather than just saying "no data"', () => {
    render(
      <EmptyState
        title="No schedules yet"
        description="A schedule defines the working hours that resolution time is measured against."
        action={<Button>Create schedule</Button>}
      />,
    );
    expect(screen.getByText(/measured against/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create schedule' })).toBeInTheDocument();
  });
});

describe('Skeleton', () => {
  it('is hidden from assistive tech - a screen reader must not read placeholder boxes', () => {
    const { container } = render(<Skeleton height={40} />);
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('Badge and VisuallyHidden', () => {
  it('renders a badge label', () => {
    render(<Badge tone="conflict">Conflict</Badge>);
    expect(screen.getByText('Conflict')).toBeInTheDocument();
  });

  it('keeps visually hidden text in the accessibility tree', () => {
    render(<VisuallyHidden>Monday, working 22:00 to 06:00 the next day.</VisuallyHidden>);
    expect(screen.getByText(/22:00 to 06:00/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/components/ui/`
Expected: FAIL — unresolved imports for every primitive.

- [ ] **Step 3: Write the primitives**

```tsx
// frontend/src/components/ui/Button.tsx
import { Button as AriaButton, type ButtonProps } from 'react-aria-components';

type Variant = 'primary' | 'secondary' | 'ghost' | 'destructive';

interface Props extends ButtonProps {
  variant?: Variant;
  compact?: boolean;
  isPending?: boolean;
}

/**
 * The primary button is ink-filled, NOT blue. In light that renders near-black
 * on paper; in dark, paper on near-black — one rule, two correct results. It
 * also keeps blue meaning "coverage" and nothing else.
 */
const VARIANT: Record<Variant, string> = {
  primary: 'bg-ink text-invert hover:opacity-90',
  secondary: 'border border-line-strong bg-surface text-ink hover:bg-sunken',
  ghost: 'text-ink-2 hover:bg-sunken hover:text-ink',
  // Bordered rather than a saturated red block: it must not read as the
  // page's primary action.
  destructive: 'border border-conflict-line bg-surface text-conflict hover:bg-conflict-fill',
};

export function Button({ variant = 'secondary', compact, isPending, className, ...props }: Props) {
  return (
    <AriaButton
      {...props}
      aria-busy={isPending || undefined}
      isDisabled={props.isDisabled || isPending}
      className={[
        compact ? 'h-7' : 'h-8',
        'inline-flex items-center gap-2 rounded-control px-3 text-body font-medium',
        'transition-[background-color,opacity,transform] duration-100',
        // Press is a 0.5px nudge, never a scale — a scaling button in a dense
        // table reads as a wobble.
        'pressed:translate-y-[0.5px]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANT[variant],
        className ?? '',
      ].join(' ')}
    />
  );
}
```

```tsx
// frontend/src/components/ui/IconButton.tsx
import type { ReactNode } from 'react';
import { Button as AriaButton, type ButtonProps } from 'react-aria-components';

interface Props extends Omit<ButtonProps, 'children'> {
  /** Required. An icon-only control with no label is invisible to a screen
   *  reader, so this is not optional and has no default. */
  label: string;
  icon: ReactNode;
}

export function IconButton({ label, icon, className, ...props }: Props) {
  return (
    <AriaButton
      {...props}
      aria-label={label}
      className={`grid h-8 w-8 place-items-center rounded-control text-ink-2 hover:bg-sunken hover:text-ink disabled:opacity-50 ${className ?? ''}`}
    >
      <span aria-hidden="true">{icon}</span>
    </AriaButton>
  );
}
```

```tsx
// frontend/src/components/ui/Field.tsx
import type { ReactNode } from 'react';

/** The shared label / control / message frame. Every field in the app uses it,
 *  so the vertical rhythm and the error slot are identical everywhere. */
export function Field({
  label,
  description,
  errorMessage,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  errorMessage?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-label uppercase tracking-[0.06em] text-ink-2">{label}</span>
      {children}
      {errorMessage ? (
        <span className="text-caption text-conflict">{errorMessage}</span>
      ) : description ? (
        <span className="text-caption text-ink-3">{description}</span>
      ) : null}
    </div>
  );
}
```

```tsx
// frontend/src/components/ui/TextField.tsx
import {
  FieldError,
  Input,
  Label,
  Text,
  TextField as AriaTextField,
  type TextFieldProps,
} from 'react-aria-components';
import type { ReactNode } from 'react';

interface Props extends Omit<TextFieldProps, 'children'> {
  label: string;
  description?: ReactNode;
  errorMessage?: ReactNode;
  placeholder?: string;
}

export function TextField({ label, description, errorMessage, placeholder, ...props }: Props) {
  return (
    <AriaTextField {...props} isInvalid={Boolean(errorMessage)} className="flex flex-col gap-1">
      {/* Visible, always. A placeholder is never the only label. */}
      <Label className="text-label uppercase tracking-[0.06em] text-ink-2">{label}</Label>
      <Input
        placeholder={placeholder}
        className="h-8 rounded-control border border-line-strong bg-surface px-2 text-body text-ink
                   focus:outline-2 focus:outline-focus focus:outline-offset-2
                   invalid:border-conflict"
      />
      {errorMessage ? (
        <FieldError className="text-caption text-conflict">{errorMessage}</FieldError>
      ) : description ? (
        <Text slot="description" className="text-caption text-ink-3">
          {description}
        </Text>
      ) : null}
    </AriaTextField>
  );
}
```

```tsx
// frontend/src/components/ui/Switch.tsx
import { Switch as AriaSwitch, type SwitchProps } from 'react-aria-components';
import type { ReactNode } from 'react';

export function Switch({ children, ...props }: SwitchProps & { children?: ReactNode }) {
  return (
    <AriaSwitch {...props} className="group flex items-center gap-2 text-body text-ink">
      <span
        aria-hidden="true"
        className="h-4 w-7 rounded-full bg-line-strong p-0.5 transition-colors duration-100
                   group-selected:bg-coverage"
      >
        <span className="block h-3 w-3 rounded-full bg-surface transition-transform duration-100 group-selected:translate-x-3" />
      </span>
      {children}
    </AriaSwitch>
  );
}
```

```tsx
// frontend/src/components/ui/Chip.tsx
import type { ReactNode } from 'react';

/** A small status marker. `⟳ +1 day` on an overnight shift is the one that
 *  matters most — it is a STATUS, not a toggle, because `end <= start` is
 *  definitionally overnight in this backend and there is nothing to switch. */
export function Chip({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-chip bg-coverage-fill px-1.5 py-0.5 text-caption text-coverage">
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      {children}
    </span>
  );
}
```

```tsx
// frontend/src/components/ui/Badge.tsx
import type { ReactNode } from 'react';

type Tone = 'neutral' | 'coverage' | 'conflict' | 'impact' | 'void';

const TONE: Record<Tone, string> = {
  neutral: 'bg-sunken text-ink-2',
  coverage: 'bg-coverage-fill text-coverage',
  conflict: 'bg-conflict-fill text-conflict',
  impact: 'bg-impact-fill text-impact',
  void: 'bg-void-fill text-void',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-chip px-1.5 py-0.5 text-label uppercase tracking-[0.06em] ${TONE[tone]}`}>
      {children}
    </span>
  );
}
```

```tsx
// frontend/src/components/ui/Skeleton.tsx
/**
 * Matches its final element's EXACT height, so a state transition moves
 * nothing (CLS = 0). The pulse is a low-amplitude breath, not a shimmer
 * sweep — a sweeping gradient across 24 rows is a distraction, not feedback.
 */
export function Skeleton({ height, width = '100%' }: { height: number; width?: number | string }) {
  return (
    <div
      aria-hidden="true"
      style={{ height, width }}
      className="animate-pulse rounded-bar bg-sunken"
    />
  );
}
```

```tsx
// frontend/src/components/ui/EmptyState.tsx
import type { ReactNode } from 'react';

/** Empty states EXPLAIN and offer the next action. "No data" is not an empty
 *  state, it is a shrug. */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 p-6">
      <h3 className="text-heading text-ink">{title}</h3>
      {description ? <p className="max-w-prose text-body text-ink-2">{description}</p> : null}
      {action}
    </div>
  );
}
```

```tsx
// frontend/src/components/ui/VisuallyHidden.tsx
import type { ReactNode } from 'react';

/** Present to a screen reader, absent to the eye. Used heavily by the week
 *  ribbon, whose visual track is aria-hidden because it renders data already
 *  present in the fields. */
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return (
    <span className="absolute h-px w-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]">
      {children}
    </span>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/components/ui/ && rm -f src/components/ui/.gitkeep`
Expected: PASS — **10 passed**.

- [ ] **Step 5: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/src/components/ && git commit -m "feat(frontend): add UI primitives built on React Aria Components"
```

---

### Task 13: Router, `AppShell`, `Header` — and the app root

**Files:**
- Create: `frontend/src/routes/{router,__root,schedules,reports}.tsx`
- Create: `frontend/src/components/layout/{AppShell,Header,NavTabs,IstClock}.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/main.tsx`
- Delete: `frontend/src/components/layout/.gitkeep`, `frontend/src/routes/.gitkeep`
- Test: `frontend/src/routes/router.test.tsx`, `frontend/src/components/layout/Header.test.tsx`

**Interfaces:**
- Produces: the route tree with typed search params on `/reports`; `AppShell`; the composed `App` (ErrorBoundary → ThemeProvider → QueryClientProvider → ToastProvider → RouterProvider).
- **This is the task gated on decision F1/F2.** Confirm the framework and router choice before starting it.

**Why the report window lives in the URL.** `/reports?from=2026-08-09T10:00:00%2B05:30&to=…&reportId=14` makes a computed report shareable, back-button-correct, and survivable across a reload. TanStack Router validates and types those params at the route boundary with `validateSearch`, so a malformed `?from=` becomes a redirect rather than an `Invalid Date` deep inside a component.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/routes/router.test.tsx
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { withQuery } from '@/test/renderWithQuery';
import { createAppRouter } from './router';

function renderAt(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const Wrapper = withQuery();
  render(
    <Wrapper>
      <RouterProvider router={router} />
    </Wrapper>,
  );
  return router;
}

describe('routing', () => {
  it('redirects the index to /schedules', async () => {
    const router = renderAt('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/schedules'));
  });

  it('renders the reports route', async () => {
    renderAt('/reports');
    await waitFor(() => expect(screen.getByRole('heading', { name: /resolution time/i })).toBeInTheDocument());
  });

  it('parses a valid ticket window out of the search params', async () => {
    const router = renderAt('/reports?from=2026-08-09T10:00:00%2B05:30&to=2026-08-12T17:30:00%2B05:30');
    await waitFor(() => expect(router.state.location.search).toMatchObject({ from: expect.any(String) }));
  });

  it('drops a malformed window instead of crashing the screen', async () => {
    const router = renderAt('/reports?from=not-a-date');
    await waitFor(() => expect(router.state.location.search.from).toBeUndefined());
  });

  it('renders a 404 page for an unknown path', async () => {
    renderAt('/nope');
    await waitFor(() => expect(screen.getByText(/page not found/i)).toBeInTheDocument());
  });
});
```

```tsx
// frontend/src/components/layout/Header.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThemeProvider } from '@/context/ThemeContext';
import { IstClock } from './IstClock';

describe('IstClock', () => {
  it('states the timezone explicitly - there is no timezone picker anywhere', () => {
    render(
      <ThemeProvider>
        <IstClock />
      </ThemeProvider>,
    );
    expect(screen.getByText(/IST/)).toBeInTheDocument();
  });

  it('exposes the time as a machine-readable time element', () => {
    render(
      <ThemeProvider>
        <IstClock />
      </ThemeProvider>,
    );
    expect(screen.getByRole('time')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/routes/ src/components/layout/`
Expected: FAIL — unresolved `./router` and `./IstClock`.

- [ ] **Step 3: Write the layout components**

```tsx
// frontend/src/components/layout/IstClock.tsx
import { useEffect, useState } from 'react';
import { istNow } from '@/helpers/dates';
import { weekdayShortLabel } from '@/helpers/weekday';

/**
 * A standing reminder that every time in this product is IST. The backend
 * pins Asia/Kolkata as a hard constant and there is no timezone picker; this
 * is how the user finds that out without reading documentation.
 */
export function IstClock() {
  const [now, setNow] = useState(() => istNow());

  useEffect(() => {
    const timer = setInterval(() => setNow(istNow()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const hh = String(now.hour).padStart(2, '0');
  const mm = String(now.minute).padStart(2, '0');
  // @internationalized/date exposes 1 = Monday for its own day-of-week, so
  // convert to our 0 = Monday convention.
  const weekday = (now.toDate().getDay() + 6) % 7;

  return (
    <span className="flex items-center gap-1.5 text-caption text-ink-3">
      IST
      <time role="time" dateTime={now.toString()} className="tabular text-ink-2">
        {hh}:{mm}
      </time>
      <span>{weekdayShortLabel(weekday)}</span>
    </span>
  );
}
```

```tsx
// frontend/src/components/layout/NavTabs.tsx
import { Link } from '@tanstack/react-router';

const TABS = [
  { to: '/schedules', label: 'Schedules' },
  { to: '/reports', label: 'Reports' },
] as const;

export function NavTabs() {
  return (
    <nav aria-label="Main">
      <ul className="flex items-center gap-1">
        {TABS.map((tab) => (
          <li key={tab.to}>
            <Link
              to={tab.to}
              className="rounded-control px-2.5 py-1 text-body text-ink-2 hover:bg-sunken hover:text-ink
                         [&.active]:bg-sunken [&.active]:text-ink [&.active]:font-medium"
              activeProps={{ className: 'active', 'aria-current': 'page' }}
            >
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

```tsx
// frontend/src/components/layout/Header.tsx
import { IstClock } from './IstClock';
import { NavTabs } from './NavTabs';
import { ThemeToggle } from './ThemeToggle';

export function Header() {
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-6 border-b border-line bg-surface px-4">
      <span className="font-display text-body font-semibold uppercase tracking-[0.06em] text-ink">
        Richpanel Ops
      </span>
      <NavTabs />
      <div className="ml-auto flex items-center gap-3">
        <IstClock />
        <ThemeToggle />
      </div>
    </header>
  );
}
```

```tsx
// frontend/src/components/layout/AppShell.tsx
import type { ReactNode } from 'react';
import { OfflineBanner } from '@/components/feedback/OfflineBanner';
import { Header } from './Header';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <OfflineBanner />
      <Header />
      <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
```

- [ ] **Step 4: Write the route tree and the app root**

```tsx
// frontend/src/routes/__root.tsx
import { Outlet, createRootRoute } from '@tanstack/react-router';
import { AppShell } from '@/components/layout/AppShell';
import { EmptyState } from '@/components/ui/EmptyState';

export const rootRoute = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
  notFoundComponent: () => (
    <EmptyState title="Page not found" description="That address does not match a screen in this tool." />
  ),
});
```

```tsx
// frontend/src/routes/schedules.tsx
import { createRoute } from '@tanstack/react-router';
import { SchedulesPage } from '@/pages/schedules/SchedulesPage';
import { rootRoute } from './__root';

export const schedulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/schedules',
  component: SchedulesPage,
});

export const scheduleDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/schedules/$scheduleId',
  parseParams: (params) => ({ scheduleId: Number(params.scheduleId) }),
  stringifyParams: (params) => ({ scheduleId: String(params.scheduleId) }),
  component: SchedulesPage,
});
```

```tsx
// frontend/src/routes/reports.tsx
import { createRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ReportPage } from '@/pages/reports/ReportPage';
import { rootRoute } from './__root';

/**
 * The ticket window lives in the URL so a computed report is shareable and
 * survives a reload. Validating HERE means a malformed `?from=` never reaches
 * a component as an Invalid Date — the route simply drops it and the screen
 * renders its idle state.
 */
const isoDateTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'not a datetime');

const reportSearchSchema = z.object({
  from: isoDateTime.optional().catch(undefined),
  to: isoDateTime.optional().catch(undefined),
  reportId: z.coerce.number().int().positive().optional().catch(undefined),
});

export type ReportSearch = z.infer<typeof reportSearchSchema>;

export const reportsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reports',
  validateSearch: (search) => reportSearchSchema.parse(search),
  component: ReportPage,
});
```

```tsx
// frontend/src/routes/router.tsx
import {
  createRouter,
  createRoute,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { rootRoute } from './__root';
import { reportsRoute } from './reports';
import { scheduleDetailRoute, schedulesRoute } from './schedules';

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/schedules' });
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  schedulesRoute,
  scheduleDetailRoute,
  reportsRoute,
]);

/** `history` is injectable so tests can drive a memory history. */
export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, ...(history ? { history } : {}) });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
```

```tsx
// frontend/src/App.tsx  — replace wholesale
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useState } from 'react';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';
import { ToastViewport } from '@/components/feedback/ToastViewport';
import { ToastProvider } from '@/context/ToastContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { createQueryClient } from '@/hooks/queryClient';
import { createAppRouter } from '@/routes/router';

/**
 * Provider order is deliberate:
 *   ErrorBoundary outermost, so a crash in ANY provider below still renders a
 *   legible page rather than a white screen.
 *   ThemeProvider before anything that renders, so the first paint is correct.
 *   QueryClientProvider before ToastProvider, because a mutation raises toasts.
 */
export default function App() {
  // useState, not a module constant: a fresh client per mount keeps tests
  // isolated and avoids a cache shared across hot reloads.
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(() => createAppRouter());

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <RouterProvider router={router} />
            <ToastViewport />
          </ToastProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
```

Create minimal page stubs so the router compiles — Tasks 17 and 18 fill them in:

```tsx
// frontend/src/pages/schedules/SchedulesPage.tsx
export function SchedulesPage() {
  return <h1 className="p-6 font-display text-display">Schedules</h1>;
}
```

```tsx
// frontend/src/pages/reports/ReportPage.tsx
export function ReportPage() {
  return <h1 className="p-6 font-display text-display">Resolution Time Report</h1>;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
cd /Users/tanishq/Desktop/Richpanel/frontend && \
npx vitest run src/routes/ src/components/layout/ && \
rm -f src/components/layout/.gitkeep src/routes/.gitkeep
```
Expected: PASS — **7 passed** (5 routing, 2 IstClock).

- [ ] **Step 6: Verify the real app boots**

Run:
```bash
cd /Users/tanishq/Desktop/Richpanel/frontend && npm run build && \
(npm run dev &) && sleep 4 && curl -sS http://localhost:5173/ | grep -q '<div id="root"' && echo OK && pkill -f vite || true
```
Expected: build succeeds; `OK` printed.

- [ ] **Step 7: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/src/ && git commit -m "feat(frontend): add the router with typed report search params, app shell and composed providers"
```

---
### Task 14: `components/datetime/` — the real calendar and clock pickers

**Files:**
- Create: `frontend/src/components/datetime/{DateField,DatePicker,DateRangePicker,TimeField,TimePicker,CalendarPanel.lazy}.tsx`
- Delete: `frontend/src/components/datetime/.gitkeep`
- Test: `frontend/src/components/datetime/TimePicker.test.tsx`, `frontend/src/components/datetime/DatePicker.test.tsx`

**Interfaces:**
- Produces: `DateField`, `DatePicker`, `DateRangePicker`, `TimeField`, `TimePicker`.
- Consumes: `react-aria-components`, `@internationalized/date`, `helpers/time.ts`.
- Consumed by: `CreateScheduleDialog` (schedule effective range), the Week Ribbon (14 × `TimePicker` for shift start/end), `TicketWindowBar` (report ticket dates and times).

**Native `<input type="date|time">` is excluded**, and this is not a style preference: native controls render differently in every browser, cannot be styled to the token set, offer no range mode, and their mobile pickers are inconsistent. **Bare text inputs are also excluded** — they push parsing and a11y onto us.

**Where each is used**

| Field | Component | Note |
|---|---|---|
| Schedule `start_date` / `end_date` | `DateRangePicker` | One control, two segmented fields, one two-month calendar. `end_date` is nullable → an "Open-ended" toggle clears and disables the end segment. Enforces `end >= start` client-side, which pre-empts the DB `CheckConstraint` 500. |
| Report ticket start/end **date** | `DatePicker` ×2 | Separate controls, not a range, because each pairs with its own time field; a range picker would split one datetime across two visually distant controls. |
| Report ticket start/end **time** | `TimePicker` ×2 | |
| Weekday shift `start_hours` / `end_hours` | `TimePicker` ×14 | |

**Granularity (F5).** The field accepts **any** minute — `09:07` must be enterable if that is genuinely the shift. Arrow keys step the hour by 1 and the minute by 5. The popover offers **15-minute** options, which covers essentially every real support-rota boundary. The 5- and 15-minute steps are conveniences, never constraints.

**Constraints the picker enforces, all from §0.4:**
- `00:00` is **never selectable as an end value** when a start is set. The list ends at `23:45`; typing `00:00` is rejected inline with *"A shift ending exactly at midnight isn't supported. Use 23:59 for end of day."*
- `end === start` is rejected inline: *"Start and end must be different."*
- `24:00` is not representable at all; the maximum is `23:59`.

**Accessibility requirements — these are acceptance criteria, not nice-to-haves:**
- Every segment is individually labelled and announced ("hour, 22", "minute, 30"). RAC does this; **do not override `aria-label` on segments.**
- The calendar popover is `role="dialog"`; the grid is `role="grid"` with `role="gridcell"` days and `aria-selected`. `PageUp`/`PageDown` change month, `Shift+PageUp/Down` change year, `Esc` closes and returns focus to the trigger.
- Invalid input sets `aria-invalid` on the group and links a `role="alert"` message via `aria-describedby`.
- Every field has a **visible** label. Trigger buttons are labelled "Choose date" / "Choose time", not an icon alone.
- The selected day uses `--color-ink` fill with `--color-invert` text; **today is marked with a ring AND a dot**, never colour alone.

**Bundle cost, stated plainly:** ~48 KB gz for the RAC subset. The calendar is the heaviest part, so `CalendarPanel.lazy.tsx` is a dynamic-import boundary loaded on first popover open and **prefetched on field focus**, so the cold-chunk delay is spent while the user is still typing.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/components/datetime/TimePicker.test.tsx
import { Time } from '@internationalized/date';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TimePicker } from './TimePicker';

describe('TimePicker field', () => {
  it('has a visible label and individually labelled segments', () => {
    render(<TimePicker label="Monday start time" value={new Time(9, 0)} onChange={vi.fn()} />);
    expect(screen.getByText('Monday start time')).toBeVisible();
    expect(screen.getByRole('spinbutton', { name: /hour/i })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: /minute/i })).toBeInTheDocument();
  });

  it('renders 24-hour with a leading zero and no AM/PM segment', () => {
    render(<TimePicker label="Start" value={new Time(9, 5)} onChange={vi.fn()} />);
    expect(screen.getByRole('spinbutton', { name: /hour/i })).toHaveTextContent('09');
    expect(screen.queryByRole('spinbutton', { name: /day period|AM\/PM/i })).not.toBeInTheDocument();
  });

  it('steps the minute by 5 on arrow up, but accepts any typed minute', async () => {
    const onChange = vi.fn();
    render(<TimePicker label="Start" value={new Time(9, 0)} onChange={onChange} />);
    const minute = screen.getByRole('spinbutton', { name: /minute/i });
    minute.focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ minute: 5 }));

    onChange.mockClear();
    await userEvent.keyboard('07');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ minute: 7 }));
  });

  it('opens a 15-minute option list from the trigger', async () => {
    render(<TimePicker label="Start" value={new Time(9, 0)} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /choose time/i }));
    expect(await screen.findByRole('option', { name: '09:15' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '09:07' })).not.toBeInTheDocument();
  });
});

describe('TimePicker end-value constraints', () => {
  it('never offers 00:00 as an end value, because the backend 500s on it', async () => {
    render(<TimePicker label="End" role="end" value={new Time(18, 0)} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /choose time/i }));
    expect(screen.queryByRole('option', { name: '00:00' })).not.toBeInTheDocument();
    expect(await screen.findByRole('option', { name: /23:45/ })).toBeInTheDocument();
  });

  it('explains the midnight limitation rather than failing silently', () => {
    render(<TimePicker label="End" role="end" value={new Time(0, 0)} onChange={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/midnight isn't supported.*23:59/i);
  });

  it('marks the group invalid so assistive tech hears it too', () => {
    render(<TimePicker label="End" role="end" value={new Time(0, 0)} onChange={vi.fn()} />);
    expect(screen.getByRole('group', { name: /End/ })).toHaveAttribute('aria-invalid', 'true');
  });

  it('surfaces an externally supplied error, e.g. equal start and end', () => {
    render(
      <TimePicker
        label="End"
        role="end"
        value={new Time(9, 0)}
        onChange={vi.fn()}
        errorMessage="Start and end must be different."
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Start and end must be different.');
  });
});
```

```tsx
// frontend/src/components/datetime/DatePicker.test.tsx
import { CalendarDate } from '@internationalized/date';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DatePicker } from './DatePicker';
import { DateRangePicker } from './DateRangePicker';

describe('DatePicker', () => {
  it('has a visible label and a labelled trigger, not a bare icon', () => {
    render(<DatePicker label="Ticket start date" value={new CalendarDate(2026, 8, 9)} onChange={vi.fn()} />);
    expect(screen.getByText('Ticket start date')).toBeVisible();
    expect(screen.getByRole('button', { name: /choose date/i })).toBeInTheDocument();
  });

  it('opens a keyboard-navigable calendar grid', async () => {
    render(<DatePicker label="Ticket start date" value={new CalendarDate(2026, 8, 9)} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /choose date/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('grid')).toBeInTheDocument();
  });
});

describe('DateRangePicker', () => {
  it('supports an open-ended range, matching end_date being nullable', async () => {
    const onChange = vi.fn();
    render(
      <DateRangePicker
        label="Effective range"
        value={{ start: new CalendarDate(2026, 8, 1), end: new CalendarDate(2026, 12, 31) }}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('switch', { name: /open-ended/i }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ end: null }));
  });

  it('rejects an end before the start, pre-empting the backend 500', () => {
    render(
      <DateRangePicker
        label="Effective range"
        value={{ start: new CalendarDate(2026, 8, 10), end: new CalendarDate(2026, 8, 1) }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/end date must be on or after the start/i);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/components/datetime/`
Expected: FAIL — unresolved `./TimePicker`, `./DatePicker`, `./DateRangePicker`.

- [ ] **Step 3: Write `TimeField.tsx` and `TimePicker.tsx`**

```tsx
// frontend/src/components/datetime/TimeField.tsx
import type { Time } from '@internationalized/date';
import {
  DateInput,
  DateSegment,
  Label,
  TimeField as AriaTimeField,
} from 'react-aria-components';

interface Props {
  label: string;
  value: Time | null;
  onChange: (value: Time | null) => void;
  isInvalid?: boolean;
  isDisabled?: boolean;
  'aria-describedby'?: string;
}

/**
 * A segmented HH:MM control, 24-hour, always IST.
 *
 * `granularity="minute"` + `hourCycle={24}` + `shouldForceLeadingZeros` gives
 * exactly two segments and no AM/PM. RAC labels and announces each segment
 * ("hour, 22" / "minute, 30") — do NOT override aria-label on them, that is
 * the whole reason this library was chosen.
 */
export function TimeField({ label, value, onChange, isInvalid, isDisabled, ...rest }: Props) {
  return (
    <AriaTimeField
      aria-label={label}
      value={value}
      onChange={onChange}
      granularity="minute"
      hourCycle={24}
      shouldForceLeadingZeros
      isInvalid={isInvalid}
      isDisabled={isDisabled}
      aria-describedby={rest['aria-describedby']}
      className="flex flex-col gap-1"
    >
      <Label className="sr-only">{label}</Label>
      <DateInput
        className={`flex h-8 w-[72px] items-center rounded-control border bg-surface px-2
                    text-body tabular text-ink
                    focus-within:outline-2 focus-within:outline-focus focus-within:outline-offset-2
                    ${isInvalid ? 'border-conflict' : 'border-line-strong'}`}
      >
        {(segment) => (
          <DateSegment
            segment={segment}
            className="rounded-[2px] px-0.5 outline-none
                       focus:bg-ink focus:text-invert
                       data-[placeholder]:text-ink-3"
          />
        )}
      </DateInput>
    </AriaTimeField>
  );
}
```

```tsx
// frontend/src/components/datetime/TimePicker.tsx
import { Time } from '@internationalized/date';
import { Clock } from 'lucide-react';
import { useId, useMemo } from 'react';
import { Button, Dialog, ListBox, ListBoxItem, Popover } from 'react-aria-components';
import { TimeField } from './TimeField';

interface Props {
  label: string;
  value: Time | null;
  onChange: (value: Time | null) => void;
  /** 'end' applies the backend's end-value constraints (see below). */
  role?: 'start' | 'end';
  isDisabled?: boolean;
  errorMessage?: string;
}

const MIDNIGHT_MESSAGE =
  "A shift ending exactly at midnight isn't supported. Use 23:59 for end of day.";

/** 15-minute options. For an END field the list stops at 23:45 and never
 *  offers 00:00 — the backend 500s on a 00:00 end value. */
function buildOptions(role: 'start' | 'end'): Time[] {
  const options: Time[] = [];
  for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
    if (role === 'end' && minutes === 0) continue;
    options.push(new Time(Math.floor(minutes / 60), minutes % 60));
  }
  return options;
}

function label(time: Time): string {
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}

/**
 * TimeField + a popover of 15-minute options.
 *
 * Mouse users pick from the list; keyboard users type in the field and never
 * open the popover at all. Any minute is typeable — 09:07 must be enterable
 * if that is genuinely the shift (decision F5).
 */
export function TimePicker({ label: fieldLabel, value, onChange, role = 'start', isDisabled, errorMessage }: Props) {
  const messageId = useId();
  const options = useMemo(() => buildOptions(role), [role]);

  // The backend rejects a 00:00 end value with a 500, so the UI refuses it
  // before the request is ever built.
  const midnightEnd = role === 'end' && value !== null && value.hour === 0 && value.minute === 0;
  const message = errorMessage ?? (midnightEnd ? MIDNIGHT_MESSAGE : undefined);

  return (
    <div role="group" aria-label={fieldLabel} aria-invalid={message ? true : undefined}>
      <span className="mb-1 block text-label uppercase tracking-[0.06em] text-ink-2">{fieldLabel}</span>
      <div className="flex items-center gap-1">
        <TimeField
          label={fieldLabel}
          value={value}
          onChange={onChange}
          isDisabled={isDisabled}
          isInvalid={Boolean(message)}
          aria-describedby={message ? messageId : undefined}
        />
        <Button
          aria-label={`Choose time for ${fieldLabel}`}
          isDisabled={isDisabled}
          className="grid h-8 w-8 place-items-center rounded-control text-ink-2 hover:bg-sunken hover:text-ink"
        >
          <Clock size={14} aria-hidden="true" />
        </Button>

        <Popover placement="bottom start" className="shadow-pop rounded-panel bg-surface">
          <Dialog aria-label={`Times for ${fieldLabel}`}>
            <ListBox
              aria-label={`Times for ${fieldLabel}`}
              selectionMode="single"
              selectedKeys={value ? [label(value)] : []}
              onSelectionChange={(keys) => {
                const key = [...keys][0];
                if (typeof key !== 'string') return;
                const [h, m] = key.split(':').map(Number) as [number, number];
                onChange(new Time(h, m));
              }}
              className="max-h-64 w-28 overflow-auto p-1"
            >
              {options.map((option) => (
                <ListBoxItem
                  key={label(option)}
                  id={label(option)}
                  textValue={label(option)}
                  className="cursor-pointer rounded-[4px] px-2 py-1 text-body tabular text-ink
                             selected:bg-ink selected:text-invert focus:bg-sunken"
                >
                  {label(option)}
                </ListBoxItem>
              ))}
            </ListBox>
          </Dialog>
        </Popover>
      </div>

      {message ? (
        <span id={messageId} role="alert" className="mt-1 block text-caption text-conflict">
          {message}
        </span>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Write the date components**

```tsx
// frontend/src/components/datetime/CalendarPanel.lazy.tsx
import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  Heading,
  RangeCalendar,
} from 'react-aria-components';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * The code-split boundary. This module carries the calendar grid, which is the
 * heaviest part of the RAC subset. It is dynamically imported on first popover
 * open and prefetched on field focus, so the initial route never pays for it.
 */

const CELL =
  'flex h-8 w-8 items-center justify-center rounded-control text-body outline-none ' +
  'hover:bg-sunken focus-visible:outline-2 focus-visible:outline-focus ' +
  'selected:bg-ink selected:text-invert ' +
  // Today gets a ring AND a dot: never colour alone.
  "data-[today]:ring-1 data-[today]:ring-line-strong data-[today]:after:content-['·'] " +
  'disabled:text-ink-3 disabled:opacity-40';

function Nav() {
  return (
    <header className="flex items-center justify-between px-1 pb-2">
      <Button slot="previous" aria-label="Previous month" className="grid h-7 w-7 place-items-center rounded-control hover:bg-sunken">
        <ChevronLeft size={14} aria-hidden="true" />
      </Button>
      <Heading className="text-body font-medium text-ink" />
      <Button slot="next" aria-label="Next month" className="grid h-7 w-7 place-items-center rounded-control hover:bg-sunken">
        <ChevronRight size={14} aria-hidden="true" />
      </Button>
    </header>
  );
}

export function CalendarPanel() {
  return (
    <Calendar className="p-3">
      <Nav />
      <CalendarGrid>{(date) => <CalendarCell date={date} className={CELL} />}</CalendarGrid>
    </Calendar>
  );
}

/** Two months side by side — a schedule's effective range is usually picked
 *  across a month boundary. */
export function RangeCalendarPanel() {
  return (
    <RangeCalendar visibleDuration={{ months: 2 }} className="p-3">
      <Nav />
      <div className="flex gap-4">
        <CalendarGrid>{(date) => <CalendarCell date={date} className={CELL} />}</CalendarGrid>
        <CalendarGrid offset={{ months: 1 }}>
          {(date) => <CalendarCell date={date} className={CELL} />}
        </CalendarGrid>
      </div>
    </RangeCalendar>
  );
}
```

```tsx
// frontend/src/components/datetime/DateField.tsx
import type { CalendarDate } from '@internationalized/date';
import { DateInput, DateSegment, DateField as AriaDateField, Label } from 'react-aria-components';

export function DateField({
  label,
  value,
  onChange,
  isInvalid,
  isDisabled,
}: {
  label: string;
  value: CalendarDate | null;
  onChange: (value: CalendarDate | null) => void;
  isInvalid?: boolean;
  isDisabled?: boolean;
}) {
  return (
    <AriaDateField
      aria-label={label}
      value={value}
      onChange={onChange}
      isInvalid={isInvalid}
      isDisabled={isDisabled}
      shouldForceLeadingZeros
    >
      <Label className="sr-only">{label}</Label>
      <DateInput
        className={`flex h-8 w-[130px] items-center rounded-control border bg-surface px-2 text-body tabular text-ink
                    focus-within:outline-2 focus-within:outline-focus focus-within:outline-offset-2
                    ${isInvalid ? 'border-conflict' : 'border-line-strong'}`}
      >
        {(segment) => (
          <DateSegment
            segment={segment}
            className="rounded-[2px] px-0.5 outline-none focus:bg-ink focus:text-invert data-[placeholder]:text-ink-3"
          />
        )}
      </DateInput>
    </AriaDateField>
  );
}
```

```tsx
// frontend/src/components/datetime/DatePicker.tsx
import type { CalendarDate } from '@internationalized/date';
import { CalendarDays } from 'lucide-react';
import { Suspense, lazy, useState } from 'react';
import { Button, Dialog, DialogTrigger, Popover } from 'react-aria-components';
import { DateField } from './DateField';

// Loaded on first open; prefetched on field focus so the ~120ms cold-chunk
// cost is spent while the user is still typing.
const CalendarPanel = lazy(() =>
  import('./CalendarPanel.lazy').then((m) => ({ default: m.CalendarPanel })),
);

export function DatePicker({
  label,
  value,
  onChange,
  errorMessage,
  isDisabled,
}: {
  label: string;
  value: CalendarDate | null;
  onChange: (value: CalendarDate | null) => void;
  errorMessage?: string;
  isDisabled?: boolean;
}) {
  const [, setPrefetched] = useState(false);
  const prefetch = () => {
    setPrefetched(true);
    void import('./CalendarPanel.lazy');
  };

  return (
    <div role="group" aria-label={label} aria-invalid={errorMessage ? true : undefined}>
      <span className="mb-1 block text-label uppercase tracking-[0.06em] text-ink-2">{label}</span>
      <div className="flex items-center gap-1" onFocusCapture={prefetch} onPointerEnter={prefetch}>
        <DateField
          label={label}
          value={value}
          onChange={onChange}
          isDisabled={isDisabled}
          isInvalid={Boolean(errorMessage)}
        />
        <DialogTrigger>
          <Button
            aria-label={`Choose date for ${label}`}
            isDisabled={isDisabled}
            className="grid h-8 w-8 place-items-center rounded-control text-ink-2 hover:bg-sunken hover:text-ink"
          >
            <CalendarDays size={14} aria-hidden="true" />
          </Button>
          <Popover placement="bottom start" className="shadow-pop rounded-panel bg-surface">
            <Dialog aria-label={`Calendar for ${label}`}>
              <Suspense fallback={<div className="h-64 w-64 animate-pulse rounded-panel bg-sunken" />}>
                <CalendarPanel />
              </Suspense>
            </Dialog>
          </Popover>
        </DialogTrigger>
      </div>
      {errorMessage ? (
        <span role="alert" className="mt-1 block text-caption text-conflict">
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
}
```

```tsx
// frontend/src/components/datetime/DateRangePicker.tsx
import type { CalendarDate } from '@internationalized/date';
import { Suspense, lazy } from 'react';
import { Button, Dialog, DialogTrigger, Popover } from 'react-aria-components';
import { CalendarDays } from 'lucide-react';
import { Switch } from '@/components/ui/Switch';
import { DateField } from './DateField';

const RangeCalendarPanel = lazy(() =>
  import('./CalendarPanel.lazy').then((m) => ({ default: m.RangeCalendarPanel })),
);

export interface DateRangeValue {
  start: CalendarDate | null;
  /** null means open-ended, matching `end_date: date | null` on the wire. */
  end: CalendarDate | null;
}

/**
 * The schedule's effective range.
 *
 * Enforces `end >= start` client-side. The backend has a DB CheckConstraint
 * for this whose violation escapes as an unhandled 500, so blocking it here is
 * the difference between a legible message and "internal server error".
 */
export function DateRangePicker({
  label,
  value,
  onChange,
  isDisabled,
}: {
  label: string;
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  isDisabled?: boolean;
}) {
  const openEnded = value.end === null;
  const inverted =
    value.start !== null && value.end !== null && value.end.compare(value.start) < 0;

  return (
    <div role="group" aria-label={label} aria-invalid={inverted || undefined}>
      <span className="mb-1 block text-label uppercase tracking-[0.06em] text-ink-2">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <DateField
          label={`${label} start`}
          value={value.start}
          onChange={(start) => onChange({ ...value, start })}
          isDisabled={isDisabled}
        />
        <span aria-hidden="true" className="text-ink-3">
          →
        </span>
        <DateField
          label={`${label} end`}
          value={value.end}
          onChange={(end) => onChange({ ...value, end })}
          isDisabled={isDisabled || openEnded}
          isInvalid={inverted}
        />

        <DialogTrigger>
          <Button
            aria-label={`Choose dates for ${label}`}
            isDisabled={isDisabled}
            className="grid h-8 w-8 place-items-center rounded-control text-ink-2 hover:bg-sunken hover:text-ink"
          >
            <CalendarDays size={14} aria-hidden="true" />
          </Button>
          <Popover placement="bottom start" className="shadow-pop rounded-panel bg-surface">
            <Dialog aria-label={`Calendar for ${label}`}>
              <Suspense fallback={<div className="h-64 w-[34rem] animate-pulse rounded-panel bg-sunken" />}>
                <RangeCalendarPanel />
              </Suspense>
            </Dialog>
          </Popover>
        </DialogTrigger>

        <Switch
          isSelected={openEnded}
          onChange={(selected) => onChange({ ...value, end: selected ? null : value.start })}
          aria-label="Open-ended"
        >
          <span className="text-body text-ink-2">Open-ended</span>
        </Switch>
      </div>

      {inverted ? (
        <span role="alert" className="mt-1 block text-caption text-conflict">
          The end date must be on or after the start date.
        </span>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/components/datetime/ && rm -f src/components/datetime/.gitkeep`
Expected: PASS — **12 passed** (8 TimePicker, 4 DatePicker/DateRangePicker).

- [ ] **Step 6: Prove the keyboard path by hand**

RAC's keyboard behaviour is the reason this library was chosen; verify it once, for real, rather than trusting it.

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npm run dev`, open a page rendering a `TimePicker`, and confirm **with the mouse untouched**:
- `Tab` reaches the hour segment; `←`/`→` move between segments.
- `↑`/`↓` step the hour by 1 and the minute by 5; typing `0907` fills both segments and advances.
- The trigger opens the popover; type-ahead "14" jumps to 14:00; `Esc` closes and returns focus to the trigger.

Record the result in the commit message if anything differed.

- [ ] **Step 7: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/src/components/datetime/ && git commit -m "feat(frontend): add accessible date and time pickers with the backend's end-value constraints"
```

---

### Task 15: `components/modals/` — base `Modal` and the three concrete dialogs

**Files:**
- Create: `frontend/src/context/ModalContext.tsx`
- Create: `frontend/src/components/modals/{Modal,ConfirmModal,DeletionImpactModal,AssignAgentModal}.tsx`
- Delete: `frontend/src/components/modals/.gitkeep`
- Test: `frontend/src/components/modals/modals.test.tsx`

**Interfaces:**
- Produces: `Modal`, `ConfirmModal`, `DeletionImpactModal`, `AssignAgentModal`, `ModalProvider`/`useModals`.
- Consumes: RAC `Dialog`/`Modal`/`ComboBox`, `components/ui/`, `helpers/format.ts`.
- **Receives all data as props.** These are shared components (rule R2) — the *page* fetches and passes down.

**The deletion-impact flow is first-class content, not a warning above a button.** The product decision is that a user must see *exactly who loses coverage* before confirming.

- **Names, not IDs.** `deletion-impact` returns `affected_agent_ids` only; the page joins them against the cached agent map from `useAgentMap()`, which is `staleTime: Infinity` and loaded at mount — so the join is free.
- **"No other schedule" is the real warning.** An agent on two schedules loses *some* coverage; an agent on only this one drops to zero. That distinction comes from `GET /agents/{id}/schedules`, fetched in parallel and only for the agents shown (capped at 10, with "+N more").
- **Prefetched on hover-intent**, so the modal opens with content already present. **No spinner in a destructive dialog.**
- **If `deletion-impact` itself fails, the confirm button is disabled.** We never let a user confirm a deletion whose impact we could not show.
- The confirm gate is an **acknowledgement checkbox carrying the count**, not type-the-name. This is a soft delete on an internal tool; the friction should be proportionate. (Escalate to type-to-confirm if deletions prove error-prone.)

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/modals/modals.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AssignAgentModal } from './AssignAgentModal';
import { ConfirmModal } from './ConfirmModal';
import { DeletionImpactModal } from './DeletionImpactModal';

const AFFECTED = [
  { id: 3, name: 'Carol Singh', email: 'carol@richpanel.example', otherSchedules: [] },
  { id: 4, name: 'David Okafor', email: 'david@richpanel.example', otherSchedules: ['Weekday Core'] },
];

describe('ConfirmModal', () => {
  it('traps focus and closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <ConfirmModal
        isOpen
        onClose={onClose}
        onConfirm={vi.fn()}
        title="Delete Weekend Cover?"
        description="No agents are assigned to it."
        confirmLabel="Delete schedule"
      />,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('DeletionImpactModal', () => {
  it('lists affected agents by NAME, not by id', () => {
    render(
      <DeletionImpactModal
        isOpen
        scheduleName="Night Desk"
        affected={AFFECTED}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText('Carol Singh')).toBeInTheDocument();
    expect(screen.queryByText(/agent #3/i)).not.toBeInTheDocument();
  });

  it('calls out the agents who will have NO schedule at all', () => {
    render(
      <DeletionImpactModal isOpen scheduleName="Night Desk" affected={AFFECTED} onClose={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(screen.getByText(/1 of these agents will have no schedule at all/i)).toBeInTheDocument();
  });

  it('keeps confirm disabled until the count is acknowledged', async () => {
    const onConfirm = vi.fn();
    render(
      <DeletionImpactModal isOpen scheduleName="Night Desk" affected={AFFECTED} onClose={vi.fn()} onConfirm={onConfirm} />,
    );
    const confirm = screen.getByRole('button', { name: /delete schedule/i });
    expect(confirm).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: /i understand 2 agents lose coverage/i }));
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('DISABLES confirm entirely when the impact could not be loaded', () => {
    render(
      <DeletionImpactModal
        isOpen
        scheduleName="Night Desk"
        affected={[]}
        impactError={{ status: 500, errorCode: 'internal_error', message: 'boom', fieldErrors: [] }}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /delete schedule/i })).toBeDisabled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('AssignAgentModal', () => {
  it('filters the combobox by typed text', async () => {
    render(
      <AssignAgentModal
        isOpen
        candidates={[
          { id: 1, name: 'Alice Chen' },
          { id: 2, name: 'Bob Martinez' },
        ]}
        onClose={vi.fn()}
        onAssign={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByRole('combobox', { name: /agent/i }), 'ali');
    expect(await screen.findByRole('option', { name: 'Alice Chen' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Bob Martinez' })).not.toBeInTheDocument();
  });

  it('renders a conflict without ever adding the agent to the list', () => {
    render(
      <AssignAgentModal
        isOpen
        candidates={[{ id: 1, name: 'Alice Chen' }]}
        conflict={{ agentName: 'Carol Singh', scheduleName: 'Night Desk', weekday: 1, detail: 'TUE 00:00-06:00 vs 05:00-13:00' }}
        onClose={vi.fn()}
        onAssign={vi.fn()}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Carol Singh/);
    expect(alert).toHaveTextContent(/Night Desk/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/components/modals/`
Expected: FAIL — unresolved imports for all three modals.

- [ ] **Step 3: Write the modals**

```tsx
// frontend/src/components/modals/Modal.tsx
import type { ReactNode } from 'react';
import { Dialog, Heading, Modal as AriaModal, ModalOverlay } from 'react-aria-components';

/**
 * The base. RAC's Dialog handles the focus trap, Escape, and focus RETURN to
 * the trigger — the three things hand-rolled modals get wrong.
 *
 * This is one of only two places in the app permitted a shadow: it floats.
 */
export function Modal({
  isOpen,
  onClose,
  title,
  description,
  footer,
  size = 'md',
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  children?: ReactNode;
}) {
  const width = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl' }[size];

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="fixed inset-0 z-50 grid place-items-center bg-ink/25 p-4 backdrop-blur-[1px]"
    >
      <AriaModal className={`w-full ${width} rounded-panel bg-surface shadow-pop`}>
        <Dialog className="outline-none">
          <div className="border-b border-line px-5 py-4">
            <Heading slot="title" className="font-display text-heading text-ink">
              {title}
            </Heading>
            {description ? <div className="mt-1 text-body text-ink-2">{description}</div> : null}
          </div>
          {children ? <div className="px-5 py-4">{children}</div> : null}
          {footer ? (
            <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>
          ) : null}
        </Dialog>
      </AriaModal>
    </ModalOverlay>
  );
}
```

```tsx
// frontend/src/components/modals/ConfirmModal.tsx
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from './Modal';

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  isPending,
  destructive = true,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  isPending?: boolean;
  destructive?: boolean;
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button onPress={onClose} variant="ghost">
            Cancel
          </Button>
          <Button onPress={onConfirm} variant={destructive ? 'destructive' : 'primary'} isPending={isPending}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
```

```tsx
// frontend/src/components/modals/DeletionImpactModal.tsx
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { Checkbox } from 'react-aria-components';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { Button } from '@/components/ui/Button';
import type { ErrorLike } from '@/helpers/errorPresentation';
import { formatCount } from '@/helpers/format';
import { Modal } from './Modal';

export interface AffectedAgent {
  id: number;
  name: string;
  email: string | null;
  /** Names of the agent's OTHER schedules. Empty means they drop to zero
   *  coverage entirely — the distinction the user actually needs. */
  otherSchedules: string[];
}

const VISIBLE_LIMIT = 10;

export function DeletionImpactModal({
  isOpen,
  scheduleName,
  affected,
  impactError,
  isPending,
  onClose,
  onConfirm,
}: {
  isOpen: boolean;
  scheduleName: string;
  affected: AffectedAgent[];
  impactError?: ErrorLike;
  isPending?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);

  const orphaned = affected.filter((a) => a.otherSchedules.length === 0).length;
  const visible = affected.slice(0, VISIBLE_LIMIT);
  const hidden = affected.length - visible.length;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Delete “${scheduleName}”?`}
      size="lg"
      footer={
        <>
          <Button onPress={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            onPress={onConfirm}
            variant="destructive"
            isPending={isPending}
            // Never let a user confirm a deletion whose impact we could not
            // show them.
            isDisabled={Boolean(impactError) || !acknowledged}
          >
            Delete schedule
          </Button>
        </>
      }
    >
      {impactError ? (
        <InlineAlert tone="conflict" icon={<AlertTriangle size={14} />}>
          The impact of this deletion could not be loaded, so it cannot be confirmed. Close this
          dialog and try again.
        </InlineAlert>
      ) : (
        <>
          {/* 3px impact rule running the length of the list. */}
          <div className="border-l-[3px] border-impact pl-4">
            <p className="text-body text-ink">
              {formatCount(affected.length, 'agent')} lose all coverage from this schedule. Their
              resolution-time hours will be computed as zero for any window this schedule used to
              cover.
            </p>

            <ul className="mt-3 flex flex-col gap-1">
              {visible.map((agent) => (
                <li key={agent.id} className="flex items-center gap-3 text-body">
                  <span className="min-w-40 font-medium text-ink">{agent.name}</span>
                  <span className="min-w-56 text-ink-3">{agent.email ?? '—'}</span>
                  {agent.otherSchedules.length === 0 ? (
                    <span className="flex items-center gap-1 text-impact">
                      <AlertTriangle size={13} aria-hidden="true" />
                      no other schedule
                    </span>
                  ) : (
                    <span className="text-ink-2">also: {agent.otherSchedules.join(', ')}</span>
                  )}
                </li>
              ))}
            </ul>
            {hidden > 0 ? <p className="mt-2 text-caption text-ink-3">+{hidden} more</p> : null}

            {orphaned > 0 ? (
              <p className="mt-3 text-body font-medium text-impact">
                {orphaned} of these agents will have no schedule at all.
              </p>
            ) : null}
          </div>

          <Checkbox
            isSelected={acknowledged}
            onChange={setAcknowledged}
            className="mt-4 flex items-center gap-2 text-body text-ink"
          >
            <span
              aria-hidden="true"
              className="grid h-4 w-4 place-items-center rounded-[3px] border border-line-strong
                         group-selected:border-ink group-selected:bg-ink group-selected:text-invert"
            >
              ✓
            </span>
            I understand {formatCount(affected.length, 'agent')} lose coverage
          </Checkbox>
        </>
      )}
    </Modal>
  );
}
```

```tsx
// frontend/src/components/modals/AssignAgentModal.tsx
import { Ban } from 'lucide-react';
import { useState } from 'react';
import { ComboBox, Input, Label, ListBox, ListBoxItem, Popover } from 'react-aria-components';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { Button } from '@/components/ui/Button';
import { weekdayShortLabel } from '@/helpers/weekday';
import { Modal } from './Modal';

export interface AssignConflict {
  agentName: string;
  scheduleName: string;
  weekday: number;
  detail: string;
}

export function AssignAgentModal({
  isOpen,
  candidates,
  conflict,
  isPending,
  onClose,
  onAssign,
}: {
  isOpen: boolean;
  candidates: { id: number; name: string }[];
  conflict?: AssignConflict;
  isPending?: boolean;
  onClose: () => void;
  onAssign: (agentId: number) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Assign an agent"
      size="md"
      footer={
        <>
          <Button onPress={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            onPress={() => selected !== null && onAssign(selected)}
            variant="primary"
            isPending={isPending}
            isDisabled={selected === null}
          >
            Assign
          </Button>
        </>
      }
    >
      <ComboBox
        aria-label="Agent"
        selectedKey={selected}
        onSelectionChange={(key) => setSelected(key === null ? null : Number(key))}
        // Shake on rejection. The agent is NEVER inserted into the list first
        // and then removed — nothing false is ever shown.
        className={conflict ? 'animate-[shake_180ms_var(--ease-in-out)]' : undefined}
      >
        <Label className="mb-1 block text-label uppercase tracking-[0.06em] text-ink-2">Agent</Label>
        <Input
          placeholder="Search agents…"
          className={`h-8 w-full rounded-control border bg-surface px-2 text-body text-ink
                      focus:outline-2 focus:outline-focus focus:outline-offset-2
                      ${conflict ? 'border-conflict' : 'border-line-strong'}`}
        />
        <Popover className="shadow-pop rounded-panel bg-surface">
          <ListBox className="max-h-64 w-[--trigger-width] overflow-auto p-1">
            {candidates.map((agent) => (
              <ListBoxItem
                key={agent.id}
                id={agent.id}
                textValue={agent.name}
                className="cursor-pointer rounded-[4px] px-2 py-1 text-body text-ink selected:bg-ink selected:text-invert focus:bg-sunken"
              >
                {agent.name}
              </ListBoxItem>
            ))}
          </ListBox>
        </Popover>
      </ComboBox>

      {conflict ? (
        <div className="mt-3">
          <InlineAlert tone="conflict" icon={<Ban size={14} />}>
            <p className="font-medium">
              {conflict.agentName} can’t be assigned to this schedule.
            </p>
            <p className="mt-1">
              They’re already on “{conflict.scheduleName}”, and the hours overlap on{' '}
              {weekdayShortLabel(conflict.weekday)}: {conflict.detail}
            </p>
          </InlineAlert>
        </div>
      ) : null}
    </Modal>
  );
}
```

Add the shake keyframe to `globals.css`:

```css
/* frontend/src/styles/globals.css — APPEND */
@keyframes shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-3px); }
  40% { transform: translateX(3px); }
  60% { transform: translateX(-2px); }
  80% { transform: translateX(2px); }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/components/modals/ && rm -f src/components/modals/.gitkeep`
Expected: PASS — **7 passed**.

- [ ] **Step 5: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/src/ && git commit -m "feat(frontend): add base modal, confirm, deletion-impact and assign-agent dialogs"
```

---
### Task 16: The Week Ribbon

**Files:**
- Create: `frontend/src/pages/schedules/week-ribbon/{weekForm.ts,WeekRibbon.tsx,DayRow.tsx,CoverageTrack.tsx,OvernightGhost.tsx,HourAxis.tsx}.tsx`
- Delete: `frontend/src/pages/schedules/week-ribbon/.gitkeep`
- Test: `frontend/src/pages/schedules/week-ribbon/WeekRibbon.test.tsx`, `.../weekForm.test.ts`

**Interfaces:**
- Produces: `WeekRibbon` (an RHF form over the week), `weekFormSchema`, `weekFormToShifts`, `shiftsToWeekForm`, `wirePathToFormField`.
- Consumes: `helpers/{time,shifts,weekday,duration}.ts`, `components/datetime/TimePicker`, `components/ui/`.
- Consumed by: the schedule detail pane (Task 17).

**This is the memorable thing.** The weekly-hours editor *is* the visualisation. Seven rows, one per day, each a full-width 24-hour track. **An overnight shift visibly runs off the right edge of its own day and reappears, hatched and read-only, at the left edge of the next day, marked `↳ from Monday`.** Nobody has to be taught what `end_hours < start_hours` means — they watch it happen.

**Overnight is entered by consequence, never by mode.** The failure mode of every overnight UI is asking the user to *declare* an intent ("is this overnight?") before they have expressed it. This design never asks. The user picks an end time; if it is at or before the start, the interface immediately shows the consequence: a `⟳ +1 day` chip with the **resolved day name** beneath it (`ends Tue`, not a relative token), the block extending past the right edge, a hatched ghost fading in on the next day, the duration recomputing across the boundary (22:00 → 06:00 = 8h, not −16h), and a live-region announcement. **A checkbox that can disagree with the times is strictly worse.**

**The overnight tail is deliberately NOT editable on the day it lands on.** Making it editable there would imply that day owns two windows — exactly the split-shift model the backend does not support. The ghost is read-only and its caption says where to go.

#### How this avoids a re-render storm — the four mechanisms, all required

Seven rows, each with a switch and two segmented time fields. A naively controlled implementation re-renders all seven on every keystroke in any of them, and re-computes the ribbon geometry with it.

1. **React Hook Form, uncontrolled, `mode: 'onBlur'`.** A keystroke does not touch React state at all. This is the mechanism, not a preference.
2. **Per-row subscription.** Each `DayRow` calls `useController({ control, name: 'days.3' })`. Only that row re-renders on its own change; the form root never re-renders.
3. **The cross-row dependency is scoped to the ghost.** `OvernightGhost` on Tuesday calls `useWatch({ control, name: 'days.1' })` — one field, inside the ghost component only. Editing Monday re-renders **exactly two components**: Monday's row and Tuesday's ghost.
4. **Geometry bypasses React entirely.** The coverage block's position is two registered custom properties (`--from`, `--to`, declared with `@property` in Task 11) set inline via a ref. Dragging on the track writes them in a `pointermove` handler — **zero React renders during a drag** — and commits to RHF on `pointerup`.

Validation is per-field on blur, whole-form only on submit. `findSelfOverlaps` runs on blur, memoised on a serialised week key.

- [ ] **Step 1: Write the failing form-model test**

```ts
// frontend/src/pages/schedules/week-ribbon/weekForm.test.ts
import { describe, expect, it } from 'vitest';
import { shiftsToWeekForm, validateWeek, weekFormToShifts, wirePathToFormField } from './weekForm';

describe('shiftsToWeekForm', () => {
  it('produces seven rows, marking days with no shift as not working', () => {
    const days = shiftsToWeekForm([{ weekday: 0, start_hours: 9, end_hours: 18 }]);
    expect(days).toHaveLength(7);
    expect(days[0]).toEqual({ weekday: 0, working: true, start: '09:00', end: '18:00' });
    expect(days[5]).toEqual({ weekday: 5, working: false, start: '09:00', end: '18:00' });
  });

  it('round-trips the inexact float the backend sends for 09:10', () => {
    const days = shiftsToWeekForm([{ weekday: 0, start_hours: 9.166666666666666, end_hours: 18 }]);
    expect(days[0]?.start).toBe('09:10');
  });
});

describe('weekFormToShifts', () => {
  it('emits only working days', () => {
    const days = shiftsToWeekForm([{ weekday: 0, start_hours: 9, end_hours: 18 }]);
    expect(weekFormToShifts(days)).toEqual([{ weekday: 0, start_hours: 9, end_hours: 18 }]);
  });

  it('round-trips through the wire without drift', () => {
    const original = [
      { weekday: 0, start_hours: 22, end_hours: 6 },
      { weekday: 3, start_hours: 9.166666666666666, end_hours: 17.916666666666668 },
    ];
    const restored = weekFormToShifts(shiftsToWeekForm(original));
    expect(restored[1]?.start_hours).toBeCloseTo(9.166666666666666, 10);
    expect(restored[1]?.end_hours).toBeCloseTo(17.916666666666668, 10);
  });
});

describe('validateWeek', () => {
  it('accepts a clean week', () => {
    expect(validateWeek(shiftsToWeekForm([{ weekday: 0, start_hours: 9, end_hours: 18 }]))).toEqual([]);
  });

  it('rejects a zero-length shift, which the backend answers with a 500', () => {
    const days = shiftsToWeekForm([{ weekday: 0, start_hours: 9, end_hours: 18 }]);
    days[0]!.end = '09:00';
    expect(validateWeek(days)).toEqual([
      { field: 'days.0.end', message: 'Start and end must be different times.' },
    ]);
  });

  it('rejects a 00:00 end value, which the backend also answers with a 500', () => {
    const days = shiftsToWeekForm([{ weekday: 0, start_hours: 22, end_hours: 6 }]);
    days[0]!.end = '00:00';
    expect(validateWeek(days)[0]?.message).toMatch(/midnight isn't supported.*23:59/i);
  });

  it('rejects an overnight tail colliding with the next day, pre-empting the 409', () => {
    const days = shiftsToWeekForm([
      { weekday: 0, start_hours: 22, end_hours: 6 },
      { weekday: 1, start_hours: 5, end_hours: 13 },
    ]);
    const errors = validateWeek(days);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/Monday.*overlaps.*Tuesday/i);
  });

  it('rejects a Sunday tail colliding with Monday - the week wraps', () => {
    const days = shiftsToWeekForm([
      { weekday: 6, start_hours: 23, end_hours: 5 },
      { weekday: 0, start_hours: 4, end_hours: 12 },
    ]);
    expect(validateWeek(days)).toHaveLength(1);
  });
});

describe('wirePathToFormField', () => {
  it('maps a 422 loc path onto the control that owns it', () => {
    const days = shiftsToWeekForm([
      { weekday: 0, start_hours: 9, end_hours: 18 },
      { weekday: 2, start_hours: 9, end_hours: 18 },
    ]);
    // Wire index 1 is the SECOND emitted shift, which is weekday 2 -> days.2
    expect(wirePathToFormField('shifts.1.end_hours', days)).toBe('days.2.end');
    expect(wirePathToFormField('shifts.0.start_hours', days)).toBe('days.0.start');
  });

  it('returns null for a path the form does not own', () => {
    expect(wirePathToFormField('name', shiftsToWeekForm([]))).toBeNull();
  });
});
```

- [ ] **Step 2: Write the failing component test**

```tsx
// frontend/src/pages/schedules/week-ribbon/WeekRibbon.test.tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WeekRibbon } from './WeekRibbon';

const MONDAY_NINE_TO_SIX = [{ weekday: 0, start_hours: 9, end_hours: 18 }];

describe('WeekRibbon structure', () => {
  it('renders seven labelled day groups', () => {
    render(<WeekRibbon shifts={MONDAY_NINE_TO_SIX} onSubmit={vi.fn()} />);
    expect(screen.getAllByRole('group', { name: /monday|tuesday|wednesday|thursday|friday|saturday|sunday/i })).toHaveLength(7);
  });

  it('says "Not working" in words - absence is stated, never merely absent', () => {
    render(<WeekRibbon shifts={MONDAY_NINE_TO_SIX} onSubmit={vi.fn()} />);
    const saturday = screen.getByRole('group', { name: /saturday/i });
    expect(within(saturday).getByText(/not working/i)).toBeInTheDocument();
  });

  it('hides the decorative track from assistive tech - the data is in the fields', () => {
    const { container } = render(<WeekRibbon shifts={MONDAY_NINE_TO_SIX} onSubmit={vi.fn()} />);
    expect(container.querySelector('[data-testid="coverage-track"]')).toHaveAttribute('aria-hidden', 'true');
  });

  it('gives each row a screen-reader summary of its hours', () => {
    render(<WeekRibbon shifts={MONDAY_NINE_TO_SIX} onSubmit={vi.fn()} />);
    expect(screen.getByText(/Monday, working 09:00 to 18:00\. 9 hours\./i)).toBeInTheDocument();
  });
});

describe('overnight, shown by consequence', () => {
  const overnight = [{ weekday: 0, start_hours: 22, end_hours: 6 }];

  it('shows a +1 day chip naming the RESOLVED day, not a relative token', () => {
    render(<WeekRibbon shifts={overnight} onSubmit={vi.fn()} />);
    expect(screen.getByText(/\+1 day/i)).toBeInTheDocument();
    expect(screen.getByText(/ends Tue/i)).toBeInTheDocument();
  });

  it('computes the duration ACROSS midnight, not as a negative', () => {
    render(<WeekRibbon shifts={overnight} onSubmit={vi.fn()} />);
    const monday = screen.getByRole('group', { name: /monday/i });
    expect(within(monday).getByText('8h 00m')).toBeInTheDocument();
  });

  it('renders a read-only ghost on the FOLLOWING day, pointing back to its owner', () => {
    render(<WeekRibbon shifts={overnight} onSubmit={vi.fn()} />);
    const tuesday = screen.getByRole('group', { name: /tuesday/i });
    expect(within(tuesday).getByText(/continues from Monday/i)).toBeInTheDocument();
    expect(within(tuesday).getByText(/edit it on Monday/i)).toBeInTheDocument();
  });

  it('wraps a Sunday overnight onto MONDAY - the week wraps, matching (weekday + 1) % 7', () => {
    render(<WeekRibbon shifts={[{ weekday: 6, start_hours: 23, end_hours: 5 }]} onSubmit={vi.fn()} />);
    const monday = screen.getByRole('group', { name: /monday/i });
    expect(within(monday).getByText(/continues from Sunday/i)).toBeInTheDocument();
  });
});

describe('validation before the request leaves', () => {
  it('blocks save and explains when two days overlap', async () => {
    const onSubmit = vi.fn();
    render(
      <WeekRibbon
        shifts={[
          { weekday: 0, start_hours: 22, end_hours: 6 },
          { weekday: 1, start_hours: 5, end_hours: 13 },
        ]}
        onSubmit={onSubmit}
        isDirty
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /save hours/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/overlaps/i);
  });

  it('submits the wire shape when the week is valid', async () => {
    const onSubmit = vi.fn();
    render(<WeekRibbon shifts={MONDAY_NINE_TO_SIX} onSubmit={onSubmit} isDirty />);
    await userEvent.click(screen.getByRole('button', { name: /save hours/i }));
    expect(onSubmit).toHaveBeenCalledWith([{ weekday: 0, start_hours: 9, end_hours: 18 }]);
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/pages/schedules/week-ribbon/`
Expected: FAIL — unresolved `./weekForm` and `./WeekRibbon`.

- [ ] **Step 4: Write `weekForm.ts`**

```ts
// frontend/src/pages/schedules/week-ribbon/weekForm.ts
/**
 * The form model for the week, and every client-side guard that keeps an
 * unrepresentable shift off the wire (see the plan's section 0.4).
 */
import { z } from 'zod';
import type { WireShift } from '@/api/types';
import { findSelfOverlaps } from '@/helpers/shifts';
import { floatHoursFromHHMM, formatFloatHours, isExpressibleEndHours, parseHHMM } from '@/helpers/time';
import { weekdayLabel } from '@/helpers/weekday';

export const dayFormSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  working: z.boolean(),
  /** "HH:MM". Kept as a string so the segmented field stays uncontrolled. */
  start: z.string(),
  end: z.string(),
});

export const weekFormSchema = z.object({ days: z.array(dayFormSchema).length(7) });

export type DayForm = z.infer<typeof dayFormSchema>;
export type WeekForm = z.infer<typeof weekFormSchema>;

const DEFAULT_START = '09:00';
const DEFAULT_END = '18:00';

/** Wire shifts -> seven form rows. Days with no shift are "not working" but
 *  keep sensible defaults, so switching one on does not present an empty field. */
export function shiftsToWeekForm(shifts: readonly WireShift[]): DayForm[] {
  const byWeekday = new Map(shifts.map((s) => [s.weekday, s]));
  return Array.from({ length: 7 }, (_unused, weekday) => {
    const shift = byWeekday.get(weekday);
    return {
      weekday,
      working: shift !== undefined,
      start: shift ? formatFloatHours(shift.start_hours) : DEFAULT_START,
      end: shift ? formatFloatHours(shift.end_hours) : DEFAULT_END,
    };
  });
}

/** Seven form rows -> the wire body. Only working days are emitted. */
export function weekFormToShifts(days: readonly DayForm[]): WireShift[] {
  return days
    .filter((day) => day.working)
    .flatMap((day) => {
      const start = floatHoursFromHHMM(day.start);
      const end = floatHoursFromHHMM(day.end);
      if (start === null || end === null) return [];
      return [{ weekday: day.weekday, start_hours: start, end_hours: end }];
    });
}

export interface WeekFieldError {
  field: string;
  message: string;
}

/**
 * Every guard, in the order the user would hit them. Each entry corresponds to
 * a backend response we refuse to trigger:
 *   unparseable            -> would be a 422
 *   start === end          -> 500 (ShiftInput: "zero duration")
 *   end === 00:00          -> 500 (tail row 00:00->00:00)
 *   self-overlap           -> 409, indistinguishable from an assignment overlap
 */
export function validateWeek(days: readonly DayForm[]): WeekFieldError[] {
  const errors: WeekFieldError[] = [];

  for (const day of days) {
    if (!day.working) continue;

    const start = parseHHMM(day.start);
    const end = parseHHMM(day.end);
    if (!start) {
      errors.push({ field: `days.${day.weekday}.start`, message: 'Enter a time as HH:MM.' });
      continue;
    }
    if (!end) {
      errors.push({ field: `days.${day.weekday}.end`, message: 'Enter a time as HH:MM.' });
      continue;
    }

    if (start.hours === end.hours && start.minutes === end.minutes) {
      errors.push({
        field: `days.${day.weekday}.end`,
        message: 'Start and end must be different times.',
      });
      continue;
    }

    const endHours = floatHoursFromHHMM(day.end);
    if (endHours === null || !isExpressibleEndHours(endHours)) {
      errors.push({
        field: `days.${day.weekday}.end`,
        message: "A shift ending exactly at midnight isn't supported. Use 23:59 for end of day.",
      });
    }
  }

  if (errors.length > 0) return errors;

  // Pre-empt the 409. The backend cannot tell us WHICH days collided, so we
  // work it out here and name them.
  for (const overlap of findSelfOverlaps(weekFormToShifts(days))) {
    const owner = overlap.a.isOvernightTail
      ? (overlap.a.weekday + 6) % 7
      : overlap.a.weekday;
    errors.push({
      field: `days.${owner}.end`,
      message: `${weekdayLabel(owner)}’s shift overlaps ${weekdayLabel(overlap.weekday)} by ${overlap.overlapMinutes} minutes.`,
    });
  }

  return errors;
}

/**
 * Map a 422 `loc` path back onto the control that produced it.
 *
 * The wire's `shifts` array is INDEXED BY EMISSION ORDER, not by weekday —
 * only working days are sent — so this must reconstruct that ordering rather
 * than assume `shifts.N` means weekday N.
 */
export function wirePathToFormField(wirePath: string, days: readonly DayForm[]): string | null {
  const match = /^shifts\.(\d+)\.(start_hours|end_hours)$/.exec(wirePath);
  if (!match) return null;

  const emitted = days.filter((d) => d.working);
  const day = emitted[Number(match[1])];
  if (!day) return null;

  return `days.${day.weekday}.${match[2] === 'start_hours' ? 'start' : 'end'}`;
}
```

- [ ] **Step 5: Write the ribbon components**

```tsx
// frontend/src/pages/schedules/week-ribbon/HourAxis.tsx
const HOURS = [0, 4, 8, 12, 16, 20, 24];

export function HourAxis() {
  return (
    <div aria-hidden="true" className="relative h-4 text-label text-ink-3">
      {HOURS.map((hour) => (
        <span
          key={hour}
          className="absolute -translate-x-1/2 tabular"
          style={{ left: `${(hour / 24) * 100}%` }}
        >
          {String(hour).padStart(2, '0')}
        </span>
      ))}
    </div>
  );
}
```

```tsx
// frontend/src/pages/schedules/week-ribbon/CoverageTrack.tsx
import { useEffect, useRef } from 'react';
import { MINUTES_PER_DAY } from '@/helpers/time';

/**
 * The 24-hour track and its coverage block.
 *
 * Geometry is written to two @property custom properties through a REF, not
 * through React state — so a drag produces zero renders, and the commit
 * transition is done by CSS interpolating --from/--to.
 *
 * aria-hidden: this is a rendering of data already present in the time fields.
 * Announcing it twice would make the ribbon unusable with a screen reader.
 */
export function CoverageTrack({
  startMinutes,
  endMinutes,
  isOvernight,
  isEditing,
}: {
  startMinutes: number;
  endMinutes: number;
  isOvernight: boolean;
  isEditing: boolean;
}) {
  const blockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const block = blockRef.current;
    if (!block) return;
    const to = isOvernight ? MINUTES_PER_DAY : endMinutes;
    block.style.setProperty('--from', `${(startMinutes / MINUTES_PER_DAY) * 100}%`);
    block.style.setProperty('--to', `${(to / MINUTES_PER_DAY) * 100}%`);
  }, [startMinutes, endMinutes, isOvernight]);

  return (
    <div
      data-testid="coverage-track"
      aria-hidden="true"
      className="relative h-5 overflow-hidden rounded-bar bg-sunken"
    >
      <div
        ref={blockRef}
        className={[
          'absolute inset-y-0 bg-coverage',
          // No transition while the user is actively dragging; only on commit.
          isEditing ? '' : 'transition-[--from,--to] duration-150 ease-[var(--ease-out)]',
          'left-[var(--from)] right-[calc(100%-var(--to))]',
          // An overnight block loses its right radius and gains a hard cut at
          // the 24:00 boundary: it visibly runs off the edge.
          isOvernight ? 'rounded-l-bar border-r-2 border-coverage' : 'rounded-bar',
        ].join(' ')}
      />
    </div>
  );
}
```

```tsx
// frontend/src/pages/schedules/week-ribbon/OvernightGhost.tsx
import { useWatch, type Control } from 'react-hook-form';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { MINUTES_PER_DAY, parseHHMM } from '@/helpers/time';
import { weekdayLabel } from '@/helpers/weekday';
import type { WeekForm } from './weekForm';

/**
 * The read-only continuation of the PREVIOUS day's overnight shift.
 *
 * The scoped useWatch here is mechanism 3 of the re-render strategy: this is
 * the ONLY place a row observes another row, and it observes exactly one
 * field. Editing Monday re-renders Monday's row and this component, and
 * nothing else.
 *
 * Deliberately not editable: making it editable would imply this day owns two
 * windows, which is the split-shift model the backend does not support.
 */
export function OvernightGhost({
  control,
  weekday,
  isPreviousWeek,
}: {
  control: Control<WeekForm>;
  weekday: number;
  isPreviousWeek: boolean;
}) {
  const previousWeekday = (weekday + 6) % 7;
  const previous = useWatch({ control, name: `days.${previousWeekday}` });

  if (!previous?.working) return null;
  const start = parseHHMM(previous.start);
  const end = parseHHMM(previous.end);
  if (!start || !end) return null;

  const startMinutes = start.hours * 60 + start.minutes;
  const endMinutes = end.hours * 60 + end.minutes;
  if (endMinutes > startMinutes) return null; // not overnight

  const ownerLabel = weekdayLabel(previousWeekday);
  const suffix = isPreviousWeek ? ' (previous week)' : '';

  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 rounded-l-bar bg-coverage-ghost
                   [background-image:repeating-linear-gradient(45deg,transparent,transparent_3px,rgb(0_0_0/.08)_3px,rgb(0_0_0/.08)_6px)]"
        style={{ width: `${(endMinutes / MINUTES_PER_DAY) * 100}%` }}
      />
      <p className="mt-1 text-caption text-ink-3">
        <span aria-hidden="true">↳ </span>
        {previous.end === '00:00' ? '00:00' : `00:00–${previous.end}`} continues from {ownerLabel}
        {suffix} · edit it on {ownerLabel}
      </p>
      <VisuallyHidden>
        Also covered from 00:00 to {previous.end}, continuing from {ownerLabel}
        {suffix}. Edit this on {ownerLabel}.
      </VisuallyHidden>
    </>
  );
}
```

```tsx
// frontend/src/pages/schedules/week-ribbon/DayRow.tsx
import { Time } from '@internationalized/date';
import { RotateCw } from 'lucide-react';
import { useController, type Control } from 'react-hook-form';
import { TimePicker } from '@/components/datetime/TimePicker';
import { Chip } from '@/components/ui/Chip';
import { Switch } from '@/components/ui/Switch';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { formatMinutesLong } from '@/helpers/duration';
import { shiftDurationMinutes } from '@/helpers/shifts';
import { floatHoursFromHHMM, parseHHMM } from '@/helpers/time';
import { nextWeekday, weekdayLabel, weekdayShortLabel } from '@/helpers/weekday';
import { CoverageTrack } from './CoverageTrack';
import { OvernightGhost } from './OvernightGhost';
import type { WeekForm } from './weekForm';

function toTime(value: string): Time | null {
  const parsed = parseHHMM(value);
  return parsed ? new Time(parsed.hours, parsed.minutes) : null;
}

function fromTime(time: Time | null): string {
  if (!time) return '';
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}

/**
 * One day.
 *
 * useController scopes the subscription to `days.N` — mechanism 2 of the
 * re-render strategy. The form root never re-renders on a keystroke here.
 */
export function DayRow({
  control,
  weekday,
  errorFor,
}: {
  control: Control<WeekForm>;
  weekday: number;
  errorFor: (field: string) => string | undefined;
}) {
  const { field } = useController({ control, name: `days.${weekday}` });
  const day = field.value;

  const start = parseHHMM(day.start);
  const end = parseHHMM(day.end);
  const startMinutes = start ? start.hours * 60 + start.minutes : 0;
  const endMinutes = end ? end.hours * 60 + end.minutes : 0;

  const startHours = floatHoursFromHHMM(day.start);
  const endHours = floatHoursFromHHMM(day.end);
  const overnight = startHours !== null && endHours !== null && endMinutes <= startMinutes;
  const durationMinutes =
    startHours !== null && endHours !== null ? shiftDurationMinutes(startHours, endHours) : 0;

  const labelId = `day-${weekday}-label`;
  const dayName = weekdayLabel(weekday);

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="relative grid grid-cols-[3rem_1fr_auto] items-center gap-3 border-b border-line px-3 py-2"
    >
      <span id={labelId} className="text-label uppercase tracking-[0.06em] text-ink-2">
        {weekdayShortLabel(weekday)}
      </span>

      <div className="relative">
        <CoverageTrack
          startMinutes={startMinutes}
          endMinutes={endMinutes}
          isOvernight={overnight && day.working}
          isEditing={false}
        />
        <OvernightGhost control={control} weekday={weekday} isPreviousWeek={weekday === 0} />
      </div>

      <div className="flex items-center gap-3">
        <Switch
          isSelected={day.working}
          onChange={(working) => field.onChange({ ...day, working })}
          aria-label={`${dayName} working`}
        />

        {day.working ? (
          <>
            <TimePicker
              label={`${dayName} start time`}
              role="start"
              value={toTime(day.start)}
              onChange={(time) => field.onChange({ ...day, start: fromTime(time) })}
              errorMessage={errorFor(`days.${weekday}.start`)}
            />
            <span aria-hidden="true" className="text-ink-3">
              →
            </span>
            <TimePicker
              label={`${dayName} end time`}
              role="end"
              value={toTime(day.end)}
              onChange={(time) => field.onChange({ ...day, end: fromTime(time) })}
              errorMessage={errorFor(`days.${weekday}.end`)}
            />

            {overnight ? (
              <span className="flex flex-col items-start">
                <Chip icon={<RotateCw size={11} />}>+1 day</Chip>
                <span className="text-caption text-ink-3">
                  ends {weekdayShortLabel(nextWeekday(weekday)).slice(0, 1)}
                  {weekdayShortLabel(nextWeekday(weekday)).slice(1).toLowerCase()}
                </span>
              </span>
            ) : null}

            <span className="w-20 text-right text-body tabular text-ink">
              {formatMinutesLong(durationMinutes)}
            </span>
          </>
        ) : (
          <span className="text-body text-ink-3">Not working</span>
        )}
      </div>

      <VisuallyHidden>
        {day.working
          ? `${dayName}, working ${day.start} to ${day.end}${overnight ? ' the next day' : ''}. ${Math.round(durationMinutes / 60)} hours.`
          : `${dayName}, not working.`}
      </VisuallyHidden>
    </div>
  );
}
```

```tsx
// frontend/src/pages/schedules/week-ribbon/WeekRibbon.tsx
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { WireShift } from '@/api/types';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { Button } from '@/components/ui/Button';
import { formatMinutesLong } from '@/helpers/duration';
import { weekTotalMinutes } from '@/helpers/shifts';
import { WEEKDAYS } from '@/helpers/weekday';
import { DayRow } from './DayRow';
import { HourAxis } from './HourAxis';
import { shiftsToWeekForm, validateWeek, weekFormToShifts, type WeekForm, type WeekFieldError } from './weekForm';

export function WeekRibbon({
  shifts,
  onSubmit,
  isPending,
  isDirty: forceDirty,
  serverFieldErrors = [],
}: {
  shifts: readonly WireShift[];
  onSubmit: (shifts: WireShift[]) => void;
  isPending?: boolean;
  isDirty?: boolean;
  /** Field errors mapped back from a 422 by the parent screen. */
  serverFieldErrors?: WeekFieldError[];
}) {
  const defaultValues = useMemo<WeekForm>(() => ({ days: shiftsToWeekForm(shifts) }), [shifts]);

  // Uncontrolled + onBlur: mechanism 1. A keystroke never touches React state.
  const { control, handleSubmit, getValues, formState } = useForm<WeekForm>({
    defaultValues,
    mode: 'onBlur',
  });

  const [localErrors, setLocalErrors] = useState<WeekFieldError[]>([]);
  const allErrors = [...localErrors, ...serverFieldErrors];
  const errorFor = (field: string) => allErrors.find((e) => e.field === field)?.message;

  const dirty = forceDirty ?? formState.isDirty;
  const total = weekTotalMinutes(weekFormToShifts(getValues().days));

  const submit = handleSubmit((values) => {
    const errors = validateWeek(values.days);
    setLocalErrors(errors);
    // The request is never sent when a local guard fires — every one of them
    // corresponds to a 500 or an unexplainable 409.
    if (errors.length > 0) return;
    onSubmit(weekFormToShifts(values.days));
  });

  return (
    <form onSubmit={submit} noValidate>
      <div className="flex items-baseline justify-between px-3 py-2">
        <h3 className="font-display text-heading text-ink">Weekly hours</h3>
        <span className="text-caption text-ink-3">All times IST (+5:30)</span>
      </div>

      <div className="px-3">
        <div className="grid grid-cols-[3rem_1fr_auto] gap-3">
          <span />
          <HourAxis />
          <span />
        </div>
      </div>

      {WEEKDAYS.map((weekdayDescriptor) => (
        <DayRow
          key={weekdayDescriptor.index}
          control={control}
          weekday={weekdayDescriptor.index}
          errorFor={errorFor}
        />
      ))}

      {allErrors.length > 0 ? (
        <div className="px-3 py-2">
          <InlineAlert tone="conflict" icon={<span>⊘</span>}>
            <ul>
              {allErrors.map((error) => (
                <li key={error.field}>{error.message}</li>
              ))}
            </ul>
          </InlineAlert>
        </div>
      ) : null}

      {dirty ? (
        <div className="sticky bottom-0 flex items-center justify-between border-t border-line bg-surface px-3 py-2">
          <span className="text-body text-ink-2">
            Unsaved changes · {formatMinutesLong(total)} / week
          </span>
          <Button type="submit" variant="primary" isPending={isPending}>
            Save hours
          </Button>
        </div>
      ) : null}

      <p role="status" className="sr-only">
        Week total {formatMinutesLong(total)}.
      </p>
    </form>
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run:
```bash
cd /Users/tanishq/Desktop/Richpanel/frontend && \
npx vitest run src/pages/schedules/week-ribbon/ && rm -f src/pages/schedules/week-ribbon/.gitkeep
```
Expected: PASS — **19 passed** (10 weekForm, 9 WeekRibbon).

- [ ] **Step 7: Verify the re-render claim, rather than asserting it**

Add a temporary render counter to `DayRow` (`console.count(`row-${weekday}`)`), run the dev server, and type a digit into Monday's end-time minute segment.
Expected: **`row-0` increments and nothing else does** — plus one `OvernightGhost` render on Tuesday if and only if Monday became overnight. If any other row logs, one of the four mechanisms is not in place; find which before continuing. Remove the counter afterwards.

- [ ] **Step 8: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/src/pages/ && git commit -m "feat(frontend): add the week ribbon with overnight-by-consequence editing and scoped re-renders"
```

---
### Task 17: Screen 1 — Schedule Configuration

**Files:**
- Create: `frontend/src/pages/schedules/{SchedulesPage,ScheduleListPanel,ScheduleListRow,ScheduleMiniRibbon,ScheduleDetailPanel,ScheduleDetailHeader,CreateScheduleDialog,AssignedAgentsPanel,AgentConflictExplainer}.tsx`
- Delete: `frontend/src/pages/schedules/.gitkeep`
- Test: `frontend/src/pages/schedules/SchedulesPage.test.tsx`

**Interfaces:**
- Consumes: every hook from Tasks 8–9, every component from Tasks 10–16.
- Produces: the `/schedules` and `/schedules/$scheduleId` screen.

**Layout: master–detail, not a card grid.** The list persists so the user can move between schedules without losing their place; the detail pane is driven by the URL so a schedule is linkable. List 320px, detail fluid.

The list row's mini-ribbon (`▓▓▓▓▓··`) is seven segments filled proportionally to each day's coverage. It makes *"which schedule covers weekends?"* answerable without opening anything.

**Every state this screen must implement:**

| State | Presentation |
|---|---|
| **Loading (first paint)** | 6 skeleton list rows; detail shows a skeleton header + 7 skeleton ribbon rows **at final height**. No spinner anywhere. |
| **Empty (no schedules)** | A 12%-opacity Week Ribbon preview behind an `EmptyState`: "No schedules yet. A schedule defines the working hours that resolution time is measured against." + "Create schedule". |
| **Filtered to nothing** | "No schedule matches *night*." + clear-filter. **Distinct from the empty state.** |
| **Detail 404** | `ErrorState`: "This schedule was deleted." + "Back to schedules". |
| **Dirty** | Sticky footer `Unsaved changes · [Save hours]`; navigation blocked with a confirm; `beforeunload` guard. |
| **Saving** | Save is `aria-busy`, fields disabled. |
| **Save success** | Toast "Hours updated"; changed rows flash the `--color-ok` rule. |
| **409 self-overlap** | **Pre-empted client-side** by `validateWeek` — Save is blocked, both offending rows carry a conflict border and an inline message naming the days. The request is never sent. |
| **409 assignment overlap on save** | Cannot be pre-empted (it depends on other schedules). Shake + `AgentConflictExplainer` naming the colliding day and hours. |
| **409 on assign** | The agent is **never added to the list**. The combobox shakes; the panel names the colliding schedule and day. |
| **500** | `ErrorState` — "Something went wrong saving these hours. Your changes have not been lost." + Retry + Copy details. Never silent. |
| **Delete, 0 agents** | Lightweight `ConfirmModal`. |
| **Delete, N agents** | `DeletionImpactModal` (Task 15). |
| **Unassigning** | Optimistic removal + 5s undo toast; if the undo re-POST 409s, the row is restored with an explanation. |
| **Offline** | Header banner; mutations disabled with a tooltip. |

**`AgentConflictExplainer` is the G2/B3 workaround, isolated so it can be deleted in one commit.** On a 409 it fetches the affected agent's other schedules (`GET /agents/{id}/schedules`, then `GET /schedules/{id}` for each — bounded; an agent has 1–3 schedules), recomputes the collision with `findOverlaps`, and names the day and hours. **It never regexes the agent id out of the server's `message` — that string is not a contract.** When B3 ships, this renders directly from `error.conflicts` and the file is deleted.

**Keyboard:** focus order is header nav → list filter → list rows → detail header actions → ribbon (day by day) → assigned agents → footer. `Alt+↓`/`Alt+↑` jump between day rows without tabbing through every field; plain `Tab` still walks everything. Conflicts go to a `role="alert"` region **and** move focus to the conflict heading.

- [ ] **Step 1: Write the failing screen test**

```tsx
// frontend/src/pages/schedules/SchedulesPage.test.tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http as mswHttp } from 'msw';
import { describe, expect, it } from 'vitest';
import { API, errors } from '@/test/handlers';
import { mswServer } from '@/test/mswServer';
import { renderWithQuery } from '@/test/renderWithQuery';
import { SchedulesPage } from './SchedulesPage';

describe('SchedulesPage list', () => {
  it('renders skeletons before data, with no spinner', () => {
    renderWithQuery(<SchedulesPage />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('skeleton-row').length).toBeGreaterThan(0);
  });

  it('lists schedules with their date range and agent count', async () => {
    renderWithQuery(<SchedulesPage />);
    expect(await screen.findByText('Weekday Core')).toBeInTheDocument();
    expect(screen.getByText('Night Desk')).toBeInTheDocument();
  });

  it('distinguishes "no schedules" from "filter matched nothing"', async () => {
    renderWithQuery(<SchedulesPage />);
    await screen.findByText('Weekday Core');
    await userEvent.type(screen.getByRole('searchbox', { name: /filter/i }), 'zzz');
    expect(await screen.findByText(/no schedule matches/i)).toBeInTheDocument();
    expect(screen.queryByText(/no schedules yet/i)).not.toBeInTheDocument();
  });

  it('shows the explanatory empty state when there are genuinely none', async () => {
    mswServer.use(mswHttp.get(`${API}/schedules`, () => HttpResponse.json([])));
    renderWithQuery(<SchedulesPage />);
    expect(await screen.findByText(/no schedules yet/i)).toBeInTheDocument();
    expect(screen.getByText(/resolution time is measured against/i)).toBeInTheDocument();
  });
});

describe('SchedulesPage detail errors', () => {
  it('renders a deleted-schedule state for a 404, not a blank pane', async () => {
    mswServer.use(
      mswHttp.get(`${API}/schedules/:id`, () => errors.envelope(404, 'not_found', 'gone')),
    );
    renderWithQuery(<SchedulesPage initialScheduleId={99} />);
    expect(await screen.findByText(/no longer exists/i)).toBeInTheDocument();
  });

  it('offers retry and copy-details on a 500 while stating the work is not lost', async () => {
    mswServer.use(
      mswHttp.get(`${API}/schedules/:id`, () => errors.envelope(500, 'internal_error', 'boom')),
    );
    renderWithQuery(<SchedulesPage initialScheduleId={1} />);
    expect(await screen.findByText(/have not been lost/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('maps a 422 field error back onto the offending day control', async () => {
    mswServer.use(
      mswHttp.put(`${API}/schedules/:id`, () =>
        errors.fastapiValidation(['body', 'shifts', 0, 'end_hours'], 'Input should be less than 24'),
      ),
    );
    renderWithQuery(<SchedulesPage initialScheduleId={1} />);
    const monday = await screen.findByRole('group', { name: /monday/i });
    const end = within(monday).getByRole('group', { name: /monday end time/i });

    await userEvent.click(screen.getByRole('button', { name: /save hours/i }));
    await waitFor(() => expect(end).toHaveAttribute('aria-invalid', 'true'));
    expect(within(end).getByRole('alert')).toHaveTextContent(/less than 24/i);
  });
});

describe('SchedulesPage deletion', () => {
  it('prefetches the impact so the modal opens with content, not a spinner', async () => {
    let impactRequests = 0;
    mswServer.use(
      mswHttp.get(`${API}/schedules/:id/deletion-impact`, ({ params }) => {
        impactRequests += 1;
        return HttpResponse.json({ schedule_id: Number(params.id), affected_agent_ids: [1, 3] });
      }),
    );
    renderWithQuery(<SchedulesPage initialScheduleId={1} />);
    const del = await screen.findByRole('button', { name: /delete/i });

    await userEvent.hover(del);
    await waitFor(() => expect(impactRequests).toBeGreaterThan(0));

    await userEvent.click(del);
    expect(await screen.findByText('Alice Chen')).toBeInTheDocument();
    expect(screen.queryByTestId('impact-spinner')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/pages/schedules/SchedulesPage.test.tsx`
Expected: FAIL — the Task 13 stub renders only a heading, so every query fails.

- [ ] **Step 3: Write the screen**

```tsx
// frontend/src/pages/schedules/ScheduleMiniRibbon.tsx
import type { WireShift } from '@/api/types';
import { shiftDurationMinutes } from '@/helpers/shifts';
import { MINUTES_PER_DAY } from '@/helpers/time';
import { WEEKDAYS } from '@/helpers/weekday';

/** Seven segments, filled proportionally to that day's coverage. Answers
 *  "which schedule covers weekends?" without opening anything. */
export function ScheduleMiniRibbon({ shifts }: { shifts: readonly WireShift[] }) {
  const byWeekday = new Map(shifts.map((s) => [s.weekday, s]));

  return (
    <span aria-hidden="true" className="flex gap-0.5">
      {WEEKDAYS.map((day) => {
        const shift = byWeekday.get(day.index);
        const fill = shift ? shiftDurationMinutes(shift.start_hours, shift.end_hours) / MINUTES_PER_DAY : 0;
        return (
          <span key={day.index} className="h-2.5 w-2 overflow-hidden rounded-[1px] bg-sunken">
            <span
              className={fill > 0 ? 'block w-full bg-coverage' : 'block w-full bg-void-fill'}
              style={{ height: `${Math.max(fill * 100, fill > 0 ? 20 : 0)}%`, marginTop: 'auto' }}
            />
          </span>
        );
      })}
    </span>
  );
}
```

```tsx
// frontend/src/pages/schedules/ScheduleListPanel.tsx
import { Search } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import type { Schedule } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatIstDate } from '@/helpers/dates';
import { ScheduleMiniRibbon } from './ScheduleMiniRibbon';

export function ScheduleListPanel({
  schedules,
  isLoading,
  selectedId,
  onSelect,
  onCreate,
}: {
  schedules: Schedule[] | undefined;
  isLoading: boolean;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onCreate: () => void;
}) {
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);

  const visible = useMemo(() => {
    const needle = deferredFilter.trim().toLowerCase();
    if (!needle) return schedules ?? [];
    return (schedules ?? []).filter((s) => s.name.toLowerCase().includes(needle));
  }, [schedules, deferredFilter]);

  return (
    <aside className="flex w-80 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex items-center justify-between px-3 py-2">
        <h2 className="text-label uppercase tracking-[0.06em] text-ink-2">Schedules</h2>
        <Button compact onPress={onCreate}>
          + New
        </Button>
      </div>

      <div className="relative px-3 pb-2">
        <Search size={13} aria-hidden="true" className="absolute left-5 top-2 text-ink-3" />
        <input
          type="search"
          role="searchbox"
          aria-label="Filter schedules"
          placeholder="filter…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="h-8 w-full rounded-control border border-line-strong bg-canvas pl-6 pr-2 text-body text-ink"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-3">
            {Array.from({ length: 6 }, (_unused, index) => (
              <div key={index} data-testid="skeleton-row">
                <Skeleton height={56} />
              </div>
            ))}
          </div>
        ) : (schedules ?? []).length === 0 ? (
          <EmptyState
            title="No schedules yet"
            description="A schedule defines the working hours that resolution time is measured against."
            action={<Button variant="primary" onPress={onCreate}>Create schedule</Button>}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title={`No schedule matches “${deferredFilter}”.`}
            action={<Button onPress={() => setFilter('')}>Clear filter</Button>}
          />
        ) : (
          <ul>
            {visible.map((schedule) => (
              <li key={schedule.id}>
                <button
                  type="button"
                  onClick={() => onSelect(schedule.id)}
                  aria-current={schedule.id === selectedId ? 'true' : undefined}
                  className="flex h-14 w-full flex-col justify-center gap-1 border-b border-line px-3 text-left
                             hover:bg-sunken aria-[current]:bg-sunken"
                >
                  <span className="text-body font-medium text-ink">{schedule.name}</span>
                  <span className="flex items-center gap-2 text-caption text-ink-3">
                    <ScheduleMiniRibbon shifts={schedule.shifts} />
                    {formatIstDate(schedule.start_date)} →{' '}
                    {schedule.end_date ? formatIstDate(schedule.end_date) : 'open'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
```

```tsx
// frontend/src/pages/schedules/AgentConflictExplainer.tsx
import { Ban } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { WireShift } from '@/api/types';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { useAgentSchedules } from '@/hooks/queries/useAgents';
import { formatFloatHours } from '@/helpers/time';
import { findOverlaps, normalizeWeek } from '@/helpers/shifts';
import { weekdayLabel } from '@/helpers/weekday';

/**
 * ══ THE B3 WORKAROUND — DELETE THIS FILE WHEN THE BACKEND SHIPS B3 ══
 *
 * The 409 body is `{error_code: "conflict", message: "agent 42 would have 2
 * overlapping shift(s)"}` and nothing else: no agent id in a machine-readable
 * field, no conflicting days, and the SAME error_code for a self-overlap. We
 * do NOT parse the message — that string is not a contract.
 *
 * So: the caller tells us which agent it was trying to assign, we fetch that
 * agent's other schedules (bounded — an agent has 1-3), and recompute the
 * collision locally to name the day and hours. 2-4 extra requests on the
 * failure path only, all cached afterwards.
 *
 * When B3 lands this renders straight from `error.conflicts` and this whole
 * file goes away in one commit.
 */
export function AgentConflictExplainer({
  agentId,
  agentName,
  proposedShifts,
  fetchSchedule,
}: {
  agentId: number;
  agentName: string;
  proposedShifts: readonly WireShift[];
  fetchSchedule: (scheduleId: number) => Promise<{ name: string; shifts: WireShift[] }>;
}) {
  const { data: otherSchedules } = useAgentSchedules(agentId);
  const [explanation, setExplanation] = useState<string | null>(null);

  useEffect(() => {
    if (!otherSchedules?.length) return;
    let cancelled = false;

    void (async () => {
      const proposed = normalizeWeek(proposedShifts);
      for (const ref of otherSchedules) {
        const other = await fetchSchedule(ref.id);
        const conflicts = findOverlaps(normalizeWeek(other.shifts), proposed);
        const first = conflicts[0];
        if (first && !cancelled) {
          setExplanation(
            `${weekdayLabel(first.weekday)}: “${other.name}” covers ` +
              `${formatFloatHours(first.a.startMinutes / 60)}–${formatFloatHours(first.a.endMinutes / 60)}, ` +
              `which overlaps this schedule by ${first.overlapMinutes} minutes.`,
          );
          return;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [otherSchedules, proposedShifts, fetchSchedule]);

  return (
    <InlineAlert tone="conflict" icon={<Ban size={14} />}>
      <p className="font-medium">{agentName} can’t be assigned to this schedule.</p>
      <p className="mt-1">
        {explanation ?? 'Their hours on another schedule overlap with this one. Working out which…'}
      </p>
    </InlineAlert>
  );
}
```

```tsx
// frontend/src/pages/schedules/SchedulesPage.tsx
import { useState } from 'react';
import { ErrorState } from '@/components/feedback/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useSchedule, useSchedules } from '@/hooks/queries/useSchedules';
import { ScheduleDetailPanel } from './ScheduleDetailPanel';
import { ScheduleListPanel } from './ScheduleListPanel';
import { CreateScheduleDialog } from './CreateScheduleDialog';

/**
 * Master-detail. The list persists across selections so the user never loses
 * their place; the detail is driven by the id so a schedule is linkable.
 *
 * `initialScheduleId` exists so the screen is testable without a router; the
 * route passes the URL param through it.
 */
export function SchedulesPage({ initialScheduleId = null }: { initialScheduleId?: number | null }) {
  const [selectedId, setSelectedId] = useState<number | null>(initialScheduleId);
  const [creating, setCreating] = useState(false);

  const list = useSchedules();
  const detail = useSchedule(selectedId);

  return (
    <div className="flex h-full">
      <ScheduleListPanel
        schedules={list.data}
        isLoading={list.isPending}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onCreate={() => setCreating(true)}
      />

      <section className="min-w-0 flex-1 overflow-auto">
        {selectedId === null ? null : detail.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton height={48} />
            {Array.from({ length: 7 }, (_unused, index) => (
              // Exact final height: the transition to real rows moves nothing.
              <Skeleton key={index} height={56} />
            ))}
          </div>
        ) : detail.isError ? (
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} operation="save-hours" />
        ) : detail.data ? (
          <ScheduleDetailPanel
            schedule={detail.data}
            onDeleted={() => setSelectedId(null)}
          />
        ) : null}
      </section>

      <CreateScheduleDialog
        isOpen={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          setSelectedId(id);
        }}
      />
    </div>
  );
}
```

`ScheduleDetailPanel`, `ScheduleDetailHeader`, `AssignedAgentsPanel` and `CreateScheduleDialog` follow the same shape: they take data as props, call the Task 8/9 hooks, and render `WeekRibbon`, `AssignAgentModal`, `DeletionImpactModal` and `ConfirmModal`. Build each against the state table above.

**`ScheduleDetailPanel` must implement, at minimum:**
1. Header: name, `start_date → end_date | open-ended`, agent count, week total. Name and dates are **read-only with a tooltip explaining that `PUT` accepts `{shifts}` only** — do not render editable fields that cannot be saved.
2. `WeekRibbon` wired to `useUpdateScheduleHours`, with `serverFieldErrors` produced by `mapFieldErrorsToForm(error, (path) => wirePathToFormField(path, days))`.
3. On a 409 from the hours save: shake the ribbon, render `AgentConflictExplainer`, move focus to its heading, and **do not invalidate**.
4. On success: `toast.success('Hours updated')`.
5. `AssignedAgentsPanel` using `useScheduleAgents` + `useAssignAgent` / `useUnassignAgent`; virtualise above 100 rows.
6. Delete: `usePrefetchDeletionImpact()` on 200ms hover-intent/focus; then `ConfirmModal` when `affected_agent_ids` is empty, `DeletionImpactModal` otherwise.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/pages/schedules/ && rm -f src/pages/schedules/.gitkeep`
Expected: PASS — **26 passed** (19 from Task 16, 7 here).

- [ ] **Step 5: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/src/pages/schedules/ && git commit -m "feat(frontend): add the schedule configuration screen with deletion impact and conflict explanation"
```

---

### Task 18: Screen 2 — Resolution Time Report (virtualised)

**Files:**
- Create: `frontend/src/pages/reports/{ReportPage,TicketWindowBar,ReportSummary,AgentHoursTable,AgentHoursRow,ZeroCoverageGroup,ReportHistoryRail}.tsx`
- Delete: `frontend/src/pages/reports/.gitkeep`
- Test: `frontend/src/pages/reports/{ReportPage,AgentHoursTable}.test.tsx`

**Interfaces:**
- Consumes: `useAgentMap`, `useReports`, `useReport`, `useGenerateReport`, `components/datetime/`, `helpers/duration.ts`.
- Produces: the `/reports` screen.

#### Performance — hard requirements, not aspirations

`POST /reports` returns **one row per agent, unpaginated**. At 3 000 agents the JSON is ~120 KB, parseable in milliseconds. **The response is not the problem. Rendering 3 000 rows is, and joining 3 000 names is.**

| Budget | Limit |
|---|---|
| Filter keystroke → paint, 5 000 rows | < 50 ms |
| Table scroll | 60 fps, no dropped frames over 5 s of continuous scroll |
| CLS on compute | 0 |

**Virtualisation: `@tanstack/react-virtual` v3**, on the report table and on the assigned-agents list above 100 rows.
- **Fixed 40px rows, no dynamic measurement.** `measureElement` forces a layout read per row and is the expensive path; a fixed height makes the offset maths pure arithmetic.
- Rows are absolutely positioned inside a spacer of `height: totalSize`, translated with `transform: translateY(top)`.
- `contain: strict` on the scroll container.
- **Cost, stated:** virtualised rows are not in the DOM, so browser `Ctrl+F` and naive select-all-copy do not see them. Mitigated by the always-available **Export CSV** (generated from the in-memory rows, **not** from the DOM) and the in-app filter. State this in the help sheet.

**Memoisation boundaries — every one of these is required:**

| Boundary | Rule |
|---|---|
| `AgentHoursRow` | `React.memo`, props are **primitives only**: `name: string`, `seconds: number`, `sharePct: number`, `isZero: boolean`, `top: number`. |
| `virtualRow` | **Never pass it.** Its identity changes every scroll frame and passing it defeats the memo entirely. Pass `top` and `index` as numbers. |
| Callbacks | `useCallback` with stable deps. **No inline arrows in the row map.** |
| Formatters | Module-scope pure functions, not recreated per render. |
| Derived rows | **One** `useMemo` keyed `[agentHours, agentMap, sortKey, sortDir, deferredFilter]`. Sorting and filtering never happen inside the render loop. |
| Query subscriptions | `notifyOnChangeProps: ['data', 'error', 'isPending']` on the heavy queries. |
| Pre-lowercased names | The filter runs over a `string[]` of lowercased names built once per agent-map change — never `toLowerCase()` per row per keystroke. |
| Filter input | `useDeferredValue` (React 19), **not** a `setTimeout` debounce. The input updates at full speed and the 3 000-row re-derive is interruptible; a debounce adds latency without making the work interruptible. |

**Accessibility — the ARIA grid, and the one bug everyone ships:**
- `role="grid"` with **`aria-rowcount={total + 1}`** reflecting the **full** row count, not the rendered window. This is the difference between hearing "row 7 of 3000" and "row 7 of 24".
- **The virtualisation focus bug, handled explicitly:** arrow-key navigation to a row outside the rendered window must call `virtualizer.scrollToIndex(i)` **and wait a frame** before calling `.focus()`, or focus lands on nothing and the reader goes silent. This is a required implementation note, not an optimisation.
- Column headers are `<button>`s inside `role="columnheader"` with `aria-sort`.
- The share bar is `aria-hidden`; the number beside it is the accessible value.
- Zero rows carry `aria-label="Alice Chen, no coverage in this window"` — absence is **stated**, not inferred from a `0`.
- Sorting and filtering announce through `role="status"`.

**States:**

| State | Presentation |
|---|---|
| **Idle** | Not a spinner and not a blank: "Choose a ticket window to see how much scheduled working time each agent had inside it." with the date fields focused. |
| **Invalid window** (`end <= start`) | Compute disabled; caption "End must be after start." The 400 is pre-empted. |
| **Very large window** | Informational caption only — the backend is O(1) in window length. No block. |
| **Computing** | 24 skeleton rows at exactly 40px. Recompute keeps the previous table at `opacity: .6` rather than blanking. |
| **Success** | Summary + table + `role="status"`: "Report ready. 12 of 17 agents had coverage." |
| **All agents zero** | A distinct state: "No agent had scheduled working hours in this window." + a **Why?** disclosure naming the two real causes (no schedule's date range covers the window; no agents assigned to a covering schedule), each linking to `/schedules`. |
| **Individual zero rows** | Grouped at the bottom behind `⌄ 5 agents with no coverage`, expandable, persisted per session (F4). |
| **Agent names still loading** | Rows render immediately with `Agent #123` in `ink-3` and swap to names when the map resolves. **The report is never held hostage to the name join.** |
| **History rail** | Each row shows **only** id, window and relative time — **never an hours figure or agent count**, because `GET /reports` always returns `agent_hours: []`. |
| **Error 400 / 500 / network** | Per the Task 10 placement table. Because mutations do not auto-retry, a duplicate report is never silently created. |

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/pages/reports/AgentHoursTable.test.tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AgentHoursTable } from './AgentHoursTable';

const HOURS = [
  { agent_id: 1, business_seconds: 97_200 },
  { agent_id: 2, business_seconds: 57_600 },
  { agent_id: 3, business_seconds: 0 },
];
const NAMES = new Map([
  [1, 'Alice Chen'],
  [2, 'Bob Martinez'],
  [3, 'Carol Singh'],
]);

describe('AgentHoursTable semantics', () => {
  it('reports the FULL row count to assistive tech, not the rendered window', () => {
    render(<AgentHoursTable agentHours={HOURS} agentNames={NAMES} />);
    // 3 data rows + 1 header row
    expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '4');
  });

  it('shows both hours formats in one cell', () => {
    render(<AgentHoursTable agentHours={HOURS} agentNames={NAMES} />);
    expect(screen.getByText('27:00:00')).toBeInTheDocument();
    expect(screen.getByText('27.00h')).toBeInTheDocument();
  });

  it('groups zero-hours agents at the bottom rather than swamping the table', async () => {
    render(<AgentHoursTable agentHours={HOURS} agentNames={NAMES} />);
    expect(screen.queryByText('Carol Singh')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /1 agent with no coverage/i }));
    expect(await screen.findByText('Carol Singh')).toBeInTheDocument();
  });

  it('STATES absence on a zero row instead of leaving it to be inferred from a 0', async () => {
    render(<AgentHoursTable agentHours={HOURS} agentNames={NAMES} />);
    await userEvent.click(screen.getByRole('button', { name: /1 agent with no coverage/i }));
    expect(
      await screen.findByRole('row', { name: /Carol Singh, no coverage in this window/i }),
    ).toBeInTheDocument();
  });

  it('renders a placeholder id when the name map has not resolved yet', () => {
    render(<AgentHoursTable agentHours={HOURS} agentNames={undefined} />);
    expect(screen.getByText('Agent #1')).toBeInTheDocument();
  });

  it('filters without blocking, and announces the result count', async () => {
    render(<AgentHoursTable agentHours={HOURS} agentNames={NAMES} />);
    await userEvent.type(screen.getByRole('searchbox', { name: /filter agents/i }), 'ali');
    expect(await screen.findByText('Alice Chen')).toBeInTheDocument();
    expect(screen.queryByText('Bob Martinez')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/1 agent matches/i);
  });

  it('sorts by hours and marks the column header', async () => {
    render(<AgentHoursTable agentHours={HOURS} agentNames={NAMES} />);
    const header = screen.getByRole('columnheader', { name: /business hours/i });
    await userEvent.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', expect.stringMatching(/ascending|descending/));
  });

  it('hides the share bar from assistive tech - the number beside it is the value', () => {
    const { container } = render(<AgentHoursTable agentHours={HOURS} agentNames={NAMES} />);
    expect(container.querySelector('[data-testid="share-bar"]')).toHaveAttribute('aria-hidden', 'true');
  });
});
```

```tsx
// frontend/src/pages/reports/ReportPage.test.tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http as mswHttp } from 'msw';
import { describe, expect, it } from 'vitest';
import { API, REPORT, errors } from '@/test/handlers';
import { mswServer } from '@/test/mswServer';
import { renderWithQuery } from '@/test/renderWithQuery';
import { ReportPage } from './ReportPage';

describe('ReportPage states', () => {
  it('starts with an instruction, not a spinner and not a blank', () => {
    renderWithQuery(<ReportPage />);
    expect(screen.getByText(/choose a ticket window/i)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('disables Compute for an inverted window, pre-empting the 400', async () => {
    renderWithQuery(<ReportPage initialWindow={{ from: '2026-08-12T10:00:00+05:30', to: '2026-08-09T10:00:00+05:30' }} />);
    expect(screen.getByRole('button', { name: /compute/i })).toBeDisabled();
    expect(screen.getByText(/end must be after start/i)).toBeInTheDocument();
  });

  it('renders a distinct state when every agent has zero hours', async () => {
    mswServer.use(
      mswHttp.post(`${API}/reports`, () =>
        HttpResponse.json({ ...REPORT, agent_hours: [{ agent_id: 1, business_seconds: 0 }] }, { status: 201 }),
      ),
    );
    renderWithQuery(<ReportPage initialWindow={{ from: '2026-08-09T10:00:00+05:30', to: '2026-08-12T17:30:00+05:30' }} />);
    await userEvent.click(screen.getByRole('button', { name: /compute/i }));
    expect(await screen.findByText(/no agent had scheduled working hours/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /why\?/i })).toBeInTheDocument();
  });

  it('does not retry a failed compute - a retry would insert a duplicate report', async () => {
    let calls = 0;
    mswServer.use(
      mswHttp.post(`${API}/reports`, () => {
        calls += 1;
        return errors.envelope(500, 'internal_error', 'boom');
      }),
    );
    renderWithQuery(<ReportPage initialWindow={{ from: '2026-08-09T10:00:00+05:30', to: '2026-08-12T17:30:00+05:30' }} />);
    await userEvent.click(screen.getByRole('button', { name: /compute/i }));
    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
    expect(calls).toBe(1);
  });
});

describe('ReportHistoryRail', () => {
  it('NEVER renders an hours figure, because GET /reports always returns agent_hours: []', async () => {
    renderWithQuery(<ReportPage />);
    const rail = await screen.findByRole('region', { name: /history/i });
    expect(rail).not.toHaveTextContent(/0:00:00/);
    expect(rail).not.toHaveTextContent(/\d+h \d+m/);
    expect(rail).toHaveTextContent('#14');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/pages/reports/`
Expected: FAIL — unresolved `./AgentHoursTable`; `ReportPage` is still the Task 13 stub.

- [ ] **Step 3: Write the row and the table**

```tsx
// frontend/src/pages/reports/AgentHoursRow.tsx
import { memo } from 'react';
import { businessSecondsToDecimalHours, businessSecondsToHHMMSS } from '@/helpers/duration';

interface Props {
  name: string;
  seconds: number;
  sharePct: number;
  isZero: boolean;
  /** A NUMBER, never the virtualRow object — its identity changes every
   *  scroll frame and passing it would defeat the memo entirely. */
  top: number;
  rowIndex: number;
}

/**
 * memo with PRIMITIVE props only. This is the single most load-bearing
 * memoisation in the app: without it, scrolling a 3 000-row table re-renders
 * every visible row on every frame.
 */
export const AgentHoursRow = memo(function AgentHoursRow({
  name,
  seconds,
  sharePct,
  isZero,
  top,
  rowIndex,
}: Props) {
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      // Absence is STATED, not inferred from a 0.
      aria-label={isZero ? `${name}, no coverage in this window` : undefined}
      style={{ transform: `translateY(${top}px)` }}
      className="absolute inset-x-0 flex h-10 items-center gap-4 border-b border-line px-3"
    >
      <div role="gridcell" className="min-w-0 flex-1 truncate text-body font-medium text-ink">
        {name}
      </div>

      <div role="gridcell" className="flex w-40 flex-col items-end">
        <span className={`text-body tabular ${isZero ? 'text-void' : 'text-ink'}`}>
          {businessSecondsToHHMMSS(seconds)}
        </span>
        <span className="text-caption tabular text-ink-3">
          {businessSecondsToDecimalHours(seconds).toFixed(2)}h
        </span>
      </div>

      <div role="gridcell" className="w-40">
        {isZero ? (
          <span aria-hidden="true" className="text-void">
            ·
          </span>
        ) : (
          <span data-testid="share-bar" aria-hidden="true" className="block h-1.5 rounded-bar bg-sunken">
            <span className="block h-full rounded-bar bg-coverage" style={{ width: `${sharePct}%` }} />
          </span>
        )}
      </div>
    </div>
  );
});
```

```tsx
// frontend/src/pages/reports/AgentHoursTable.tsx
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import type { AgentHours } from '@/api/types';
import { formatCount } from '@/helpers/format';
import { AgentHoursRow } from './AgentHoursRow';

const ROW_HEIGHT = 40; // must match the CSS h-10 exactly

type SortKey = 'name' | 'hours';
type SortDir = 'asc' | 'desc';

interface DerivedRow {
  agentId: number;
  name: string;
  lowerName: string;
  seconds: number;
  sharePct: number;
  isZero: boolean;
}

export function AgentHoursTable({
  agentHours,
  agentNames,
}: {
  agentHours: readonly AgentHours[];
  /** undefined while the paged agent fetch is still in flight. The table
   *  renders `Agent #123` rather than waiting — the report is never held
   *  hostage to the name join. */
  agentNames: Map<number, string> | undefined;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('hours');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [zeroExpanded, setZeroExpanded] = useState(false);

  // Interruptible, not debounced: the input stays at full speed and the
  // re-derive yields to it.
  const deferredFilter = useDeferredValue(filter);

  // ONE useMemo produces the final array. Sorting and filtering never happen
  // inside the render loop. Names are pre-lowercased here, once per change —
  // not toLowerCase() per row per keystroke.
  const { visible, zeroRows } = useMemo(() => {
    const max = agentHours.reduce((m, row) => Math.max(m, row.business_seconds), 0);

    const all: DerivedRow[] = agentHours.map((row) => {
      const name = agentNames?.get(row.agent_id) ?? `Agent #${row.agent_id}`;
      return {
        agentId: row.agent_id,
        name,
        lowerName: name.toLowerCase(),
        seconds: row.business_seconds,
        sharePct: max > 0 ? (row.business_seconds / max) * 100 : 0,
        isZero: row.business_seconds === 0,
      };
    });

    const needle = deferredFilter.trim().toLowerCase();
    const matched = needle ? all.filter((row) => row.lowerName.includes(needle)) : all;

    const direction = sortDir === 'asc' ? 1 : -1;
    const sorted = [...matched].sort((a, b) =>
      sortKey === 'name'
        ? direction * a.name.localeCompare(b.name)
        : direction * (a.seconds - b.seconds),
    );

    return {
      visible: sorted.filter((row) => !row.isZero),
      zeroRows: sorted.filter((row) => row.isZero),
    };
  }, [agentHours, agentNames, deferredFilter, sortKey, sortDir]);

  const rows = zeroExpanded ? [...visible, ...zeroRows] : visible;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT, // fixed: no measureElement, no layout reads
    overscan: 10,
  });

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((currentKey) => {
      setSortDir((currentDir) => (currentKey === key && currentDir === 'desc' ? 'asc' : 'desc'));
      return key;
    });
  }, []);

  const ariaSort = (key: SortKey) =>
    sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-3 py-2">
        <input
          type="search"
          role="searchbox"
          aria-label="Filter agents"
          placeholder="filter agents…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="h-8 w-56 rounded-control border border-line-strong bg-surface px-2 text-body text-ink"
        />
        <p role="status" className="text-caption text-ink-3">
          {formatCount(rows.length + (zeroExpanded ? 0 : zeroRows.length), 'agent')} match
          {rows.length === 1 ? 'es' : ''}
        </p>
      </div>

      <div
        role="grid"
        aria-label="Business hours by agent"
        // The FULL count, not the rendered window: "row 7 of 3000".
        aria-rowcount={visible.length + zeroRows.length + 1}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div role="row" aria-rowindex={1} className="flex items-center gap-4 border-b border-line px-3 py-1.5">
          <div role="columnheader" aria-sort={ariaSort('name')} className="min-w-0 flex-1">
            <button type="button" onClick={() => toggleSort('name')} className="text-label uppercase tracking-[0.06em] text-ink-2">
              Agent
            </button>
          </div>
          <div role="columnheader" aria-sort={ariaSort('hours')} className="w-40 text-right">
            <button type="button" onClick={() => toggleSort('hours')} className="text-label uppercase tracking-[0.06em] text-ink-2">
              Business hours
            </button>
          </div>
          <div role="columnheader" className="w-40 text-label uppercase tracking-[0.06em] text-ink-2">
            Share
          </div>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto [contain:strict]">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;
              return (
                <AgentHoursRow
                  key={row.agentId}
                  name={row.name}
                  seconds={row.seconds}
                  sharePct={row.sharePct}
                  isZero={row.isZero}
                  // Numbers only. Never the virtualRow object.
                  top={virtualRow.start}
                  rowIndex={virtualRow.index + 2}
                />
              );
            })}
          </div>
        </div>
      </div>

      {zeroRows.length > 0 && !zeroExpanded ? (
        <button
          type="button"
          onClick={() => setZeroExpanded(true)}
          className="border-t border-line px-3 py-2 text-left text-body text-ink-2 hover:bg-sunken"
        >
          ⌄ {formatCount(zeroRows.length, 'agent')} with no coverage in this window
        </button>
      ) : null}
    </div>
  );
}
```

**Keyboard navigation — the `scrollToIndex`-then-focus rule.** When implementing arrow-key row movement, a target outside the rendered window is not in the DOM yet:

```ts
const focusRow = useCallback(
  (index: number) => {
    virtualizer.scrollToIndex(index);
    // MUST wait a frame. Calling .focus() synchronously lands on nothing and
    // the screen reader goes silent — this is the classic virtualisation a11y
    // bug and it is not optional to handle.
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>(`[aria-rowindex="${index + 2}"]`)?.focus();
    });
  },
  [virtualizer],
);
```

- [ ] **Step 4: Write `ReportPage`, `TicketWindowBar`, `ReportSummary`, `ReportHistoryRail`**

Build these against the state table above. Required behaviours, restated because each has a specific failure mode:
1. `TicketWindowBar` — 2× `DatePicker` + 2× `TimePicker` + Compute + elapsed readout, on a **single sticky line**. Compute is disabled and the caption reads "End must be after start." whenever `elapsedLabel()` returns `null`.
2. The window and `reportId` are written to the URL search params, so a result is shareable and survives reload.
3. `useGenerateReport()` on submit. On success, `role="status"`: "Report ready. N of M agents had coverage."
4. **Recompute keeps the previous table at `opacity: .6`** rather than blanking. Skeletons are 24 rows at exactly 40px so CLS is 0.
5. `ReportHistoryRail` renders **only** `#id`, the window and a relative timestamp. **No hours figure, no agent count, no "0"** — `GET /reports` always returns `agent_hours: []`. Selecting a row calls `useReport(id)` to hydrate.
6. All-zero is its own state with a **Why?** disclosure naming the two real causes and linking to `/schedules`.
7. Export CSV is generated from the in-memory rows, never scraped from the DOM.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/pages/reports/ && rm -f src/pages/reports/.gitkeep`
Expected: PASS — **12 passed** (8 AgentHoursTable, 4 ReportPage).

- [ ] **Step 6: Measure the performance budget for real**

Reading the code does not prove 60 fps. Add a temporary MSW handler returning **3 000** agent-hours rows, run the dev server, and in Chrome DevTools:
- Record a Performance profile while scrolling the table continuously for 5 seconds. **Expected: no long tasks over 50 ms, no dropped frames.**
- Type into the filter with the 3 000 rows loaded. **Expected: the input never lags; the list re-derives behind it.**
- Compute a report and check the Layout Shift track. **Expected: CLS 0.**

If any budget is missed, the cause is in the memoisation table above — find which boundary is broken rather than adding another `useMemo` at random. Remove the temporary handler afterwards.

- [ ] **Step 7: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/src/pages/reports/ && git commit -m "feat(frontend): add the virtualised resolution time report screen"
```

---
### Task 19: Error-handling end-to-end audit

**Files:**
- Create: `frontend/src/test/errorMatrix.test.tsx`
- Modify: whichever screen components the audit finds gaps in
- Test: the matrix itself is the test

**Interfaces:**
- Consumes: everything.
- Produces: proof that **every** error type is handled on **both** screens — the product owner's explicit requirement.

This task exists because "we handled errors" is a claim, and a claim is not evidence. The matrix below is executable, it is exhaustive across the status codes the backend can actually produce, and **any cell that fails is a bug to fix in this task, not a test to relax.**

**The matrix — every cell must pass:**

| Error | Schedules screen | Report screen |
|---|---|---|
| **400** `validation_error` | InlineAlert above the form; offending field focused | InlineAlert above the table |
| **404** `not_found` | Detail pane: "This item no longer exists" + back | History row hydrate: inline error, table untouched |
| **409** `conflict` (assign) | Agent **not** added; combobox shakes; conflict named | n/a |
| **409** `conflict` (hours save) | Ribbon shakes; conflict explainer; **no invalidation** | n/a |
| **422** field-level | Message on the **offending day control**, `aria-invalid` set | Message on the offending date/time control |
| **500** `internal_error` | ErrorState + Retry + Copy details; "changes have not been lost" | ErrorState + Retry; **no duplicate report created** |
| **Network failure** | Offline banner; mutations disabled | Offline banner; Compute disabled |
| **Timeout** | Toast + Retry | Toast + Retry |
| **Unhandled render error** | ErrorBoundary catches; Try again + Reload | Same |
| **Empty `null` body (201)** | Assign resolves; list invalidates; no parse crash | n/a |
| **`agent_hours: []` on list** | n/a | History rail renders **no** hours figure |

- [ ] **Step 1: Write the matrix test**

```tsx
// frontend/src/test/errorMatrix.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http as mswHttp } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import App from '@/App';
import { ReportPage } from '@/pages/reports/ReportPage';
import { SchedulesPage } from '@/pages/schedules/SchedulesPage';
import { API, errors } from './handlers';
import { mswServer } from './mswServer';
import { renderWithQuery } from './renderWithQuery';

const WINDOW = { from: '2026-08-09T10:00:00+05:30', to: '2026-08-12T17:30:00+05:30' };

describe('schedules screen error matrix', () => {
  it('400: shows the server message inline and does not toast it away', async () => {
    mswServer.use(
      mswHttp.put(`${API}/schedules/:id`, () =>
        errors.envelope(400, 'validation_error', 'shifts must not be empty'),
      ),
    );
    renderWithQuery(<SchedulesPage initialScheduleId={1} />);
    await screen.findByRole('group', { name: /monday/i });
    await userEvent.click(screen.getByRole('button', { name: /save hours/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/shifts must not be empty/i);
  });

  it('404: renders a pane state, never a blank detail area', async () => {
    mswServer.use(mswHttp.get(`${API}/schedules/:id`, () => errors.envelope(404, 'not_found', 'gone')));
    renderWithQuery(<SchedulesPage initialScheduleId={99} />);
    expect(await screen.findByText(/no longer exists/i)).toBeInTheDocument();
  });

  it('409 on assign: the agent is never shown as added', async () => {
    mswServer.use(
      mswHttp.post(`${API}/schedules/:id/agents`, () =>
        errors.envelope(409, 'conflict', 'agent 3 would have 2 overlapping shift(s)'),
      ),
    );
    renderWithQuery(<SchedulesPage initialScheduleId={1} />);
    await userEvent.click(await screen.findByRole('button', { name: /assign agent/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^assign$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/can’t be assigned|conflict/i);
  });

  it('422: the message lands on the OFFENDING control, not in a toast', async () => {
    mswServer.use(
      mswHttp.put(`${API}/schedules/:id`, () =>
        errors.fastapiValidation(['body', 'shifts', 0, 'end_hours'], 'Input should be less than 24'),
      ),
    );
    renderWithQuery(<SchedulesPage initialScheduleId={1} />);
    await screen.findByRole('group', { name: /monday/i });
    await userEvent.click(screen.getByRole('button', { name: /save hours/i }));

    const end = await screen.findByRole('group', { name: /monday end time/i });
    await waitFor(() => expect(end).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.queryByRole('status', { name: /toast/i })).not.toBeInTheDocument();
  });

  it('500: says the work is not lost and offers retry', async () => {
    mswServer.use(
      mswHttp.get(`${API}/schedules/:id`, () => errors.envelope(500, 'internal_error', 'internal server error')),
    );
    renderWithQuery(<SchedulesPage initialScheduleId={1} />);
    expect(await screen.findByText(/have not been lost/i)).toBeInTheDocument();
    // Never echo the raw server string at the user.
    expect(screen.queryByText('internal server error')).not.toBeInTheDocument();
  });

  it('network failure: surfaces as a connection message, not an empty list', async () => {
    mswServer.use(mswHttp.get(`${API}/schedules`, () => HttpResponse.error()));
    renderWithQuery(<SchedulesPage />);
    expect(await screen.findByText(/could not reach the server|offline/i)).toBeInTheDocument();
  });

  it('an HTML 502 from a proxy does not crash the JSON parser', async () => {
    mswServer.use(mswHttp.get(`${API}/schedules`, () => errors.badGateway()));
    renderWithQuery(<SchedulesPage />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('report screen error matrix', () => {
  it('500 on compute: no duplicate report is created', async () => {
    let posts = 0;
    mswServer.use(
      mswHttp.post(`${API}/reports`, () => {
        posts += 1;
        return errors.envelope(500, 'internal_error', 'boom');
      }),
    );
    renderWithQuery(<ReportPage initialWindow={WINDOW} />);
    await userEvent.click(screen.getByRole('button', { name: /compute/i }));
    await screen.findByText(/something went wrong/i);
    expect(posts).toBe(1);
  });

  it('422 on compute: the message lands on the date control', async () => {
    mswServer.use(
      mswHttp.post(`${API}/reports`, () =>
        errors.fastapiValidation(['body', 'ticket_end_at'], 'Input should be a valid datetime'),
      ),
    );
    renderWithQuery(<ReportPage initialWindow={WINDOW} />);
    await userEvent.click(screen.getByRole('button', { name: /compute/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid datetime/i);
  });

  it('the history rail never renders an hours figure', async () => {
    renderWithQuery(<ReportPage />);
    const rail = await screen.findByRole('region', { name: /history/i });
    expect(rail).not.toHaveTextContent(/:\d\d:\d\d/);
  });
});

describe('global boundary', () => {
  it('a crash anywhere renders a recovery panel, not a white screen', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Force a crash by making the query client construction throw.
    vi.stubGlobal('fetch', () => {
      throw new Error('catastrophic');
    });
    render(<App />);
    expect(screen.queryByText(/something went wrong/i)).toBeTruthy();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run it and fix every failure in the screens**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/test/errorMatrix.test.tsx`
Expected on the first run: **several failures.** That is the point — each one is a genuine gap in Task 17 or 18.

Fix them **in the screen components**, following the Task 10 placement table. Do not relax an assertion to make a cell pass; if a cell seems wrong, the placement rule is the thing to argue with, not the test.

- [ ] **Step 3: Re-run until the whole matrix is green**

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx vitest run src/test/errorMatrix.test.tsx`
Expected: PASS — **11 passed**.

- [ ] **Step 4: Run the entire suite and every gate**

Run:
```bash
cd /Users/tanishq/Desktop/Richpanel/frontend && \
npm test && npm run typecheck && npm run lint:arch && npm run build
```
Expected: all tests pass, no type errors, no dependency violations, a clean production build.

- [ ] **Step 5: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/ && git commit -m "test(frontend): add the exhaustive error-handling matrix across both screens and fix the gaps it found"
```

---

### Task 20: Activate `frontend/Dockerfile` and wire `VITE_APP_BASE_URL`

**Files:**
- Modify: `frontend/Dockerfile` (activate the template; rename the build arg)
- Modify: `frontend/.dockerignore` (allow the source the build needs)
- Verify: `frontend/.env`, `frontend/.env.example`

**Interfaces:**
- Produces: `richpanel-frontend:local`, an nginx image serving the static bundle on **port 80**, healthchecked.
- **The frontend container serves static assets only. It does NOT reverse-proxy `/api`.** The browser calls the backend cross-origin at `VITE_APP_BASE_URL`. `CORSMiddleware` on the backend is assumed to exist (B1).

#### The three env traps in this task, in the order they will bite

**1. `VITE_` prefix.** Vite exposes only `VITE_`-prefixed variables to client code. `APP_BASE_URL` would be `undefined` in the bundle with no warning. The variable is **`VITE_APP_BASE_URL`**, and the existing Dockerfile template's `VITE_API_BASE_URL` must be **renamed** to match — as must the `args:` key in `docker-compose.yml`.

**2. `.dockerignore` excludes `.env`.** Lines 45–46 of `frontend/.dockerignore` are `.env` and `.env.*`. **This is correct — never bake an env file into an image layer — but it means Vite cannot read `frontend/.env` during the Docker build.** Inside the image, the value must arrive as a **build arg promoted to an `ENV`**; Vite picks up `VITE_`-prefixed variables from the process environment as well as from `.env` files. Leave `.dockerignore` as it is; do not "fix" it by un-ignoring `.env`.

**3. Compose `env_file:` does NOT feed `${...}` interpolation.** `env_file:` injects variables into the **running container**. Build args are resolved from Compose's own interpolation, which reads the shell environment and the file given to `--env-file` (default: a `.env` beside the compose file). With per-service env files and no root `.env`, the frontend's build arg must be supplied explicitly — see Task 21's command.

Also worth stating plainly: for a static nginx bundle, `env_file:` on the frontend service is **almost useless at runtime** — nginx does not read `VITE_*`. Only `TZ` has any effect. This is the concrete reason F8 (build-time inlining vs a runtime `config.js`) is a real decision rather than a theoretical one.

- [ ] **Step 1: Rename the build arg in the Dockerfile**

Replace lines 56–60 of `frontend/Dockerfile`:

```dockerfile
# Injected by Compose as a BUILD ARG.
#
# It must be a build arg and not an env_file entry: .dockerignore deliberately
# excludes .env from the build context (never bake an env file into a layer),
# so Vite cannot read frontend/.env in here. Promoting the ARG to an ENV lets
# Vite pick it up from the process environment — it reads VITE_-prefixed
# process vars as well as .env files.
#
# The VITE_ prefix is MANDATORY. A variable named APP_BASE_URL is silently
# undefined in the browser bundle.
#
# NOTE: this value is INLINED into the bundle by `npm run build`. The image is
# therefore environment-specific. See the plan's F8 for the runtime-config
# alternative if more than one environment ever appears.
ARG VITE_APP_BASE_URL=http://localhost:8000
ENV VITE_APP_BASE_URL=${VITE_APP_BASE_URL}
```

Then update the header comment block (lines 8–31): the app has landed, so delete the "TEMPLATE, not yet active" framing and the "building it right now WILL fail" warning, and change the `APP_BASE_URL` reference to `VITE_APP_BASE_URL`.

Everything else in the file is already correct for this deployment: `BUILD_OUTPUT_DIR=dist` matches Vite; the inline nginx config has the SPA `try_files` fallback, immutable `/assets/` caching and `no-cache` on `index.html`; it runs as the unprivileged `nginx` user; it `EXPOSE`s 80 and has a `HEALTHCHECK`. **Do not add a `location /api/` proxy block — the same-origin proxy is rejected.**

- [ ] **Step 2: Add the security headers the tool needs**

Insert into the generated `server { … }` block, before the closing brace:

```
'    add_header X-Content-Type-Options nosniff;' \
'    add_header Referrer-Policy same-origin;' \
'    add_header X-Robots-Tag "noindex, nofollow";' \
```

`X-Robots-Tag` matters because **there is no authentication of any kind** (F7): anyone who can reach the port can delete every schedule. This header is a mitigation, not a solution — the port must not be published on a public host.

A `Content-Security-Policy` is deliberately **omitted for now**: `connect-src` must name the backend origin, which is exactly the value that varies per environment, so a hardcoded CSP would be wrong in every environment but one. Add it alongside the F8 runtime-config decision.

- [ ] **Step 3: Build the image and verify the API URL was actually inlined**

Run:
```bash
cd /Users/tanishq/Desktop/Richpanel && \
docker build -t richpanel-frontend:local \
  --build-arg VITE_APP_BASE_URL=http://localhost:8000 \
  ./frontend
```
Expected: build succeeds; `npm ci` and `npm run build` both complete; the final image is roughly 50–60 MB.

Now prove the value is in the bundle rather than assuming it:
```bash
docker run --rm richpanel-frontend:local \
  sh -c 'grep -rl "localhost:8000" /usr/share/nginx/html/assets/ | head -1'
```
Expected: at least one asset filename is printed. **If nothing is printed, `import.meta.env.VITE_APP_BASE_URL` was undefined at build time** — check the `VITE_` prefix and that the `ARG`/`ENV` pair is above the `RUN npm run build` line. This is the single check that catches the whole class of env bugs described above.

- [ ] **Step 4: Verify the container serves and is healthy**

Run:
```bash
docker run -d --name rp-fe-check -p 5173:80 richpanel-frontend:local && sleep 5 && \
curl -sS -o /dev/null -w 'index=%{http_code}\n' http://localhost:5173/ && \
curl -sS -o /dev/null -w 'spa-fallback=%{http_code}\n' http://localhost:5173/schedules/1 && \
docker inspect --format '{{.State.Health.Status}}' rp-fe-check; \
docker rm -f rp-fe-check
```
Expected: `index=200`, **`spa-fallback=200`** (the deep link must not 404 — that is the `try_files` rule doing its job), health `healthy`.

- [ ] **Step 5: Confirm the env files are exactly as required**

Run:
```bash
cd /Users/tanishq/Desktop/Richpanel && \
test -f frontend/.env && test -f frontend/.env.example && \
grep -q '^VITE_APP_BASE_URL=' frontend/.env && \
grep -q '^VITE_APP_BASE_URL=' frontend/.env.example && \
git check-ignore -q frontend/.env && ! git check-ignore -q frontend/.env.example && \
echo "env files OK"
```
Expected: `env files OK`. Both files exist, both declare the correctly-prefixed variable, `.env` is ignored and `.env.example` is committed.

- [ ] **Step 6: Commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && git add frontend/Dockerfile frontend/.env.example && git commit -m "build(frontend): activate the Dockerfile and wire VITE_APP_BASE_URL as a build arg"
```

---

### Task 21: Activate the `frontend` compose profile and verify the three-container stack

**Files:**
- Modify: `docker-compose.yml` (frontend service: build arg rename, per-service `env_file`)
- Modify: `README.md` (the run recipe)

**Interfaces:**
- Produces: `docker compose --profile frontend up` bringing up **postgres + backend + frontend**, three separate containers on three different ports, verified end to end through a real browser request.

**The deployment shape, restated so nobody re-derives it:** three containers, different ports. Postgres on `${POSTGRES_HOST_PORT:-55432}`, backend on `${BACKEND_HOST_PORT:-8000}`, frontend on `${FRONTEND_HOST_PORT:-5173}`. The browser loads the app from `:5173` and calls the API at `:8000` — **cross-origin, by design.** The frontend container does not proxy. This works if and only if the backend's `CORSMiddleware` allows `http://localhost:5173` (B1).

- [ ] **Step 1: Update the `frontend` service in `docker-compose.yml`**

```yaml
  frontend:
    profiles: ["frontend"]
    build:
      context: ./frontend
      dockerfile: Dockerfile
      args:
        # BUILD-TIME, and it must be a build arg, not an env_file entry:
        # frontend/.dockerignore excludes .env from the build context, so Vite
        # cannot read frontend/.env inside the image.
        #
        # The VITE_ prefix is mandatory — Vite exposes nothing else to client
        # code, and an unprefixed name is silently undefined in the bundle.
        #
        # Compose resolves this ${...} from the SHELL environment (or the file
        # passed to --env-file); `env_file:` below does NOT feed interpolation.
        # See the run recipe in the README.
        VITE_APP_BASE_URL: ${VITE_APP_BASE_URL:-http://localhost:8000}
    image: richpanel-frontend:local
    restart: unless-stopped
    depends_on:
      backend:
        condition: service_healthy
    # Per-service env file. For a static nginx bundle this is nearly inert at
    # runtime — nginx does not read VITE_* — so effectively only TZ applies.
    # That asymmetry is exactly why build-time inlining vs a runtime config.js
    # is an open decision (plan F8).
    env_file:
      - ./frontend/.env
    environment:
      TZ: ${TZ:-Asia/Kolkata}
    ports:
      - "${FRONTEND_HOST_PORT:-5173}:80"
```

Also update the header comment at the top of the file: the `frontend` service is no longer a placeholder, and the profile now exists to keep backend-only workflows fast rather than to hide a missing app.

- [ ] **Step 2: Bring up all three containers**

Run:
```bash
cd /Users/tanishq/Desktop/Richpanel && \
set -a && . ./frontend/.env && set +a && \
docker compose --profile frontend up --build -d
```

The `set -a; . ./frontend/.env; set +a` line is what makes `VITE_APP_BASE_URL` visible to Compose's `${...}` interpolation, given there is no root `.env`. Alternatively `docker compose --env-file ./frontend/.env --profile frontend up --build -d`, but note that `--env-file` applies to the whole invocation, so only use it if the backend and postgres services get their variables from `env_file:` entries rather than interpolation.

Expected: three containers created. Postgres becomes healthy first, then the backend (which runs migrations in its entrypoint), then the frontend.

- [ ] **Step 3: Verify all three are up and healthy**

Run:
```bash
cd /Users/tanishq/Desktop/Richpanel && \
docker compose --profile frontend ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
```
Expected: exactly **three** services — `postgres`, `backend`, `frontend` — all `Up`, backend and frontend reporting `(healthy)`, published on three **different** host ports.

- [ ] **Step 4: Verify each tier independently**

Run:
```bash
# Postgres accepts connections
docker compose exec -T postgres pg_isready -h 127.0.0.1 -U "$(grep '^POSTGRES_USER=' backend/.env | cut -d= -f2)"

# Backend health and a real data endpoint
curl -sS http://localhost:8000/health
echo
curl -sS 'http://localhost:8000/api/v1/agents?limit=5'
echo

# Frontend serves the SPA, and the deep link does not 404
curl -sS -o /dev/null -w 'index=%{http_code}\n' http://localhost:5173/
curl -sS -o /dev/null -w 'deep-link=%{http_code}\n' http://localhost:5173/reports
```
Expected: `pg_isready` reports accepting connections; `{"status":"ok"}`; a JSON array of agents; `index=200`; `deep-link=200`.

- [ ] **Step 5: Verify CORS — the cross-origin call the whole design depends on**

This is the step that catches B1 not having landed. A preflight and a real request, both from the frontend's origin:

```bash
# Preflight for a mutation
curl -sS -i -X OPTIONS 'http://localhost:8000/api/v1/schedules' \
  -H 'Origin: http://localhost:5173' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' | head -20

# Simple GET with an Origin header
curl -sS -i 'http://localhost:8000/api/v1/agents?limit=1' \
  -H 'Origin: http://localhost:5173' | head -20
```
Expected: both responses carry **`access-control-allow-origin: http://localhost:5173`** (or `*`), and the preflight returns 200/204 with `access-control-allow-methods` including `POST`.

**If those headers are absent, stop.** The stack is up but the app cannot talk to the API from a browser, and no amount of frontend work fixes it. Report it as B1 outstanding.

- [ ] **Step 6: Verify end to end in a real browser**

`curl` cannot prove the SPA works — only that bytes are served. Open **http://localhost:5173** and confirm, with the DevTools Network and Console panels open:

1. The Schedules screen loads and the schedule list populates (or shows the explanatory empty state on a fresh database).
2. **Network shows requests to `http://localhost:8000/api/v1/...`** — cross-origin, and succeeding. Not to `localhost:5173/api/...`.
3. **Console has zero errors**, and specifically no CORS message and no `undefined/api/v1/...` request.
4. Create a schedule with an **overnight Monday shift (22:00 → 06:00)**. Confirm the `+1 day` chip appears with `ends Tue`, and that the hatched ghost renders on the Tuesday row.
5. Assign an agent; delete a schedule that has assignees and confirm the impact modal lists **names**, not IDs, and that its content is present the instant it opens.
6. Switch to Reports, compute a window, and confirm the summary and table render with no layout shift.
7. Toggle the theme; confirm both themes are legible.
8. Reload on `/reports?from=…&to=…` and confirm the window survives.

- [ ] **Step 7: Verify offline behaviour against the real stack**

Stop only the backend and confirm the UI degrades honestly rather than lying:

```bash
cd /Users/tanishq/Desktop/Richpanel && docker compose stop backend
```
Expected in the browser: the offline/connection banner appears, mutations are disabled, and previously-loaded data is still shown rather than the screen blanking. Then:
```bash
cd /Users/tanishq/Desktop/Richpanel && docker compose start backend
```
Expected: the app recovers on the next query without a manual reload.

- [ ] **Step 8: Write the Playwright end-to-end suite**

With the stack verified by hand, encode it. Create `frontend/playwright.config.ts` pointing `baseURL` at `http://localhost:5173`, and `frontend/e2e/` covering:

1. Create a schedule with an overnight Monday shift; assert the ghost renders on Tuesday and the week total is correct.
2. Assign an agent whose other schedule collides; assert 409 → the agent is **not** added → the conflict panel names the day and hours.
3. Delete a schedule with assignees; assert the impact modal lists names **before** the confirm is enabled, and that the impact request was already in flight before the click.
4. Compute a report; assert skeleton → results with **no layout shift**, and that a zero-hours agent appears in the collapsed group.
5. Keyboard-only traversal of both screens with **no mouse events at all**.
6. `@axe-core/playwright` on both screens in **both themes**, asserting zero violations.

Run: `cd /Users/tanishq/Desktop/Richpanel/frontend && npx playwright install --with-deps && npm run e2e`
Expected: all six specs pass against the live three-container stack.

- [ ] **Step 9: Update the README**

Add a "Running the full stack" section giving the exact recipe from Step 2, the three ports, the note that the frontend calls the API cross-origin and therefore needs CORS, and the per-service env-file layout (`frontend/.env` and `backend/.env`, no root `.env`), including the `VITE_` prefix warning.

- [ ] **Step 10: Tear down and commit**

```bash
cd /Users/tanishq/Desktop/Richpanel && docker compose --profile frontend down
```
(Use `down` without `-v` — `-v` destroys `richpanel_pgdata`.)

```bash
cd /Users/tanishq/Desktop/Richpanel && git add docker-compose.yml README.md frontend/ && git commit -m "build: activate the frontend compose profile and verify the three-container stack end to end"
```

---

## Appendix A — Task summary

| # | Task | Verified by |
|---|---|---|
| 1 | Project setup: Vite + React + TS + Tailwind v4 + TanStack Query + Vitest/RTL/MSW, `frontend/.env` | `npm test` (5), `npm run build`, dev server returns 200 |
| 2 | Architecture constraints R1–R7 via dependency-cruiser | A deliberately-violating fixture fails the build |
| 3 | `helpers/time.ts` — float ↔ HH:MM | Property test over all 1440 minutes, incl. a JSON round trip |
| 4 | `helpers/weekday.ts` + `shifts.ts` — overnight, normalise, overlap | Pinned to the backend's own domain fixtures |
| 5 | `helpers/duration.ts`, `dates.ts`, `format.ts` | Unit tests incl. the >24h no-wrap case |
| 6 | `api/types.ts` + `http.ts` + `ApiError` | All three error shapes, timeout, network, 204, `null` body |
| 7 | `api/apiService.ts` + MSW handlers | Every endpoint against handlers mirroring real responses |
| 8 | `queryKeys.ts`, QueryClient retry policy, read hooks | Retry predicate asserted per status; agent paging asserted |
| 9 | Mutations + invalidation matrix | Optimistic unassign rolls back; assign never shows a false row |
| 10 | Shared error-handling layer | Placement rules, error boundary, toast context |
| 11 | Design tokens, dark theme, `ThemeContext` | WCAG AA contrast asserted from the CSS, both themes |
| 12 | `components/ui/` primitives | Labels, disabled, busy, a11y |
| 13 | Router with typed report search params, AppShell | Malformed `?from=` is dropped, not crashed on |
| 14 | `components/datetime/` real calendar + clock pickers | Segments labelled, 15-min options, `00:00` end refused |
| 15 | Modals incl. `DeletionImpactModal` | Confirm gated on acknowledgement; disabled if impact failed |
| 16 | The Week Ribbon | Overnight ghost, Sunday→Monday wrap, scoped re-renders |
| 17 | Screen 1 — Schedule Configuration | Every state in the table, incl. 422→control mapping |
| 18 | Screen 2 — Report, virtualised | `aria-rowcount` full count; 3 000-row scroll profiled |
| 19 | Error-handling end-to-end audit | An 11-case matrix across both screens |
| 20 | Dockerfile activation + `VITE_APP_BASE_URL` | The inlined URL is grepped **out of the built bundle** |
| 21 | Compose `frontend` profile + three-container stack | Three containers, CORS preflight, real browser, Playwright |

## Appendix B — Open decisions, consolidated

Reproduced from §0.8 so this list can be lifted straight into a product-owner review.

| # | Decision | Default in this plan | Blocks |
|---|---|---|---|
| **F1** | **Framework: Vite SPA or Next.js?** | Vite SPA | Task 13 |
| **F2** | **Router: TanStack Router or React Router 7?** | TanStack Router v1 | Task 13 |
| **F3** | Report hours format: decimal, `HH:MM:SS`, or both? | Both | — |
| **F4** | Zero-hour agents: shown inline, grouped, or hidden? | Grouped and collapsed | — |
| **F5** | Time granularity: any minute, or a hard 15/30-minute constraint? | Any minute typeable; 15-min options; 5-min arrows | — |
| **F6** | Pagination vs virtualisation thresholds | Virtualise the report table; `limit: 50` load-more; virtualise agent lists above 100 | — |
| **F7** | **Authentication — there is none.** VPN-only, SSO proxy, or backend auth? | None; `noindex`; must not be public | Task 21 |
| **F8** | `VITE_APP_BASE_URL` build-time inlining vs runtime `config.js` | Build-time (matches the existing Dockerfile/compose contract) | — |
| **F9** | Is the 422 envelope being normalised to `{error_code, message, details}`? | Handle **both** shapes | — |

Backend change requests raised by this plan — B1 (CORS, assumed shipping), B2, B3, B4, B5, B6, B7, B8, B10 — are listed in §0.7.

