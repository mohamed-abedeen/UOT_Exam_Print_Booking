// Saturday requests (contracts §1.8, §3.4, §4 "Saturday"): a college asks for a Saturday, an admin approves it up to a
// quantity of impressions or rejects it; an approval opens that date for that college only (lib/scheduling/load.ts
// loads it into `ctx.saturdayApprovals`). No scheduling lock: an approval only adds room and is never revoked (owner,
// 2026-11-25, step 2.6). The server actions in lib/actions/saturday.ts run the role guard and call these.
// Not a "use server" file.
import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { getDb } from "@/db";
import { colleges, holidays, saturdayRequests, users } from "@/db/schema";
import { audit } from "@/lib/auth/audit";
import { AuthError, collegeScope, type Actor } from "@/lib/auth/guard";
import { dateString, VALIDATION } from "@/lib/bookings/create";
import { notifyAdmins, notifyCollege } from "@/lib/notifications";
import { loadSettings } from "@/lib/scheduling/load";
import { localDate, weekdayOf } from "@/lib/scheduling/time";

export type SaturdayStatus = (typeof saturdayRequests.$inferSelect)["status"];

const SATURDAY = 6;
const id = z.number().int().positive();
const quantity = z.number().int().positive().max(2_147_483_647); // impressions; fits the integer column
const text = (min: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(500)
    .refine((s) => !s.includes("\u0000")); // PostgreSQL text cannot hold it

const createInput = z.strictObject({ date: dateString, expectedQuantity: quantity, reason: text(1) });
const note = text(0).optional(); // blank = none
const decideInput = z.discriminatedUnion("decision", [
  z.strictObject({ requestId: id, decision: z.literal("approve"), approvedQuantity: quantity, note }),
  z.strictObject({ requestId: id, decision: z.literal("reject"), note }),
]);
const listInput = z.strictObject({ collegeId: id.optional(), status: z.enum(["pending", "approved", "rejected"]).optional() });

/** What the two notifications carry for their Arabic text. */
export interface SaturdayRequestedData {
  date: string;
  collegeName: string;
  expectedQuantity: number;
}
export interface SaturdayDecidedData {
  date: string;
  status: "approved" | "rejected";
  approvedQuantity: number | null;
  note: string | null;
}

// ---- createSaturdayRequest

export type CreateSaturdayRequestResult =
  | { ok: true; request: { id: number } }
  | { ok: false; error: "validation" | "duplicate" }; // duplicate = a pending or approved request for that date

/**
 * A college asks for a Saturday. The date must be a Saturday after today, not a holiday, and Saturday must not be a
 * working weekday already (owner, 2026-11-25, step 2.6): an approval would change nothing there. One open (pending
 * or approved) request per college and date; after a rejection a new one may be sent. `saturday_requested` to the
 * admins. Not audited (contracts §6 lists only the decision).
 */
export async function createSaturdayRequestFor(actor: Actor, input: unknown): Promise<CreateSaturdayRequestResult> {
  if (actor.role !== "college" || actor.collegeId === null) throw new AuthError();
  const collegeId = actor.collegeId;
  const parsed = createInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  const v = parsed.data;
  if (weekdayOf(v.date) !== SATURDAY || v.date <= localDate(new Date())) return VALIDATION;

  try {
    return await getDb().transaction(async (tx): Promise<CreateSaturdayRequestResult> => {
      const settings = await loadSettings(tx);
      if (settings.workingWeekdays.includes(SATURDAY)) return VALIDATION;
      const [holiday] = await tx.select({ date: holidays.date }).from(holidays).where(eq(holidays.date, v.date));
      if (holiday) return VALIDATION;

      const [row] = await tx
        .insert(saturdayRequests)
        .values({
          collegeId,
          date: v.date,
          expectedQuantity: v.expectedQuantity,
          reason: v.reason,
          createdBy: actor.userId,
        })
        .returning({ id: saturdayRequests.id });
      const [college] = await tx.select({ name: colleges.name }).from(colleges).where(eq(colleges.id, collegeId));
      const data: SaturdayRequestedData = { date: v.date, collegeName: college.name, expectedQuantity: v.expectedQuantity };
      await notifyAdmins(tx, "saturday_requested", null, data, row.id);
      return { ok: true, request: { id: row.id } };
    });
  } catch (error) {
    if (isOpenRequestConflict(error)) return { ok: false, error: "duplicate" };
    throw error;
  }
}

/** The unique index `saturday_one_open_idx` refused the row (also when a rival request won the race). */
function isOpenRequestConflict(error: unknown): boolean {
  type PgError = { code?: unknown; constraint_name?: unknown; cause?: unknown };
  for (let e = error as PgError | null | undefined, depth = 0; e && depth < 10; depth++) {
    if (e.code === "23505" && e.constraint_name === "saturday_one_open_idx") return true;
    e = e.cause as typeof e;
  }
  return false;
}

// ---- decideSaturdayRequest

export type DecideSaturdayRequestResult =
  | { ok: true; request: { id: number; status: "approved" | "rejected" } }
  | { ok: false; error: "validation" | "not_found" | "refused" }; // refused = already decided, or the date has passed

/**
 * Approve with `approvedQuantity` (any positive number of impressions, more or less than expected) or reject; `note`
 * optional. Only a pending request whose date is today or later, once (owner, 2026-11-25, step 2.6).
 * `saturday_decided` to the college, audited `saturday.decide`.
 */
export async function decideSaturdayRequestFor(actor: Actor, input: unknown): Promise<DecideSaturdayRequestResult> {
  if (actor.role !== "admin") throw new AuthError();
  const parsed = decideInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  const v = parsed.data;
  const status = v.decision === "approve" ? "approved" : "rejected";
  const approvedQuantity = v.decision === "approve" ? v.approvedQuantity : null;
  const decisionNote = v.note ? v.note : null;

  return getDb().transaction(async (tx): Promise<DecideSaturdayRequestResult> => {
    const now = new Date();
    const [r] = await tx.select().from(saturdayRequests).where(eq(saturdayRequests.id, v.requestId)).for("update");
    if (!r) return { ok: false, error: "not_found" };
    if (r.status !== "pending" || r.date < localDate(now)) return { ok: false, error: "refused" };

    await tx
      .update(saturdayRequests)
      .set({ status, approvedQuantity, decidedBy: actor.userId, decidedAt: now, decisionNote })
      .where(and(eq(saturdayRequests.id, r.id), eq(saturdayRequests.status, "pending")));

    const data: SaturdayDecidedData = { date: r.date, status, approvedQuantity, note: decisionNote };
    await notifyCollege(tx, r.collegeId, "saturday_decided", null, data, r.id);
    await audit(tx, actor, {
      action: "saturday.decide",
      entity: "saturday_requests",
      entityId: r.id,
      collegeId: r.collegeId,
      details: { date: r.date, expectedQuantity: r.expectedQuantity, status, approvedQuantity, note: decisionNote },
    });
    return { ok: true, request: { id: r.id, status } };
  });
}

// ---- listSaturdayRequests

export interface SaturdayRequestItem {
  id: number;
  collegeId: number;
  collegeName: string;
  date: string;
  expectedQuantity: number;
  reason: string;
  status: SaturdayStatus;
  approvedQuantity: number | null;
  /** Impressions of the college's holding bookings that day (own and on behalf); null unless approved. */
  usedImpressions: number | null;
  decisionNote: string | null;
  decidedAt: Date | null;
  decidedByName: string | null;
  createdAt: Date;
}

export type ListSaturdayRequestsResult = { ok: true; items: SaturdayRequestItem[] } | { ok: false; error: "validation" };

/**
 * A college: its own rows (a `collegeId` in the request is refused). An admin: every row, optionally one college
 * and one status. Newest date first, no paging (owner, 2026-11-25, step 2.6).
 */
export async function listSaturdayRequestsFor(actor: Actor, input: unknown = {}): Promise<ListSaturdayRequestsResult> {
  if (actor.role !== "college" && actor.role !== "admin") throw new AuthError();
  const parsed = listInput.safeParse(input);
  if (!parsed.success) return VALIDATION;
  const scope = collegeScope(actor, parsed.data.collegeId);
  const decider = alias(users, "decider");
  const rows = await getDb()
    .select({
      id: saturdayRequests.id,
      collegeId: saturdayRequests.collegeId,
      collegeName: colleges.name,
      date: saturdayRequests.date,
      expectedQuantity: saturdayRequests.expectedQuantity,
      reason: saturdayRequests.reason,
      status: saturdayRequests.status,
      approvedQuantity: saturdayRequests.approvedQuantity,
      used: sql<string>`(SELECT coalesce(sum(b.impressions), 0) FROM bookings b
        WHERE b.college_id = ${saturdayRequests.collegeId} AND b.work_date = ${saturdayRequests.date}
          AND b.status NOT IN ('cancelled', 'no_show'))`,
      decisionNote: saturdayRequests.decisionNote,
      decidedAt: saturdayRequests.decidedAt,
      decidedByName: decider.fullName,
      createdAt: saturdayRequests.createdAt,
    })
    .from(saturdayRequests)
    .innerJoin(colleges, eq(colleges.id, saturdayRequests.collegeId))
    .leftJoin(decider, eq(decider.id, saturdayRequests.decidedBy))
    .where(
      and(
        scope === null ? undefined : eq(saturdayRequests.collegeId, scope),
        parsed.data.status === undefined ? undefined : eq(saturdayRequests.status, parsed.data.status),
      ),
    )
    .orderBy(desc(saturdayRequests.date), desc(saturdayRequests.id));
  return {
    ok: true,
    items: rows.map(({ used, ...r }) => ({ ...r, usedImpressions: r.status === "approved" ? Number(used) : null })),
  };
}
