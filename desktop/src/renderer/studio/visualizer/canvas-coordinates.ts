export interface CanvasPoint {
  x: number;
  y: number;
}

type CanvasCoordinateSource = Pick<
  HTMLCanvasElement,
  "width" | "height" | "getBoundingClientRect"
>;

/** Convert viewport pointer coordinates into the canvas backing-store space. */
export function canvasPointFromClient(
  canvas: CanvasCoordinateSource,
  clientX: number,
  clientY: number,
): CanvasPoint {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
  const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;

  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}
