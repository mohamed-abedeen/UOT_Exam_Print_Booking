// Step 1.5 — machine and college actions behind the admin screens.
// Calls the real server actions against the test database; only cookies / headers / redirect are faked
// (tests/setup.ts). Skipped when DATABASE_URL is not set.
import { count, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, colleges, machines, sessions, users } from "@/db/schema";
import { createCollege, listColleges, setCollegeActive, updateCollege } from "@/lib/actions/colleges";
import { archiveMachine, createMachine, listMachines, unarchiveMachine, updateMachine } from "@/lib/actions/machines";
import { createUser, setUserActive } from "@/lib/actions/users";
import { AuthError, SESSION_COOKIE } from "@/lib/auth/guard";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { takeSchedulingLock } from "@/lib/scheduling/load";
import { eligibleMachines } from "@/lib/scheduling/schedule";
import type { JobSpec, ScheduleContext } from "@/lib/scheduling/types";
import { browser } from "./helpers/fake-request";
import { resetTestDb } from "./helpers/test-db";

const NAMES = ["admin", "operator", "collegeA"] as const;
type Name = (typeof NAMES)[number];

const NEW_MACHINE = {
  name: "آلة جديدة",
  model: "Ricoh Pro",
  type: "laser",
  minSheets: 1,
  maxSheets: 400,
  supportsDuplex: true,
  speedPerHour: 3000,
  setupMinutesPerModel: 5,
  priority: 100,
} as const;

/** Only `machines` and `loadMinutes` are read by `eligibleMachines`. */
const ctxWith = (rows: Awaited<ReturnType<typeof listMachines>>) =>
  ({ machines: rows, loadMinutes: () => 0 }) as unknown as ScheduleContext;
const job = (models: number, pagesPerModel: number, copies: number): JobSpec => ({ models, pagesPerModel, copies, sides: "single" });

describe.skipIf(!process.env.DATABASE_URL)("step 1.5: admin machines and colleges", () => {
  const ids = {} as Record<Name, number>;
  const tokens = {} as Record<Name, string>;
  let collegeA: number;

  function actAs(name: Name) {
    browser.reset();
    browser.cookies.set(SESSION_COOKIE, tokens[name]);
  }
  const auditRows = (action: string) => getDb().select().from(auditLog).where(eq(auditLog.action, action));
  const machineRow = async (id: number) => (await getDb().select().from(machines).where(eq(machines.id, id)))[0];

  beforeEach(async () => {
    await resetTestDb();
    browser.reset();
    const db = getDb();
    const passwordHash = await hashPassword("correct horse 42");
    const [a] = await db.insert(colleges).values({ name: "كلية أ" }).returning();
    collegeA = a.id;
    const base = { passwordHash, mustChangePassword: false };
    const rows = await db
      .insert(users)
      .values([
        { ...base, username: "admin", role: "admin", fullName: "مسؤول" },
        { ...base, username: "operator", role: "operator", fullName: "فني" },
        { ...base, username: "collegeA", role: "college", fullName: "منسق أ", collegeId: a.id },
      ])
      .returning({ id: users.id });
    for (const [i, name] of NAMES.entries()) {
      ids[name] = rows[i].id;
      tokens[name] = (await createSession(db, rows[i].id, { ip: null, userAgent: null }, new Date())).token;
    }
  });

  describe("role guard", () => {
    const adminOnly: Record<string, () => Promise<unknown>> = {
      createMachine: () => createMachine(NEW_MACHINE),
      updateMachine: () => updateMachine({ machineId: 1, fields: NEW_MACHINE }),
      archiveMachine: () => archiveMachine({ machineId: 1 }),
      unarchiveMachine: () => unarchiveMachine({ machineId: 1 }),
      listColleges: () => listColleges(),
      createCollege: () => createCollege({ name: "كلية جديدة" }),
      updateCollege: () => updateCollege({ collegeId: 1, name: "اسم آخر" }),
      setCollegeActive: () => setCollegeActive({ collegeId: 1, isActive: false }),
    };
    const snapshot = async () => ({
      machines: await getDb().select().from(machines),
      colleges: await getDb().select().from(colleges),
      audit: (await getDb().select({ n: count() }).from(auditLog))[0].n,
    });

    for (const action of Object.keys(adminOnly)) {
      for (const role of ["operator", "collegeA"] as const) {
        it(`${action} is refused to ${role} and changes nothing`, async () => {
          const before = await snapshot();
          actAs(role);
          await expect(adminOnly[action]()).rejects.toBeInstanceOf(AuthError);
          expect(await snapshot()).toEqual(before);
        });
      }
      it(`${action} without a session goes to /login`, async () => {
        browser.reset();
        await expect(adminOnly[action]()).rejects.toMatchObject({ to: "/login" });
      });
    }

    it("listMachines is open to the operator and the admin, refused to a college", async () => {
      actAs("operator");
      await expect(listMachines()).resolves.toEqual([]);
      actAs("admin");
      await expect(listMachines()).resolves.toEqual([]);
      actAs("collegeA");
      await expect(listMachines()).rejects.toBeInstanceOf(AuthError);
    });
  });

  describe("machines", () => {
    it("a machine added through the action is bookable without a code change", async () => {
      actAs("admin");
      const result = await createMachine(NEW_MACHINE);
      expect(result.ok).toBe(true);

      const rows = await listMachines();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: NEW_MACHINE.name, archivedAt: null });
      // the same rows the booking code will load go straight into the scheduling core
      expect(eligibleMachines(job(2, 5, 20), "2026-11-29", ctxWith(rows)).map((m) => m.id)).toEqual([rows[0].id]);
      // outside its range it is not offered
      expect(eligibleMachines(job(2, 5, 50), "2026-11-29", ctxWith(rows))).toEqual([]);
      const [entry] = await auditRows("machine.create");
      expect(entry).toMatchObject({ userId: ids.admin, entityId: String(rows[0].id) });
    });

    it("max_sheets empty means no limit", async () => {
      actAs("admin");
      await createMachine({ ...NEW_MACHINE, maxSheets: null });
      const rows = await listMachines();
      expect(rows[0].maxSheets).toBeNull();
      expect(eligibleMachines(job(50, 500, 20), "2026-11-29", ctxWith(rows)).map((m) => m.id)).toEqual([rows[0].id]);
    });

    it("refuses bad values and writes nothing", async () => {
      actAs("admin");
      const bad = [
        { ...NEW_MACHINE, name: "   " },
        { ...NEW_MACHINE, minSheets: 0 },
        { ...NEW_MACHINE, minSheets: 500, maxSheets: 400 },
        { ...NEW_MACHINE, speedPerHour: 0 },
        { ...NEW_MACHINE, setupMinutesPerModel: -1 },
        { ...NEW_MACHINE, type: "inkjet" },
        { ...NEW_MACHINE, priority: 1.5 },
        { ...NEW_MACHINE, supportsDuplex: "yes" },
      ];
      for (const input of bad) expect(await createMachine(input)).toEqual({ ok: false, error: "validation" });
      expect(await listMachines()).toEqual([]);
      expect(await auditRows("machine.create")).toEqual([]);
    });

    it("two active machines cannot share a name; an archived name can be used again", async () => {
      actAs("admin");
      const first = await createMachine(NEW_MACHINE);
      expect(await createMachine(NEW_MACHINE)).toEqual({ ok: false, error: "name_taken" });
      if (!first.ok) throw new Error("setup");
      expect((await archiveMachine({ machineId: first.machine.id })).ok).toBe(true);
      const second = await createMachine(NEW_MACHINE);
      expect(second.ok).toBe(true);
      // the old row cannot come back while the new one holds the name
      expect(await unarchiveMachine({ machineId: first.machine.id })).toEqual({ ok: false, error: "name_taken" });
      expect((await machineRow(first.machine.id)).archivedAt).not.toBeNull();
    });

    it("update replaces the fields, audits before and after, and leaves a no-op unaudited", async () => {
      actAs("admin");
      const created = await createMachine(NEW_MACHINE);
      if (!created.ok) throw new Error("setup");
      const machineId = created.machine.id;

      expect(await updateMachine({ machineId, fields: NEW_MACHINE })).toEqual({ ok: true, moved: [], flagged: [] });
      expect(await auditRows("machine.update")).toEqual([]);

      const fields = { ...NEW_MACHINE, name: "آلة معدّلة", maxSheets: null, supportsDuplex: false, priority: 5 };
      expect(await updateMachine({ machineId, fields })).toEqual({ ok: true, moved: [], flagged: [] });
      expect(await machineRow(machineId)).toMatchObject({ name: "آلة معدّلة", maxSheets: null, supportsDuplex: false, priority: 5 });
      const [entry] = await auditRows("machine.update");
      expect(entry.details).toMatchObject({ before: { name: NEW_MACHINE.name, priority: 100 }, after: { name: "آلة معدّلة", priority: 5 } });

      expect(await updateMachine({ machineId: 9999, fields })).toEqual({ ok: false, error: "not_found" });
      expect(await updateMachine({ machineId, fields: { ...fields, minSheets: 10, maxSheets: 5 } })).toEqual({ ok: false, error: "validation" });
    });

    it("renaming onto another active machine's name is refused", async () => {
      actAs("admin");
      await createMachine(NEW_MACHINE);
      const other = await createMachine({ ...NEW_MACHINE, name: "آلة أخرى" });
      if (!other.ok) throw new Error("setup");
      expect(await updateMachine({ machineId: other.machine.id, fields: NEW_MACHINE })).toEqual({ ok: false, error: "name_taken" });
      expect((await machineRow(other.machine.id)).name).toBe("آلة أخرى");
    });

    it("an archived machine is not offered; unarchiving offers it again; each change is audited once", async () => {
      actAs("admin");
      const created = await createMachine(NEW_MACHINE);
      if (!created.ok) throw new Error("setup");
      const machineId = created.machine.id;
      const eligible = async () => eligibleMachines(job(2, 5, 20), "2026-11-29", ctxWith(await listMachines())).map((m) => m.id);

      expect(await eligible()).toEqual([machineId]);
      expect(await archiveMachine({ machineId })).toEqual({ ok: true, moved: [], flagged: [] });
      expect(await archiveMachine({ machineId })).toEqual({ ok: true, moved: [], flagged: [] }); // already archived: no second audit row
      expect(await eligible()).toEqual([]);
      expect((await listMachines())[0].archivedAt).toBeInstanceOf(Date);
      expect(await unarchiveMachine({ machineId })).toEqual({ ok: true, moved: [], flagged: [] });
      expect(await eligible()).toEqual([machineId]);
      expect(await auditRows("machine.archive")).toHaveLength(1);
      expect(await auditRows("machine.unarchive")).toHaveLength(1);
      expect(await archiveMachine({ machineId: 9999 })).toEqual({ ok: false, error: "not_found" });
      expect(await archiveMachine({ machineId: "1" })).toEqual({ ok: false, error: "validation" });
    });

    it("every machine write waits for the scheduling lock (contracts §3.9)", async () => {
      actAs("admin");
      const created = await createMachine(NEW_MACHINE);
      if (!created.ok) throw new Error("setup");
      const machineId = created.machine.id;
      const waiting = async () => {
        const rows = await getDb().execute(sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
        return Number((rows[0] as { n: number }).n);
      };
      const writes = [
        () => createMachine({ ...NEW_MACHINE, name: "آلة ثانية" }),
        () => updateMachine({ machineId, fields: { ...NEW_MACHINE, priority: 5 } }),
        () => archiveMachine({ machineId }),
        () => unarchiveMachine({ machineId }),
      ];

      for (const write of writes) {
        let result: ReturnType<typeof write> | undefined;
        // Another transaction (a booking being placed) holds the lock while the write is sent.
        await getDb().transaction(async (tx) => {
          await takeSchedulingLock(tx);
          result = write();
          for (let i = 0; i < 200 && (await waiting()) === 0; i++) await new Promise((r) => setTimeout(r, 10));
          expect(await waiting()).toBe(1);
        });
        expect(await result).toMatchObject({ ok: true });
      }
      expect(await machineRow(machineId)).toMatchObject({ priority: 5, archivedAt: null });
    });
  });

  describe("colleges", () => {
    it("creates, renames, lists; names are unique", async () => {
      actAs("admin");
      const created = await createCollege({ name: "  كلية الطب  " });
      if (!created.ok) throw new Error("setup");
      expect(await createCollege({ name: "كلية الطب" })).toEqual({ ok: false, error: "name_taken" });
      expect(await createCollege({ name: "   " })).toEqual({ ok: false, error: "validation" });

      expect(await updateCollege({ collegeId: created.college.id, name: "كلية الطب البشري" })).toEqual({ ok: true });
      expect(await updateCollege({ collegeId: created.college.id, name: "كلية أ" })).toEqual({ ok: false, error: "name_taken" });
      expect(await updateCollege({ collegeId: 9999, name: "س" })).toEqual({ ok: false, error: "not_found" });

      const rows = await listColleges();
      expect(rows.map((c) => c.name)).toEqual(["كلية أ", "كلية الطب البشري"]);
      expect(await auditRows("college.create")).toHaveLength(1);
      expect(await auditRows("college.update")).toHaveLength(1);
    });

    it("deactivating a college stops its account and ends its sessions; reactivating does not bring the account back", async () => {
      actAs("admin");
      const other = await createCollege({ name: "كلية ب" });
      if (!other.ok) throw new Error("setup");
      const otherUser = await createUser({ username: "collegeb", fullName: "منسق ب", role: "college", collegeId: other.college.id });
      if (!otherUser.ok) throw new Error("setup");
      const collegeBSession = await createSession(getDb(), otherUser.user.id, { ip: null, userAgent: null }, new Date());
      const sessionsOf = async (userId: number) =>
        (await getDb().select({ n: count() }).from(sessions).where(eq(sessions.userId, userId)))[0].n;

      expect(await setCollegeActive({ collegeId: collegeA, isActive: false })).toEqual({ ok: true });
      const [userA] = await getDb().select().from(users).where(eq(users.id, ids.collegeA));
      expect(userA.isActive).toBe(false);
      expect(await sessionsOf(ids.collegeA)).toBe(0);
      const [collegeRow] = await getDb().select().from(colleges).where(eq(colleges.id, collegeA));
      expect(collegeRow.isActive).toBe(false);
      // another college is untouched
      expect(await sessionsOf(otherUser.user.id)).toBe(1);
      expect((await getDb().select().from(users).where(eq(users.id, otherUser.user.id)))[0].isActive).toBe(true);
      expect(collegeBSession.token).toBeTruthy();

      const audited = await auditRows("user.set_active");
      expect(audited).toHaveLength(1);
      expect(audited[0]).toMatchObject({ entityId: String(ids.collegeA), collegeId: collegeA });
      expect(audited[0].details).toMatchObject({ cause: "college_deactivated" });

      // the account of an inactive college cannot be reactivated, and a new one cannot be made
      expect(await setUserActive({ userId: ids.collegeA, isActive: true })).toEqual({ ok: false, error: "college_not_found" });
      expect(await createUser({ username: "again", fullName: "س", role: "college", collegeId: collegeA })).toEqual({
        ok: false,
        error: "college_not_found",
      });

      expect(await setCollegeActive({ collegeId: collegeA, isActive: true })).toEqual({ ok: true });
      expect((await getDb().select().from(users).where(eq(users.id, ids.collegeA)))[0].isActive).toBe(false);
      expect(await setUserActive({ userId: ids.collegeA, isActive: true })).toEqual({ ok: true });
      expect(await setCollegeActive({ collegeId: 9999, isActive: false })).toEqual({ ok: false, error: "not_found" });
    });

    it("setting the state a college already has writes nothing", async () => {
      actAs("admin");
      expect(await setCollegeActive({ collegeId: collegeA, isActive: true })).toEqual({ ok: true });
      expect(await auditRows("college.set_active")).toEqual([]);
    });
  });
});
