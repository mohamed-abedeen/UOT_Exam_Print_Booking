# UOT Exam Print Booking — plan

منظومة حجز تصوير أسئلة الامتحانات — جامعة طرابلس، مركز التصوير والطباعة.

- Source spec: `مواصفات_منظومة_حجز_تصوير_الاسئلة.pdf` (owner's Desktop).
- Where this file and the PDF differ, **this file wins** (decisions taken with the owner, 2026-11-25).
- Build order and model per step: [checklist.md](checklist.md).

## 1. Goal

A website where each college's exam office books a time at the print centre for copying exam papers, and the centre runs its machines, stock and hand-over from it.
**No exam file is ever uploaded or stored.** Booking and print specs only; originals are handed over by hand.

## 2. Stack

- Next.js (App Router, TypeScript) + Tailwind. Arabic-only UI, RTL, usable on a phone.
- PostgreSQL on the same VPS (Libyan Spider).
- Technical choices (mine; change before step 0.2 if you disagree): Drizzle ORM with SQL migrations, own username/password login with sessions in the DB (no third-party auth), Zod validation, Vitest + Playwright, Docker Compose (app + db + HTTPS proxy), time zone `Africa/Tripoli`.

## 3. Roles

| Role | Account | Can |
|---|---|---|
| `college` | one per college, held by the head of the exam office | book, edit, cancel, delay notice, Saturday request, own bookings and notifications |
| `operator` | one per technician | day queue, confirm identity, WhatsApp buttons, waste, ready, delivered, no-show |
| `admin` | centre manager | everything: machines, maintenance, accounts, settings, stock, Saturday approvals, booking on behalf, reports, audit log |

No self sign-up; the admin creates every account. A college sees only its own data.

## 4. Rules

### Booking form
College (from the account), doctor name + phone, **recipient full name (four parts)**, subject, service type (exam questions / results / quality / answer sheets), copies, models, pages per model, sides (single / duplex), exam date (optional), day + start hour.

- Phone is normalised to `218XXXXXXXXX`; an invalid number is rejected.
- Exam date only warns (never blocks) when the booking is on or after it.
- Every booking gets a reference number `YYYY-NNNN`.

### Quantities
- `impressions = models × pages_per_model × copies` → machine tier, duration, large-job rule, part counters.
- `sheets = models × copies × (duplex ? ceil(pages_per_model / 2) : pages_per_model)` → paper stock.

### Machines are data, not code
The admin adds, edits and archives machines: name, model, type (laser / duplicator), `min_sheets`, `max_sheets` (empty = no limit), `supports_duplex`, `speed_per_hour`, `setup_minutes_per_model`, `priority`.
Seed = the 7 machines of the PDF, tiers 1–400 / 401–800 / 801+. Archive, never delete.

### Scheduling
- Duration = `models × setup_minutes_per_model + impressions ÷ speed_per_hour`, rounded up to 10 minutes.
- A booking is one time interval on one machine. Intervals on a machine never overlap (DB exclusion constraint), so small jobs share an hour and big jobs span several.
- Eligible machine: active, not in maintenance during the interval, supports the sides, `max_sheets ≥ impressions`.
- Preference: machines whose range contains the job, then larger ones (a larger machine may take a smaller job, **never the reverse**), then by priority, then least loaded that day.
- The coordinator picks a day and an hour. The system places the job at the earliest free start in that hour; if none, it offers the nearest free start.
- Working hours, working weekdays and holidays come from settings (default 09:00–15:00).
- Large jobs: at most 2 bookings a day above 6,000 (both numbers in settings).
- Saturday: the college sends a request (date, expected quantity, reason). On approval that date opens for that college only, up to the approved quantity.

### Changes to a booking
- The college may edit or cancel until 60 minutes before the start; after that, admin only.
- Delay notice: accepted until 60 minutes before the start. The booking moves to the latest free interval that day (searching back from closing time) and the original time is released. None free → the admin decides.
- No-show: the operator marks it. The time is released, the college is notified, it counts in reports.
- The admin can book on behalf of a college (recorded as such).

### Maintenance
- Stop a machine now or for a planned window, with a reason; reactivate later.
- Affected bookings move automatically to another eligible machine at the same time.
- Bookings with no alternative get `needs_reschedule` and wait in an admin list for a manual move (for example to the end of the day). The college is notified.
- Every stop is logged: who, when, why, how long.

### At the centre
States: `booked → in_progress → ready → delivered`, plus `cancelled` and `no_show`.

1. The recipient arrives with an ID. The operator checks it and presses **تأكيد الهوية** (operator and time are recorded). Nothing starts before this.
2. WhatsApp button "started": a `wa.me` link with a pre-filled message (college, subject, machine).
3. Finish: the operator enters wasted sheets and ticks "wasted copies destroyed" → `ready`. The college gets an in-app notification, and a second WhatsApp button "ready" appears.
4. Hand-over → `delivered`.

Daily printed sheet: time, reference, college, doctor, recipient, subject, service, copies × models, sides, machine, and two signature boxes (original handed in / copies received).

### Stock
- Items: A4 paper, toner, master rolls, and parts with a life in impressions (drum, fuser, rollers, blades), tied to a machine where relevant.
- Every change is a movement row (receive / consume / waste / adjust); the balance is derived from movements.
- On `ready`: paper −(`sheets` + wasted); the machine's part counters +`impressions`.
- Toner and master rolls are deducted by hand when replaced.
- Alerts: stock at its minimum, part near end of life, a day's booked sheets above the paper balance.

### Also in v1
Settings screen · audit log of sensitive actions (admin only) · reports by college, by machine (with downtime), waste and stock, peak hours.

## 5. Tables

`colleges`, `users`, `sessions`, `machines`, `machine_maintenance`, `machine_parts`, `bookings`, `saturday_requests`, `inventory_items`, `inventory_movements`, `notifications`, `settings`, `holidays`, `audit_log`.
Exact columns, state transitions and the permission matrix are written in `docs/contracts.md` (checklist step 0.1).

## 6. Confirmed assumptions (owner, 2026-11-25)

1. **Confirmed.** Tiers and the 6,000 rule count `impressions` (the PDF's "total sheets" formula), not physical sheets.
2. **Confirmed (manual).** The system never splits a job; the coordinator does.
   - A booking is one interval on one machine inside one working day.
   - If no eligible machine can finish the job within one full working day, the booking is refused with a clear Arabic message, and the form shows the largest number of copies that fits in one day on the fastest eligible machine, so the coordinator can book the job as several separate bookings.
   - Each booking stands alone: its own reference `YYYY-NNNN`, no part numbers, no link between bookings.
3. **Confirmed.** One delay notice per booking.
4. **Confirmed.** Durations round up to 10 minutes; starts are on the 10-minute grid.
5. **Confirmed.** The same person hands in the original and collects the copies.

## 7. Open items (owner)

- Real speed and setup time for each machine. The seed uses placeholders until then.
- Domain name, and VPS access for deployment.
- Working weekdays and holidays (entered in settings).

## 8. Not in v1

Exam file upload (never) · automatic WhatsApp gateway · several users per college · paper sizes other than A4 · internal emergency bookings for the centre.
