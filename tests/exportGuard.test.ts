import { describe, it, expect } from "vitest";
import { assertExportable } from "../src/lib/exportGuard.js";
import { AppError } from "../src/lib/errors.js";

describe("assertExportable (R4)", () => {
  it("allows generic songs", () => {
    expect(() => assertExportable({ child_id: null })).not.toThrow();
  });

  it("blocks personalized songs with 403 FORBIDDEN", () => {
    let caught: unknown;
    try {
      assertExportable({ child_id: "c1111111-1111-4111-8111-111111111111" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });
});
