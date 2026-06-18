import { describe, it, expect } from "vitest";
import { uuidv7, uuidv7Time } from "../src/lib/uuidv7.js";

describe("uuidv7", () => {
  it("produces valid v7 UUIDs", () => {
    const id = uuidv7();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("is unique across a tight loop", () => {
    const set = new Set<string>();
    for (let i = 0; i < 10_000; i++) set.add(uuidv7());
    expect(set.size).toBe(10_000);
  });

  it("is time-sortable (monotonic within and across ms)", () => {
    const ids: string[] = [];
    for (let i = 0; i < 5_000; i++) ids.push(uuidv7());
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  it("encodes the creation timestamp", () => {
    const t = 1_750_000_000_000;
    const id = uuidv7(t);
    expect(uuidv7Time(id)).toBe(t);
  });
});
