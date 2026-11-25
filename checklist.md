# UOT Exam Print Booking — checklist

Rules and decisions: [plan.md](plan.md).

- **One step = one session.** Open it with: "Read plan.md and docs/contracts.md, then do step X.Y of checklist.md."
- Tick a box only when its "Done when" holds and its review passed.
- **Requires** names the steps whose boxes must be ticked before the step starts; "none" means it can start at any time.
- Review is always by a different model than the builder: Fable reviews Opus and Sonnet work, Opus reviews Fable work.

| Model | Used for |
|---|---|
| **Fable 5.2** (high) | contracts, login and permissions, locks and concurrency, security audit, reviews |
| **Opus 5.5** | schema and migrations, states, deployment |
| **Sonnet 5.5** | fully specified screens, CRUD, reads, reports |
| **Haiku 5.5** | mechanical runs (run tests, summarise) |

## Phase 0 — Foundation

- [ ] **0.1 Contracts** — Fable 5.2 (high) · review: Opus 5.5
  Requires: none.
  Write `docs/contracts.md`: exact tables and columns, booking state transitions, scheduling algorithm with worked examples, permission matrix per action, settings keys.
  Done when: every rule in plan.md §4 maps to a table, a transition or a function signature.
  Note 2026-11-25: [docs/contracts.md](docs/contracts.md) written by Fable 5.2 (rule map in its §7). **Opus 5.5 review still owed** — the box stays unticked until it passes; the review also rules on the 18 choices in its §8.
- [x] **0.2 Scaffold** — Sonnet 5.5
  Requires: none.
  Next.js + TypeScript + Tailwind RTL shell (Arabic font, layout per role), Drizzle, Postgres in Docker Compose, Vitest, lint, `.env.example`, `git init`.
  Done when: `npm run dev` shows an Arabic RTL page and `npm test` runs.

## Phase 1 — First end-to-end slice

Login → admin adds a machine → college books → operator sees the queue.

- [ ] **1.1 Schema v1 + seed** — Opus 5.5
  Requires: 0.1, 0.2.
  Migrations for `colleges`, `users`, `sessions`, `machines`, `bookings` (exclusion constraint on machine + interval), `settings`, `holidays`, `audit_log`. Seed: the 7 machines, one admin, two test colleges, one operator.
  Done when: migrations apply on an empty DB and the seed loads.
- [ ] **1.2 Login and permissions** — Fable 5.2 (high) · review: Opus 5.5
  Requires: 1.1.
  Password hashing, DB sessions, role guard used by every server action, login rate limit, admin creates accounts and resets passwords, `audit()` helper.
  Done when: tests prove each role is refused the other roles' actions and a college cannot read another college's rows.
- [ ] **1.3 Scheduling core** — Fable 5.2 (high) · review: Opus 5.5
  Requires: 0.1, 0.2.
  Pure functions with unit tests: quantities, duration, eligible machines with the "larger takes smaller" order, free-interval search, working calendar, large-job rule.
  Done when: tests cover odd pages in duplex, tier edges (400, 401, 800, 801), a job longer than the day, a full hour, a holiday.
- [ ] **1.4 Booking transaction** — Fable 5.2 (high) · review: Opus 5.5
  Requires: 1.2, 1.3.
  Create a booking under the exclusion constraint, with retry on conflict.
  Done when: a test firing parallel requests at the same hour never produces two overlapping bookings on one machine.
- [ ] **1.5 Admin screens: machines and accounts** — Sonnet 5.5
  Requires: 1.2.
  Machines list, add, edit, archive. Colleges and user accounts.
  Done when: a machine added in the screen becomes bookable without a code change.
- [ ] **1.6 College screens: book and follow** — Sonnet 5.5
  Requires: 1.4.
  Booking form with live availability and the suggested nearest time, phone normalisation, exam-date warning, list of own bookings.
- [ ] **1.7 Operator screen: day queue** — Sonnet 5.5
  Requires: 1.4.
  Today's bookings by time and machine, read-only.
- [ ] **1.8 Review of phase 1** — Fable 5.2
  Requires: 1.1–1.7.
  Review 1.1 and 1.5–1.7. Done when: the full slice works in the browser for the three roles.

## Phase 2 — Day-to-day operation

- [ ] **2.1 Booking lifecycle (server)** — Opus 5.5
  Requires: 1.8.
  Confirm identity, ready (wasted sheets + destroyed tick), delivered, no-show, reference numbers, notification rows.
  Done when: tests reject every transition not listed in the contracts.
- [ ] **2.2 Operator actions and notifications (UI)** — Sonnet 5.5
  Requires: 2.1.
  Buttons for 2.1, the two WhatsApp buttons (started / ready), notification bell for colleges.
- [ ] **2.3 Edit, cancel, delay notice (server)** — Opus 5.5 (high)
  Requires: 2.1.
  The 60-minute rules, move to the latest free interval, fallback to the admin list.
- [ ] **2.4 Maintenance (server)** — Opus 5.5 (high)
  Requires: 2.3.
  Stop now or planned window, automatic move to an eligible machine, `needs_reschedule`, manual move, maintenance log.
  Done when: tests cover "alternative exists", "no alternative", and a planned window that starts later.
- [ ] **2.5 Maintenance and changes (UI)** — Sonnet 5.5
  Requires: 2.3, 2.4.
  Stop / reactivate dialog, affected-bookings list with a move action, maintenance log, college buttons for edit, cancel and delay.
- [ ] **2.6 Saturday requests (server)** — Opus 5.5
  Requires: 2.1.
  Request, approve / reject, date opened for that college only up to the approved quantity.
- [ ] **2.7 Saturday, on-behalf booking, settings (UI)** — Sonnet 5.5
  Requires: 2.6.
  Saturday request and approval screens, admin booking on behalf of a college, settings screen (hours, weekdays, holidays, 6,000 rule, deadlines).
- [ ] **2.8 Review of phase 2** — Fable 5.2 (high)
  Requires: 2.1–2.7.
  Focus: state transitions, moves under concurrency, college isolation.

## Phase 3 — Stock

- [ ] **3.1 Stock schema and logic** — Opus 5.5
  Requires: 2.1.
  `inventory_items`, `inventory_movements`, `machine_parts` with life counters, deduction on `ready`, alerts.
  Done when: the balance always equals the sum of movements in tests.
- [ ] **3.2 Stock screens** — Sonnet 5.5
  Requires: 3.1.
  Balances, receive, adjust, replace a part (counter reset), alerts panel, a day's booked sheets against the paper balance.

## Phase 4 — Print-outs and reports

- [ ] **4.1 Daily printed sheet** — Sonnet 5.5
  Requires: 2.1.
  Print layout with reference number and the two signature boxes.
- [ ] **4.2 Reports** — Sonnet 5.5
  Requires: 2.4, 3.1.
  By college, by machine (with downtime), waste and stock, peak hours.
- [ ] **4.3 Audit log viewer** — Sonnet 5.5
  Requires: 1.2.
  Admin only, filter by user, action and date.
- [ ] **4.4 Review of phases 3–4** — Fable 5.2
  Requires: 3.1–4.3.

## Phase 5 — Hardening and go-live

- [ ] **5.1 Security audit** — Fable 5.2 (high) · fixes to Fable-built code reviewed by Opus 5.5
  Requires: 2.8, 4.4.
  Permission check on every action, college-to-college leaks, sessions, rate limits, headers, input validation.
- [ ] **5.2 End-to-end tests** — Sonnet 5.5
  Requires: 2.8.
  Playwright flows for the three roles: book → confirm identity → ready → delivered; cancel; delay; machine stop.
- [ ] **5.3 Deployment** — Opus 5.5
  Requires: 5.1.
  Docker Compose on the Libyan Spider VPS, HTTPS, secrets, daily DB backup, time zone.
- [ ] **5.4 Full test run and summary** — Haiku 5.5
  Requires: 5.2, 5.3.
- [ ] **5.5 Owner go-live tasks** — owner
  Requires: 5.4.
  Real machine speeds, real colleges and accounts, working weekdays and holidays, one trial day at the centre.
