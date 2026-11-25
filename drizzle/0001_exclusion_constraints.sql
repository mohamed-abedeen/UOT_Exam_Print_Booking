-- Hand-written (contracts §0): what Drizzle cannot express. Runs after 0000, which creates the tables.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
-- two bookings never overlap on one machine (holding statuses only)
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist (machine_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (status NOT IN ('cancelled', 'no_show'));
--> statement-breakpoint
ALTER TABLE "machine_maintenance" ADD CONSTRAINT "maintenance_no_overlap"
  EXCLUDE USING gist (machine_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&);
