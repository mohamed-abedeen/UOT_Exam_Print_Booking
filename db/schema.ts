// Drizzle schema, step 1.1. Source of truth: docs/contracts.md §1 (the SQL there is the contract).
// Constraint and index names match what Postgres gives the contract SQL.
// Not here (Drizzle cannot express them): btree_gist, bookings_no_overlap, maintenance_no_overlap
// — see drizzle/0001_exclusion_constraints.sql.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const id = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const ref = (name: string) => bigint(name, { mode: "number" });
const createdAt = () => tstz("created_at").notNull().defaultNow();

// ---- enums (only those used by the tables below; the rest arrive with their tables)

export const userRole = pgEnum("user_role", ["college", "operator", "admin"]);
export const machineType = pgEnum("machine_type", ["laser", "duplicator"]);
export const serviceType = pgEnum("service_type", ["exam_questions", "results", "quality", "answer_sheets"]);
export const sides = pgEnum("sides", ["single", "duplex"]);
export const bookingStatus = pgEnum("booking_status", [
  "booked",
  "in_progress",
  "ready",
  "delivered",
  "cancelled",
  "no_show",
]);
export const rescheduleReason = pgEnum("reschedule_reason", ["maintenance", "delay_no_slot", "machine_change"]);
export const saturdayStatus = pgEnum("saturday_status", ["pending", "approved", "rejected"]);
export const itemKind = pgEnum("item_kind", ["paper", "toner", "master_roll", "part"]);
export const movementType = pgEnum("movement_type", ["receive", "consume", "waste", "adjust"]);
export const notificationType = pgEnum("notification_type", [
  "booking_ready",
  "booking_no_show",
  "booking_needs_reschedule",
  "booking_rescheduled",
  "booking_restored",
  "booking_cancelled",
  "booking_on_behalf",
  "saturday_requested",
  "saturday_decided",
]);

// ---- 1.1 colleges

export const colleges = pgTable(
  "colleges",
  {
    id: id(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique("colleges_name_key").on(t.name)],
);

// ---- 1.2 users

export const users = pgTable(
  "users",
  {
    id: id(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(), // argon2id
    role: userRole("role").notNull(),
    collegeId: ref("college_id"), // set only for role 'college'
    fullName: text("full_name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    mustChangePassword: boolean("must_change_password").notNull().default(true),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: tstz("locked_until"),
    lastLoginAt: tstz("last_login_at"),
    createdBy: ref("created_by"), // NULL only for the seeded admin
    updatedAt: tstz("updated_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "users_college_id_fkey", columns: [t.collegeId], foreignColumns: [colleges.id] }).onDelete(
      "restrict",
    ),
    foreignKey({ name: "users_created_by_fkey", columns: [t.createdBy], foreignColumns: [t.id] }).onDelete(
      "restrict",
    ),
    check("users_check", sql`(${t.role} = 'college') = (${t.collegeId} IS NOT NULL)`),
    uniqueIndex("users_username_key").on(sql`lower(${t.username})`),
    uniqueIndex("users_one_per_college").on(t.collegeId).where(sql`${t.role} = 'college' AND ${t.isActive}`),
  ],
);

// ---- 1.3 sessions

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // sha-256 hex of the cookie token; the raw token is never stored
    userId: ref("user_id").notNull(),
    lastSeenAt: tstz("last_seen_at").notNull().defaultNow(),
    expiresAt: tstz("expires_at").notNull(),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "sessions_user_id_fkey", columns: [t.userId], foreignColumns: [users.id] }).onDelete(
      "cascade",
    ),
    index("sessions_user_idx").on(t.userId),
    index("sessions_expires_idx").on(t.expiresAt),
  ],
);

// ---- 1.4 machines

export const machines = pgTable(
  "machines",
  {
    id: id(),
    name: text("name").notNull(),
    model: text("model").notNull(),
    type: machineType("type").notNull(),
    minSheets: integer("min_sheets").notNull(), // unit: impressions
    maxSheets: integer("max_sheets"), // NULL = no limit
    supportsDuplex: boolean("supports_duplex").notNull(),
    speedPerHour: integer("speed_per_hour").notNull(), // impressions per hour
    setupMinutesPerModel: integer("setup_minutes_per_model").notNull(),
    priority: integer("priority").notNull().default(100), // lower = preferred
    archivedAt: tstz("archived_at"), // NULL = active
    updatedAt: tstz("updated_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    check("machines_min_sheets_check", sql`${t.minSheets} >= 1`),
    check("machines_check", sql`${t.maxSheets} IS NULL OR ${t.maxSheets} >= ${t.minSheets}`),
    check("machines_speed_per_hour_check", sql`${t.speedPerHour} > 0`),
    check("machines_setup_minutes_per_model_check", sql`${t.setupMinutesPerModel} >= 0`),
    uniqueIndex("machines_name_key").on(t.name).where(sql`${t.archivedAt} IS NULL`),
  ],
);

// ---- 1.5 machine_maintenance (exclusion constraint maintenance_no_overlap: hand-written migration)

export const machineMaintenance = pgTable(
  "machine_maintenance",
  {
    id: id(),
    machineId: ref("machine_id").notNull(),
    startsAt: tstz("starts_at").notNull(),
    endsAt: tstz("ends_at"), // NULL = open until reactivated
    reason: text("reason").notNull(),
    createdBy: ref("created_by").notNull(),
    endedBy: ref("ended_by"), // who pressed "reactivate" or cancelled a planned window
    endedAt: tstz("ended_at"), // when they pressed it
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "machine_maintenance_machine_id_fkey",
      columns: [t.machineId],
      foreignColumns: [machines.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "machine_maintenance_created_by_fkey",
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "machine_maintenance_ended_by_fkey",
      columns: [t.endedBy],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    check("machine_maintenance_check", sql`${t.endsAt} IS NULL OR ${t.endsAt} >= ${t.startsAt}`),
    index("maintenance_machine_idx").on(t.machineId, t.startsAt),
  ],
);

// ---- 1.7 bookings (exclusion constraint bookings_no_overlap: hand-written migration)

export const bookings = pgTable(
  "bookings",
  {
    id: id(),

    // reference
    refYear: integer("ref_year").notNull(), // year of creation
    refSeq: integer("ref_seq").notNull(),
    reference: text("reference").notNull(), // 'YYYY-NNNN'

    // who
    collegeId: ref("college_id").notNull(),
    createdBy: ref("created_by").notNull(),
    onBehalf: boolean("on_behalf").notNull().default(false), // true when an admin booked for the college

    // form
    doctorName: text("doctor_name").notNull(),
    doctorPhone: text("doctor_phone").notNull(),
    recipientName: text("recipient_name").notNull(), // four-part name, validated by isFourPartName()
    subject: text("subject").notNull(),
    serviceType: serviceType("service_type").notNull(),
    copies: integer("copies").notNull(),
    models: integer("models").notNull(),
    pagesPerModel: integer("pages_per_model").notNull(),
    sides: sides("sides").notNull(),
    examDate: date("exam_date", { mode: "string" }),
    impressions: integer("impressions").generatedAlwaysAs(sql`models * pages_per_model * copies`),
    sheets: integer("sheets").generatedAlwaysAs(
      sql`models * copies * CASE WHEN sides = 'duplex' THEN (pages_per_model + 1) / 2 ELSE pages_per_model END`,
    ),

    // schedule
    machineId: ref("machine_id").notNull(),
    startsAt: tstz("starts_at").notNull(),
    endsAt: tstz("ends_at").notNull(),
    workDate: date("work_date", { mode: "string" }).generatedAlwaysAs(
      sql`(starts_at AT TIME ZONE 'Africa/Tripoli')::date`,
    ),

    // state
    status: bookingStatus("status").notNull().default("booked"),
    needsReschedule: boolean("needs_reschedule").notNull().default(false),
    rescheduleReason: rescheduleReason("reschedule_reason"),
    delayNoticeAt: tstz("delay_notice_at"), // set once; the one delay notice
    delayedFrom: tstz("delayed_from"), // starts_at before the delay notice

    identityConfirmedBy: ref("identity_confirmed_by"),
    identityConfirmedAt: tstz("identity_confirmed_at"),
    wastedSheets: integer("wasted_sheets"),
    wasteDestroyed: boolean("waste_destroyed"),
    readyBy: ref("ready_by"),
    readyAt: tstz("ready_at"),
    deliveredBy: ref("delivered_by"),
    deliveredAt: tstz("delivered_at"),
    noShowBy: ref("no_show_by"),
    noShowAt: tstz("no_show_at"),
    cancelledBy: ref("cancelled_by"),
    cancelledAt: tstz("cancelled_at"),
    cancelReason: text("cancel_reason"),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("bookings_reference_key").on(t.reference),
    unique("bookings_ref_year_ref_seq_key").on(t.refYear, t.refSeq),

    foreignKey({ name: "bookings_college_id_fkey", columns: [t.collegeId], foreignColumns: [colleges.id] }).onDelete(
      "restrict",
    ),
    foreignKey({ name: "bookings_created_by_fkey", columns: [t.createdBy], foreignColumns: [users.id] }).onDelete(
      "restrict",
    ),
    foreignKey({ name: "bookings_machine_id_fkey", columns: [t.machineId], foreignColumns: [machines.id] }).onDelete(
      "restrict",
    ),
    foreignKey({
      name: "bookings_identity_confirmed_by_fkey",
      columns: [t.identityConfirmedBy],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({ name: "bookings_ready_by_fkey", columns: [t.readyBy], foreignColumns: [users.id] }).onDelete(
      "restrict",
    ),
    foreignKey({ name: "bookings_delivered_by_fkey", columns: [t.deliveredBy], foreignColumns: [users.id] }).onDelete(
      "restrict",
    ),
    foreignKey({ name: "bookings_no_show_by_fkey", columns: [t.noShowBy], foreignColumns: [users.id] }).onDelete(
      "restrict",
    ),
    foreignKey({ name: "bookings_cancelled_by_fkey", columns: [t.cancelledBy], foreignColumns: [users.id] }).onDelete(
      "restrict",
    ),

    check("bookings_ref_seq_check", sql`${t.refSeq} >= 1`),
    check("bookings_doctor_phone_check", sql`${t.doctorPhone} ~ '^2189[0-9]{8}$'`),
    check("bookings_copies_check", sql`${t.copies} BETWEEN 1 AND 20000`),
    check("bookings_models_check", sql`${t.models} BETWEEN 1 AND 50`),
    check("bookings_pages_per_model_check", sql`${t.pagesPerModel} BETWEEN 1 AND 500`),
    check("bookings_starts_at_check", sql`extract(epoch FROM ${t.startsAt}) % 600 = 0`),
    check("bookings_ends_at_check", sql`extract(epoch FROM ${t.endsAt}) % 600 = 0`),
    check("bookings_wasted_sheets_check", sql`${t.wastedSheets} >= 0`),
    check("bookings_check", sql`${t.endsAt} > ${t.startsAt}`),
    check("bookings_check1", sql`${t.needsReschedule} = (${t.rescheduleReason} IS NOT NULL)`),
    check("bookings_check2", sql`NOT ${t.needsReschedule} OR ${t.status} IN ('booked', 'in_progress')`),
    check(
      "bookings_check3",
      sql`${t.status} NOT IN ('in_progress', 'ready', 'delivered') OR ${t.identityConfirmedAt} IS NOT NULL`,
    ),
    check(
      "bookings_check4",
      sql`${t.status} NOT IN ('ready', 'delivered') OR (${t.readyAt} IS NOT NULL AND ${t.wastedSheets} IS NOT NULL AND ${t.wasteDestroyed} IS TRUE)`,
    ),
    check("bookings_check5", sql`${t.status} <> 'delivered' OR ${t.deliveredAt} IS NOT NULL`),
    check("bookings_check6", sql`${t.status} <> 'cancelled' OR ${t.cancelledAt} IS NOT NULL`),
    check("bookings_check7", sql`${t.status} <> 'no_show' OR ${t.noShowAt} IS NOT NULL`),

    index("bookings_day_machine_idx").on(t.workDate, t.machineId, t.startsAt),
    index("bookings_college_idx").on(t.collegeId, t.workDate),
    index("bookings_status_idx").on(t.status, t.workDate),
    index("bookings_reschedule_idx").on(t.startsAt).where(sql`${t.needsReschedule}`),
  ],
);

// ---- 1.8 saturday_requests (step 2.6). Quantities are impressions.

export const saturdayRequests = pgTable(
  "saturday_requests",
  {
    id: id(),
    collegeId: ref("college_id").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    expectedQuantity: integer("expected_quantity").notNull(),
    reason: text("reason").notNull(),
    status: saturdayStatus("status").notNull().default("pending"),
    approvedQuantity: integer("approved_quantity"),
    decidedBy: ref("decided_by"),
    decidedAt: tstz("decided_at"),
    decisionNote: text("decision_note"),
    createdBy: ref("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "saturday_requests_college_id_fkey",
      columns: [t.collegeId],
      foreignColumns: [colleges.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "saturday_requests_decided_by_fkey",
      columns: [t.decidedBy],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "saturday_requests_created_by_fkey",
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    check("saturday_requests_date_check", sql`extract(isodow FROM ${t.date}) = 6`), // a Saturday
    check("saturday_requests_expected_quantity_check", sql`${t.expectedQuantity} > 0`),
    check("saturday_requests_approved_quantity_check", sql`${t.approvedQuantity} > 0`),
    check("saturday_requests_check", sql`(${t.status} = 'approved') = (${t.approvedQuantity} IS NOT NULL)`),
    check("saturday_requests_check1", sql`(${t.status} = 'pending') = (${t.decidedAt} IS NULL)`),
    uniqueIndex("saturday_one_open_idx")
      .on(t.collegeId, t.date)
      .where(sql`${t.status} IN ('pending', 'approved')`),
  ],
);

// ---- 1.11 notifications (step 2.1; `saturday_request_id` step 2.6)

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: ref("user_id").notNull(),
    type: notificationType("type").notNull(),
    bookingId: ref("booking_id"),
    saturdayRequestId: ref("saturday_request_id"),
    data: jsonb("data").notNull().default(sql`'{}'`), // values for the Arabic text
    readAt: tstz("read_at"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "notifications_user_id_fkey", columns: [t.userId], foreignColumns: [users.id] }).onDelete(
      "cascade",
    ),
    foreignKey({
      name: "notifications_booking_id_fkey",
      columns: [t.bookingId],
      foreignColumns: [bookings.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "notifications_saturday_request_id_fkey",
      columns: [t.saturdayRequestId],
      foreignColumns: [saturdayRequests.id],
    }).onDelete("restrict"),
    index("notifications_user_idx").on(t.userId, t.createdAt.desc().nullsFirst()),
    index("notifications_unread_idx").on(t.userId).where(sql`${t.readAt} IS NULL`),
  ],
);

// ---- 1.12 settings, holidays

export const settings = pgTable(
  "settings",
  {
    key: text("key").primaryKey(),
    value: jsonb("value").notNull(),
    updatedBy: ref("updated_by"),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "settings_updated_by_fkey", columns: [t.updatedBy], foreignColumns: [users.id] }).onDelete(
      "restrict",
    ),
  ],
);

export const holidays = pgTable(
  "holidays",
  {
    date: date("date", { mode: "string" }).primaryKey(),
    name: text("name").notNull(),
    createdBy: ref("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "holidays_created_by_fkey", columns: [t.createdBy], foreignColumns: [users.id] }).onDelete(
      "restrict",
    ),
  ],
);

// ---- 1.13 audit_log (append-only; no created_at — it is `at`)

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    at: tstz("at").notNull().defaultNow(),
    userId: ref("user_id"), // NULL = the system
    role: userRole("role"),
    action: text("action").notNull(), // list in contracts §6
    entity: text("entity").notNull(), // table name
    entityId: text("entity_id"),
    collegeId: ref("college_id"),
    details: jsonb("details").notNull().default(sql`'{}'`), // before / after values; never a password or token
    ip: inet("ip"),
  },
  (t) => [
    foreignKey({ name: "audit_log_user_id_fkey", columns: [t.userId], foreignColumns: [users.id] }).onDelete(
      "restrict",
    ),
    foreignKey({ name: "audit_log_college_id_fkey", columns: [t.collegeId], foreignColumns: [colleges.id] }).onDelete(
      "restrict",
    ),
    index("audit_at_idx").on(t.at),
    index("audit_user_idx").on(t.userId, t.at),
    index("audit_action_idx").on(t.action, t.at),
  ],
);

// ---- 1.9 inventory_items (step 3.1). Exactly one active paper item, seeded by drizzle/0004 (A4, counted in sheets).

export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: id(),
    name: text("name").notNull(),
    kind: itemKind("kind").notNull(),
    unit: text("unit").notNull(),
    machineId: ref("machine_id"), // toner, master rolls and parts of one machine
    minQuantity: integer("min_quantity").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique("inventory_items_name_key").on(t.name),
    foreignKey({
      name: "inventory_items_machine_id_fkey",
      columns: [t.machineId],
      foreignColumns: [machines.id],
    }).onDelete("restrict"),
    check("inventory_items_min_quantity_check", sql`${t.minQuantity} >= 0`),
    uniqueIndex("inventory_one_paper_idx").on(t.kind).where(sql`${t.kind} = 'paper' AND ${t.isActive}`),
  ],
);

// ---- 1.6 machine_parts (step 3.1). Replacing closes the row and opens a new one at 0; old rows are the history.

export const machineParts = pgTable(
  "machine_parts",
  {
    id: id(),
    machineId: ref("machine_id").notNull(),
    name: text("name").notNull(), // drum, fuser, roller, blade …
    inventoryItemId: ref("inventory_item_id"), // the spare in stock (kind 'part'), if tracked
    lifeImpressions: integer("life_impressions").notNull(),
    impressionsUsed: integer("impressions_used").notNull().default(0),
    installedAt: tstz("installed_at").notNull().defaultNow(),
    replacedAt: tstz("replaced_at"), // NULL = installed now
    replacedBy: ref("replaced_by"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "machine_parts_machine_id_fkey",
      columns: [t.machineId],
      foreignColumns: [machines.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "machine_parts_inventory_item_id_fkey",
      columns: [t.inventoryItemId],
      foreignColumns: [inventoryItems.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "machine_parts_replaced_by_fkey",
      columns: [t.replacedBy],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    check("machine_parts_life_impressions_check", sql`${t.lifeImpressions} > 0`),
    check("machine_parts_impressions_used_check", sql`${t.impressionsUsed} >= 0`),
    index("machine_parts_installed_idx").on(t.machineId).where(sql`${t.replacedAt} IS NULL`),
  ],
);

// ---- 1.10 inventory_movements (step 3.1). Append-only; balance of an item = sum(quantity); no balance column.

export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: id(),
    itemId: ref("item_id").notNull(),
    type: movementType("type").notNull(),
    quantity: integer("quantity").notNull(), // signed
    bookingId: ref("booking_id"), // set by markReady
    machinePartId: ref("machine_part_id"), // set by replaceMachinePart
    note: text("note"),
    createdBy: ref("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "inventory_movements_item_id_fkey",
      columns: [t.itemId],
      foreignColumns: [inventoryItems.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_movements_booking_id_fkey",
      columns: [t.bookingId],
      foreignColumns: [bookings.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_movements_machine_part_id_fkey",
      columns: [t.machinePartId],
      foreignColumns: [machineParts.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_movements_created_by_fkey",
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    check("inventory_movements_quantity_check", sql`${t.quantity} <> 0`),
    check(
      "inventory_movements_check",
      sql`(${t.type} = 'receive' AND ${t.quantity} > 0) OR (${t.type} IN ('consume', 'waste') AND ${t.quantity} < 0) OR ${t.type} = 'adjust'`,
    ),
    check("inventory_movements_check1", sql`${t.type} <> 'adjust' OR ${t.note} IS NOT NULL`),
    index("movements_item_idx").on(t.itemId, t.createdAt),
    uniqueIndex("movements_once_per_booking_idx")
      .on(t.bookingId, t.type)
      .where(sql`${t.bookingId} IS NOT NULL`),
  ],
);
