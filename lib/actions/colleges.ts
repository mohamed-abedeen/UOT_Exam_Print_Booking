"use server";
// College actions (contracts §4 "Colleges and accounts"): admin only. Rows are never deleted.
// Deactivating a college also deactivates its account and ends that account's sessions (owner, 2026-11-25).
// Reactivating a college does not reactivate the account: that is `setUserActive`.
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { colleges, users } from "@/db/schema";
import { audit } from "@/lib/auth/audit";
import { requireRole } from "@/lib/auth/guard";
import { deleteUserSessions } from "@/lib/auth/session";

const ADMIN = ["admin"] as const;

const id = z.number().int().positive();
const name = z.string().trim().min(1).max(100);

function uniqueViolation(error: unknown): string | null {
  for (let e = error as { code?: string; constraint_name?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === "23505") return e.constraint_name ?? "";
  }
  return null;
}

export interface CollegeRow {
  id: number;
  name: string;
  isActive: boolean;
}

export async function listColleges(): Promise<CollegeRow[]> {
  await requireRole(ADMIN);
  return getDb()
    .select({ id: colleges.id, name: colleges.name, isActive: colleges.isActive })
    .from(colleges)
    .orderBy(asc(colleges.id));
}

const createCollegeInput = z.object({ name });

export type CreateCollegeResult = { ok: true; college: { id: number } } | { ok: false; error: "validation" | "name_taken" };

export async function createCollege(input: unknown): Promise<CreateCollegeResult> {
  const actor = await requireRole(ADMIN);
  const parsed = createCollegeInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation" };

  try {
    return await getDb().transaction(async (tx): Promise<CreateCollegeResult> => {
      const [college] = await tx.insert(colleges).values({ name: parsed.data.name }).returning({ id: colleges.id });
      await audit(tx, actor, {
        action: "college.create",
        entity: "colleges",
        entityId: college.id,
        collegeId: college.id,
        details: { name: parsed.data.name },
      });
      return { ok: true, college: { id: college.id } };
    });
  } catch (e) {
    if (uniqueViolation(e) === "colleges_name_key") return { ok: false, error: "name_taken" };
    throw e;
  }
}

const updateCollegeInput = z.object({ collegeId: id, name });

export type UpdateCollegeResult = { ok: true } | { ok: false; error: "validation" | "not_found" | "name_taken" };

export async function updateCollege(input: unknown): Promise<UpdateCollegeResult> {
  const actor = await requireRole(ADMIN);
  const parsed = updateCollegeInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation" };
  const v = parsed.data;

  try {
    return await getDb().transaction(async (tx): Promise<UpdateCollegeResult> => {
      const [before] = await tx.select().from(colleges).where(eq(colleges.id, v.collegeId)).for("update");
      if (!before) return { ok: false, error: "not_found" };
      if (before.name === v.name) return { ok: true };
      await tx.update(colleges).set({ name: v.name }).where(eq(colleges.id, before.id));
      await audit(tx, actor, {
        action: "college.update",
        entity: "colleges",
        entityId: before.id,
        collegeId: before.id,
        details: { before: { name: before.name }, after: { name: v.name } },
      });
      return { ok: true };
    });
  } catch (e) {
    if (uniqueViolation(e) === "colleges_name_key") return { ok: false, error: "name_taken" };
    throw e;
  }
}

const setCollegeActiveInput = z.object({ collegeId: id, isActive: z.boolean() });

export type SetCollegeActiveResult = { ok: true } | { ok: false; error: "validation" | "not_found" };

export async function setCollegeActive(input: unknown): Promise<SetCollegeActiveResult> {
  const actor = await requireRole(ADMIN);
  const parsed = setCollegeActiveInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation" };
  const v = parsed.data;

  return getDb().transaction(async (tx): Promise<SetCollegeActiveResult> => {
    const [before] = await tx.select().from(colleges).where(eq(colleges.id, v.collegeId)).for("update");
    if (!before) return { ok: false, error: "not_found" };
    if (before.isActive === v.isActive) return { ok: true };
    await tx.update(colleges).set({ isActive: v.isActive }).where(eq(colleges.id, before.id));
    await audit(tx, actor, {
      action: "college.set_active",
      entity: "colleges",
      entityId: before.id,
      collegeId: before.id,
      details: { before: { isActive: before.isActive }, after: { isActive: v.isActive } },
    });
    if (!v.isActive) {
      const active = await tx
        .update(users)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(users.collegeId, before.id), eq(users.isActive, true)))
        .returning({ id: users.id });
      for (const u of active) {
        await deleteUserSessions(tx, u.id);
        await audit(tx, actor, {
          action: "user.set_active",
          entity: "users",
          entityId: u.id,
          collegeId: before.id,
          details: { before: { isActive: true }, after: { isActive: false }, cause: "college_deactivated" },
        });
      }
    }
    return { ok: true };
  });
}
