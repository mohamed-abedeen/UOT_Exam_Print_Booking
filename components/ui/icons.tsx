// The app's icons on a 24x24 grid. Each icon is a few solid shapes; a shape's inner outlines are holes (even-odd).
// variant="fill" paints them solid (tab bar, SF-Symbols-like); variant="line" draws their outline (sidebar, lucide-like).
import type { SVGProps } from "react";

// A rounded rectangle and a circle as path text, so the glyphs below stay readable.
const rr = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
const dot = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;

type Shape = { d: string; r?: number };
const rays = (): Shape[] => [0, 45, 90, 135, 180, 225, 270, 315].map((r) => ({ d: rr(11.1, 1.8, 1.8, 3.4, 0.9), r }));
const teeth = (): Shape[] => [0, 45, 90, 135, 180, 225, 270, 315].map((r) => ({ d: rr(10.2, 2.2, 3.6, 4.6, 1), r }));

const GLYPHS = {
  calendar: [
    { d: rr(3, 5, 18, 16, 4) + rr(7, 10.5, 3.5, 3, 0.9) + rr(13.5, 10.5, 3.5, 3, 0.9) + rr(7, 15, 3.5, 3, 0.9) },
    { d: rr(7.5, 2.5, 2, 2.4, 0.9) },
    { d: rr(14.5, 2.5, 2, 2.4, 0.9) },
  ],
  plus: [
    {
      d:
        dot(12, 12, 9) +
        "M11 7.5a1 1 0 0 1 2 0V11h3.5a1 1 0 0 1 0 2H13v3.5a1 1 0 0 1-2 0V13H7.5a1 1 0 0 1 0-2H11Z",
    },
  ],
  clock: [
    {
      d:
        dot(12, 12, 9) +
        "M11.25 7.5a.75.75 0 0 1 1.5 0v4.19l2.78 1.6a.75.75 0 1 1-.75 1.3l-3.15-1.82a.75.75 0 0 1-.38-.65Z",
    },
  ],
  list: [{ d: rr(3, 3, 18, 18, 4.5) + rr(7, 8, 10, 1.8, 0.9) + rr(7, 11.1, 10, 1.8, 0.9) + rr(7, 14.2, 6, 1.8, 0.9) }],
  doc: [
    {
      d:
        "M7 2.5h6.4a2 2 0 0 1 1.4.6l3.1 3.1a2 2 0 0 1 .6 1.4V19a2.5 2.5 0 0 1-2.5 2.5H7A2.5 2.5 0 0 1 4.5 19V5A2.5 2.5 0 0 1 7 2.5Z" +
        rr(8, 12, 8, 1.6, 0.8) +
        rr(8, 15.5, 5, 1.6, 0.8),
    },
  ],
  printer: [
    { d: rr(7, 3, 10, 4.5, 1.5) },
    { d: rr(3, 8.5, 18, 8, 3) + dot(17.5, 12.5, 0.9) },
    { d: rr(7.5, 14.3, 9, 6.7, 1.5) },
  ],
  wrench: [
    {
      r: 45,
      d: "M8 2.5h2.4v4.1a1.6 1.6 0 0 0 3.2 0V2.5H16V8a4 4 0 0 1-2.2 3.6V19.5a1.8 1.8 0 0 1-3.6 0V11.6A4 4 0 0 1 8 8Z",
    },
  ],
  swap: [
    { d: "M8 3.5 12.2 8.5H9.2V19.5H6.8V8.5H3.8Z" },
    { d: "M16 20.5 11.8 15.5H14.8V4.5H17.2V15.5H20.2Z" },
  ],
  box: [{ d: rr(2.5, 3, 19, 4, 1.5) }, { d: rr(4, 8.5, 16, 12.5, 3) + rr(9.5, 12, 5, 2, 1) }],
  chart: [{ d: rr(3.5, 12, 4.5, 9, 1.3) }, { d: rr(9.75, 7, 4.5, 14, 1.3) }, { d: rr(16, 3, 4.5, 18, 1.3) }],
  building: [
    {
      d:
        rr(5, 3, 14, 18, 2.5) +
        rr(8, 6.5, 2.6, 2.6, 0.7) +
        rr(13.4, 6.5, 2.6, 2.6, 0.7) +
        rr(8, 11, 2.6, 2.6, 0.7) +
        rr(13.4, 11, 2.6, 2.6, 0.7) +
        rr(10.2, 16, 3.6, 5, 0.9),
    },
  ],
  users: [
    { d: dot(12, 8, 3.6) },
    { d: "M4.8 20.5c0-3.8 3.2-6.4 7.2-6.4s7.2 2.6 7.2 6.4a.9.9 0 0 1-.9.9H5.7a.9.9 0 0 1-.9-.9Z" },
  ],
  gear: [{ d: dot(12, 12, 6.6) + dot(12, 12, 2.6) }, ...teeth()],
  more: [{ d: dot(12, 12, 9.5) + dot(7.5, 12, 1.4) + dot(12, 12, 1.4) + dot(16.5, 12, 1.4) }],
  sun: [{ d: dot(12, 12, 4.2) }, ...rays()],
  moon: [{ d: "M20.5 14.2A8.6 8.6 0 0 1 9.8 3.5a8.6 8.6 0 1 0 10.7 10.7Z" }],
  display: [{ d: rr(3, 4.5, 18, 12, 2.5) }, { d: rr(8.5, 18.2, 7, 2, 1) }],
  logout: [
    {
      d: "M9.5 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h2.5a1 1 0 1 0 0-2H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h2.5a1 1 0 1 0 0-2Z",
    },
    {
      d: "M16.3 8.3a1 1 0 0 1 1.4 0l3 3a1 1 0 0 1 0 1.4l-3 3a1 1 0 0 1-1.4-1.4l1.3-1.3H11a1 1 0 1 1 0-2h6.6l-1.3-1.3a1 1 0 0 1 0-1.4Z",
    },
  ],
  close: [
    {
      d: "M6.7 5.3 12 10.6l5.3-5.3a1 1 0 0 1 1.4 1.4L13.4 12l5.3 5.3a1 1 0 0 1-1.4 1.4L12 13.4l-5.3 5.3a1 1 0 0 1-1.4-1.4L10.6 12 5.3 6.7a1 1 0 0 1 1.4-1.4Z",
    },
  ],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof GLYPHS;

export function Icon({
  name,
  variant = "fill",
  strokeWidth = 1.8,
  ...props
}: { name: IconName; variant?: "fill" | "line"; strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  const line = variant === "line";
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill={line ? "none" : "currentColor"}
      stroke="currentColor"
      strokeWidth={line ? strokeWidth : 0.6}
      strokeLinejoin="round"
      strokeLinecap="round"
      {...props}
    >
      {GLYPHS[name].map((s: Shape, i: number) => (
        <path key={i} d={s.d} fillRule="evenodd" transform={s.r ? `rotate(${s.r} 12 12)` : undefined} />
      ))}
    </svg>
  );
}
