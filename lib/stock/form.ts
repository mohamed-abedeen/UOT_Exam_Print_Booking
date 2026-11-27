// Step 3.2 — the stock screen: labels, the browser-side reading of typed quantities, and the sentence of each alert.
// Pure (no database, no `server-only`): the client screen and a test both use it. The server checks every value again.
import { digits, formatDay } from "@/lib/bookings/format";
import type { InventoryItem, ItemKind, MachinePartRow, MovementType, PaperDay, StockAlert } from "@/lib/stock";

/** One movement, either sign (contracts §8.33). */
export const MOVE_MAX = 1_000_000;
/** Movements returned by one `listMovements` call, newest first (owner, 2026-11-27, step 3.1). */
export const MOVEMENTS_LIMIT = 500;
/** The largest number the database holds in an `integer` column (minimum quantity, part life). */
export const INT_MAX = 2_147_483_647;

export const KIND_LABEL: Record<ItemKind, string> = {
  paper: "ورق",
  toner: "حبر",
  master_roll: "رول ماستر",
  part: "قطعة غيار",
};

export const MOVEMENT_LABEL: Record<MovementType, string> = {
  receive: "استلام",
  consume: "صرف",
  waste: "تالف",
  adjust: "تسوية",
};

export const ALERT_KIND_LABEL: Record<StockAlert["kind"], string> = {
  low_stock: "رصيد منخفض",
  part_near_end: "قطعة قاربت نهاية عمرها",
  paper_short: "ورق لا يكفي",
};

/** A machine a form can pick: active ones only. */
export interface MachineOption {
  id: number;
  name: string;
}

/** 1234567 → '1,234,567'; a minus stays a plain '-'. Never Intl: the server and the browser print the same text. */
export function formatCount(n: number): string {
  const text = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n < 0 ? `-${text}` : text;
}

/** A typed whole number between `min` and `max` (Arabic-Indic digits read), or null. */
export function parseWhole(text: string, min: number, max: number): number | null {
  const t = digits(text).trim();
  if (!/^\d{1,10}$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/** A typed adjustment: a non-zero whole number up to `MOVE_MAX` either way; '-', '−' and '+' signs are read. */
export function parseSigned(text: string): number | null {
  const t = digits(text).trim().replace(/[−–—]/g, "-").replace(/^\+/, "");
  const m = /^(-?)(\d{1,10})$/.exec(t);
  if (!m) return null;
  const n = Number(m[2]);
  if (n < 1 || n > MOVE_MAX) return null;
  return m[1] ? -n : n;
}

/** Whole percent of a part's life used; may pass 100. */
export function percentUsed(used: number, life: number): number {
  return life > 0 ? Math.floor((used * 100) / life) : 0;
}

/** A day whose booked sheets pass the paper balance (the same test as the `paper_short` alert). */
export function isPaperShort(day: PaperDay, balance: number | null): boolean {
  return balance !== null && day.sheets > balance;
}

export interface AlertLine {
  key: string;
  kind: StockAlert["kind"];
  text: string;
}

/** One Arabic sentence per alert, with the numbers; what an id no longer finds is named by its number. */
export function alertLines(
  alerts: StockAlert[],
  items: InventoryItem[],
  parts: MachinePartRow[],
  days: PaperDay[],
  paperBalance: number | null,
): AlertLine[] {
  return alerts.map((a, i) => {
    const key = `${a.kind}-${a.itemId ?? ""}-${a.machinePartId ?? ""}-${a.date ?? ""}-${i}`;
    if (a.kind === "low_stock") {
      const item = items.find((x) => x.id === a.itemId);
      const text = item
        ? `«${item.name}» عند حدّه الأدنى أو دونه: الرصيد ${formatCount(item.balance)} ${item.unit} والحد ${formatCount(item.minQuantity)}.`
        : `صنف رقم ${a.itemId} عند حدّه الأدنى أو دونه.`;
      return { key, kind: a.kind, text };
    }
    if (a.kind === "part_near_end") {
      const part = parts.find((x) => x.id === a.machinePartId);
      const text = part
        ? `القطعة «${part.name}» في الآلة ${part.machineName} قاربت نهاية عمرها: ${formatCount(part.impressionsUsed)} من ${formatCount(part.lifeImpressions)} (${percentUsed(part.impressionsUsed, part.lifeImpressions)}٪).`
        : `قطعة رقم ${a.machinePartId} قاربت نهاية عمرها.`;
      return { key, kind: a.kind, text };
    }
    const day = days.find((d) => d.date === a.date);
    const date = a.date ? formatDay(a.date) : "";
    const text =
      day && paperBalance !== null
        ? `الورق لا يكفي ${date}: المحجوز ${formatCount(day.sheets)} ورقة والرصيد ${formatCount(paperBalance)}.`
        : `الورق لا يكفي ${date}.`;
    return { key, kind: a.kind, text };
  });
}
