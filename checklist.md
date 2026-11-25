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
- [x] **1.4 Booking transaction** — Fable 5.2 (high) · review: Opus 5.5
  Requires: 1.2, 1.3.
  Create a booking under the exclusion constraint, with retry on conflict.
  Done when: a test firing parallel requests at the same hour never produces two overlapping bookings on one machine.
  Note 2026-11-25 (Fable 5.2): built. Owner choices: `getAvailability` built here too; no `booking_on_behalf` notification row until the table exists (2.1); `saturdayApprovals = []` until 2.6, so a non-working weekday is closed for everyone; an inactive or unknown college → `validation` (both roles). Code: `lib/bookings/create.ts` (core, not a public endpoint), `lib/actions/bookings.ts` (`createBooking`, `getAvailability`), `lib/scheduling/load.ts` (lock 7001 + `ctx` loader), `availability.ts`, `helpers.ts` (the four §3.10 helpers used here). Tests: `tests/bookings.test.ts` (34 tests); the parallel tests fail when the lock is removed, the clock test fails when the clock is read before the lock. Readings applied: 1 try + 3 retries; `doctorName` / `subject` / `recipientName` trimmed, 1–200 chars; a `collegeId` from a college is refused even when it is its own; `getAvailability` reads one REPEATABLE READ snapshot without the lock and returns `{ ok, availability }`. Left for later: `bookingId` / `ignoreBookingId` (2.3; `getAvailability` refuses the key until then); a real 40P01 deadlock is only unit-tested; no limit on how far ahead a date may be (not in the contracts). Opus 5.5 review "pass" (0 blocker, 1 should-fix test gap, 4 nits); all applied except the deadlock test, not re-checked by Opus.
- [x] **1.5 Admin screens: machines and accounts** — Sonnet 5.5
  Requires: 1.2.
  Machines list, add, edit, archive. Colleges and user accounts.
  Done when: a machine added in the screen becomes bookable without a code change.
  Note 2026-11-25 (Sonnet 5.5): built; review is in 1.8. Owner choices: archive and edit change only the machine row (the §3.8 reassign-or-flag step for bookings on it comes with the maintenance step); `setCollegeActive(false)` also deactivates the college's account and ends its sessions, reactivating the college does not bring the account back. Code: `lib/actions/machines.ts`, `lib/actions/colleges.ts`, `app/(admin)/admin/{machines,colleges,accounts}`, `components/admin/*`; `/admin` redirects to the machines screen (`next.config.ts`). Tests: `tests/admin.test.ts` (35 tests): role guard per action, a created machine comes back from `eligibleMachines()`, archive / unarchive, name rules, college cascade. Checked by hand in the browser as admin (add, edit, archive, rename, deactivate, create account with temporary password, reset). Left open: no maintenance screen (not in 1.5); priority and the other numbers only have an upper bound of 1,000,000; a hidden, kept-alive page can show its old error text when you come back to it.
- [x] **1.6 College screens: book and follow** — Sonnet 5.5
  Requires: 1.4.
  Booking form with live availability and the suggested nearest time, phone normalisation, exam-date warning, list of own bookings.
  Note 2026-11-25 (Sonnet 5.5): built, not ticked: review is in 1.8. Owner choices: two pages (`/college` = own list, `/college/book` = form; success returns to the list with the reference); hour picker from a small read `getBookingFormConfig` (work hours, weekdays, today only); list without the machine, newest first, no paging; edit / cancel / delay notice stay in 2.x. Code: `app/(college)/college/page.tsx`, `book/page.tsx`, `components/college/booking-form.tsx`, `lib/bookings/read.ts` (`listBookings`, `getBookingFormConfig`), `lib/bookings/format.ts` (Arabic labels, +02:00 display), `ServiceType` / `BookingStatus` added to `lib/scheduling/types.ts`. Tests: `tests/college-screens.test.ts` (15). Readings applied: a college that names a college in `listBookings` is refused even when the value is invalid; Arabic-Indic digits typed in the phone and number fields are converted in the browser only (the server stays strict); a suggestion is accepted by pressing the button, which then sends `accept`; closed weekdays are not blocked in the browser (Saturday approvals open them in 2.6), the server answers `day_closed`; the pages wrap their data reads in their own `<Suspense>` (Next 16 instant-navigation check). Checked in the browser (desktop and phone width): exact time, suggestion accepted, field errors, exam-date warning, success banner. Left open: no component tests (no jsdom in the project).
- [x] **1.7 Operator screen: day queue** — Sonnet 5.5
  Requires: 1.4.
  Today's bookings by time and machine, read-only.
  Note 2026-11-25 (Sonnet 5.5): built, not ticked (review is in 1.8). Owner choices: today only (no date picker); one list by start time with the machine as a column; every status except `cancelled`. Code: `getDayQueue(date)` in `lib/actions/bookings.ts` (operator + admin), `lib/bookings/queue.ts`, `app/(operator)/operator/page.tsx`. Tests: `tests/queue.test.ts` (6). Not checked in the browser as a signed-in operator (the seed password was not readable by the agent). Arabic labels for service types are mine (`quality` → «جودة»); the phone is not shown (2.2).
- [x] **1.8 Review of phase 1** — Fable 5.2
  Requires: 1.1–1.7.
  Review 1.1 and 1.5–1.7. Done when: the full slice works in the browser for the three roles.
  Note 2026-11-25 (Fable 5.2): review "pass after fixes" (0 blocker, 4 fixed, nits listed). Branch `step-1.8-phase1-review` = 1.4 + 1.7 + 1.6 + merge of 1.5 (they were on three branches). 230 tests, `tsc`, lint pass; `drizzle-kit generate` reports no drift.
  - **1.1 pass.** `drizzle/0000` + `0001` match contracts §1 for the nine tables (columns, checks, indexes, both exclusion constraints); seed = 7 machines, 4 accounts, 9 settings of §5. Nit: the seed does not check `SEED_PASSWORD` against the 10–128 rule.
  - **Fixed here:** (1) 1.5 machine writes did not take the scheduling lock of §3.9 — `createMachine`, `updateMachine`, archive and unarchive now call `takeSchedulingLock` first (test in `tests/admin.test.ts`, fails without the fix); (2) the operator page had its own Arabic labels, different from the college screens — it now uses `lib/bookings/format.ts` (one wording); (3) the operator page read its data outside `<Suspense>` (Next dev error "blocking-prerender-dynamic") — now the same pattern as the other pages.
  - **Found in the browser, fixed after the owner's yes (touches 1.2; Opus 5.5 has not reviewed it):** after logout the previous user's last pages stayed in the tab, hidden (Next keeps visited routes alive with `cacheComponents`): admin logs out, a college logs in in the same tab, the machines table was still in the DOM. Now logout is a plain form post to `app/logout/route.ts` (303 to `/login`) and a successful login returns the target and the form loads it as a new document (`app/login/actions.ts`, `login-form.tsx`); contracts §1.3 has the rule; 2 tests in `tests/auth.test.ts` (232 in all). Checked in one tab: admin in, client link to another screen, logout, operator in → new document each time, no admin table in the DOM, "Back" shows no data. Not covered: a session that runs out leaves its pages in the tab until the next login.
  - **Carried forward:** archive / edit of a machine still does not reassign or flag its bookings (§3.8 last bullet) → written into 2.4. The admin has no screen for the day queue yet (`getDayQueue` allows it).
  - **Nits, not fixed:** no confirm before archiving a machine or stopping a college; the live availability box stays on "checking" when the request itself fails; the "booked" banner stays after a reload; the operator page has no tab title, does not refresh by itself, and its quantity cell is three bare numbers; `uniqueViolation()` is copied in two action files.
  - **Browser (signed in, desktop width, dark):** admin adds a college, a college account, an operator account and a machine through the screens → the college signs in with the temporary password, must change it, books (Arabic-digit phone normalised, exam-date warning, live availability, reference 2026-0001 in its list) → the operator signs in, must change the password, sees the booking on the machine that was just added. A college and an operator are sent home from the other roles' pages (the admin was not tried). Done on `review.localhost:3000` with throwaway accounts and `work_end` moved to 23:50 for the run; all of it removed again (dev DB back to the seed). Date and hour fields were set through the form's own change handlers (the hidden browser pane did not take typed dates); typing was checked on the phone field only. Phone width not re-checked here (1.6 did).

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
  Also: `archiveMachine` and `updateMachine` reassign or flag the bookings they make ineligible (contracts §3.8 last bullet; left out of 1.5).
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
