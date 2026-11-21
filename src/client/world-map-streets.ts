import type { Position } from '../game/game-types';
import { boundary, chunkSize, mapChunk, type MapChunk } from '../game/region';
import { streetLabels } from './renderer';

export type MapView = Position & { scale: number };

// Neighbouring chunks contain overlapping geometry. Clip each one to its own square.
function streetDrawing(chunk: MapChunk) {
  const lines = new Map<number, Path2D>();
  for (const road of [...chunk.roads, ...chunk.paths.filter((p) => p.name)]) {
    const width = road.width;
    let line = lines.get(width);
    if (!line) {
      line = new Path2D();
      lines.set(width, line);
    }
    road.points.forEach(([x, y], i) => i ? line.lineTo(x, y) : line.moveTo(x, y));
  }
  return { lines, labels: streetLabels(chunk) };
}

export function makeWorldMapStreets(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  const drawings = new WeakMap<MapChunk, ReturnType<typeof streetDrawing>>();
  const edge = new Path2D();
  boundary.forEach(([x, y], i) => i ? edge.lineTo(x, y) : edge.moveTo(x, y));
  edge.closePath();
  let lastView = '', retry = 0;

  function clear() {
    window.clearTimeout(retry);
    lastView = '';
    canvas.hidden = true;
  }

  function draw(view: MapView, width: number, height: number) {
    const { x, y, scale } = view;
    // At most five rows and five columns, including partially visible edge tiles.
    if (Math.max(width, height) / scale > 4 * chunkSize) {
      if (!canvas.hidden) clear();
      return;
    }
    canvas.hidden = false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const key = [x, y, scale, width, height, dpr].join(',');
    if (lastView === key) return;
    lastView = key;
    window.clearTimeout(retry);
    if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
    if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, -x * dpr * scale, -y * dpr * scale);
    ctx.clip(edge);
    ctx.strokeStyle = '#a7ac97';
    ctx.lineJoin = ctx.lineCap = 'round';
    const labels: ReturnType<typeof streetLabels> = [];
    let pending = false;
    for (let row = Math.floor(y / chunkSize); row < Math.ceil((y + height / scale) / chunkSize); row++) {
      for (let col = Math.floor(x / chunkSize); col < Math.ceil((x + width / scale) / chunkSize); col++) {
        const left = col * chunkSize, top = row * chunkSize;
        const chunk = mapChunk(left, top);
        if (!chunk) {
          pending = true;
          continue;
        }
        let drawing = drawings.get(chunk);
        if (!drawing) {
          drawing = streetDrawing(chunk);
          drawings.set(chunk, drawing);
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, chunkSize, chunkSize);
        ctx.clip();
        for (const [roadWidth, line] of drawing.lines) {
          ctx.lineWidth = Math.max(1 / scale, roadWidth);
          ctx.stroke(line);
        }
        ctx.restore();
        labels.push(...drawing.labels);
      }
    }

    // Lay out names in screen pixels, including across chunk seams.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#344037';
    ctx.fillStyle = '#faf8e9';
    ctx.lineWidth = 3;
    const placed: { x: number; y: number; half: number }[] = [];
    for (const label of labels) {
      const px = (label.x - x) * scale, py = (label.y - y) * scale;
      if (px < 0 || py < 0 || px > width || py > height) continue;
      const half = ctx.measureText(label.name).width / 2 + 4;
      if (placed.some((p) => Math.abs(px - p.x) < half + p.half && Math.abs(py - p.y) < 17)) continue;
      ctx.strokeText(label.name, px, py);
      ctx.fillText(label.name, px, py);
      placed.push({ x: px, y: py, half });
    }
    ctx.restore();

    if (pending) retry = window.setTimeout(() => {
      lastView = '';
      draw(view, width, height);
    }, 200);
  }
  return { draw, clear };
}
