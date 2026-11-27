"use client";

import { button } from "@/components/admin/styles";

export function PrintButton() {
  return (
    <button type="button" className={button} onClick={() => window.print()}>
      طباعة
    </button>
  );
}
