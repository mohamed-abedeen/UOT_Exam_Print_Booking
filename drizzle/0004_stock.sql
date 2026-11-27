CREATE TYPE "public"."item_kind" AS ENUM('paper', 'toner', 'master_roll', 'part');--> statement-breakpoint
CREATE TYPE "public"."movement_type" AS ENUM('receive', 'consume', 'waste', 'adjust');--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"kind" "item_kind" NOT NULL,
	"unit" text NOT NULL,
	"machine_id" bigint,
	"min_quantity" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_items_name_key" UNIQUE("name"),
	CONSTRAINT "inventory_items_min_quantity_check" CHECK ("inventory_items"."min_quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory_movements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"item_id" bigint NOT NULL,
	"type" "movement_type" NOT NULL,
	"quantity" integer NOT NULL,
	"booking_id" bigint,
	"machine_part_id" bigint,
	"note" text,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_quantity_check" CHECK ("inventory_movements"."quantity" <> 0),
	CONSTRAINT "inventory_movements_check" CHECK (("inventory_movements"."type" = 'receive' AND "inventory_movements"."quantity" > 0) OR ("inventory_movements"."type" IN ('consume', 'waste') AND "inventory_movements"."quantity" < 0) OR "inventory_movements"."type" = 'adjust'),
	CONSTRAINT "inventory_movements_check1" CHECK ("inventory_movements"."type" <> 'adjust' OR "inventory_movements"."note" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "machine_parts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "machine_parts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"machine_id" bigint NOT NULL,
	"name" text NOT NULL,
	"inventory_item_id" bigint,
	"life_impressions" integer NOT NULL,
	"impressions_used" integer DEFAULT 0 NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replaced_at" timestamp with time zone,
	"replaced_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_parts_life_impressions_check" CHECK ("machine_parts"."life_impressions" > 0),
	CONSTRAINT "machine_parts_impressions_used_check" CHECK ("machine_parts"."impressions_used" >= 0)
);
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_machine_part_id_fkey" FOREIGN KEY ("machine_part_id") REFERENCES "public"."machine_parts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_parts" ADD CONSTRAINT "machine_parts_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_parts" ADD CONSTRAINT "machine_parts_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_parts" ADD CONSTRAINT "machine_parts_replaced_by_fkey" FOREIGN KEY ("replaced_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_one_paper_idx" ON "inventory_items" USING btree ("kind") WHERE "inventory_items"."kind" = 'paper' AND "inventory_items"."is_active";--> statement-breakpoint
CREATE INDEX "movements_item_idx" ON "inventory_movements" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "movements_once_per_booking_idx" ON "inventory_movements" USING btree ("booking_id","type") WHERE "inventory_movements"."booking_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "machine_parts_installed_idx" ON "machine_parts" USING btree ("machine_id") WHERE "machine_parts"."replaced_at" IS NULL;--> statement-breakpoint
-- Hand-added (step 3.1, contracts §1.9): the one active paper item, A4, counted in sheets; balance starts at 0.
INSERT INTO "inventory_items" ("name", "kind", "unit", "min_quantity") VALUES ('ورق A4', 'paper', 'ورقة', 0);