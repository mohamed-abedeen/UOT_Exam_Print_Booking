// Step 1.2 — login, sessions, role guard, accounts, audit, college scoping.
// Calls the real server actions against the test database; only cookies / headers / redirect are faked
// (tests/setup.ts). Skipped when DATABASE_URL is not set.
import { createHash } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loginAction } from "@/app/login/actions";
import { POST as logoutRoute } from "@/app/logout/route";
import { getDb } from "@/db";
import { auditLog, bookings, colleges, machines, sessions, users } from "@/db/schema";
import { changeOwnPassword, login, logout } from "@/lib/actions/session";
import { createUser, listUsers, resetUserPassword, setUserActive, updateUser } from "@/lib/actions/users";
import { AuthError, collegeScope, ownRows, requireRole, SESSION_COOKIE } from "@/lib/auth/guard";
import { hashPassword, PASSWORD_MIN } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { browser } from "./helpers/fake-request";
import { resetTestDb } from "./helpers/test-db";

const PASSWORD = "correct horse 42";
const WRONG = "wrong password 1";
const HOUR = 60 * 60 * 1000;
const NAMES = ["admin", "operator", "collegeA", "collegeB"] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!process.env.DATABASE_URL)("step 1.2: login and permissions", () => {
  let passwordHash: string;
  const ids = {} as Record<Name, number>;
  const collegeIds = {} as { A: number; B: number };
  const tokens = {} as Record<Name, string>;

  /** The next calls come from this user's browser. */
  function actAs(name: Name) {
    browser.reset();
    browser.cookies.set(SESSION_COOKIE, tokens[name]);
  }
  const userRow = async (id: number) => (await getDb().select().from(users).where(eq(users.id, id)))[0];
  const auditRows = (action?: string) =>
    getDb().select().from(auditLog).where(action ? eq(auditLog.action, action) : undefined);
  const fakeClock = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    return Date.now();
  };

  beforeAll(async () => {
    passwordHash = await hashPassword(PASSWORD);
  });

  beforeEach(async () => {
    await resetTestDb();
    browser.reset();
    const db = getDb();
    const [a, b] = await db.insert(colleges).values([{ name: "كلية أ" }, { name: "كلية ب" }]).returning();
    collegeIds.A = a.id;
    collegeIds.B = b.id;
    const base = { passwordHash, mustChangePassword: false };
    const rows = await db
      .insert(users)
      .values([
        { ...base, username: "admin", role: "admin", fullName: "مسؤول" },
        { ...base, username: "operator", role: "operator", fullName: "فني" },
        { ...base, username: "collegeA", role: "college", fullName: "منسق أ", collegeId: a.id },
        { ...base, username: "collegeB", role: "college", fullName: "منسق ب", collegeId: b.id },
      ])
      .returning({ id: users.id });
    for (const [i, name] of NAMES.entries()) {
      ids[name] = rows[i].id;
      tokens[name] = (await createSession(db, rows[i].id, { ip: null, userAgent: null }, new Date())).token;
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- the "Done when" of step 1.2

  describe("role guard: each role is refused the other roles' actions", () => {
    const adminOnly: Record<string, () => Promise<unknown>> = {
      listUsers: () => listUsers(),
      createUser: () => createUser({ username: "newuser", fullName: "جديد", role: "operator" }),
      updateUser: () => updateUser({ userId: ids.operator, fullName: "اسم آخر" }),
      setUserActive: () => setUserActive({ userId: ids.operator, isActive: false }),
      resetUserPassword: () => resetUserPassword({ userId: ids.operator }),
    };
    const snapshot = async () => ({
      users: await getDb().select().from(users).orderBy(users.id),
      sessions: (await getDb().select({ n: count() }).from(sessions))[0].n,
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

      it(`${action} without a session goes to /login and changes nothing`, async () => {
        const before = await snapshot();
        browser.reset();
        await expect(adminOnly[action]()).rejects.toMatchObject({ to: "/login" });
        browser.cookies.set(SESSION_COOKIE, "not-a-real-token");
        await expect(adminOnly[action]()).rejects.toMatchObject({ to: "/login" });
        expect(await snapshot()).toEqual(before);
      });

      it(`${action} is allowed to the admin`, async () => {
        actAs("admin");
        await expect(adminOnly[action]()).resolves.toBeDefined();
      });
    }

    it("requireRole lets each role into its own area only", async () => {
      for (const name of NAMES) {
        actAs(name);
        const own = name.startsWith("college") ? "college" : name;
        for (const role of ["college", "operator", "admin"] as const) {
          if (role === own) expect((await requireRole([role])).userId).toBe(ids[name]);
          else await expect(requireRole([role])).rejects.toBeInstanceOf(AuthError);
        }
      }
    });
  });

  describe("a college cannot read another college's rows", () => {
    let bookingA: number;
    let bookingB: number;

    beforeEach(async () => {
      const db = getDb();
      const [machine] = await db
        .insert(machines)
        .values({ name: "M1", model: "X", type: "laser", minSheets: 1, supportsDuplex: true, speedPerHour: 1000, setupMinutesPerModel: 0 })
        .returning({ id: machines.id });
      const form = {
        refYear: 2026,
        createdBy: ids.admin,
        doctorName: "د. فلان",
        doctorPhone: "218912345678",
        recipientName: "أ ب ج د",
        subject: "مادة",
        serviceType: "exam_questions",
        copies: 10,
        models: 1,
        pagesPerModel: 2,
        sides: "single",
        machineId: machine.id,
      } as const;
      const rows = await db
        .insert(bookings)
        .values([
          { ...form, refSeq: 1, reference: "2026-0001", collegeId: collegeIds.A, startsAt: new Date("2026-12-01T08:00:00Z"), endsAt: new Date("2026-12-01T08:10:00Z") },
          { ...form, refSeq: 2, reference: "2026-0002", collegeId: collegeIds.B, startsAt: new Date("2026-12-01T09:00:00Z"), endsAt: new Date("2026-12-01T09:10:00Z") },
        ])
        .returning({ id: bookings.id });
      bookingA = rows[0].id;
      bookingB = rows[1].id;
    });

    const visible = async (name: Name) => {
      actAs(name);
      const actor = await requireRole(["college", "operator", "admin"]);
      const rows = await getDb().select({ id: bookings.id }).from(bookings).where(ownRows(actor, bookings.collegeId)).orderBy(bookings.id);
      return rows.map((r) => r.id);
    };

    it("a list holds only the college's own rows", async () => {
      expect(await visible("collegeA")).toEqual([bookingA]);
      expect(await visible("collegeB")).toEqual([bookingB]);
      expect(await visible("operator")).toEqual([bookingA, bookingB]);
      expect(await visible("admin")).toEqual([bookingA, bookingB]);
    });

    it("another college's row asked for by id is not found", async () => {
      actAs("collegeA");
      const actor = await requireRole(["college"]);
      const byId = (id: number) =>
        getDb().select({ id: bookings.id }).from(bookings).where(and(eq(bookings.id, id), ownRows(actor, bookings.collegeId)));
      expect(await byId(bookingA)).toEqual([{ id: bookingA }]);
      expect(await byId(bookingB)).toEqual([]);
    });

    it("the college comes from the session; only an admin may pass a collegeId", async () => {
      actAs("collegeA");
      const college = await requireRole(["college"]);
      expect(collegeScope(college)).toBe(collegeIds.A);
      expect(() => collegeScope(college, collegeIds.B)).toThrow(AuthError);
      expect(() => collegeScope(college, collegeIds.A)).toThrow(AuthError);

      actAs("operator");
      const operator = await requireRole(["operator"]);
      expect(collegeScope(operator)).toBeNull();
      expect(() => collegeScope(operator, collegeIds.A)).toThrow(AuthError);

      actAs("admin");
      const admin = await requireRole(["admin"]);
      expect(collegeScope(admin)).toBeNull();
      expect(collegeScope(admin, collegeIds.B)).toBe(collegeIds.B);
    });
  });

  // ---- login and its rate limit

  describe("login", () => {
    it("sets an HttpOnly cookie and stores only the token's hash", async () => {
      browser.reset();
      // the first entry is whatever the client sent; the last is the one our proxy appends
      browser.headers.set("x-forwarded-for", "6.6.6.6, 10.1.2.3");
      expect(await login({ username: "operator", password: PASSWORD })).toEqual({
        ok: true,
        role: "operator",
        mustChangePassword: false,
      });
      const token = browser.cookies.get(SESSION_COOKIE)!;
      expect(browser.lastCookieOptions).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
      const mine = await getDb().select().from(sessions).where(eq(sessions.id, createHash("sha256").update(token).digest("hex")));
      expect(mine).toHaveLength(1);
      expect(mine[0].ip).toBe("10.1.2.3");
      expect(await getDb().select().from(sessions).where(eq(sessions.id, token))).toEqual([]);
      expect((await requireRole(["operator"])).userId).toBe(ids.operator);
      expect((await userRow(ids.operator)).lastLoginAt).not.toBeNull();
    });

    it("finds the username whatever its letter case", async () => {
      expect((await login({ username: "  COLLEGEa ", password: PASSWORD })).ok).toBe(true);
    });

    it("gives one answer for a wrong password, an unknown user, an inactive user and bad input", async () => {
      await getDb().update(users).set({ isActive: false }).where(eq(users.id, ids.collegeB));
      const invalid = { ok: false, error: "invalid" };
      expect(await login({ username: "operator", password: WRONG })).toEqual(invalid);
      expect(await login({ username: "nobody", password: PASSWORD })).toEqual(invalid);
      expect(await login({ username: "collegeB", password: PASSWORD })).toEqual(invalid);
      expect(await login({ username: "operator" })).toEqual(invalid);
      expect(await login({ username: "operator", password: "x".repeat(5000) })).toEqual(invalid);
      expect(await login(null)).toEqual(invalid);
      expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
      // audited: the wrong password and the inactive account; an unknown username leaves no row
      const failed = await auditRows("auth.login_failed");
      expect(failed.map((r) => r.userId).sort()).toEqual([ids.operator, ids.collegeB].sort());
    });

    it("locks the account for 15 minutes after 5 wrong passwords, then starts the count again", async () => {
      const t0 = fakeClock();
      for (let i = 1; i <= 4; i++) {
        await login({ username: "operator", password: WRONG });
        expect(await userRow(ids.operator)).toMatchObject({ failedLoginCount: i, lockedUntil: null });
      }
      await login({ username: "operator", password: WRONG });
      const locked = await userRow(ids.operator);
      expect(locked.failedLoginCount).toBe(5);
      expect(locked.lockedUntil!.getTime()).toBe(t0 + 15 * 60 * 1000);
      expect(await auditRows("auth.login_failed")).toHaveLength(5);
      expect(await auditRows("auth.lockout")).toHaveLength(1);

      // while locked: the right password is refused, and nothing more is counted or logged
      expect((await login({ username: "operator", password: PASSWORD })).ok).toBe(false);
      await login({ username: "operator", password: WRONG });
      expect(await auditRows("auth.login_failed")).toHaveLength(5);
      vi.setSystemTime(t0 + 15 * 60 * 1000 - 1000);
      expect((await login({ username: "operator", password: PASSWORD })).ok).toBe(false);

      // the lock has run out: one wrong try counts as the first, not the sixth
      vi.setSystemTime(t0 + 15 * 60 * 1000 + 1000);
      await login({ username: "operator", password: WRONG });
      expect(await userRow(ids.operator)).toMatchObject({ failedLoginCount: 1, lockedUntil: null });
      expect((await login({ username: "operator", password: PASSWORD })).ok).toBe(true);
      expect(await userRow(ids.operator)).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    });

    it("a successful login resets the count", async () => {
      for (let i = 0; i < 4; i++) await login({ username: "operator", password: WRONG });
      expect((await login({ username: "operator", password: PASSWORD })).ok).toBe(true);
      expect((await userRow(ids.operator)).failedLoginCount).toBe(0);
    });

    it("parallel guesses cannot get past the limit", async () => {
      const results = await Promise.all(
        Array.from({ length: 9 }, () => login({ username: "operator", password: WRONG })),
      );
      expect(results.every((r) => !r.ok)).toBe(true);
      const row = await userRow(ids.operator);
      expect(row.failedLoginCount).toBe(5);
      expect(row.lockedUntil).not.toBeNull();
      expect(await auditRows("auth.login_failed")).toHaveLength(5);
      expect(await auditRows("auth.lockout")).toHaveLength(1);
      expect((await login({ username: "operator", password: PASSWORD })).ok).toBe(false);
    });
  });

  // ---- sessions

  describe("sessions", () => {
    it("ends after 8 hours without activity; activity extends it", async () => {
      const t0 = fakeClock();
      actAs("admin");
      vi.setSystemTime(t0 + 7 * HOUR);
      await expect(listUsers()).resolves.toBeDefined();
      vi.setSystemTime(t0 + 14 * HOUR);
      await expect(listUsers()).resolves.toBeDefined();
      vi.setSystemTime(t0 + 22 * HOUR + 60 * 1000);
      await expect(listUsers()).rejects.toMatchObject({ to: "/login" });
    });

    it("ends 7 days after login even when used all the time", async () => {
      const t0 = fakeClock();
      actAs("admin");
      for (let h = 7; h < 7 * 24; h += 7) {
        vi.setSystemTime(t0 + h * HOUR);
        await expect(listUsers()).resolves.toBeDefined();
      }
      vi.setSystemTime(t0 + 7 * 24 * HOUR + 60 * 1000);
      await expect(listUsers()).rejects.toMatchObject({ to: "/login" });
    });

    it("logout deletes the session row and the cookie", async () => {
      actAs("operator");
      await logout();
      expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
      expect(await getDb().select().from(sessions).where(eq(sessions.userId, ids.operator))).toEqual([]);
      browser.cookies.set(SESSION_COOKIE, tokens.operator);
      await expect(requireRole(["operator"])).rejects.toMatchObject({ to: "/login" });
    });

    // Step 5.1: the cookie a login replaces must not leave a live session row behind.
    it("a login ends the session the browser held before; a failed login leaves it alone", async () => {
      actAs("collegeA");
      expect(await login({ username: "operator", password: WRONG })).toEqual({ ok: false, error: "invalid" });
      expect((await requireRole(["college"])).userId).toBe(ids.collegeA);
      // the one refusal that comes after the password check
      await getDb().update(users).set({ isActive: false }).where(eq(users.id, ids.operator));
      expect(await login({ username: "operator", password: PASSWORD })).toEqual({ ok: false, error: "invalid" });
      expect((await requireRole(["college"])).userId).toBe(ids.collegeA);
      await getDb().update(users).set({ isActive: true }).where(eq(users.id, ids.operator));

      expect(await login({ username: "operator", password: PASSWORD })).toMatchObject({ ok: true, role: "operator" });
      expect((await requireRole(["operator"])).userId).toBe(ids.operator);
      expect(await getDb().select().from(sessions).where(eq(sessions.userId, ids.collegeA))).toEqual([]);
      browser.cookies.set(SESSION_COOKIE, tokens.collegeA);
      await expect(requireRole(["college"])).rejects.toMatchObject({ to: "/login" });
    });

    // Both end with a full page load in the browser, so no page of the previous user stays alive in the tab.
    it("the logout route signs out and answers with a real redirect to /login", async () => {
      actAs("operator");
      const response = await logoutRoute();
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");
      expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
      expect(await getDb().select().from(sessions).where(eq(sessions.userId, ids.operator))).toEqual([]);

      browser.reset(); // nobody signed in: still the same answer, nothing to delete
      expect((await logoutRoute()).status).toBe(303);
    });

    it("the login form action returns where to go instead of redirecting", async () => {
      const form = (username: string, password: string) => {
        const data = new FormData();
        data.set("username", username);
        data.set("password", password);
        return data;
      };
      browser.reset();
      expect(await loginAction(undefined, form("operator", WRONG))).toEqual({ error: "invalid" });
      expect(await loginAction(undefined, form("operator", PASSWORD))).toEqual({ to: "/operator" });
      await getDb().update(users).set({ mustChangePassword: true }).where(eq(users.id, ids.admin));
      browser.reset();
      expect(await loginAction(undefined, form("admin", PASSWORD))).toEqual({ to: "/change-password" });
    });

    it("deactivating a user ends their sessions at once and blocks login", async () => {
      actAs("admin");
      expect(await setUserActive({ userId: ids.operator, isActive: false })).toEqual({ ok: true });
      expect(await getDb().select().from(sessions).where(eq(sessions.userId, ids.operator))).toEqual([]);
      actAs("operator");
      await expect(requireRole(["operator"])).rejects.toMatchObject({ to: "/login" });
      expect((await login({ username: "operator", password: PASSWORD })).ok).toBe(false);
      const [row] = await auditRows("user.set_active");
      expect(row).toMatchObject({ userId: ids.admin, role: "admin", entity: "users", entityId: String(ids.operator) });
      expect(row.details).toEqual({ before: { isActive: true }, after: { isActive: false } });
    });

    it("a user who was deactivated behind a live session is refused", async () => {
      await getDb().update(users).set({ isActive: false }).where(eq(users.id, ids.operator));
      actAs("operator");
      await expect(requireRole(["operator"])).rejects.toMatchObject({ to: "/login" });
    });
  });

  // ---- passwords

  describe("passwords", () => {
    it("a temporary password opens nothing but changeOwnPassword and logout", async () => {
      actAs("admin");
      const created = await createUser({ username: "op2", fullName: "فني ثان", role: "operator" });
      if (!created.ok) throw new Error(created.error);
      expect(created.temporaryPassword.length).toBeGreaterThanOrEqual(PASSWORD_MIN);

      browser.reset();
      expect(await login({ username: "op2", password: created.temporaryPassword })).toEqual({
        ok: true,
        role: "operator",
        mustChangePassword: true,
      });
      await expect(requireRole(["operator"])).rejects.toMatchObject({ to: "/change-password" });
      await expect(listUsers()).rejects.toMatchObject({ to: "/change-password" });

      const next = "a new password 7";
      expect(await changeOwnPassword({ currentPassword: created.temporaryPassword, newPassword: next })).toEqual({ ok: true });
      expect((await requireRole(["operator"])).mustChangePassword).toBe(false);
      browser.reset();
      expect((await login({ username: "op2", password: created.temporaryPassword })).ok).toBe(false);
      expect((await login({ username: "op2", password: next })).ok).toBe(true);
    });

    it("changeOwnPassword checks the current password and the rules", async () => {
      actAs("collegeA");
      const change = (currentPassword: string, newPassword: string) => changeOwnPassword({ currentPassword, newPassword });
      expect(await change(WRONG, "a new password 7")).toEqual({ ok: false, error: "wrong_password" });
      expect(await change(PASSWORD, "short")).toEqual({ ok: false, error: "validation" });
      expect(await change(PASSWORD, "x".repeat(129))).toEqual({ ok: false, error: "validation" });
      expect(await change(PASSWORD, PASSWORD)).toEqual({ ok: false, error: "same_password" });
      expect((await userRow(ids.collegeA)).passwordHash).toBe(passwordHash);
      browser.reset();
      await expect(change(PASSWORD, "a new password 7")).rejects.toMatchObject({ to: "/login" });
    });

    it("wrong current passwords count toward the lock; the 5th ends every session of the user", async () => {
      const other = await createSession(getDb(), ids.collegeA, { ip: null, userAgent: null }, new Date());
      actAs("collegeA");
      const guess = () => changeOwnPassword({ currentPassword: WRONG, newPassword: "a new password 7" });
      for (let i = 1; i <= 4; i++) {
        expect(await guess()).toEqual({ ok: false, error: "wrong_password" });
        expect(await userRow(ids.collegeA)).toMatchObject({ failedLoginCount: i, lockedUntil: null });
      }
      expect(await guess()).toEqual({ ok: false, error: "locked" });
      const row = await userRow(ids.collegeA);
      expect(row).toMatchObject({ failedLoginCount: 5, passwordHash });
      expect(row.lockedUntil).not.toBeNull();
      expect(await auditRows("auth.login_failed")).toHaveLength(5);
      expect(await auditRows("auth.lockout")).toHaveLength(1);

      // signed out everywhere: this browser, the other session, and no way back in while locked
      expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
      expect(await getDb().select().from(sessions).where(eq(sessions.userId, ids.collegeA))).toEqual([]);
      for (const token of [tokens.collegeA, other.token]) {
        browser.cookies.set(SESSION_COOKIE, token);
        await expect(guess()).rejects.toMatchObject({ to: "/login" });
      }
      browser.reset();
      expect((await login({ username: "collegeA", password: PASSWORD })).ok).toBe(false);
    });

    it("changeOwnPassword is refused while the account is locked, and a success resets the count", async () => {
      const change = () => changeOwnPassword({ currentPassword: PASSWORD, newPassword: "a new password 7" });
      const setLock = (failedLoginCount: number, lockedUntil: Date | null) =>
        getDb().update(users).set({ failedLoginCount, lockedUntil }).where(eq(users.id, ids.collegeA));
      actAs("collegeA");

      await setLock(5, new Date(Date.now() + HOUR)); // locked by wrong logins from somewhere else
      expect(await change()).toEqual({ ok: false, error: "locked" });
      expect((await userRow(ids.collegeA)).passwordHash).toBe(passwordHash);
      expect(await auditRows()).toEqual([]);

      await setLock(3, null);
      expect(await change()).toEqual({ ok: true });
      expect(await userRow(ids.collegeA)).toMatchObject({ failedLoginCount: 0, lockedUntil: null, mustChangePassword: false });
    });

    it("changeOwnPassword ends the user's other sessions and keeps this one", async () => {
      const other = await createSession(getDb(), ids.collegeA, { ip: null, userAgent: null }, new Date());
      actAs("collegeA");
      expect(await changeOwnPassword({ currentPassword: PASSWORD, newPassword: "a new password 7" })).toEqual({ ok: true });
      expect((await requireRole(["college"])).userId).toBe(ids.collegeA);
      browser.cookies.set(SESSION_COOKIE, other.token);
      await expect(requireRole(["college"])).rejects.toMatchObject({ to: "/login" });
    });

    it("resetUserPassword gives a new temporary password, ends sessions and lifts a lock", async () => {
      await getDb()
        .update(users)
        .set({ failedLoginCount: 5, lockedUntil: new Date(Date.now() + HOUR) })
        .where(eq(users.id, ids.collegeA));
      actAs("admin");
      const reset = await resetUserPassword({ userId: ids.collegeA });
      if (!reset.ok) throw new Error(reset.error);
      expect(await userRow(ids.collegeA)).toMatchObject({ mustChangePassword: true, failedLoginCount: 0, lockedUntil: null });

      actAs("collegeA");
      await expect(requireRole(["college"])).rejects.toMatchObject({ to: "/login" });
      expect((await login({ username: "collegeA", password: PASSWORD })).ok).toBe(false);
      expect(await login({ username: "collegeA", password: reset.temporaryPassword })).toMatchObject({ ok: true, mustChangePassword: true });

      const [row] = await auditRows("user.reset_password");
      expect(row).toMatchObject({ userId: ids.admin, entityId: String(ids.collegeA), collegeId: collegeIds.A });
      expect(JSON.stringify(row)).not.toContain(reset.temporaryPassword);
    });
  });

  // ---- accounts

  describe("accounts (admin)", () => {
    beforeEach(() => actAs("admin"));

    it("createUser stores an argon2id hash, forces a password change and audits without the password", async () => {
      const [c] = await getDb().insert(colleges).values({ name: "كلية ج" }).returning();
      const created = await createUser({ username: "collegeC", fullName: "منسق ج", role: "college", collegeId: c.id });
      if (!created.ok) throw new Error(created.error);
      const row = await userRow(created.user.id);
      expect(row).toMatchObject({ username: "collegeC", role: "college", collegeId: c.id, isActive: true, mustChangePassword: true, createdBy: ids.admin });
      expect(row.passwordHash.startsWith("$argon2id$")).toBe(true);
      const [log] = await auditRows("user.create");
      expect(log).toMatchObject({ userId: ids.admin, role: "admin", entity: "users", entityId: String(row.id), collegeId: c.id });
      expect(JSON.stringify(log)).not.toContain(created.temporaryPassword);
      expect(JSON.stringify(log)).not.toContain(row.passwordHash);
    });

    it("createUser refuses bad input, a taken username, a second account for a college", async () => {
      const refused = async (input: unknown, error: string) => expect(await createUser(input)).toEqual({ ok: false, error });
      await refused({ username: "ab", fullName: "x", role: "operator" }, "validation");
      await refused({ username: "has space", fullName: "x", role: "operator" }, "validation");
      await refused({ username: "ok.name", fullName: "", role: "operator" }, "validation");
      await refused({ username: "ok.name", fullName: "x", role: "boss" }, "validation");
      await refused({ username: "ok.name", fullName: "x", role: "college" }, "validation");
      await refused({ username: "ok.name", fullName: "x", role: "operator", collegeId: collegeIds.A }, "validation");
      await refused({ username: "OPERATOR", fullName: "x", role: "operator" }, "username_taken");
      await refused({ username: "ok.name", fullName: "x", role: "college", collegeId: collegeIds.A }, "college_taken");
      await refused({ username: "ok.name", fullName: "x", role: "college", collegeId: 999999 }, "college_not_found");
      expect(await auditRows("user.create")).toEqual([]);
      expect(await listUsers()).toHaveLength(4);
    });

    it("listUsers never returns a password hash", async () => {
      const list = await listUsers();
      expect(list.map((u) => u.username)).toEqual(["admin", "operator", "collegeA", "collegeB"]);
      expect(list[2]).toMatchObject({ role: "college", collegeId: collegeIds.A, collegeName: "كلية أ" });
      expect(JSON.stringify(list)).not.toContain("argon2");
    });

    it("updateUser changes name and username and audits before / after", async () => {
      expect(await updateUser({ userId: ids.operator, username: "print.op", fullName: "فني الطباعة" })).toEqual({ ok: true });
      expect(await userRow(ids.operator)).toMatchObject({ username: "print.op", fullName: "فني الطباعة", role: "operator" });
      const [log] = await auditRows("user.update");
      expect(log.details).toEqual({
        before: { username: "operator", fullName: "فني" },
        after: { username: "print.op", fullName: "فني الطباعة" },
      });
      expect(await updateUser({ userId: ids.operator, username: "Admin" })).toEqual({ ok: false, error: "username_taken" });
      expect(await updateUser({ userId: 999999, fullName: "x" })).toEqual({ ok: false, error: "not_found" });
      expect(await updateUser({ userId: ids.operator })).toEqual({ ok: false, error: "validation" });
      // role and college are not editable: unknown keys are dropped, nothing changes
      await updateUser({ userId: ids.operator, fullName: "فني الطباعة", role: "admin" });
      expect((await userRow(ids.operator)).role).toBe("operator");
    });

    it("an admin cannot deactivate or reset their own account", async () => {
      expect(await setUserActive({ userId: ids.admin, isActive: false })).toEqual({ ok: false, error: "self" });
      expect(await resetUserPassword({ userId: ids.admin })).toEqual({ ok: false, error: "self" });
      expect(await userRow(ids.admin)).toMatchObject({ isActive: true, passwordHash });
    });

    it("reactivating a college account is refused while the college has another active one", async () => {
      expect(await setUserActive({ userId: ids.collegeA, isActive: false })).toEqual({ ok: true });
      const second = await createUser({ username: "collegeA2", fullName: "منسق جديد", role: "college", collegeId: collegeIds.A });
      expect(second.ok).toBe(true);
      expect(await setUserActive({ userId: ids.collegeA, isActive: true })).toEqual({ ok: false, error: "college_taken" });
      expect((await userRow(ids.collegeA)).isActive).toBe(false);
      expect(await setUserActive({ userId: 999999, isActive: true })).toEqual({ ok: false, error: "not_found" });
    });

    it("reactivating an account of an inactive college is refused", async () => {
      expect(await setUserActive({ userId: ids.collegeB, isActive: false })).toEqual({ ok: true });
      await getDb().update(colleges).set({ isActive: false }).where(eq(colleges.id, collegeIds.B));
      expect(await setUserActive({ userId: ids.collegeB, isActive: true })).toEqual({ ok: false, error: "college_not_found" });
      expect((await userRow(ids.collegeB)).isActive).toBe(false);
    });
  });
});
