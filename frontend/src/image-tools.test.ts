import { describe, expect, it } from "vitest";
import { normalizedImagePoint } from "./image-tools";

describe("normalized image selection coordinates", () => {
  it("maps pointer positions into the displayed image bounds", () => {
    expect(normalizedImagePoint(250, 150, { left: 100, top: 50, width: 400, height: 200 }))
      .toEqual({ x: 0.375, y: 0.5 });
  });

  it("uses the transformed image rectangle when zoomed", () => {
    expect(normalizedImagePoint(150, 150, { left: 0, top: 0, width: 600, height: 300 }))
      .toEqual({ x: 0.25, y: 0.5 });
  });

  it("clamps pointer positions to the image edges", () => {
    expect(normalizedImagePoint(1100, -10, { left: 100, top: 20, width: 200, height: 100 }))
      .toEqual({ x: 1, y: 0 });
  });
});