import { describe, expect, it } from "vitest";
import { opaqueTitleBarColor } from "./title-bar-overlay-color";

describe("opaqueTitleBarColor", () => {
  it("keeps opaque hex values", () => {
    expect(opaqueTitleBarColor("#131316", "#000000")).toBe("#131316");
  });

  it("expands short hex values", () => {
    expect(opaqueTitleBarColor("#abc", "#000000")).toBe("#aabbcc");
  });

  it("composites translucent theme colors over their opaque base", () => {
    expect(opaqueTitleBarColor("rgba(4, 12, 26, 0.96)", "#101013")).toBe(
      "#040c1a",
    );
  });
});
