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

- [x] **0.1 Contracts** — Fable 5.2 (high) · review: Opus 5.5
  Requires: none.
  Write `docs/contracts.md`: exact tables and columns, booking state transitions, scheduling algorithm with worked examples, permission matrix per action, settings keys.
  Done when: every rule in plan.md §4 maps to a table, a transition or a function signature.
  Note 2026-11-25: [docs/contracts.md](docs/contracts.md) written by Fable 5.2 (rule map in its §7). Opus 5.5 review done ("pass after fixes", 0 blocker / 15 should-fix / 8 nit). Fixes applied and re-check passed (3 nits 24–26 applied after it). The fixes were written and re-checked by Opus 5.5 (session switched models), so a Fable 5.2 look at them is still possible but was not required by the owner. The 20 choices in its §8 were approved by the owner on 2026-11-25.
- [x] **0.2 Scaffold** — Sonnet 5.5
  Requires: none.
  Next.js + TypeScript + Tailwind RTL shell (Arabic font, layout per role), Drizzle, Postgres in Docker Compose, Vitest, lint, `.env.example`, `git init`.
  Done when: `npm run dev` shows an Arabic RTL page and `npm test` runs.

## Phase 1 — First end-to-end slice

Login → admin adds a machine → college books → operator sees the queue.

- [x] **1.1 Schema v1 + seed** — Opus 5.5
  Requires: 0.1, 0.2.
  Migrations for `colleges`, `users`, `sessions`, `machines`, `bookings` (exclusion constraint on machine + interval), `settings`, `holidays`, `audit_log`. Seed: the 7 machines, one admin, two test colleges, one operator.
  Done when: migrations apply on an empty DB and the seed loads.
  Note 2026-11-25 (Opus 5.5): built; ticked by the owner before review, which is in 1.8. Owner choices: `machine_maintenance` added now (its exclusion constraint is tested here); seeded accounts use `SEED_PASSWORD` from `.env`; hashing with `@node-rs/argon2` (1.2 reuses it); 650i seeded as 401–800. Schema checked against the contract SQL: only diffs are `created_at` columns and `ON DELETE RESTRICT` (both from §0). Speeds and setup times are placeholders; all priorities 100.
- [x] **1.2 Login and permissions** — Fable 5.2 (high) · review: Opus 5.5
  Requires: 1.1.
  Password hashing, DB sessions, role guard used by every server action, login rate limit, admin creates accounts and resets passwords, `audit()` helper.
  Done when: tests prove each role is refused the other roles' actions and a college cannot read another college's rows.
  Note 2026-11-25 (Fable 5.2): built; values fixed here are in contracts §1.3. Owner choices: 8 h idle / 7 d max; 5 wrong → 15 min lock; server-made temporary password, min 10; minimal login and change-password screens included. Code: `lib/auth/*`, `lib/actions/session.ts`, `lib/actions/users.ts`, `components/auth/role-shell.tsx`, `app/login`, `app/change-password`. Tests: `tests/auth.test.ts` (48 tests) on a separate `<db>_test` database made by `tests/global-setup.ts`. Opus 5.5 review "pass after fixes" (1 should-fix: `changeOwnPassword` guesses now count toward the lock; 3 nits fixed), re-check "pass". Left as is: no per-IP limit; login timing differs by a few DB round trips for known usernames; the "own rows" proof uses `ownRows()` on `bookings` directly — every later college-facing action needs its own other-college test; a dev-only "could not validate instant" notice when the layout gate redirects.
- [x] **1.3 Scheduling core** — Fable 5.2 (high) · review: Opus 5.5
  Requires: 0.1, 0.2.
  Pure functions with unit tests: quantities, duration, eligible machines with the "larger takes smaller" order, free-interval search, working calendar, large-job rule.
  Done when: tests cover odd pages in duplex, tier edges (400, 401, 800, 801), a job longer than the day, a full hour, a holiday.
  Note 2026-11-25 (Fable 5.2): built; ticked by the owner without an Opus re-check of the test fixes. Owner choices: §3.1–3.6 only (`latestFreeStart`, `reassignSameTime` and the §3.10 helpers stay with the steps that use them); time zone as one fixed +02:00 constant, no Intl. Code: `lib/scheduling/types.ts`, `time.ts`, `schedule.ts`. Tests: `tests/scheduling.test.ts` (89 tests, no DB rows used). One helper beyond the contract: `eligibleMachines()` = static-eligible machines in tie order (tierGroup, priority, load, id). Readings applied: `Busy.end = null` blocks from its start on; an hour is `day_closed` only when none of its six starts lies inside the working hours; `isFreeOn` also skips the row of `ignoreBookingId`. Opus 5.5 review "pass after fixes": code matches §3.1–3.6, 1 should-fix and 5 nits, all test gaps, all added. Left open: contracts §3 intro ("never subtract it again") and the §3.3 `isFreeOn` comment ("ignoreBookingId excepted") disagree in wording; harmless, the contract text was not changed.
- [ ] **1.4 Booking transaction** — Fable 5.2 (high) · review: Opus 5.5
  Requires: 1.2, 1.3.
  Create a booking under the exclusion constraint, with retry on conflict.
  Done when: a test firing parallel requests at the same hour never produces two overlapping bookings on one machine.
- [x] **1.5 Admin screens: machines and accounts** — Sonnet 5.5
  Requires: 1.2.
  Machines list, add, edit, archive. Colleges and user accounts.
  Done when: a machine added in the screen becomes bookable without a code change.
  Note 2026-11-25 (Sonnet 5.5): built; review is in 1.8. Owner choices: archive and edit change only the machine row (the §3.8 reassign-or-flag step for bookings on it comes with the maintenance step); `setCollegeActive(false)` also deactivates the college's account and ends its sessions, reactivating the college does not bring the account back. Code: `lib/actions/machines.ts`, `lib/actions/colleges.ts`, `app/(admin)/admin/{machines,colleges,accounts}`, `components/admin/*`; `/admin` redirects to the machines screen (`next.config.ts`). Tests: `tests/admin.test.ts` (35 tests): role guard per action, a created machine comes back from `eligibleMachines()`, archive / unarchive, name rules, college cascade. Checked by hand in the browser as admin (add, edit, archive, rename, deactivate, create account with temporary password, reset). Left open: no maintenance screen (not in 1.5); priority and the other numbers only have an upper bound of 1,000,000; a hidden, kept-alive page can show its old error text when you come back to it.
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
