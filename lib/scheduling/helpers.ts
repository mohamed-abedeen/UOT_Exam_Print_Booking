// Small pure helpers (contracts §3.10) used by the booking form and createBooking.
// getStockAlerts arrives with the stock step (3.1).

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

export type WhatsAppKind = "started" | "ready";

/** The wa.me link to the doctor's phone with the fixed Arabic text of contracts §3.10. Writes nothing. */
export function whatsAppLink(
  kind: WhatsAppKind,
  b: { doctorPhone: string; subject: string; collegeName: string; machineName: string; reference: string },
): string {
  const head = "مركز التصوير والطباعة – جامعة طرابلس: ";
  const text =
    kind === "started"
      ? `${head}بدأ تصوير «${b.subject}» (${b.collegeName}) على الآلة ${b.machineName}. المرجع ${b.reference}.`
      : `${head}«${b.subject}» (${b.collegeName}) جاهز للاستلام. المرجع ${b.reference}.`;
  return `https://wa.me/${b.doctorPhone}?text=${encodeURIComponent(text)}`;
}
