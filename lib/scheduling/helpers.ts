// Small pure helpers (contracts §3.10) used by the booking form and createBooking.
// whatsAppLink and getStockAlerts arrive with the steps that use them.

/** A Libyan mobile number as '2189XXXXXXXX', or null when it is not one. */
export function normalizePhone(input: string): string | null {
  let s = input.replace(/[\s\-()[\]]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("00218")) s = s.slice(2);
  else if (/^09\d{8}$/.test(s)) s = `218${s.slice(1)}`;
  else if (/^9\d{8}$/.test(s)) s = `218${s}`;
  return /^2189\d{8}$/.test(s) ? s : null;
}

/** At least four words of two letters or more. */
export function isFourPartName(name: string): boolean {
  const words = name.trim().split(/\s+/);
  return words.filter((w) => (w.match(/\p{L}/gu)?.length ?? 0) >= 2).length >= 4;
}

/** True when the exam date is set and the booking is on or after it. A warning only: it never blocks. */
export function examDateWarning(bookingDate: string, examDate: string | null): boolean {
  return examDate !== null && bookingDate >= examDate;
}

/** '2026-0042'; the sequence is zero-padded to 4 and grows past 9999. */
export function formatReference(year: number, seq: number): string {
  return `${year}-${String(seq).padStart(4, "0")}`;
}
