"use server";
// Saturday actions (contracts §4 "Saturday"). Every export of this file is a public endpoint: the role guard is the
// first line of each one; the work is in lib/saturday/.
import { requireRole } from "@/lib/auth/guard";
import {
  createSaturdayRequestFor,
  decideSaturdayRequestFor,
  listSaturdayRequestsFor,
  type CreateSaturdayRequestResult,
  type DecideSaturdayRequestResult,
  type ListSaturdayRequestsResult,
} from "@/lib/saturday";

/** College only (the admin decides, does not file): `{ date, expectedQuantity, reason }`, quantities in impressions. */
export async function createSaturdayRequest(input: unknown): Promise<CreateSaturdayRequestResult> {
  const actor = await requireRole(["college"]);
  return createSaturdayRequestFor(actor, input);
}

/** College: own rows. Admin: every row, `{ collegeId?, status? }`. Newest date first. */
export async function listSaturdayRequests(input?: unknown): Promise<ListSaturdayRequestsResult> {
  const actor = await requireRole(["college", "admin"]);
  return listSaturdayRequestsFor(actor, input);
}

/** Admin only: `{ requestId, decision: 'approve', approvedQuantity, note? }` or `{ requestId, decision: 'reject', note? }`. */
export async function decideSaturdayRequest(input: unknown): Promise<DecideSaturdayRequestResult> {
  const actor = await requireRole(["admin"]);
  return decideSaturdayRequestFor(actor, input);
}
