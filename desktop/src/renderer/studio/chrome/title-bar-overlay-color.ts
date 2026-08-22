/** Convert CSS palette colors into opaque hex for Electron title-bar overlays. */
export function opaqueTitleBarColor(color: string, backdrop: string): string {
  const foreground = parseColor(color);
  const background = parseColor(backdrop);
  if (!foreground || !background) return backdrop;

  const alpha = foreground.a / 255;
  return toHex({
    r: Math.round(foreground.r * alpha + background.r * (1 - alpha)),
    g: Math.round(foreground.g * alpha + background.g * (1 - alpha)),
    b: Math.round(foreground.b * alpha + background.b * (1 - alpha)),
  });
}

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(color: string): RgbaColor | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const raw = hex[1].length === 3
      ? hex[1].split("").map((part) => `${part}${part}`).join("")
      : hex[1];
    return {
      r: Number.parseInt(raw.slice(0, 2), 16),
      g: Number.parseInt(raw.slice(2, 4), 16),
      b: Number.parseInt(raw.slice(4, 6), 16),
      a: 255,
    };
  }

  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(color);
  if (!rgba) return null;
  const [r, g, b] = rgba.slice(1, 4).map(Number);
  const alpha = rgba[4] == null ? 1 : Number(rgba[4]);
  if (![r, g, b, alpha].every(Number.isFinite)) return null;
  return {
    r: Math.min(255, Math.max(0, r)),
    g: Math.min(255, Math.max(0, g)),
    b: Math.min(255, Math.max(0, b)),
    a: Math.round(Math.min(1, Math.max(0, alpha)) * 255),
  };
}

function toHex({ r, g, b }: Pick<RgbaColor, "r" | "g" | "b">): string {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}
