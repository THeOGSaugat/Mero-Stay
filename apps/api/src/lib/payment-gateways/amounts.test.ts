import { describe, expect, it } from "vitest";
import { khaltiPaisa, paisaToRupees, rupeesToPaisa } from "./amounts.js";

describe("gateway amounts ⇄ paisa (ADR 0017)", () => {
  it("writes paisa as eSewa rupees", () => {
    expect(paisaToRupees(11000n)).toBe("110");
    expect(paisaToRupees(10050n)).toBe("100.50");
    expect(paisaToRupees(10005n)).toBe("100.05");
    expect(paisaToRupees(0n)).toBe("0");
    expect(paisaToRupees(957110n)).toBe("9571.10");
    expect(paisaToRupees(900719925474099300n)).toBe("9007199254740993");
    expect(() => paisaToRupees(-1n)).toThrow(RangeError);
  });

  it("reads eSewa rupees (text and JSON numbers) as paisa", () => {
    expect(rupeesToPaisa("110")).toBe(11000n);
    expect(rupeesToPaisa("100.5")).toBe(10050n);
    expect(rupeesToPaisa("100.50")).toBe(10050n);
    expect(rupeesToPaisa("1,000.0")).toBe(100000n);
    expect(rupeesToPaisa("12,34,567.0")).toBe(123456700n);
    expect(rupeesToPaisa(" 9571.10 ")).toBe(957110n);
    expect(rupeesToPaisa(100)).toBe(10000n);
    expect(rupeesToPaisa(100.5)).toBe(10050n);
    expect(rupeesToPaisa(9571.1)).toBe(957110n);
    expect(rupeesToPaisa(0.07)).toBe(7n);
  });

  it("refuses anything that is not a plain amount", () => {
    for (const bad of [
      "100.555",
      "-10",
      "1e3",
      "abc",
      "",
      "1,00,0.0.0",
      "Rs. 100",
      100.555,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      null,
      undefined,
      {},
    ]) {
      expect(rupeesToPaisa(bad), JSON.stringify(bad) ?? "undefined").toBeNull();
    }
  });

  it("reads Khalti paisa as bigint", () => {
    expect(khaltiPaisa(1000)).toBe(1000n);
    expect(khaltiPaisa("957110")).toBe(957110n);
    expect(khaltiPaisa(10.5)).toBeNull();
    expect(khaltiPaisa(-1)).toBeNull();
    expect(khaltiPaisa("10.5")).toBeNull();
    expect(khaltiPaisa(null)).toBeNull();
  });

  it("round-trips every paisa value through eSewa text", () => {
    for (const paisa of [1n, 9n, 10n, 99n, 100n, 101n, 4500_00n, 123456789n]) {
      expect(rupeesToPaisa(paisaToRupees(paisa))).toBe(paisa);
    }
  });
});
