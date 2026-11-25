"use server";
// Notification actions (contracts §4 "Session"): every role, own rows only.
import { ALL_ROLES, requireRole } from "@/lib/auth/guard";
import {
  listMyNotificationsFor,
  markNotificationReadFor,
  type ListMyNotificationsResult,
  type MarkNotificationReadResult,
} from "@/lib/notifications";

/** The signed-in user's newest notifications and the unread count. */
export async function listMyNotifications(): Promise<ListMyNotificationsResult> {
  const actor = await requireRole(ALL_ROLES);
  return listMyNotificationsFor(actor);
}

/** `{ id }` of one of the user's own notifications. */
export async function markNotificationRead(input: unknown): Promise<MarkNotificationReadResult> {
  const actor = await requireRole(ALL_ROLES);
  return markNotificationReadFor(actor, input);
}
