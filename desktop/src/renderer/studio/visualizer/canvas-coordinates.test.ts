import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canvasPointFromClient } from "./canvas-coordinates";

function canvasAt(
  width: number,
  height: number,
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
): Pick<HTMLCanvasElement, "width" | "height" | "getBoundingClientRect"> {
  return {
    width,
    height,
    getBoundingClientRect: () => rect as DOMRect,
  };
}

describe("canvasPointFromClient", () => {
  it("is used by every visualizer canvas pointer interaction", () => {
    for (const file of [
      "VisualizerRoot.tsx",
      "VisualizerCanvas.tsx",
      "Campus.tsx",
    ]) {
      const source = readFileSync(
        fileURLToPath(new URL(file, import.meta.url)),
        "utf8",
      );
      expect(source).not.toMatch(/nativeEvent\.offset[XY]/);
      expect(source).toContain("canvasPointFromClient");
    }
  });

  it("maps viewport coordinates into the backing store at 150% UI scale", () => {
    const canvas = canvasAt(900, 600, {
      left: 150,
      top: 75,
      width: 1350,
      height: 900,
    });

    expect(canvasPointFromClient(canvas, 825, 525)).toEqual({
      x: 450,
      y: 300,
    });
  });

  it("maps viewport coordinates into the backing store below 100% UI scale", () => {
    const canvas = canvasAt(900, 600, {
      left: 80,
      top: 40,
      width: 720,
      height: 480,
    });

    expect(canvasPointFromClient(canvas, 440, 280)).toEqual({
      x: 450,
      y: 300,
    });
  });

  it("keeps unscaled canvas coordinates unchanged", () => {
    const canvas = canvasAt(900, 600, {
      left: 20,
      top: 10,
      width: 900,
      height: 600,
    });

    expect(canvasPointFromClient(canvas, 470, 310)).toEqual({
      x: 450,
      y: 300,
    });
  });
});
