CREATE TYPE "public"."saturday_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "saturday_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "saturday_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"college_id" bigint NOT NULL,
	"date" date NOT NULL,
	"expected_quantity" integer NOT NULL,
	"reason" text NOT NULL,
	"status" "saturday_status" DEFAULT 'pending' NOT NULL,
	"approved_quantity" integer,
	"decided_by" bigint,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saturday_requests_date_check" CHECK (extract(isodow FROM "saturday_requests"."date") = 6),
	CONSTRAINT "saturday_requests_expected_quantity_check" CHECK ("saturday_requests"."expected_quantity" > 0),
	CONSTRAINT "saturday_requests_approved_quantity_check" CHECK ("saturday_requests"."approved_quantity" > 0),
	CONSTRAINT "saturday_requests_check" CHECK (("saturday_requests"."status" = 'approved') = ("saturday_requests"."approved_quantity" IS NOT NULL)),
	CONSTRAINT "saturday_requests_check1" CHECK (("saturday_requests"."status" = 'pending') = ("saturday_requests"."decided_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "saturday_request_id" bigint;--> statement-breakpoint
ALTER TABLE "saturday_requests" ADD CONSTRAINT "saturday_requests_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "public"."colleges"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saturday_requests" ADD CONSTRAINT "saturday_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saturday_requests" ADD CONSTRAINT "saturday_requests_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saturday_one_open_idx" ON "saturday_requests" USING btree ("college_id","date") WHERE "saturday_requests"."status" IN ('pending', 'approved');--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_saturday_request_id_fkey" FOREIGN KEY ("saturday_request_id") REFERENCES "public"."saturday_requests"("id") ON DELETE restrict ON UPDATE no action;