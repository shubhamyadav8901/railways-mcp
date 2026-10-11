import { describe, expect, it } from "vitest";
import { escapeRegExp } from "../../src/lib/regexp.js";

describe("escapeRegExp", () => {
  it("matches every regex metacharacter literally, including backslash", () => {
    const s = String.raw`a.b*c+d?e^f$g{h}i(j)k|l[m]n\o/p`;
    expect(new RegExp(`^${escapeRegExp(s)}$`).test(s)).toBe(true);
    expect(new RegExp(escapeRegExp("et.rsStat")).test("etXrsStat")).toBe(false);
    expect(escapeRegExp(String.raw`\d`)).toBe(String.raw`\\d`);
  });
});
