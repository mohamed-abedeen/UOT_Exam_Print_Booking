// Scheduling types (contracts §3). Only what the pure functions of step 1.3 use.

export type Sides = "single" | "duplex";

export interface JobSpec {
  models: number;
  pagesPerModel: number;
  copies: number;
  sides: Sides;
}

export interface Quantities {
  impressions: number;
  sheets: number;
}

export interface Machine {
  id: number;
  minSheets: number;
  maxSheets: number | null;
  supportsDuplex: boolean;
  speedPerHour: number;
  setupMinutesPerModel: number;
  priority: number;
  archivedAt: Date | null;
}

/** One working day, `[open, close)`. */
export interface Window {
  open: Date;
  close: Date;
}

/** A holding booking or a maintenance row; `end === null` is a stop with no end yet. */
export interface Busy {
  machineId: number;
  start: Date;
  end: Date | null;
  bookingId?: number;
}

export interface Placement {
  machineId: number;
  startsAt: Date;
  endsAt: Date;
}

/** The §5 settings keys in camelCase. */
export interface Settings {
  workStart: string;
  workEnd: string;
  workingWeekdays: number[];
  largeJobThreshold: number;
  largeJobsPerDay: number;
  editDeadlineMinutes: number;
  delayDeadlineMinutes: number;
  suggestionSearchDays: number;
  partWarnPercent: number;
}

export interface ScheduleContext {
  now: Date;
  collegeId: number;
  settings: Settings;
  /** 'YYYY-MM-DD' */
  holidays: Set<string>;
  /** Approved rows of this college only. */
  saturdayApprovals: { date: string; approvedQuantity: number; usedImpressions: number }[];
  machines: Machine[];
  busy: Busy[];
  /** Holding bookings with impressions above the large-job threshold, per date. */
  largeJobsByDate: Map<string, number>;
  /** Minutes of holding bookings on that machine that day. */
  loadMinutes(machineId: number, date: string): number;
  /** The booking being edited, delayed or moved; the loader already left it out of the fields above. */
  ignoreBookingId?: number;
}

export type Refusal =
  | "day_closed"
  | "past"
  | "hour_full"
  | "large_job_limit"
  | "saturday_quota"
  | "no_machine"
  | "no_free_slot"
  | "too_long";
