import { describe, expect, it } from "vitest";
import {
  formatAmount,
  formatMoney,
  groupNepali,
  groupThousands,
  isMinorString,
  majorInputToMinor,
  splitMinor,
} from "./money";

describe("formatMoney: minor-unit strings to display text", () => {
  it("formats NPR with Nepali grouping", () => {
    expect(formatMoney("115500", "NPR", 2)).toBe("Rs 1,155.00");
    expect(formatMoney("957110", "NPR", 2)).toBe("Rs 9,571.10");
    expect(formatMoney("123456700", "NPR", 2)).toBe("Rs 12,34,567.00");
    expect(formatMoney("0", "NPR", 2)).toBe("Rs 0.00");
    expect(formatMoney("5", "NPR", 2)).toBe("Rs 0.05");
    expect(formatMoney("100", "NPR", 2)).toBe("Rs 1.00");
  });

  it("formats other currencies with their code and thousands grouping", () => {
    expect(formatMoney("123450", "USD", 2)).toBe("USD 1,234.50");
    expect(formatMoney("1500", "JPY", 0)).toBe("JPY 1,500");
  });

  it("stays exact far above Number.MAX_SAFE_INTEGER (no float, no precision loss)", () => {
    // 2^53 + 1 = 9007199254740993: as a JS number it would become ...992.
    expect(formatMoney("9007199254740993", "NPR", 2)).toBe("Rs 9,00,71,99,25,47,409.93");
    expect(formatMoney("9223372036854775807", "USD", 2)).toBe("USD 92,233,720,368,547,758.07");
    expect(Number("9007199254740993")).toBe(9007199254740992); // what a number would lose
  });

  it("refuses anything that is not a digit string (never a JSON number)", () => {
    expect(() => formatMoney(115500 as unknown as string, "NPR", 2)).toThrow(TypeError);
    expect(() => formatMoney("11.55", "NPR", 2)).toThrow(TypeError);
    expect(() => formatMoney("-100", "NPR", 2)).toThrow(TypeError);
    expect(() => formatMoney("100", "NPR", -1)).toThrow(RangeError);
  });

  it("formatAmount shows a dash for an absent optional amount", () => {
    const npr = { currency: "NPR", currencyExponent: 2 };
    expect(formatAmount("350000", npr)).toBe("Rs 3,500.00");
    expect(formatAmount(null, npr)).toBe("—");
  });
});

describe("building blocks", () => {
  it("groups digits", () => {
    expect(groupNepali("1")).toBe("1");
    expect(groupNepali("1234")).toBe("1,234");
    expect(groupNepali("100000")).toBe("1,00,000");
    expect(groupNepali("00012345")).toBe("12,345");
    expect(groupThousands("1234567")).toBe("1,234,567");
  });

  it("splits minor units without arithmetic", () => {
    expect(splitMinor("115500", 2)).toEqual(["1155", "00"]);
    expect(splitMinor("7", 2)).toEqual(["0", "07"]);
    expect(splitMinor("0042", 0)).toEqual(["42", ""]);
  });

  it("recognises minor-unit strings", () => {
    expect(isMinorString("0")).toBe(true);
    expect(isMinorString("115500")).toBe(true);
    expect(isMinorString(115500)).toBe(false);
    expect(isMinorString("1e5")).toBe(false);
    expect(isMinorString("")).toBe(false);
  });
});

describe("majorInputToMinor: what a person types into a price filter", () => {
  it("converts rupees to paisa with string operations", () => {
    expect(majorInputToMinor("1500", 2)).toBe("150000");
    expect(majorInputToMinor("1,500", 2)).toBe("150000");
    expect(majorInputToMinor("1500.5", 2)).toBe("150050");
    expect(majorInputToMinor("0.05", 2)).toBe("5");
    expect(majorInputToMinor("90071992547409.93", 2)).toBe("9007199254740993");
  });

  it("returns null for anything that is not a valid amount", () => {
    for (const bad of ["", "  ", "-5", "1.234", "abc", "1e3", "12,34.5.6"]) {
      expect(majorInputToMinor(bad, 2)).toBeNull();
    }
    expect(majorInputToMinor("99999999999999999999", 2)).toBeNull();
  });
});
