# UOT Exam Print Booking — contracts

Step 0.1 of [checklist.md](../checklist.md). Rules come from [plan.md](../plan.md); where a rule is silent, the choice made here is listed in §8 (all approved by the owner, 2026-11-25).
Status: written by Fable 5.2 on 2026-11-25; Opus 5.5 review "pass after fixes", fixes applied, re-check "pass" (2026-11-25). Step 0.1 done.

Contents: 0 conventions · 1 tables · 2 booking states · 3 scheduling · 4 actions and permissions · 5 settings · 6 notifications and audit · 7 rule map · 8 choices made here.

## 0. Conventions

- All instants are `timestamptz`. Business time zone is `Africa/Tripoli` (UTC+2, no DST); "day", "hour" and "today" always mean that zone.
- Primary keys are `bigint GENERATED ALWAYS AS IDENTITY` unless shown otherwise. Foreign keys are `ON DELETE RESTRICT` unless shown otherwise. Nothing is hard-deleted except `sessions`, `holidays` rows and read `notifications`.
- Every table has `created_at timestamptz NOT NULL DEFAULT now()`; it is not repeated below. `updated_at` is listed where it exists.
- Intervals are half-open `[starts_at, ends_at)`.
- Time grid: `SLOT_MINUTES = 10` (a constant, not a setting). Every booking start and every duration is a multiple of 10 minutes.
- "Holding" statuses are every status except `cancelled` and `no_show`: these rows occupy their interval.
- The SQL below is the contract. The Drizzle schema of step 1.1 must produce an equivalent database (same names, types, checks, indexes).
- Table order in this file is for reading; the migration creates tables in dependency order (for example `inventory_items` before `machine_parts`, `machine_parts` before `inventory_movements`).
- Drizzle cannot express three things; they live in one hand-written SQL migration that runs right after the generated one that creates the tables (`drizzle/0001_exclusion_constraints.sql`): `CREATE EXTENSION IF NOT EXISTS btree_gist;`, constraint `bookings_no_overlap`, constraint `maintenance_no_overlap`. `drizzle-kit` does not know about them. A test in step 1.1 asserts both constraints exist (`SELECT conname FROM pg_constraint WHERE contype = 'x'`).
- Scheduling transactions run at READ COMMITTED (§3.9).

## 1. Tables

### Enums

```sql
CREATE TYPE user_role         AS ENUM ('college', 'operator', 'admin');
CREATE TYPE machine_type      AS ENUM ('laser', 'duplicator');
CREATE TYPE service_type      AS ENUM ('exam_questions', 'results', 'quality', 'answer_sheets');
CREATE TYPE sides             AS ENUM ('single', 'duplex');
CREATE TYPE booking_status    AS ENUM ('booked', 'in_progress', 'ready', 'delivered', 'cancelled', 'no_show');
CREATE TYPE reschedule_reason AS ENUM ('maintenance', 'delay_no_slot', 'machine_change');
CREATE TYPE saturday_status   AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE item_kind         AS ENUM ('paper', 'toner', 'master_roll', 'part');
CREATE TYPE movement_type     AS ENUM ('receive', 'consume', 'waste', 'adjust');
CREATE TYPE notification_type AS ENUM (
  'booking_ready', 'booking_no_show', 'booking_needs_reschedule', 'booking_rescheduled',
  'booking_restored', 'booking_cancelled', 'booking_on_behalf',
  'saturday_requested', 'saturday_decided');
```

### 1.1 `colleges`

```sql
CREATE TABLE colleges (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  is_active  boolean NOT NULL DEFAULT true
);
```

### 1.2 `users`

```sql
CREATE TABLE users (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username             text NOT NULL,
  password_hash        text NOT NULL,                    -- argon2id
  role                 user_role NOT NULL,
  college_id           bigint REFERENCES colleges(id),   -- set only for role 'college'
  full_name            text NOT NULL,
  is_active            boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  failed_login_count   integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  created_by           bigint REFERENCES users(id),      -- NULL only for the seeded admin
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'college') = (college_id IS NOT NULL))
);
CREATE UNIQUE INDEX users_username_key    ON users (lower(username));
CREATE UNIQUE INDEX users_one_per_college ON users (college_id) WHERE role = 'college' AND is_active;
```

No self sign-up: rows are created only by `createUser` (admin). One active account per college is enforced by `users_one_per_college`.

### 1.3 `sessions`

```sql
CREATE TABLE sessions (
  id           text PRIMARY KEY,                -- sha-256 hex of the cookie token; the raw token is never stored
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           inet,
  user_agent   text
);
CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
```

Session lifetime, cookie flags and the login rate limit are fixed in step 1.2; the columns above are all it may use. Deactivating a user or resetting a password deletes that user's sessions.

Fixed in step 1.2 (owner, 2026-11-25):

- **Lifetime:** a session ends after 8 hours without activity (each request moves `expires_at` to now + 8 h, written at most once a minute) and at most 7 days after login (`created_at` + 7 d).
- **Cookie:** `uot_session`, a random 32-byte token; `HttpOnly`, `SameSite=Lax`, `Secure` in production, `Path=/`.
- **Rate limit:** 5 wrong passwords in a row set `locked_until` = now + 15 min (`auth.lockout`). A correct password, or a lock that has run out, restarts the count. A wrong current password in `changeOwnPassword` counts the same way; the 5th there also deletes all of the user's sessions. While locked nothing is counted or audited. No per-IP limit.
- **Answers:** `login` gives one answer (`invalid`) for an unknown user, a wrong password, a locked and an inactive account. A wrong password for an unknown username is not audited (the log cannot be flooded); the answer time for a known username differs by a few DB round trips (accepted).
- **Passwords:** argon2id (`@node-rs/argon2` defaults); 10–128 characters, no other rule. `createUser` and `resetUserPassword` make a 12-character temporary password on the server and return it once. While `must_change_password` is set, only `changeOwnPassword` and `logout` are open. `changeOwnPassword` deletes the user's other sessions.
- **Accounts:** `updateUser` changes `username` (3–32 of `a-z A-Z 0-9 . _ -`) and `full_name` only; role and college are fixed at creation. An admin cannot deactivate or reset their own account. An account of an inactive college cannot be created or reactivated.
- **Guard:** `requireRole(roles)` in `lib/auth/guard.ts` — no session → `/login`, temporary password → `/change-password`, wrong role → `AuthError`. `collegeScope(actor, collegeId?)` and `ownRows(actor, column)` carry rules 2–3 of §4. `audit(tx, who, entry)` is in `lib/auth/audit.ts`. Audit `ip` is the last `X-Forwarded-For` entry (the one our proxy appends).

### 1.4 `machines`

```sql
CREATE TABLE machines (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                    text NOT NULL,
  model                   text NOT NULL,
  type                    machine_type NOT NULL,
  min_sheets              integer NOT NULL CHECK (min_sheets >= 1),          -- unit: impressions
  max_sheets              integer CHECK (max_sheets IS NULL OR max_sheets >= min_sheets), -- NULL = no limit
  supports_duplex         boolean NOT NULL,
  speed_per_hour          integer NOT NULL CHECK (speed_per_hour > 0),       -- impressions per hour
  setup_minutes_per_model integer NOT NULL CHECK (setup_minutes_per_model >= 0),
  priority                integer NOT NULL DEFAULT 100,                      -- lower = preferred
  archived_at             timestamptz,                                       -- NULL = active
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX machines_name_key ON machines (name) WHERE archived_at IS NULL;
```

`min_sheets` / `max_sheets` keep the plan's names but count `impressions` (plan §6.1). Rows are never deleted. The seed (step 1.1) loads the 7 machines of the PDF with tiers 1–400 / 401–800 / 801+ (`max_sheets` NULL) and placeholder speeds.

### 1.5 `machine_maintenance`

```sql
CREATE TABLE machine_maintenance (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  machine_id bigint NOT NULL REFERENCES machines(id),
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz CHECK (ends_at IS NULL OR ends_at >= starts_at),  -- NULL = open until reactivated
  reason     text NOT NULL,
  created_by bigint NOT NULL REFERENCES users(id),
  ended_by   bigint REFERENCES users(id),     -- who pressed "reactivate" or cancelled a planned window
  ended_at   timestamptz,                     -- when they pressed it
  CONSTRAINT maintenance_no_overlap
    EXCLUDE USING gist (machine_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
);
CREATE INDEX maintenance_machine_idx ON machine_maintenance (machine_id, starts_at);
```

A machine is "in maintenance during an interval" when a row's `[starts_at, ends_at)` (NULL end = infinity) overlaps it. A planned window cancelled before it starts gets `ends_at = starts_at` (empty range, stays in the log). The log's who / when / why / how long = `created_by`, `starts_at`, `reason`, `ends_at − starts_at`.

### 1.6 `machine_parts`

```sql
CREATE TABLE machine_parts (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  machine_id        bigint NOT NULL REFERENCES machines(id),
  name              text NOT NULL,                              -- drum, fuser, roller, blade …
  inventory_item_id bigint REFERENCES inventory_items(id),      -- the spare in stock (kind 'part'), if tracked
  life_impressions  integer NOT NULL CHECK (life_impressions > 0),
  impressions_used  integer NOT NULL DEFAULT 0 CHECK (impressions_used >= 0),
  installed_at      timestamptz NOT NULL DEFAULT now(),
  replaced_at       timestamptz,                                -- NULL = installed now
  replaced_by       bigint REFERENCES users(id)
);
CREATE INDEX machine_parts_installed_idx ON machine_parts (machine_id) WHERE replaced_at IS NULL;
```

Replacing a part closes the row (`replaced_at`, `replaced_by`) and inserts a new row with `impressions_used = 0`; old rows are the history.

### 1.7 `bookings`

```sql
CREATE TABLE bookings (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- reference
  ref_year         integer  NOT NULL,                 -- year of creation
  ref_seq          integer  NOT NULL CHECK (ref_seq >= 1),
  reference        text     NOT NULL UNIQUE,          -- 'YYYY-NNNN'

  -- who
  college_id       bigint  NOT NULL REFERENCES colleges(id),
  created_by       bigint  NOT NULL REFERENCES users(id),
  on_behalf        boolean NOT NULL DEFAULT false,    -- true when an admin booked for the college

  -- form
  doctor_name      text NOT NULL,
  doctor_phone     text NOT NULL CHECK (doctor_phone ~ '^2189[0-9]{8}$'),
  recipient_name   text NOT NULL,                     -- four-part name, validated by isFourPartName()
  subject          text NOT NULL,
  service_type     service_type NOT NULL,
  copies           integer NOT NULL CHECK (copies BETWEEN 1 AND 20000),
  models           integer NOT NULL CHECK (models BETWEEN 1 AND 50),
  pages_per_model  integer NOT NULL CHECK (pages_per_model BETWEEN 1 AND 500),   -- max impressions 5 × 10⁸, inside integer
  sides            sides   NOT NULL,
  exam_date        date,
  impressions      integer GENERATED ALWAYS AS (models * pages_per_model * copies) STORED,
  sheets           integer GENERATED ALWAYS AS (
                     models * copies *
                     CASE WHEN sides = 'duplex' THEN (pages_per_model + 1) / 2 ELSE pages_per_model END
                   ) STORED,

  -- schedule
  machine_id       bigint NOT NULL REFERENCES machines(id),
  starts_at        timestamptz NOT NULL CHECK (extract(epoch FROM starts_at) % 600 = 0),
  ends_at          timestamptz NOT NULL CHECK (extract(epoch FROM ends_at) % 600 = 0),
  work_date        date GENERATED ALWAYS AS ((starts_at AT TIME ZONE 'Africa/Tripoli')::date) STORED,

  -- state
  status           booking_status NOT NULL DEFAULT 'booked',
  needs_reschedule boolean NOT NULL DEFAULT false,
  reschedule_reason reschedule_reason,
  delay_notice_at  timestamptz,                       -- set once; the one delay notice
  delayed_from     timestamptz,                       -- starts_at before the delay notice

  identity_confirmed_by bigint REFERENCES users(id),
  identity_confirmed_at timestamptz,
  wasted_sheets    integer CHECK (wasted_sheets >= 0),
  waste_destroyed  boolean,
  ready_by         bigint REFERENCES users(id),
  ready_at         timestamptz,
  delivered_by     bigint REFERENCES users(id),
  delivered_at     timestamptz,
  no_show_by       bigint REFERENCES users(id),
  no_show_at       timestamptz,
  cancelled_by     bigint REFERENCES users(id),
  cancelled_at     timestamptz,
  cancel_reason    text,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CHECK (ends_at > starts_at),
  CHECK (needs_reschedule = (reschedule_reason IS NOT NULL)),
  CHECK (NOT needs_reschedule OR status IN ('booked', 'in_progress')),
  CHECK (status NOT IN ('in_progress', 'ready', 'delivered') OR identity_confirmed_at IS NOT NULL),
  CHECK (status NOT IN ('ready', 'delivered')
         OR (ready_at IS NOT NULL AND wasted_sheets IS NOT NULL AND waste_destroyed IS TRUE)),
  CHECK (status <> 'delivered' OR delivered_at IS NOT NULL),
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
  CHECK (status <> 'no_show'   OR no_show_at   IS NOT NULL),
  UNIQUE (ref_year, ref_seq),

  -- two bookings never overlap on one machine
  CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (machine_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
    WHERE (status NOT IN ('cancelled', 'no_show'))
);
CREATE INDEX bookings_day_machine_idx ON bookings (work_date, machine_id, starts_at);
CREATE INDEX bookings_college_idx     ON bookings (college_id, work_date);
CREATE INDEX bookings_status_idx      ON bookings (status, work_date);
CREATE INDEX bookings_reschedule_idx  ON bookings (starts_at) WHERE needs_reschedule;
```

- Cancelling or marking no-show releases the interval because the row leaves the exclusion constraint.
- `needs_reschedule` is a flag on a `booked` / `in_progress` row, not a status. A flagged row keeps its machine and interval until it is moved.
- The interval lies inside one working window (same `work_date`, between `work_start` and `work_end`); checked by the scheduler, not by the DB.
- Booking vs maintenance overlap spans two tables and is enforced by the scheduling lock (§3.9), not by a constraint.

### 1.8 `saturday_requests`

```sql
CREATE TABLE saturday_requests (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  college_id        bigint NOT NULL REFERENCES colleges(id),
  date              date   NOT NULL CHECK (extract(isodow FROM date) = 6),   -- a Saturday
  expected_quantity integer NOT NULL CHECK (expected_quantity > 0),          -- impressions
  reason            text NOT NULL,
  status            saturday_status NOT NULL DEFAULT 'pending',
  approved_quantity integer CHECK (approved_quantity > 0),                   -- impressions
  decided_by        bigint REFERENCES users(id),
  decided_at        timestamptz,
  decision_note     text,
  created_by        bigint NOT NULL REFERENCES users(id),
  CHECK ((status = 'approved') = (approved_quantity IS NOT NULL)),
  CHECK ((status = 'pending')  = (decided_at IS NULL))
);
CREATE UNIQUE INDEX saturday_one_open_idx ON saturday_requests (college_id, date) WHERE status IN ('pending', 'approved');
```

### 1.9 `inventory_items`

```sql
CREATE TABLE inventory_items (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  kind         item_kind NOT NULL,
  unit         text NOT NULL,                       -- paper is always counted in sheets
  machine_id   bigint REFERENCES machines(id),      -- for toner, master rolls and parts of one machine
  min_quantity integer NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
  is_active    boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX inventory_one_paper_idx ON inventory_items (kind) WHERE kind = 'paper' AND is_active;
```

Exactly one active paper item (A4, seeded); it cannot be deactivated.

### 1.10 `inventory_movements`

```sql
CREATE TABLE inventory_movements (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id         bigint NOT NULL REFERENCES inventory_items(id),
  type            movement_type NOT NULL,
  quantity        integer NOT NULL,                 -- signed
  booking_id      bigint REFERENCES bookings(id),   -- set by markReady
  machine_part_id bigint REFERENCES machine_parts(id), -- set by replaceMachinePart
  note            text,
  created_by      bigint NOT NULL REFERENCES users(id),
  CHECK (quantity <> 0),
  CHECK ((type = 'receive' AND quantity > 0)
      OR (type IN ('consume', 'waste') AND quantity < 0)
      OR  type = 'adjust'),
  CHECK (type <> 'adjust' OR note IS NOT NULL)
);
CREATE INDEX movements_item_idx ON inventory_movements (item_id, created_at);
CREATE UNIQUE INDEX movements_once_per_booking_idx ON inventory_movements (booking_id, type) WHERE booking_id IS NOT NULL;
```

Append-only (no UPDATE, no DELETE; a mistake is corrected by an `adjust`). Balance of an item = `SELECT coalesce(sum(quantity), 0) FROM inventory_movements WHERE item_id = $1`; no balance column exists anywhere.

### 1.11 `notifications`

```sql
CREATE TABLE notifications (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id             bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                notification_type NOT NULL,
  booking_id          bigint REFERENCES bookings(id),
  saturday_request_id bigint REFERENCES saturday_requests(id),
  data                jsonb NOT NULL DEFAULT '{}',   -- values for the Arabic text (old/new time, machine …)
  read_at             timestamptz
);
CREATE INDEX notifications_user_idx   ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
```

"The college is notified" = one row for each active user of that college. "Admins are notified" = one row per active admin.

### 1.12 `settings`, `holidays`

```sql
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by bigint REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE holidays (
  date       date PRIMARY KEY,
  name       text NOT NULL,
  created_by bigint NOT NULL REFERENCES users(id)
);
```

Keys and defaults: §5.

### 1.13 `audit_log`

```sql
CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    bigint REFERENCES users(id),     -- NULL = the system
  role       user_role,
  action     text NOT NULL,                   -- list in §6
  entity     text NOT NULL,                   -- table name
  entity_id  text,
  college_id bigint REFERENCES colleges(id),
  details    jsonb NOT NULL DEFAULT '{}',     -- before / after values; never a password or token
  ip         inet
);
CREATE INDEX audit_at_idx     ON audit_log (at);
CREATE INDEX audit_user_idx   ON audit_log (user_id, at);
CREATE INDEX audit_action_idx ON audit_log (action, at);
```

Append-only; no `created_at` (it is `at`).

## 2. Booking states

`booked → in_progress → ready → delivered`, plus `cancelled` and `no_show`. Every transition not in this table is refused.

| # | From → to | Action | Who | Guards | Writes |
|---|---|---|---|---|---|
| T1 | (none) → `booked` | `createBooking` | college (own), admin (on behalf) | form valid; placement found (§3) | booking row, reference; admin: `on_behalf = true`, audit, `booking_on_behalf` to the college |
| T2 | `booked` → `in_progress` | `confirmIdentity` | operator, admin | `work_date` = today; `needs_reschedule = false` (a flagged job that has not started is moved by the admin first) | `identity_confirmed_by`, `identity_confirmed_at`; audit |
| T3 | `in_progress` → `ready` | `markReady` | operator, admin | `wasted_sheets ≥ 0` given; `waste_destroyed = true`; a flag does not block it | `wasted_sheets`, `waste_destroyed`, `ready_by`, `ready_at`, flag cleared; paper movement `consume −sheets`; if wasted > 0, paper movement `waste −wasted_sheets`; `impressions_used += impressions` on every installed part of the machine; `booking_ready` to the college |
| T4 | `ready` → `delivered` | `markDelivered` | operator, admin | — | `delivered_by`, `delivered_at` |
| T5 | `booked` → `cancelled` | `cancelBooking` | college (own), admin | college: `now ≤ starts_at − edit_deadline_minutes`; admin: none | `cancelled_by`, `cancelled_at`, `cancel_reason`, flag cleared; admin: audit, `booking_cancelled` to the college |
| T6 | `in_progress` → `cancelled` | `cancelBooking` | admin only | `cancel_reason` required | as T5; no stock movement |
| T7 | `booked` → `no_show` | `markNoShow` | operator, admin | `now ≥ starts_at` | `no_show_by`, `no_show_at`, flag cleared; audit; `booking_no_show` to the college |

Rules for all transitions:

- Each one is a single `UPDATE … WHERE id = $1 AND status = $from AND <every guard of the row>` (e.g. T2: `AND needs_reschedule = false AND work_date = $today`; T5 by a college: `AND starts_at >= $now + edit_deadline`); zero rows updated = refused (someone else moved it first). Stock and notification rows are written in the same transaction.
- "Flag cleared" = `needs_reschedule = false, reschedule_reason = NULL`, both in the same UPDATE.
- `delivered`, `cancelled` and `no_show` are final.
- `confirmIdentity` is the step that starts the job: nothing can become `ready` without `identity_confirmed_at`.
- WhatsApp buttons write nothing: "started" is shown while `in_progress`, "ready" while `ready` (§4, `getWhatsAppLink`).
- Changes that are not transitions (the status stays the same): `editBooking`, `sendDelayNotice`, `moveBooking`, automatic reassignment (§3.7, §3.8).

## 3. Scheduling

Pure functions (step 1.3) take everything through `ctx` and never read the clock or the database themselves. Transactional steps (1.4, 2.3, 2.4) load `ctx` under the scheduling lock (§3.9).

```ts
type Sides = 'single' | 'duplex';
type ServiceType = 'exam_questions' | 'results' | 'quality' | 'answer_sheets';
type BookingStatus = 'booked' | 'in_progress' | 'ready' | 'delivered' | 'cancelled' | 'no_show';
interface JobSpec    { models: number; pagesPerModel: number; copies: number; sides: Sides }
interface Quantities { impressions: number; sheets: number }
interface Machine    { id: number; minSheets: number; maxSheets: number | null; supportsDuplex: boolean;
                       speedPerHour: number; setupMinutesPerModel: number; priority: number; archivedAt: Date | null }
interface Window     { open: Date; close: Date }                  // one working day
interface Busy       { machineId: number; start: Date; end: Date | null; bookingId?: number }  // holding bookings and maintenance rows
interface Placement  { machineId: number; startsAt: Date; endsAt: Date }
interface Booking extends JobSpec, Placement {
  id: number; collegeId: number; status: BookingStatus; reference: string;
  doctorPhone: string; subject: string; needsReschedule: boolean;
  rescheduleReason: 'maintenance' | 'delay_no_slot' | 'machine_change' | null;
  collegeName: string; machineName: string;   // joined for display (WhatsApp text, daily sheet)
}
interface Settings {                          // the §5 keys in camelCase
  workStart: string; workEnd: string; workingWeekdays: number[];
  largeJobThreshold: number; largeJobsPerDay: number;
  editDeadlineMinutes: number; delayDeadlineMinutes: number;
  suggestionSearchDays: number; partWarnPercent: number;
}
interface StockAlert { kind: 'low_stock' | 'part_near_end' | 'paper_short'; itemId?: number; machinePartId?: number; date?: string }

interface ScheduleContext {
  now: Date;
  collegeId: number;
  settings: Settings;                    // §5
  holidays: Set<string>;                 // 'YYYY-MM-DD'
  saturdayApprovals: { date: string; approvedQuantity: number; usedImpressions: number }[];  // this college only
  machines: Machine[];
  busy: Busy[];
  largeJobsByDate: Map<string, number>;  // holding bookings with impressions > large_job_threshold
  loadMinutes(machineId: number, date: string): number;   // minutes of holding bookings that day
  ignoreBookingId?: number;              // the booking being edited, delayed or moved (see below)
}
type Refusal = 'day_closed' | 'past' | 'hour_full' | 'large_job_limit' | 'saturday_quota'
             | 'no_machine' | 'no_free_slot' | 'too_long';
```

- The loader builds `ctx` without the booking named by `ignoreBookingId`: it is absent from `busy`, `loadMinutes`, `largeJobsByDate` and `usedImpressions`. The pure functions never subtract it again.
- `usedImpressions` = sum of `impressions` of this college's holding bookings on that date (own and on-behalf).

Example machines used below (placeholders, not the real seed):

| | type | range | duplex | speed/h | setup/model | priority |
|---|---|---|---|---|---|---|
| M1 | laser | 1–400 | yes | 3,000 | 5 | 1 |
| M2 | laser | 401–800 | yes | 4,200 | 5 | 1 |
| M3 | duplicator | 801+ | no | 7,200 | 10 | 1 |
| M4 | laser | 801+ | yes | 6,000 | 5 | 2 |

Working window in the examples: 09:00–15:00 (360 minutes).

### 3.1 Quantities

```ts
function quantities(job: JobSpec): Quantities
// impressions = models × pagesPerModel × copies
// sheets      = models × copies × (sides === 'duplex' ? ceil(pagesPerModel / 2) : pagesPerModel)
```

| models × pages × copies | sides | impressions | sheets |
|---|---|---|---|
| 3 × 4 × 200 | duplex | 2,400 | 3 × 200 × 2 = 1,200 |
| 3 × 4 × 200 | single | 2,400 | 2,400 |
| 2 × 5 × 100 | duplex (odd pages) | 1,000 | 2 × 100 × 3 = 600 |
| 1 × 1 × 30 | duplex | 30 | 30 |

`impressions` drives tier, duration, the large-job rule, the Saturday quota and part counters. `sheets` drives paper stock only.

### 3.2 Duration

```ts
function durationMinutes(job: JobSpec, m: Machine): number
// raw minutes = models × setup + impressions × 60 ÷ speed, rounded up to a multiple of 10, minimum 10.
// Integer arithmetic only (a float form such as 2500 / 600 * 60 = 250.00000000000003 rounds to 260):
// result = max(10, ceil((models × setup × speed + impressions × 60) / (speed × 10)) × 10)
```

| Job | Machine | raw | result |
|---|---|---|---|
| 3 × 4 × 200 (2,400) | M4 | 15 + 24 = 39 | 40 |
| 1 × 2 × 150 (300) | M1 | 5 + 6 = 11 | 20 |
| 1 × 2 × 150 (300) | M2 | 5 + 4.29 = 9.29 | 10 |
| 2 × 5 × 50 (500) | M3 | 20 + 4.17 = 24.17 | 30 |

The duration is fixed when the booking is placed. A later change to the machine's speed does not move existing bookings.

### 3.3 Eligible machines and their order

```ts
function isStaticEligible(job: JobSpec, m: Machine): boolean
// m.archivedAt === null
// && (job.sides === 'single' || m.supportsDuplex)
// && (m.maxSheets === null || m.maxSheets >= impressions)      // a smaller machine never takes a bigger job

function tierGroup(m: Machine, impressions: number): number
// 0          when m.minSheets <= impressions   (the job is inside the machine's range)
// m.minSheets otherwise                        (a larger machine; nearer tiers sort first)

function isFreeOn(m: Machine, interval: { start: Date; end: Date }, ctx: ScheduleContext): boolean
// no holding booking and no maintenance row on m overlaps the interval (ctx.ignoreBookingId excepted)
```

Full eligibility for an interval = `isStaticEligible && isFreeOn`. Machine order, when two machines compete at the same start: `tierGroup` ascending, then `priority` ascending, then `loadMinutes` that day ascending, then `id`. Functions below that also compare starts give their own full key.

Tier edges, single-sided job:

| impressions | M1 (1–400) | M2 (401–800) | M3 (801+) | M4 (801+) | order |
|---|---|---|---|---|---|
| 400 | in range | larger | larger | larger | M1, M2, M3, M4 |
| 401 | **not eligible** | in range | larger | larger | M2, M3, M4 |
| 800 | not eligible | in range | larger | larger | M2, M3, M4 |
| 801 | not eligible | **not eligible** | in range | in range | M3, M4 |

Same rows for a duplex job: M3 drops out everywhere (no duplex), so 801 duplex → M4 only.

### 3.4 Working calendar

```ts
function workingWindow(date: string, ctx: ScheduleContext): Window | null
// null (closed) when the date is a holiday
// open for every college when the weekday is in settings.working_weekdays
// otherwise open only when ctx.saturdayApprovals has an approved row for this date and college
// window = [date work_start, date work_end)

function dayRefusal(job: JobSpec, date: string, ctx: ScheduleContext): Refusal | null
// 'day_closed'      workingWindow() is null
// 'large_job_limit' impressions > large_job_threshold && largeJobsByDate(date) >= large_jobs_per_day
// 'saturday_quota'  date is open only by approval && usedImpressions + impressions > approvedQuantity
```

Examples (threshold 6,000, limit 2): a day already holds jobs of 7,200 and 9,000 impressions. A new job of 6,000 is not large ("above 6,000" is strict) → allowed. A new job of 6,001 → `large_job_limit`, the suggestion moves to the next open day. A holiday on a weekday → `day_closed` for everyone. A Saturday approved for college A up to 5,000 with 3,800 used: A's 1,000 job is allowed, A's 1,500 job → `saturday_quota`, college B → `day_closed`.

### 3.5 Free-interval search

```ts
function freeStarts(job: JobSpec, m: Machine, date: string, ctx: ScheduleContext): Date[]
// every grid start s (10-minute steps) on that date with
//   s >= max(window.open, ctx.now rounded up to the grid),
//   s + durationMinutes(job, m) <= window.close,
//   isFreeOn(m, [s, s + duration))
// [] when dayRefusal() is not null or m is not static-eligible

function placeInHour(job: JobSpec, date: string, hour: number, ctx: ScheduleContext): Placement | Refusal
// candidates: for each static-eligible machine, its earliest free start s with hour:00 <= s <= hour:50
// winner: smallest (tierGroup, s, priority, loadMinutes, id)
// the end may run past the hour, never past window.close

function nearestFreeStart(job: JobSpec, date: string, hour: number, ctx: ScheduleContext): Placement | Refusal
// used when placeInHour() refuses. On the start date, then on each later date up to
// suggestion_search_days calendar days after the start date, skipping dates that are closed
// or refused by dayRefusal(): among all free starts of that date take the smallest
// (|s − hour:00 of that date|, tierGroup, s, priority, loadMinutes, id). The first date with a candidate wins.
// A suggestion is never booked until the coordinator accepts it.
```

Example A — the hour has room. Job 1 × 2 × 150 single (300 impressions), Sunday, hour 10. M1 (20 min) is busy 09:30–10:40 and 10:50–11:30: no start in hour 10 fits (10:40 would end at 11:00 and hit the 10:50 booking). M2 (10 min, tier group 401) is busy 10:00–10:30 → earliest free start 10:30. Result: M2, 10:30–10:40.

Example B — a full hour. Same job and same M1, but M2, M3 and M4 are busy 09:00–11:00. `placeInHour` → `hour_full`. Free starts nearby: M1 09:10 (09:10–09:30, 50 minutes from 10:00), M1 09:00 and M2 11:00 (60 minutes), M1 11:30 (90 minutes). Suggestion: M1 at 09:10.

Example C — closed day. The coordinator asks for Friday (not a working weekday): `day_closed`, suggestion = the nearest start to that hour on the next open day.

Refusal order and results:

- `placeInHour` checks in this order and returns the first hit: `past` (date before today, or no grid start of that hour is ≥ `ctx.now` rounded up) · `no_machine` (no static-eligible machine) · `too_long` · `day_closed` (also when the hour lies outside `[work_start, work_end)`) · `large_job_limit` · `saturday_quota` · `hour_full`.
- `nearestFreeStart` is not called after `no_machine` or `too_long`. After any other refusal it searches from `max(requested date, today)`; nothing found → `no_free_slot`.
- `getAvailability` = `exact` (the `placeInHour` placement) · else `suggestion` (the `nearestFreeStart` placement, `reason` = the `placeInHour` refusal) · else `none` with `reason` = `no_machine` / `too_long` (+ `maxCopies`) / `no_free_slot`.

### 3.6 A job longer than the day (manual split, plan §6.2)

```ts
function maxCopiesInOneDay(job: JobSpec, ctx: ScheduleContext): number
// E = machines static-eligible for the job as entered (never empty here: 'no_machine' is answered first)
// dayMinutes = work_end − work_start
// result = the largest, over E, of
//   floor(((dayMinutes − models × setup_m) × speed_m) / (60 × models × pagesPerModel)), never below 0
//   (one integer division, no floating point)
// i.e. the most copies the fastest eligible machine finishes in one full working day
```

A booking is one interval on one machine inside one working day, and the system never splits a job. A job is too long when `job.copies > maxCopiesInOneDay(job, ctx)`, which is the same as "no eligible machine has `durationMinutes(job, m) <= dayMinutes`". `placeInHour` checks this right after `past` and `no_machine` (order in §3.5) and answers `too_long`: no suggestion is searched, nothing is written. `getAvailability` and `createBooking` pass on `too_long` with `maxCopies`, and the form shows:

> هذا العمل لا يكفيه يوم دوام واحد على أي آلة مناسبة. أقصى عدد نسخ في حجز واحد: {maxCopies}. قسّم العمل إلى عدة حجوزات.

The coordinator then books the job as several separate bookings. Each one stands alone: its own reference `YYYY-NNNN`, form, identity confirmation and hand-over; there are no part numbers and nothing links the bookings in the database. A result of 0 means even one copy of all the models does not fit in a day: the coordinator books fewer models per booking.

Example. 6 models × 8 pages × 1,200 copies, duplex = 57,600 impressions. Only M4 is eligible (duplex, 801+): 6 × 5 + 57,600 ÷ 6,000 × 60 = 606 → 610 minutes > 360. `maxCopiesInOneDay` = floor((360 − 30) × 6,000 ÷ (60 × 48)) = floor(687.5) = 687; 1,200 > 687 → `too_long`, the form shows 687. The coordinator books two jobs of 600 copies (28,800 impressions, 14,400 sheets, 30 + 288 = 318 → 320 minutes each):

| Booking | Reference | Machine | Interval | Large-job slot |
|---|---|---|---|---|
| 600 copies, Sunday hour 9 | `2026-0042` | M4 | Sunday 09:00–14:20 | one of Sunday's two |
| 600 copies, Monday hour 9 | `2026-0043` | M4 | Monday 09:00–14:20 (M4 has only 40 minutes left on Sunday) | one of Monday's two |

### 3.7 Edit, delay notice, manual move

```ts
function latestFreeStart(booking: Booking, ctx: ScheduleContext): Placement | null
// same date only; ctx.ignoreBookingId = booking.id
// candidates: every free start s > booking.startsAt on every static-eligible machine
// winner: the latest s; ties by (tierGroup, priority, loadMinutes, id); the end comes from that machine's duration
```

- **`editBooking`**. College: status `booked` and `now ≤ starts_at − edit_deadline_minutes`. Admin: status `booked`, any time. If none of `copies`, `models`, `pages_per_model`, `sides`, day or hour changes, it is a plain update: `UPDATE … WHERE id = $1 AND status = 'booked'` (college: `AND starts_at >= $now + edit_deadline`); zero rows → `not_editable`. Otherwise the booking is placed again exactly like a new one (`ignoreBookingId` set); no placement → nothing changes and the suggestion is returned, which the coordinator may accept with `accept` exactly as for `createBooking` (types in §4). The reference stays the same. A successful new placement clears `needs_reschedule`. An admin edit is audited and, when the time changes, sends `booking_rescheduled`.
- **`sendDelayNotice`**. College (own). Guards: status `booked`, `delay_notice_at IS NULL`, `needs_reschedule = false`, `now ≤ starts_at − delay_deadline_minutes`. Writes `delay_notice_at = now`, `delayed_from = old starts_at`, then:
  - `latestFreeStart` found → `machine_id`, `starts_at`, `ends_at` updated; the old interval is free from that moment;
  - none → the interval stays, `needs_reschedule = true`, `reschedule_reason = 'delay_no_slot'`, `booking_needs_reschedule` to the admins. The admin decides with `moveBooking` or `cancelBooking`.
- **`moveBooking(bookingId, { machineId, startsAt })`**. Admin; status `booked` or `in_progress`. The target must pass `isStaticEligible`, `isFreeOn`, the working window, when the day changes `dayRefusal`, and, for a `booked` booking, `startsAt ≥ ctx.now` rounded up to the grid (an `in_progress` job may keep a past start). Writes the new machine and interval, clears the flag, audit, `booking_rescheduled` to the college.

Example — delay. A 1 × 2 × 150 single-sided booking (300 impressions) sits on M1 at 11:00–11:20; the notice arrives at 09:45 (75 minutes before, accepted). M1 is busy 14:00–15:00, the other machines are free in the afternoon. Latest starts: M1 13:40 (20 min), M2 14:50 (10 min), M3 14:40 (20 min), M4 14:50 (10 min). Latest is 14:50 on M2 and M4; M2 wins the tie (tier group 401 before 801). Result: M2 14:50–15:00, `delayed_from = 11:00`, M1 11:00–11:20 is free again. A second notice on this booking is refused. Had no eligible machine had a free start after 11:00, the booking would stay at 11:00 with the flag and wait in the admin list.

### 3.8 Maintenance and reassignment

```ts
function reassignSameTime(booking: Booking, ctx: ScheduleContext): Placement | null
// start stays; candidates: other static-eligible machines m with
//   [startsAt, startsAt + durationMinutes(job, m)) free on m and ending <= window.close
// winner: smallest (tierGroup, priority, loadMinutes, id); the end may change with the machine's speed
```

- **`startMaintenance(machineId, { startsAt, endsAt | null, reason })`**. Admin. `startsAt` = now ("stop now") or a future instant (planned window). In one transaction: insert the row, then for every booking on that machine with status `booked` or `in_progress` whose interval overlaps the window, in `starts_at` order:
  - `reassignSameTime` found → update `machine_id` and `ends_at`; audit `booking.auto_move`; no notification (the time did not change);
  - none → when the row is not flagged yet: `needs_reschedule = true`, `reschedule_reason = 'maintenance'`; audit; `booking_needs_reschedule` to the college and the admins. A row already flagged (for example `delay_no_slot`) keeps its reason; audit only.
  The move runs when the stop is recorded, also for a window that starts later. From then on the window is busy time, so no new booking lands in it.
- **`endMaintenance(maintenanceId)`**. Admin. Sets `ends_at = now` when it was NULL or later than now (`ends_at = starts_at` when the window has not started), `ended_by`, `ended_at`. Then every booking still on that machine with `reschedule_reason = 'maintenance'`, `starts_at > now`, no remaining overlap with a maintenance row, and whose machine still passes `isStaticEligible` for the job gets its flag cleared and the college gets `booking_restored`. (A flagged job already `in_progress` is cleared by `markReady`, T3.)
- **`listNeedsReschedule()`** = `SELECT … WHERE needs_reschedule ORDER BY starts_at` (admin list); each row is resolved by `moveBooking` or `cancelBooking`.
- **Archiving a machine, or an edit that makes a booking on it ineligible** (duplex removed, `max_sheets` lowered): affected = bookings on that machine with status `booked` and `starts_at > now` that fail `isStaticEligible`. They go through the same two branches; branch "none" writes `reschedule_reason = 'machine_change'`. `unarchiveMachine` restores nothing.

Example. M2 gets a planned stop 10:00–12:00, recorded the day before.

| Booking on M2 | Job | Candidates | Result |
|---|---|---|---|
| B1 10:10–10:30 | 2 × 5 × 50 single, 500 impressions | M1 never (max 400 < 500). M3 and M4 are larger, same tier group; M3 has priority 1; M3 needs 30 min and is free 10:10–10:40 | moved to M3, 10:10–10:40 |
| B2 11:00–11:20 | 1 × 6 × 100 duplex, 600 impressions | M3 has no duplex. M4 needs 20 min but is busy 10:30–11:30 | stays, `needs_reschedule` (maintenance); the admin moves it, for example to M2 at 14:00 |
| B3 13:00–13:20 | any | does not overlap the window | untouched |

If the admin reactivates M2 at 10:40, B2 (11:00, still on M2, no overlap left) is restored automatically and the college is told.

### 3.9 Concurrency

- Scheduling transactions run at READ COMMITTED (the PostgreSQL default), never REPEATABLE READ or SERIALIZABLE: there the snapshot is taken by the lock statement before it waits, so every read after the lock would be stale.
- Every transaction that creates a booking; may change a booking's `machine_id` / `starts_at` / `ends_at` / `needs_reschedule`; writes `machine_maintenance`; writes `machines` (`createMachine`, `updateMachine`, `archiveMachine`, `unarchiveMachine`); or runs `addHoliday` starts with `SELECT pg_advisory_xact_lock(7001)` (one scheduling lock for the whole centre), then loads `ctx`, decides and writes. This makes free-interval search, the large-job count, the Saturday quota, the reference number, the booking-vs-maintenance rule and the holiday check atomic.
- Under the lock, every UPDATE of a booking's placement or flag also has `AND status IN ('booked', 'in_progress')` (edit and delay: `AND status = 'booked'`). Zero rows = the booking left a holding state meanwhile: skipped by `startMaintenance` and archive, refused for move, edit and delay.
- `bookings_no_overlap` stays the final authority. On SQLSTATE `23P01` or `40P01` the transaction is retried from the start, at most 3 times; then the action returns `slot_taken` with a fresh suggestion.
- Reference number, under the same lock: `ref_seq = coalesce(max(ref_seq), 0) + 1` for `ref_year` = current year; `UNIQUE (ref_year, ref_seq)` is the backstop.
- State transitions (§2) do not take the lock; they rely on the guards in their `WHERE` (§2 rules).

### 3.10 Small helpers

```ts
function normalizePhone(input: string): string | null
// strip spaces, dashes, brackets and a leading '+'; '00218…' → '218…'; '09XXXXXXXX' → '2189XXXXXXXX';
// '9XXXXXXXX' → '2189XXXXXXXX'; valid only when the result matches /^2189\d{8}$/, else null (rejected)
// '091-2345678' → '218912345678' · '+218 92 123 4567' → '218921234567' · '0213601234' → null

function isFourPartName(name: string): boolean        // at least four words of two letters or more
function examDateWarning(bookingDate: string, examDate: string | null): boolean
// true when examDate is set and bookingDate >= examDate; a warning only, it never blocks

function formatReference(year: number, seq: number): string
// '2026-0042'; seq is zero-padded to 4 and grows past 9999

function whatsAppLink(kind: 'started' | 'ready', b: Booking): string
// `https://wa.me/${b.doctorPhone}?text=${encodeURIComponent(text)}`
// started: 'مركز التصوير والطباعة – جامعة طرابلس: بدأ تصوير «{subject}» ({college}) على الآلة {machine}. المرجع {reference}.'
// ready:   'مركز التصوير والطباعة – جامعة طرابلس: «{subject}» ({college}) جاهز للاستلام. المرجع {reference}.'

function getStockAlerts(): StockAlert[]
// 'low_stock'       item balance <= min_quantity
// 'part_near_end'   installed part with impressions_used >= life_impressions × part_warn_percent / 100
// 'paper_short'     a date (today … +suggestion_search_days) whose booked + in_progress sheets exceed the paper balance
```

## 4. Server actions and permission matrix

Rules for every action:

1. The first line is the role guard (`requireRole`). No session, inactive user or wrong role → refused before anything is read.
2. A `college` user's `college_id` comes from the session, never from the request. "own" below means `row.college_id = session.college_id`; any other row answers "not found".
3. Only an admin may pass a `collegeId` (booking on behalf).
4. Input is validated with Zod before the transaction. Form bounds (same as the §1.7 CHECKs): `copies` 1–20,000, `models` 1–50, `pages_per_model` 1–500.
5. Admin exceptions to plan §3 "everything" (owner, 2026-11-25): the admin does not send delay notices (uses `moveBooking`) and does not file Saturday requests (decides them).

`✓` allowed · `own` own college's rows only · `—` refused.

| Action | college | operator | admin | Notes |
|---|---|---|---|---|
| **Session** | | | | |
| `login` | public | public | public | rate-limited; `failed_login_count`, `locked_until` |
| `logout`, `changeOwnPassword` | ✓ | ✓ | ✓ | |
| `listMyNotifications`, `markNotificationRead` | ✓ | ✓ | ✓ | own rows only |
| **Colleges and accounts** | | | | |
| `listColleges`, `createCollege`, `updateCollege`, `setCollegeActive` | — | — | ✓ | |
| `listUsers`, `createUser`, `updateUser`, `setUserActive`, `resetUserPassword` | — | — | ✓ | new and reset passwords set `must_change_password` |
| **Machines and maintenance** | | | | |
| `listMachines` | — | ✓ | ✓ | operator: read-only, for the queue |
| `createMachine`, `updateMachine`, `archiveMachine`, `unarchiveMachine` | — | — | ✓ | §3.8 last bullet |
| `startMaintenance`, `endMaintenance`, `listMaintenance` | — | — | ✓ | §3.8 |
| `listNeedsReschedule`, `moveBooking` | — | — | ✓ | §3.7, §3.8 |
| **Bookings** | | | | |
| `getAvailability` | own | — | ✓ | returns an exact placement, a suggestion or a refusal; writes nothing; `bookingId` (own booking) for an edit |
| `createBooking` | own | — | ✓ | T1; admin = on behalf |
| `getBooking` | own | ✓ | ✓ | |
| `listBookings` | own | — | ✓ | admin may pass `collegeId`; newest `starts_at` first; no machine in a row (step 1.6) |
| `getBookingFormConfig` | ✓ | — | ✓ | `work_start`, `work_end`, `working_weekdays` and today's business date, for the booking form; a college cannot read the settings (step 1.6) |
| `getDayQueue(date)` | — | ✓ | ✓ | by time and machine |
| `editBooking` | own | — | ✓ | §3.7; college until the deadline |
| `cancelBooking` | own | — | ✓ | T5, T6 |
| `sendDelayNotice` | own | — | — | §3.7; the admin uses `moveBooking` |
| `confirmIdentity` | — | ✓ | ✓ | T2 |
| `markReady` | — | ✓ | ✓ | T3 |
| `markDelivered` | — | ✓ | ✓ | T4 |
| `markNoShow` | — | ✓ | ✓ | T7 |
| `getWhatsAppLink` | — | ✓ | ✓ | §3.10 |
| `getDailySheet(date)` | — | ✓ | ✓ | holding bookings of the day: time, reference, college, doctor, recipient, subject, service, copies × models, sides, machine; the two signature boxes are print-only |
| **Saturday** | | | | |
| `createSaturdayRequest` | own | — | — | `saturday_requested` to the admins |
| `listSaturdayRequests` | own | — | ✓ | |
| `decideSaturdayRequest` | — | — | ✓ | approve with `approved_quantity`, or reject; `saturday_decided` to the college |
| **Stock** | | | | |
| `listInventory`, `listMovements`, `getStockAlerts` | — | — | ✓ | balance = sum of movements |
| `createInventoryItem`, `updateInventoryItem` | — | — | ✓ | |
| `receiveStock` | — | — | ✓ | movement `receive` (+) |
| `consumeStock` | — | — | ✓ | movement `consume` (−); toner and master rolls replaced by hand |
| `adjustStock` | — | — | ✓ | movement `adjust` (±), note required |
| `listMachineParts`, `addMachinePart` | — | — | ✓ | |
| `replaceMachinePart` | — | — | ✓ | closes the old row, new row at 0, movement `consume −1` when the part has a stock item |
| **Settings** | | | | |
| `getSettings`, `updateSettings` | — | — | ✓ | §5 |
| `listHolidays`, `addHoliday`, `removeHoliday` | — | — | ✓ | `addHoliday` refused while the date has holding bookings (§5) |
| **Reports and audit** | | | | |
| `reportByCollege(from, to)` | — | — | ✓ | bookings, impressions, sheets, cancelled, no-shows, delay notices |
| `reportByMachine(from, to)` | — | — | ✓ | bookings, impressions, booked minutes, downtime from `machine_maintenance` |
| `reportWasteAndStock(from, to)` | — | — | ✓ | `wasted_sheets`, movements by item and type |
| `reportPeakHours(from, to)` | — | — | ✓ | bookings and impressions by hour of `starts_at` |
| `listAuditLog(filter)` | — | — | ✓ | filter by user, action, date |

`createBooking` input and result:

```ts
interface BookingForm { doctorName: string; doctorPhone: string; recipientName: string; subject: string;
                        serviceType: ServiceType; copies: number; models: number; pagesPerModel: number;
                        sides: Sides; examDate: string | null }
interface CreateBookingInput extends BookingForm {
  collegeId?: number;                    // admin only
  date: string; hour: number;            // what the coordinator picked
  accept?: Placement;                    // a suggestion returned earlier, now accepted
}
type Availability =
  | { kind: 'exact';      placement: Placement }
  | { kind: 'suggestion'; placement: Placement; reason: Refusal }
  | { kind: 'none';       reason: Refusal; maxCopies?: number };   // maxCopies comes with 'too_long'
type CreateBookingResult =
  | { ok: true;  booking: { id: number; reference: string }; examDateWarning: boolean }
  | { ok: false; error: 'validation' | 'slot_taken' | 'needs_confirmation' | 'refused'; availability?: Availability };
```

Without `accept`, a booking is written only when availability is `exact`. A `suggestion` writes nothing and returns `needs_confirmation`; `none` writes nothing and returns `refused`.

With `accept`, the server uses only `accept.machineId` and `accept.startsAt`; `endsAt` = `startsAt + durationMinutes(job, machine)`. Under the lock it requires: start on the grid and ≥ `ctx.now` rounded up, `isStaticEligible`, not `too_long`, `workingWindow` open and `endsAt ≤ close`, `dayRefusal` null, `isFreeOn`. Any failure → nothing written, `slot_taken` with fresh availability.

```ts
interface EditBookingInput extends BookingForm { bookingId: number; date: string; hour: number; accept?: Placement }
type EditBookingResult =
  | { ok: true;  booking: { id: number; reference: string }; examDateWarning: boolean }   // same reference kept
  | { ok: false; error: 'validation' | 'slot_taken' | 'needs_confirmation' | 'refused' | 'not_editable';
      availability?: Availability };                                     // 'not_editable' = status or deadline
interface GetAvailabilityInput extends JobSpec { collegeId?: number; date: string; hour: number; bookingId?: number }  // collegeId: admin only; bookingId sets ignoreBookingId, own booking only
```

`accept` works for an edit exactly as for `createBooking`.

## 5. Settings keys

Rows of `settings`; `value` is JSON. Seeded with the defaults.

| Key | Default | Meaning | Validation |
|---|---|---|---|
| `work_start` | `"09:00"` | opening time | `HH:MM` on the 10-minute grid |
| `work_end` | `"15:00"` | closing time | on the grid, after `work_start` |
| `working_weekdays` | `[0, 1, 2, 3, 4]` | 0 = Sunday … 6 = Saturday; default Sunday–Thursday until the owner confirms (plan §7) | non-empty subset of 0–6 |
| `large_job_threshold` | `6000` | a job is large when `impressions` is above this | integer ≥ 1 |
| `large_jobs_per_day` | `2` | large jobs allowed per day, all machines and colleges together | integer ≥ 0 |
| `edit_deadline_minutes` | `60` | a college may edit or cancel until this long before the start | integer ≥ 0 |
| `delay_deadline_minutes` | `60` | a delay notice is accepted until this long before the start | integer ≥ 0 |
| `suggestion_search_days` | `14` | how many days ahead the nearest-start search looks | integer 1–60 |
| `part_warn_percent` | `90` | a part alerts when its counter reaches this share of its life | integer 1–100 |

Holidays live in `holidays`. Changing hours or weekdays never moves existing bookings. `addHoliday` is refused while that date has holding bookings; the answer lists them, and the admin moves or cancels them first (owner, 2026-11-25). Constants that are not settings: time zone, `SLOT_MINUTES = 10`, one delay notice per booking, scheduling lock key `7001`, 3 retries.

## 6. Notifications and audit

| Notification | To | Written by |
|---|---|---|
| `booking_ready` | college | `markReady` |
| `booking_no_show` | college | `markNoShow` |
| `booking_needs_reschedule` | college and admins (maintenance, machine change); admins (delay with no slot) | `startMaintenance`, machine archive or edit, `sendDelayNotice` |
| `booking_rescheduled` | college | `moveBooking`, admin `editBooking` that changes the time |
| `booking_restored` | college | `endMaintenance` |
| `booking_cancelled` | college | admin `cancelBooking` |
| `booking_on_behalf` | college | admin `createBooking` |
| `saturday_requested` | admins | `createSaturdayRequest` |
| `saturday_decided` | college | `decideSaturdayRequest` |

Audited actions (`audit_log.action`), written by the `audit()` helper inside the same transaction:

`auth.login_failed`, `auth.lockout`, `user.create`, `user.update`, `user.set_active`, `user.reset_password`, `college.create`, `college.update`, `college.set_active`, `machine.create`, `machine.update`, `machine.archive`, `machine.unarchive`, `maintenance.start`, `maintenance.end`, `settings.update`, `holiday.add`, `holiday.remove`, `booking.create_on_behalf`, `booking.admin_edit`, `booking.admin_cancel`, `booking.move`, `booking.auto_move`, `booking.flag_reschedule`, `booking.delay_notice`, `booking.confirm_identity`, `booking.no_show`, `saturday.decide`, `stock.receive`, `stock.consume`, `stock.adjust`, `part.add`, `part.replace`.

## 7. Rule map — plan.md §4 → this file

| Plan rule | Where |
|---|---|
| Booking form fields | `bookings` form columns (§1.7), `BookingForm` (§4) |
| Phone normalised, invalid rejected | `normalizePhone` (§3.10), `doctor_phone` CHECK |
| Exam date only warns | `examDateWarning` (§3.10), `CreateBookingResult.examDateWarning` |
| Reference `YYYY-NNNN` | `ref_year`, `ref_seq`, `reference` (§1.7), `formatReference`, §3.9 |
| `impressions`, `sheets` | generated columns (§1.7), `quantities` (§3.1) |
| Machines are data; fields | `machines` (§1.4); `createMachine`, `updateMachine` |
| Seed of 7 machines, tiers | note under §1.4 (loaded in step 1.1), `tierGroup` (§3.3) |
| Archive, never delete | `machines.archived_at`, RESTRICT foreign keys, `archiveMachine` |
| Duration formula, 10-minute rounding | `durationMinutes` (§3.2) |
| One interval on one machine, no overlap | `bookings_no_overlap` (§1.7), §3.9 |
| Eligible machine | `isStaticEligible`, `isFreeOn` (§3.3) |
| Preference order, larger takes smaller, never the reverse | machine order and `tierGroup` (§3.3) |
| Day and hour, earliest free start, else nearest | `placeInHour`, `nearestFreeStart` (§3.5), `Availability` (§4) |
| Working hours, weekdays, holidays | `workingWindow` (§3.4), settings (§5), `holidays` |
| Large jobs: at most 2 a day above 6,000 | `dayRefusal` (§3.4), `large_job_threshold`, `large_jobs_per_day` |
| Saturday request and approval, per college, up to a quantity | `saturday_requests` (§1.8), `workingWindow`, `dayRefusal`, `createSaturdayRequest`, `decideSaturdayRequest` |
| A job must fit in one working day; a bigger one is split by the coordinator (plan §6.2) | `maxCopiesInOneDay`, refusal `too_long` with `maxCopies` (§3.6) |
| Edit or cancel until 60 minutes before; then admin only | `editBooking` (§3.7), T5, `edit_deadline_minutes` |
| Delay notice, once, latest free interval, else admin | `sendDelayNotice`, `latestFreeStart` (§3.7), `delay_notice_at`, `delayed_from` |
| No-show releases the time, notifies, counts in reports | T7, exclusion predicate, `booking_no_show`, `reportByCollege` |
| Admin books on behalf, recorded | `on_behalf`, `created_by`, audit `booking.create_on_behalf` |
| Stop now or planned, with reason; reactivate | `machine_maintenance` (§1.5), `startMaintenance`, `endMaintenance` |
| Affected bookings move to another machine at the same time | `reassignSameTime` (§3.8) |
| No alternative → `needs_reschedule`, admin list, college notified | `needs_reschedule`, `reschedule_reason`, `listNeedsReschedule`, `moveBooking`, `booking_needs_reschedule` |
| Every stop logged: who, when, why, how long | `machine_maintenance` columns, audit `maintenance.start` / `maintenance.end` |
| States | `booking_status`, table in §2 |
| Identity confirmed first; operator and time recorded | T2, `identity_confirmed_by`, `identity_confirmed_at` |
| WhatsApp "started" | `whatsAppLink('started')`, `getWhatsAppLink` |
| Finish: wasted sheets, destroyed tick, notification, WhatsApp "ready" | T3, `wasted_sheets`, `waste_destroyed`, `booking_ready`, `whatsAppLink('ready')` |
| Hand-over | T4 |
| Daily printed sheet | `getDailySheet` (§4) |
| Stock items and parts with a life | `inventory_items` (§1.9), `machine_parts` (§1.6) |
| Every change is a movement; balance derived | `inventory_movements` (§1.10) |
| On `ready`: paper and part counters | T3 writes |
| Toner and master rolls by hand | `consumeStock` |
| Alerts | `getStockAlerts` (§3.10), `part_warn_percent`, `min_quantity` |
| Settings screen | §5, `getSettings`, `updateSettings`, holiday actions |
| Audit log, admin only | `audit_log` (§1.13), §6, `listAuditLog` |
| Reports | the four `report…` actions (§4) |
| Roles; a college sees only its own data; no self sign-up | matrix and rules 1–3 (§4), `users` (§1.2) |
| Starts and durations on the 10-minute grid (plan §6.4) | `SLOT_MINUTES`, grid CHECKs (§1.7), `durationMinutes` (§3.2) |
| Same person hands in and collects (plan §6.5) | one `recipient_name`; identity checked at T2 only |

## 8. Choices made here (not stated in plan.md)

All approved by the owner on 2026-11-25 (1–16 before the Opus 5.5 review, 17–20 while applying it). They are settled product decisions: a review checks that the rest of this file follows them, it does not reopen them.

1. Inside the chosen hour the order is tier group → earliest start → priority → least loaded. Among larger machines the nearest tier comes first.
2. A suggestion is the start nearest to the requested hour, same day first, then later days up to `suggestion_search_days` (default 14).
3. `ready` and `delivered` bookings keep holding their interval; only `cancelled` and `no_show` release it.
4. `confirmIdentity` is itself the move to `in_progress`, allowed only on the booking's day.
5. No-show can be marked only once the start time has passed.
6. An admin (nobody else) may cancel a booking that is `in_progress`, with a reason — the way out when a job cannot be finished.
7. An automatic move for maintenance keeps the start; the end may change with the new machine's speed. The college is not notified, because its time is unchanged.
8. Reactivating a machine early restores flagged bookings that are valid again.
9. A delay notice with no free interval keeps the booking's time, flags it for the admin and uses up the one notice.
10. The delay move takes the latest start on any eligible machine, even a larger one.
11. The Saturday quota counts `impressions`. A holiday closes the day even for an approved Saturday.
12. Stock may go negative; `ready` is never blocked by stock.
13. Archiving a machine or removing a capability reassigns its future bookings like a maintenance stop.
14. One scheduling lock for the whole centre instead of per-machine locks.
15. Operators do not see stock. WhatsApp goes to the doctor's phone (the only phone on the form).
16. Default working weekdays are Sunday–Thursday until the owner gives the real ones.
17. Form bounds per booking: `copies` 1–20,000, `models` 1–50, `pages_per_model` 1–500 (typing errors only; the real limit is one working day).
18. An `in_progress` job flagged by a stop can still be finished by the operator: `markReady` clears the flag. A flagged job that has not started is moved by the admin before `confirmIdentity`.
19. `addHoliday` is refused while the date has holding bookings; the admin moves or cancels them first.
20. The admin does not send delay notices or file Saturday requests; uses `moveBooking` and decides requests instead.
