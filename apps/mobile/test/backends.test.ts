import { stringCells } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { cjkLines } from "../src/util/fixtures.js";

describe("cjk fixture", () => {
  it("declares cell widths that match stringCells", () => {
    for (const line of cjkLines()) {
      for (const r of line.r) {
        expect(r.n ?? Array.from(r.t).length).toBe(stringCells(r.t));
      }
    }
  });
});
