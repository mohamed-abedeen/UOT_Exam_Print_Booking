// Notifications (contracts §1.11, §6). Writers run inside the transaction of the change they report;
// the reads are called by lib/actions/notifications.ts after its role guard. Not a "use server" file.
import "server-only";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Executor } from "@/db";
import { notifications, users } from "@/db/schema";
import type { Actor } from "@/lib/auth/guard";

export type NotificationType = (typeof notifications.$inferSelect)["type"];

/** What a booking notification carries for its Arabic text (owner, 2026-11-25): nothing else is copied. */
export interface BookingNotificationData {
  reference: string;
  startsAt: string; // ISO instant
  endsAt: string;
}

export function bookingData(b: { reference: string; startsAt: Date; endsAt: Date }): BookingNotificationData {
  return { reference: b.reference, startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString() };
}

/** "The college is notified" = one row for each active user of that college (contracts §1.11). */
export async function notifyCollege(
  tx: Executor,
  collegeId: number,
  type: NotificationType,
  bookingId: number | null,
  data: object,
  saturdayRequestId: number | null = null,
): Promise<void> {
  const recipients = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.collegeId, collegeId), eq(users.role, "college"), eq(users.isActive, true)));
  if (recipients.length === 0) return;
  await tx.insert(notifications).values(recipients.map((u) => ({ userId: u.id, type, bookingId, saturdayRequestId, data })));
}

/** "The admins are notified" = one row for each active admin. */
export async function notifyAdmins(
  tx: Executor,
  type: NotificationType,
  bookingId: number | null,
  data: object,
  saturdayRequestId: number | null = null,
): Promise<void> {
  const recipients = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.isActive, true)));
  if (recipients.length === 0) return;
  await tx.insert(notifications).values(recipients.map((u) => ({ userId: u.id, type, bookingId, saturdayRequestId, data })));
}

// ---- reads (own rows only)

/** The newest rows the bell shows; older ones stay in the table. */
export const NOTIFICATIONS_PAGE = 50;

export interface NotificationItem {
  id: number;
  type: NotificationType;
  bookingId: number | null;
  saturdayRequestId: number | null;
  data: unknown;
  readAt: Date | null;
  createdAt: Date;
}

export type ListMyNotificationsResult = { ok: true; unread: number; items: NotificationItem[] };

export async function listMyNotificationsFor(actor: Actor): Promise<ListMyNotificationsResult> {
  const db = getDb();
  const items = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      bookingId: notifications.bookingId,
      saturdayRequestId: notifications.saturdayRequestId,
      data: notifications.data,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(eq(notifications.userId, actor.userId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(NOTIFICATIONS_PAGE);
  const [{ n }] = await db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, actor.userId), isNull(notifications.readAt)));
  return { ok: true, unread: n, items };
}

export type MarkNotificationReadResult = { ok: true } | { ok: false; error: "validation" | "not_found" };

const markReadInput = z.strictObject({ id: z.number().int().positive() });

/** Sets `read_at` once; marking a read row again is a no-op. Another user's row answers "not found". */
export async function markNotificationReadFor(actor: Actor, input: unknown): Promise<MarkNotificationReadResult> {
  const parsed = markReadInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation" };
  const own = and(eq(notifications.id, parsed.data.id), eq(notifications.userId, actor.userId));
  const db = getDb();
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(own, isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  if (updated.length > 0) return { ok: true };
  const [found] = await db.select({ id: notifications.id }).from(notifications).where(own);
  return found ? { ok: true } : { ok: false, error: "not_found" };
}
