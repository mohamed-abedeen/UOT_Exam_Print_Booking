import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("smoke", () => {
  it("runs Vitest and Zod", () => {
    expect(z.string().parse("ok")).toBe("ok");
  });
});
