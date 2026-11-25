// Seed, step 1.1: the 7 machines of the spec PDF, one admin, one operator, two test colleges, settings defaults.
// Run on a migrated, empty DB: `npm run db:seed`. Refuses to run twice.
// Passwords: SEED_PASSWORD from .env for every seeded account; all must change it on first login.
import { loadEnvConfig } from "@next/env";
import { hash } from "@node-rs/argon2";
import { count } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { colleges, machines, settings, users } from "./schema";

loadEnvConfig(process.cwd());

// Tiers 1–400 / 401–800 / 801+ (plan §5, owner 2026-11-25). Speeds and setup times are
// placeholders until the centre gives real figures (plan §7).
const MACHINES: (typeof machines.$inferInsert)[] = [
  { name: "آلة (1)", model: "Konica Minolta 650i", type: "laser", minSheets: 401, maxSheets: 800, supportsDuplex: true, speedPerHour: 4200, setupMinutesPerModel: 5 },
  { name: "آلة (2)", model: "Konica Minolta 450i", type: "laser", minSheets: 1, maxSheets: 400, supportsDuplex: true, speedPerHour: 3000, setupMinutesPerModel: 5 },
  { name: "آلة (3)", model: "Konica Minolta 367", type: "laser", minSheets: 1, maxSheets: 400, supportsDuplex: true, speedPerHour: 3000, setupMinutesPerModel: 5 },
  { name: "آلة (4)", model: "Konica Minolta 958", type: "laser", minSheets: 801, maxSheets: null, supportsDuplex: true, speedPerHour: 6000, setupMinutesPerModel: 5 },
  { name: "آلة (5)", model: "Duplo DP-M400", type: "duplicator", minSheets: 801, maxSheets: null, supportsDuplex: false, speedPerHour: 7200, setupMinutesPerModel: 10 },
  { name: "آلة (6) أ", model: "Riso CV3030", type: "duplicator", minSheets: 801, maxSheets: null, supportsDuplex: false, speedPerHour: 7200, setupMinutesPerModel: 10 },
  { name: "آلة (6) ب", model: "Riso CV3030", type: "duplicator", minSheets: 801, maxSheets: null, supportsDuplex: false, speedPerHour: 7200, setupMinutesPerModel: 10 },
];

// contracts §5
const SETTINGS: Record<string, unknown> = {
  work_start: "09:00",
  work_end: "15:00",
  working_weekdays: [0, 1, 2, 3, 4],
  large_job_threshold: 6000,
  large_jobs_per_day: 2,
  edit_deadline_minutes: 60,
  delay_deadline_minutes: 60,
  suggestion_search_days: 14,
  part_warn_percent: 90,
};

const TEST_COLLEGES = [
  { name: "كلية الهندسة", username: "engineering" },
  { name: "كلية العلوم", username: "science" },
];

async function main() {
  const url = process.env.DATABASE_URL;
  const password = process.env.SEED_PASSWORD;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!password) throw new Error("SEED_PASSWORD is not set (see .env.example)");

  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    const [{ n }] = await db.select({ n: count() }).from(users);
    if (n > 0) {
      console.log("Seed skipped: users already exist.");
      return;
    }

    const passwordHash = await hash(password); // argon2id, library defaults

    await db.transaction(async (tx) => {
      const [admin] = await tx
        .insert(users)
        .values({ username: "admin", passwordHash, role: "admin", fullName: "مسؤول المركز" })
        .returning({ id: users.id });

      await tx
        .insert(users)
        .values({ username: "operator", passwordHash, role: "operator", fullName: "فني التشغيل", createdBy: admin.id });

      for (const c of TEST_COLLEGES) {
        const [college] = await tx.insert(colleges).values({ name: c.name }).returning({ id: colleges.id });
        await tx.insert(users).values({
          username: c.username,
          passwordHash,
          role: "college",
          collegeId: college.id,
          fullName: `الدراسة والامتحانات — ${c.name}`,
          createdBy: admin.id,
        });
      }

      await tx.insert(machines).values(MACHINES);
      await tx.insert(settings).values(Object.entries(SETTINGS).map(([key, value]) => ({ key, value })));
    });

    console.log(
      `Seeded: 1 admin, 1 operator, ${TEST_COLLEGES.length} colleges, ${MACHINES.length} machines, ${Object.keys(SETTINGS).length} settings.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
