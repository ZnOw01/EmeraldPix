export function safeMax(values: number[]): number {
  const filtered = values.filter((value) => Number.isFinite(value));
  return filtered.length ? Math.max(...filtered) : 0;
}

export function generateAxisStops(maxPosition: number, step: number): number[] {
  const positions: number[] = [];
  const safeMaxPosition = Number.isFinite(maxPosition) ? Math.max(0, Math.floor(maxPosition)) : 0;
  const safeStep = Number.isFinite(step) ? Math.max(1, Math.floor(step)) : 1;

  for (let position = 0; position <= safeMaxPosition; position += safeStep) {
    positions.push(position);
  }

  if (!positions.length || positions[positions.length - 1] !== safeMaxPosition) {
    positions.push(safeMaxPosition);
  }

  return positions;
}

export const MAX_CAPTURE_TILES = 500;

export function buildCapturePlan(
  totalWidth: number,
  totalHeight: number,
  windowWidth: number,
  windowHeight: number
): Array<[number, number]> {
  const safeTotalWidth = Number.isFinite(totalWidth) ? totalWidth : 1;
  const safeTotalHeight = Number.isFinite(totalHeight) ? totalHeight : 1;
  const safeWindowWidth = Number.isFinite(windowWidth) ? windowWidth : 1;
  const safeWindowHeight = Number.isFinite(windowHeight) ? windowHeight : 1;
  const maxX = Math.max(0, safeTotalWidth - safeWindowWidth);
  const maxY = Math.max(0, safeTotalHeight - safeWindowHeight);
  // Use viewport dimensions directly without scroll padding to avoid overlapping tiles
  // Overlapping causes content to be drawn multiple times, creating ghosting/artifacts
  const xStep = Math.max(1, safeWindowWidth);
  const yStep = Math.max(1, safeWindowHeight);
  const xStops = generateAxisStops(maxX, xStep);
  const yStops = generateAxisStops(maxY, yStep);

  const estimatedTiles = xStops.length * yStops.length;
  if (estimatedTiles > MAX_CAPTURE_TILES) {
    console.warn(
      `[CaptureMath] Tile plan exceeds safe limit: ${estimatedTiles} > ${MAX_CAPTURE_TILES}. ` +
        `Consider reducing capture area or increasing viewport size.`
    );
  }

  const plan: Array<[number, number]> = [];
  yStops.forEach((y) => {
    xStops.forEach((x) => {
      plan.push([x, y]);
    });
  });
  return plan;
}
