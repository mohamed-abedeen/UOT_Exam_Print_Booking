CREATE TYPE "public"."booking_status" AS ENUM('booked', 'in_progress', 'ready', 'delivered', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."machine_type" AS ENUM('laser', 'duplicator');--> statement-breakpoint
CREATE TYPE "public"."reschedule_reason" AS ENUM('maintenance', 'delay_no_slot', 'machine_change');--> statement-breakpoint
CREATE TYPE "public"."service_type" AS ENUM('exam_questions', 'results', 'quality', 'answer_sheets');--> statement-breakpoint
CREATE TYPE "public"."sides" AS ENUM('single', 'duplex');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('college', 'operator', 'admin');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" bigint,
	"role" "user_role",
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"college_id" bigint,
	"details" jsonb DEFAULT '{}' NOT NULL,
	"ip" "inet"
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bookings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ref_year" integer NOT NULL,
	"ref_seq" integer NOT NULL,
	"reference" text NOT NULL,
	"college_id" bigint NOT NULL,
	"created_by" bigint NOT NULL,
	"on_behalf" boolean DEFAULT false NOT NULL,
	"doctor_name" text NOT NULL,
	"doctor_phone" text NOT NULL,
	"recipient_name" text NOT NULL,
	"subject" text NOT NULL,
	"service_type" "service_type" NOT NULL,
	"copies" integer NOT NULL,
	"models" integer NOT NULL,
	"pages_per_model" integer NOT NULL,
	"sides" "sides" NOT NULL,
	"exam_date" date,
	"impressions" integer GENERATED ALWAYS AS (models * pages_per_model * copies) STORED,
	"sheets" integer GENERATED ALWAYS AS (models * copies * CASE WHEN sides = 'duplex' THEN (pages_per_model + 1) / 2 ELSE pages_per_model END) STORED,
	"machine_id" bigint NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"work_date" date GENERATED ALWAYS AS ((starts_at AT TIME ZONE 'Africa/Tripoli')::date) STORED,
	"status" "booking_status" DEFAULT 'booked' NOT NULL,
	"needs_reschedule" boolean DEFAULT false NOT NULL,
	"reschedule_reason" "reschedule_reason",
	"delay_notice_at" timestamp with time zone,
	"delayed_from" timestamp with time zone,
	"identity_confirmed_by" bigint,
	"identity_confirmed_at" timestamp with time zone,
	"wasted_sheets" integer,
	"waste_destroyed" boolean,
	"ready_by" bigint,
	"ready_at" timestamp with time zone,
	"delivered_by" bigint,
	"delivered_at" timestamp with time zone,
	"no_show_by" bigint,
	"no_show_at" timestamp with time zone,
	"cancelled_by" bigint,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_reference_key" UNIQUE("reference"),
	CONSTRAINT "bookings_ref_year_ref_seq_key" UNIQUE("ref_year","ref_seq"),
	CONSTRAINT "bookings_ref_seq_check" CHECK ("bookings"."ref_seq" >= 1),
	CONSTRAINT "bookings_doctor_phone_check" CHECK ("bookings"."doctor_phone" ~ '^2189[0-9]{8}$'),
	CONSTRAINT "bookings_copies_check" CHECK ("bookings"."copies" BETWEEN 1 AND 20000),
	CONSTRAINT "bookings_models_check" CHECK ("bookings"."models" BETWEEN 1 AND 50),
	CONSTRAINT "bookings_pages_per_model_check" CHECK ("bookings"."pages_per_model" BETWEEN 1 AND 500),
	CONSTRAINT "bookings_starts_at_check" CHECK (extract(epoch FROM "bookings"."starts_at") % 600 = 0),
	CONSTRAINT "bookings_ends_at_check" CHECK (extract(epoch FROM "bookings"."ends_at") % 600 = 0),
	CONSTRAINT "bookings_wasted_sheets_check" CHECK ("bookings"."wasted_sheets" >= 0),
	CONSTRAINT "bookings_check" CHECK ("bookings"."ends_at" > "bookings"."starts_at"),
	CONSTRAINT "bookings_check1" CHECK ("bookings"."needs_reschedule" = ("bookings"."reschedule_reason" IS NOT NULL)),
	CONSTRAINT "bookings_check2" CHECK (NOT "bookings"."needs_reschedule" OR "bookings"."status" IN ('booked', 'in_progress')),
	CONSTRAINT "bookings_check3" CHECK ("bookings"."status" NOT IN ('in_progress', 'ready', 'delivered') OR "bookings"."identity_confirmed_at" IS NOT NULL),
	CONSTRAINT "bookings_check4" CHECK ("bookings"."status" NOT IN ('ready', 'delivered') OR ("bookings"."ready_at" IS NOT NULL AND "bookings"."wasted_sheets" IS NOT NULL AND "bookings"."waste_destroyed" IS TRUE)),
	CONSTRAINT "bookings_check5" CHECK ("bookings"."status" <> 'delivered' OR "bookings"."delivered_at" IS NOT NULL),
	CONSTRAINT "bookings_check6" CHECK ("bookings"."status" <> 'cancelled' OR "bookings"."cancelled_at" IS NOT NULL),
	CONSTRAINT "bookings_check7" CHECK ("bookings"."status" <> 'no_show' OR "bookings"."no_show_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "colleges" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "colleges_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "colleges_name_key" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"date" date PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_maintenance" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "machine_maintenance_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"machine_id" bigint NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"reason" text NOT NULL,
	"created_by" bigint NOT NULL,
	"ended_by" bigint,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_maintenance_check" CHECK ("machine_maintenance"."ends_at" IS NULL OR "machine_maintenance"."ends_at" >= "machine_maintenance"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "machines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"model" text NOT NULL,
	"type" "machine_type" NOT NULL,
	"min_sheets" integer NOT NULL,
	"max_sheets" integer,
	"supports_duplex" boolean NOT NULL,
	"speed_per_hour" integer NOT NULL,
	"setup_minutes_per_model" integer NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"archived_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machines_min_sheets_check" CHECK ("machines"."min_sheets" >= 1),
	CONSTRAINT "machines_check" CHECK ("machines"."max_sheets" IS NULL OR "machines"."max_sheets" >= "machines"."min_sheets"),
	CONSTRAINT "machines_speed_per_hour_check" CHECK ("machines"."speed_per_hour" > 0),
	CONSTRAINT "machines_setup_minutes_per_model_check" CHECK ("machines"."setup_minutes_per_model" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" NOT NULL,
	"college_id" bigint,
	"full_name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_check" CHECK (("users"."role" = 'college') = ("users"."college_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "public"."colleges"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "public"."colleges"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_identity_confirmed_by_fkey" FOREIGN KEY ("identity_confirmed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_ready_by_fkey" FOREIGN KEY ("ready_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_delivered_by_fkey" FOREIGN KEY ("delivered_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_show_by_fkey" FOREIGN KEY ("no_show_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_maintenance" ADD CONSTRAINT "machine_maintenance_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_maintenance" ADD CONSTRAINT "machine_maintenance_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_maintenance" ADD CONSTRAINT "machine_maintenance_ended_by_fkey" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "public"."colleges"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_user_idx" ON "audit_log" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_log" USING btree ("action","at");--> statement-breakpoint
CREATE INDEX "bookings_day_machine_idx" ON "bookings" USING btree ("work_date","machine_id","starts_at");--> statement-breakpoint
CREATE INDEX "bookings_college_idx" ON "bookings" USING btree ("college_id","work_date");--> statement-breakpoint
CREATE INDEX "bookings_status_idx" ON "bookings" USING btree ("status","work_date");--> statement-breakpoint
CREATE INDEX "bookings_reschedule_idx" ON "bookings" USING btree ("starts_at") WHERE "bookings"."needs_reschedule";--> statement-breakpoint
CREATE INDEX "maintenance_machine_idx" ON "machine_maintenance" USING btree ("machine_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "machines_name_key" ON "machines" USING btree ("name") WHERE "machines"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_key" ON "users" USING btree (lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_one_per_college" ON "users" USING btree ("college_id") WHERE "users"."role" = 'college' AND "users"."is_active";