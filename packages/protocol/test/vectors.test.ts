import { describe, expect, it } from "vitest";
import { runVectorChecks, type Vectors } from "../src/vectors.js";
import vectors from "./vectors.json" with { type: "json" };

describe("golden vectors", () => {
  it("all checks pass in Node", () => {
    const results = runVectorChecks(vectors as Vectors);
    expect(results.length).toBe(10);
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });
});
