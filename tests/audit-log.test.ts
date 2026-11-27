// Step 4.3 — the audit log viewer (contracts §4, §6, §8.39): who may read it, each filter and its edges, the row limit.
// The pure part runs everywhere; the database part needs DATABASE_URL and is skipped without it.
import { readFileSync } from "node:fs";
import { count } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, colleges, users } from "@/db/schema";
import { listAuditLog } from "@/lib/actions/audit";
import { ACTION_LABEL, actionLabel, AUDIT_ACTIONS, AUDIT_LIMIT, defaultAuditRange } from "@/lib/audit/form";
import { AuthError, SESSION_COOKIE } from "@/lib/auth/guard";
import { createSession } from "@/lib/auth/session";
import { atMinutes } from "@/lib/scheduling/time";
import { browser } from "./helpers/fake-request";
import { resetTestDb } from "./helpers/test-db";

const at = (date: string, time: string) => {
  const [h, m] = time.split(":").map(Number);
  return atMinutes(date, h * 60 + m);
};

describe("audit log form helpers", () => {
  it("the default range is the last 7 days, today included", () => {
    expect(defaultAuditRange("2026-11-27")).toEqual({ from: "2026-11-21", to: "2026-11-27" });
    expect(defaultAuditRange("2026-12-03")).toEqual({ from: "2026-11-27", to: "2026-12-03" });
  });

  it("every action named in contracts §6 has an Arabic label, and no label is for an unlisted action", () => {
    const text = readFileSync("docs/contracts.md", "utf8");
    const paragraph = text.split("Audited actions (`audit_log.action`)")[1]?.split(/\r?\n\r?\n/)[1] ?? "";
    const named = [...paragraph.matchAll(/`([a-z_]+\.[a-z_]+)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(20);
    expect([...AUDIT_ACTIONS].sort()).toEqual([...named].sort());
    for (const label of Object.values(ACTION_LABEL)) expect(label.trim()).not.toBe("");
  });

  it("a code this build does not know is shown as it is", () => {
    expect(actionLabel("booking.move")).toBe(ACTION_LABEL["booking.move"]);
    expect(actionLabel("future.thing")).toBe("future.thing");
  });
});

const NAMES = ["admin", "operator", "collegeA"] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!process.env.DATABASE_URL)("step 4.3: listAuditLog", () => {
  const tokens = {} as Record<Name, string>;
  let adminId = 0;
  let operatorId = 0;
  let collegeA = 0;

  const actAs = (name: Name) => {
    browser.reset();
    browser.cookies.set(SESSION_COOKIE, tokens[name]);
  };
  const row = (opts: {
    when: Date;
    action?: string;
    userId?: number | null;
    role?: "admin" | "operator" | "college" | null;
    collegeId?: number | null;
    details?: Record<string, unknown>;
    ip?: string | null;
  }) => ({
    at: opts.when,
    action: opts.action ?? "settings.update",
    userId: opts.userId === undefined ? adminId : opts.userId,
    role: opts.role === undefined ? ("admin" as const) : opts.role,
    entity: "settings",
    entityId: "1",
    collegeId: opts.collegeId ?? null,
    details: opts.details ?? {},
    ip: opts.ip ?? null,
  });
  const ok = async (filter?: unknown) => {
    const result = await listAuditLog(filter);
    if (!result.ok) throw new Error("validation");
    return result;
  };

  beforeEach(async () => {
    await resetTestDb();
    browser.reset();
    const db = getDb();
    const [college] = await db.insert(colleges).values([{ name: "كلية أ" }]).returning({ id: colleges.id });
    collegeA = college.id;
    const base = { passwordHash: "not-a-real-hash", mustChangePassword: false };
    const userRows = await db
      .insert(users)
      .values([
        { ...base, username: "admin", role: "admin", fullName: "مسؤول" },
        { ...base, username: "operator", role: "operator", fullName: "فني" },
        { ...base, username: "collegeA", role: "college", fullName: "منسق أ", collegeId: collegeA },
      ])
      .returning({ id: users.id });
    adminId = userRows[0].id;
    operatorId = userRows[1].id;
    for (const [i, name] of NAMES.entries()) {
      tokens[name] = (await createSession(db, userRows[i].id, { ip: null, userAgent: null }, new Date())).token;
    }
  });

  it("only an admin may read the log; a college, an operator and a visitor are refused", async () => {
    for (const name of ["collegeA", "operator"] as const) {
      actAs(name);
      await expect(listAuditLog()).rejects.toBeInstanceOf(AuthError);
    }
    browser.reset();
    await expect(listAuditLog()).rejects.toMatchObject({ to: "/login" });
  });

  it("a filter that is not valid answers validation", async () => {
    actAs("admin");
    const bad: unknown[] = [
      { userId: 0 },
      { userId: "1" },
      { userId: 1.5 },
      { action: "not.an.action" },
      { action: "" },
      { from: "2026-02-30" },
      { to: "29-11-2026" },
      { from: "2026-11-30", to: "2026-11-29" },
      { extra: 1 },
    ];
    for (const filter of bad) {
      await expect(listAuditLog(filter)).resolves.toEqual({ ok: false, error: "validation" });
    }
  });

  it("no filter gives every row newest first; each row carries who, college, details and ip", async () => {
    actAs("admin");
    await getDb()
      .insert(auditLog)
      .values([
        row({ when: at("2026-11-29", "09:00"), action: "user.create", details: { username: "x" } }),
        row({
          when: at("2026-11-29", "11:00"),
          action: "booking.no_show",
          userId: operatorId,
          role: "operator",
          collegeId: collegeA,
          ip: "10.0.0.7",
        }),
        row({ when: at("2026-11-29", "10:00"), action: "booking.auto_move", userId: null, role: null }),
      ]);
    const result = await ok();
    expect(result.truncated).toBe(false);
    expect(result.rows.map((r) => r.action)).toEqual(["booking.no_show", "booking.auto_move", "user.create"]);
    const [noShow, system, create] = result.rows;
    expect(noShow).toMatchObject({ userName: "فني", username: "operator", role: "operator", collegeName: "كلية أ", ip: "10.0.0.7" });
    expect(system).toMatchObject({ userId: null, userName: null, role: null, collegeName: null, ip: null });
    expect(create.details).toEqual({ username: "x" });
  });

  it("filters by user, by action, and by both together", async () => {
    actAs("admin");
    await getDb()
      .insert(auditLog)
      .values([
        row({ when: at("2026-11-29", "09:00"), action: "user.create" }),
        row({ when: at("2026-11-29", "10:00"), action: "booking.no_show", userId: operatorId, role: "operator" }),
        row({ when: at("2026-11-29", "11:00"), action: "booking.no_show" }),
        row({ when: at("2026-11-29", "12:00"), action: "booking.auto_move", userId: null, role: null }),
      ]);
    expect((await ok({ userId: operatorId })).rows.map((r) => r.action)).toEqual(["booking.no_show"]);
    expect((await ok({ action: "booking.no_show" })).rows).toHaveLength(2);
    expect((await ok({ userId: adminId, action: "booking.no_show" })).rows).toHaveLength(1);
    expect((await ok({ userId: adminId })).rows).toHaveLength(2); // the system's row has no user
    expect((await ok({ action: "stock.adjust" })).rows).toEqual([]);
  });

  it("dates are business days, both inclusive, on the row's time", async () => {
    actAs("admin");
    await getDb()
      .insert(auditLog)
      .values([
        row({ when: at("2026-11-28", "23:59"), details: { n: 1 } }),
        row({ when: at("2026-11-29", "00:00"), details: { n: 2 } }),
        row({ when: at("2026-11-30", "23:59"), details: { n: 3 } }),
        row({ when: at("2026-12-01", "00:00"), details: { n: 4 } }),
      ]);
    const ns = async (filter: unknown) => (await ok(filter)).rows.map((r) => r.details.n).sort();
    expect(await ns({ from: "2026-11-29", to: "2026-11-30" })).toEqual([2, 3]);
    expect(await ns({ from: "2026-11-30", to: "2026-11-30" })).toEqual([3]);
    expect(await ns({ from: "2026-11-30" })).toEqual([3, 4]); // no upper limit
    expect(await ns({ to: "2026-11-28" })).toEqual([1]); // no lower limit
    expect(await ns({})).toEqual([1, 2, 3, 4]);
  });

  it("returns at most the limit and says when older rows matched too", async () => {
    actAs("admin");
    const db = getDb();
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) => row({ when: new Date(at("2026-11-29", "00:00").getTime() + i * 1000), details: { i } }));
    await db.insert(auditLog).values(make(AUDIT_LIMIT));
    let result = await ok();
    expect(result.rows).toHaveLength(AUDIT_LIMIT);
    expect(result.truncated).toBe(false);
    await db.insert(auditLog).values(row({ when: at("2026-11-29", "05:00"), details: { i: 999 } }));
    result = await ok();
    expect(result.rows).toHaveLength(AUDIT_LIMIT);
    expect(result.truncated).toBe(true);
    expect(result.rows[0].details.i).toBe(999); // newest first: the oldest rows are the ones cut
  });

  it("reading the log writes nothing", async () => {
    actAs("admin");
    await getDb().insert(auditLog).values(row({ when: at("2026-11-29", "09:00") }));
    await ok();
    await ok({ userId: adminId });
    expect((await getDb().select({ n: count() }).from(auditLog))[0].n).toBe(1);
  });
});
