// Step 3.2 — the browser-side reading of the stock screen and the sentence of each alert. Pure: no database.
import { describe, expect, it } from "vitest";
import type { InventoryItem, MachinePartRow, PaperDay, StockAlert } from "@/lib/stock";
import {
  alertLines,
  formatCount,
  INT_MAX,
  isPaperShort,
  MOVE_MAX,
  parseSigned,
  parseWhole,
  percentUsed,
} from "@/lib/stock/form";

describe("parseWhole", () => {
  it("reads Latin and Arabic-Indic digits inside the bounds", () => {
    expect(parseWhole("500", 1, MOVE_MAX)).toBe(500);
    expect(parseWhole(" ٣٠٠٠ ", 1, MOVE_MAX)).toBe(3000);
    expect(parseWhole("۱۲", 1, MOVE_MAX)).toBe(12);
    expect(parseWhole("1000000", 1, MOVE_MAX)).toBe(1_000_000);
    expect(parseWhole("0", 0, INT_MAX)).toBe(0);
  });

  it("refuses zero where 1 is the least, a sign, a decimal, text, empty and the over-large", () => {
    for (const bad of ["0", "-5", "+5", "1.5", "1,000", "abc", "", "  ", "1000001", "12345678901"]) {
      expect(parseWhole(bad, 1, MOVE_MAX)).toBeNull();
    }
    expect(parseWhole("2147483648", 0, INT_MAX)).toBeNull();
    expect(parseWhole("2147483647", 1, INT_MAX)).toBe(INT_MAX);
  });
});

describe("parseSigned", () => {
  it("reads a sign of any kind, with Arabic-Indic digits", () => {
    expect(parseSigned("500")).toBe(500);
    expect(parseSigned("+500")).toBe(500);
    expect(parseSigned("-120")).toBe(-120);
    expect(parseSigned("−120")).toBe(-120); // U+2212
    expect(parseSigned("-١٢٠")).toBe(-120);
    expect(parseSigned("-1000000")).toBe(-1_000_000);
  });

  it("refuses zero, out of range, a decimal, text and empty", () => {
    for (const bad of ["0", "-0", "1000001", "-1000001", "1.5", "5-", "--5", "abc", "", "-"]) {
      expect(parseSigned(bad)).toBeNull();
    }
  });
});

describe("formatCount and percentUsed", () => {
  it("groups thousands and keeps a plain minus", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1000)).toBe("1,000");
    expect(formatCount(1_234_567)).toBe("1,234,567");
    expect(formatCount(-1500)).toBe("-1,500");
  });

  it("percent is the whole part and may pass 100", () => {
    expect(percentUsed(899, 1000)).toBe(89);
    expect(percentUsed(900, 1000)).toBe(90);
    expect(percentUsed(1200, 1000)).toBe(120);
    expect(percentUsed(5, 0)).toBe(0);
  });
});

describe("isPaperShort", () => {
  it("is true only above the balance, and never without a paper item", () => {
    const day: PaperDay = { date: "2026-11-29", sheets: 400 };
    expect(isPaperShort(day, 399)).toBe(true);
    expect(isPaperShort(day, 400)).toBe(false);
    expect(isPaperShort(day, null)).toBe(false);
  });
});

describe("alertLines", () => {
  const items: InventoryItem[] = [
    { id: 1, name: "ورق A4", kind: "paper", unit: "ورقة", machineId: null, machineName: null, minQuantity: 500, isActive: true, balance: 300 },
  ];
  const parts: MachinePartRow[] = [
    {
      id: 7,
      machineId: 2,
      machineName: "كونيكا 1",
      name: "درم",
      inventoryItemId: null,
      inventoryItemName: null,
      lifeImpressions: 1000,
      impressionsUsed: 950,
      installedAt: new Date("2026-11-01T08:00:00Z"),
      replacedAt: null,
      replacedByName: null,
    },
  ];
  const days: PaperDay[] = [
    { date: "2026-11-29", sheets: 200 },
    { date: "2026-11-30", sheets: 400 },
  ];

  it("one sentence per alert, with its numbers", () => {
    const alerts: StockAlert[] = [
      { kind: "low_stock", itemId: 1 },
      { kind: "part_near_end", machinePartId: 7 },
      { kind: "paper_short", itemId: 1, date: "2026-11-30" },
    ];
    const lines = alertLines(alerts, items, parts, days, 300);
    expect(lines.map((l) => l.kind)).toEqual(["low_stock", "part_near_end", "paper_short"]);
    expect(lines[0].text).toBe("«ورق A4» عند حدّه الأدنى أو دونه: الرصيد 300 ورقة والحد 500.");
    expect(lines[1].text).toBe("القطعة «درم» في الآلة كونيكا 1 قاربت نهاية عمرها: 950 من 1,000 (95٪).");
    expect(lines[2].text).toBe("الورق لا يكفي الاثنين 2026-11-30: المحجوز 400 ورقة والرصيد 300.");
    expect(new Set(lines.map((l) => l.key)).size).toBe(3);
  });

  it("an id the lists no longer hold is named by its number, not dropped", () => {
    const lines = alertLines(
      [
        { kind: "low_stock", itemId: 99 },
        { kind: "part_near_end", machinePartId: 98 },
        { kind: "paper_short", itemId: 1, date: "2026-12-05" },
      ],
      items,
      parts,
      days,
      300,
    );
    expect(lines[0].text).toContain("99");
    expect(lines[1].text).toContain("98");
    expect(lines[2].text).toBe("الورق لا يكفي السبت 2026-12-05.");
  });
});
