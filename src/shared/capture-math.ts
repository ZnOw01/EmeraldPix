export function safeMax(values: number[]): number {
  const filtered = values.filter((value) => Number.isFinite(value));
  return filtered.length ? Math.max(...filtered) : 0;
}

export function generateAxisStops(maxPosition: number, step: number): number[] {
  const positions: number[] = [];
  const safeMaxPosition = Math.max(0, Math.floor(maxPosition));
  const safeStep = Math.max(1, Math.floor(step));

  for (let position = 0; position <= safeMaxPosition; position += safeStep) {
    positions.push(position);
  }

  if (!positions.length || positions[positions.length - 1] !== safeMaxPosition) {
    positions.push(safeMaxPosition);
  }

  return positions;
}

export function buildCapturePlan(
  totalWidth: number,
  totalHeight: number,
  windowWidth: number,
  windowHeight: number,
  scrollPad: number
): Array<[number, number]> {
  const maxX = Math.max(0, totalWidth - windowWidth);
  const maxY = Math.max(0, totalHeight - windowHeight);
  const xStep = Math.max(1, windowWidth);
  const yStep = Math.max(1, windowHeight - Math.min(scrollPad, Math.max(0, windowHeight - 1)));
  const xStops = generateAxisStops(maxX, xStep);
  const yStops = generateAxisStops(maxY, yStep);

  const plan: Array<[number, number]> = [];
  yStops.forEach((y) => {
    xStops.forEach((x) => {
      plan.push([x, y]);
    });
  });
  return plan;
}
