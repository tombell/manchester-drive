import type { Gps } from './gps';
import type { MapData, Point } from '../game/map-types';
import type { Appearance } from '../game/garage';
import type { VisiblePlayer, Snapshot } from '../protocol/snapshots';
import type { Pedestrian, Pose, Position, Vehicle } from '../game/game-types';
import type { StreetObject } from '../game/streets';
import { gates, raceEntry } from '../game/race';
import { circuit, crosswalks, streetObjects, mapTree } from '../game/streets';
import { areas, width as seedWidth } from '../game/manchester-map';
import {
  boundary,
  chunkSize,
  mapChunk,
  namedStreets,
  overlapsTile,
  type MapChunk,
} from '../game/region';
import { jackets, models, skinTones } from '../game/garage';
import { signals } from '../game/world';

type Context = CanvasRenderingContext2D;
type Label = Pose & { name: string; oneway: number };
type Tile = Pick<MapData, 'roads' | 'paths' | 'areas' | 'buildings'> & {
  crosswalks: typeof crosswalks;
  labels: Label[];
};
type CarSprite = Omit<Vehicle, 'id' | 'speed'>;
type CharacterSprite = Pick<VisiblePlayer, 'x' | 'y' | 'angle' | 'speed' | 'jacket' | 'skin'>;

function rect(g: Context, x: number, y: number, w: number, h: number, color: string) {
  g.fillStyle = color;
  g.fillRect(Math.round(x), Math.round(y), w, h);
}
function label(
  g: Context,
  str: string,
  x: number,
  y: number,
  size: number,
  ink: string,
  align: CanvasTextAlign = 'center',
) {
  g.font = 'bold ' + size + 'px monospace';
  g.textAlign = align;
  g.fillStyle = ink;
  g.fillText(str, Math.round(x), Math.round(y));
}
function random(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
function tree(g: Context, x: number, y: number, scale: number) {
  g.save();
  g.translate(x, y - 11 * scale);
  g.scale(scale, scale);
  const R = (x: number, y: number, w: number, h: number, c: string) => rect(g, x, y, w, h, c);
  R(-6, 5, 19, 8, '#68735b');
  R(-2, 1, 4, 12, '#504b39');
  R(0, 2, 2, 9, '#876a47');
  R(-11, -7, 22, 12, '#334f42');
  R(-8, -12, 16, 21, '#334f42');
  R(-5, -15, 10, 23, '#47694c');
  R(-12, -6, 20, 9, '#47694c');
  R(-9, -11, 17, 15, '#5d8053');
  R(-5, -14, 10, 16, '#71915c');
  R(-10, -6, 9, 6, '#71915c');
  R(-6, -10, 5, 3, '#91a56d');
  R(2, -7, 4, 3, '#829c62');
  R(4, 0, 4, 3, '#426648');
  g.restore();
}
function drawStreetObject(g: Context, item: StreetObject, signal: string) {
  const { kind, x, y } = item;
  switch (kind) {
    case 'tree':
      tree(g, x, y, item.radius / 2);
      break;
    case 'signal':
      light(g, x - 1, y - 12, signal);
      break;
    case 'bench':
      rect(g, x - 5, y - 2, 10, 4, '#4c5045');
      rect(g, x - 5, y - 3, 10, 2, '#ab7d50');
      rect(g, x - 5, y, 10, 2, '#c19762');
      break;
    case 'bollard':
      rect(g, x - 1, y - 4, 3, 5, '#364341');
      rect(g, x - 1, y - 3, 3, 1, '#e9ce86');
      break;
    case 'busStop':
      rect(g, x - 1, y - 13, 2, 14, '#4c5250');
      rect(g, x - 2, y - 16, 8, 6, '#524a37');
      rect(g, x - 1, y - 15, 6, 4, '#f2c346');
      rect(g, x, y - 14, 4, 1, '#554e3e');
      break;
    case 'guidepost':
      rect(g, x - 1, y - 13, 2, 14, '#394640');
      rect(g, x - 6, y - 14, 7, 3, '#356058');
      rect(g, x, y - 10, 7, 3, '#356058');
      rect(g, x - 5, y - 13, 4, 1, '#e7ddbd');
      rect(g, x + 2, y - 9, 4, 1, '#e7ddbd');
      break;
    case 'bin':
      rect(g, x - 2, y - 4, 4, 6, '#40534d');
      rect(g, x - 2, y - 5, 4, 2, '#788177');
      rect(g, x - 1, y - 4, 2, 1, '#263532');
      break;
    case 'postBox':
      rect(g, x - 2, y - 7, 5, 9, '#a64436');
      rect(g, x - 3, y - 8, 6, 2, '#c75a43');
      rect(g, x - 1, y - 5, 3, 1, '#3f342f');
      rect(g, x - 2, y, 5, 2, '#45473d');
      break;
    case 'planter':
      rect(g, x - item.hx, y - item.hy, item.hx * 2, item.hy * 2, '#896b51');
      rect(g, x - 5, y - 4, 10, 2, '#aa8970');
      rect(g, x - 3, y - 6, 6, 4, '#507854');
      rect(g, x - 2, y - 7, 3, 2, '#86a36b');
      break;
  }
}
function outline(g: Context, points: Point[], closed = false) {
  g.moveTo(...points[0]);
  for (let i = 1; i < points.length; i++) g.lineTo(...points[i]);
  if (closed) g.closePath();
}
function line(g: Context, points: Point[], width: number, ink: string) {
  g.beginPath();
  outline(g, points);
  g.strokeStyle = ink;
  g.lineWidth = width;
  g.stroke();
}
function footprint(g: Context, building: MapData['buildings'][number], rng: () => number) {
  const { rings, name } = building;
  g.beginPath();
  for (const ring of rings) outline(g, ring, true);
  g.fillStyle = '#856650';
  g.fill('evenodd');
  g.lineWidth = 1.5;
  g.strokeStyle = '#584e46';
  g.stroke();
  g.save();
  g.clip('evenodd');
  // Keep the brick elevation and roof inside the collision outline.
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = ring[i],
        [ex, ey] = ring[(i + 1) % ring.length];
      const length = Math.hypot(ex - x, ey - y);
      for (let d = 5; d < length - 4; d += 12) {
        const wx = x + ((ex - x) * d) / length,
          wy = y + ((ey - y) * d) / length;
        rect(g, wx, wy - 5, 4, 4, '#394d4b');
        rect(g, wx, wy - 5, 2, 2, '#9ab0a9');
      }
    }
  }
  g.translate(0, -7);
  g.beginPath();
  for (const ring of rings) outline(g, ring, true);
  g.strokeStyle = '#cab29b';
  g.lineWidth = 3;
  g.stroke();
  g.clip('evenodd');
  // Align roof seams and skylights with the longest exterior wall.
  let angle = 0,
    longest = 0;
  for (let i = 0; i < rings[0].length; i++) {
    const [x, y] = rings[0][i],
      [ex, ey] = rings[0][(i + 1) % rings[0].length];
    const length = Math.hypot(ex - x, ey - y);
    if (length > longest) {
      longest = length;
      angle = Math.atan2(ey - y, ex - x);
    }
  }
  if (Math.cos(angle) < 0) angle += Math.PI;
  const ux = Math.cos(angle),
    uy = Math.sin(angle);
  const vertices = rings.flat();
  const xx = vertices.map(([x, y]) => x * ux + y * uy);
  const yy = vertices.map(([x, y]) => -x * uy + y * ux);
  const x = Math.min(...xx),
    y = Math.min(...yy);
  const w = Math.max(...xx) - x,
    h = Math.max(...yy) - y;
  g.rotate(angle);
  rect(
    g,
    x,
    y,
    w + 2,
    h + 2,
    ['#97897c', '#ad9583', '#99867c', '#a7907c', '#817e77'][Math.floor(rng() * 5)],
  );
  for (let row = y + 6; row < y + h; row += 12) {
    rect(g, x, row, w + 1, 1, '#5e554844');
    rect(g, x, row + 1, w + 1, 1, '#f2dbc533');
  }
  for (let row = y + 14; row < y + h - 10; row += 46) {
    for (let col = x + 14; col < x + w - 12; col += 47) {
      if (rng() > 0.45) continue;
      rect(g, col + 2, row + 3, 13, 8, '#645c55');
      rect(g, col, row, 13, 8, '#b9a28a');
      rect(g, col + 1, row + 1, 11, 5, '#52676b');
      rect(g, col + 2, row + 1, 4, 3, '#92a5a2');
    }
  }
  if (name && w > name.length * 5 + 12 && h > 30) {
    const mid = x + w / 2,
      base = y + h / 2;
    rect(g, mid - name.length * 2.5 - 3, base - 7, name.length * 5 + 6, 11, '#544c43');
    label(g, name.toUpperCase(), mid, base + 1, 8, '#ecddc2');
  }
  g.restore();
}

export function streetLabels(chunk: MapChunk) {
  // Place street names on their longest segment, with room between labels.
  const labels: Label[] = [];
  for (const road of namedStreets(chunk)) {
    let longest = 0,
      anchor: Pose | undefined;
    for (let i = 1; i < road.points.length; i++) {
      const [x, y] = road.points[i - 1],
        [ex, ey] = road.points[i];
      const len = Math.hypot(ex - x, ey - y);
      if (len > longest) {
        longest = len;
        anchor = { x: (x + ex) / 2, y: (y + ey) / 2, angle: Math.atan2(ey - y, ex - x) };
      }
    }
    if (!anchor || longest < road.name.length * 4 + 12) continue;
    if (
      labels.some(
        (p) => Math.hypot(anchor.x - p.x, anchor.y - p.y) < (p.name === road.name ? 200 : 65),
      )
    )
      continue;
    labels.push({ ...anchor, name: road.name, oneway: road.oneway });
  }
  return labels;
}

const tileSize = 720;
function terrainTile(left: number, top: number, tile: Tile, edge: Path2D) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = tileSize;
  const g = canvas.getContext('2d', { alpha: false })!,
    rng = random(418 + left + top * seedWidth);
  g.translate(-left, -top);
  rect(g, left, top, canvas.width, canvas.height, '#bfb39e');
  for (let y = top; y < top + canvas.height; y += 9) {
    for (let x = left - 12 + (y % 2) * 12; x < left + canvas.width; x += 24)
      rect(
        g,
        x,
        y,
        23,
        8,
        (Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663)) & 256 ? '#c3b7a2' : '#bbae99',
      );
  }
  const fills: Record<string, string> = {
    gardens: '#96a181',
    green: '#82966f',
    plaza: '#cbbdab',
    water: '#789a9c',
  };
  for (const kind of Object.keys(fills)) {
    for (const area of tile.areas.filter((a) => a.kind === kind)) {
      g.beginPath();
      outline(g, area.points, true);
      for (const hole of area.holes ?? []) outline(g, hole, true);
      g.fillStyle = fills[kind];
      g.fill('evenodd');
      if (kind !== 'plaza') {
        g.save();
        g.clip('evenodd');
        const xs = area.points.map(([x]) => x),
          ys = area.points.map(([, y]) => y);
        const x = Math.max(left, Math.min(...xs)),
          y = Math.max(top, Math.min(...ys));
        const w = Math.max(0, Math.min(left + canvas.width, Math.max(...xs)) - x);
        const h = Math.max(0, Math.min(top + canvas.height, Math.max(...ys)) - y);
        for (let i = 0; i < (w * h) / 80; i++) {
          rect(
            g,
            x + rng() * w,
            y + rng() * h,
            kind === 'water' ? 5 : 2,
            1,
            kind === 'water' ? '#a5c2ba' : '#647b533a',
          );
        }
        g.restore();
      }
    }
  }
  g.lineJoin = g.lineCap = 'round';
  for (const p of tile.paths) {
    if (p.kind !== 'tram') line(g, p.points, p.width, '#d2c6ae');
  }
  for (const layer of [...new Set(tile.roads.map((r) => r.layer))].sort((a, b) => a - b)) {
    const roads = tile.roads.filter((r) => r.layer === layer);
    for (const [extra, ink] of [
      [5, layer > 0 ? '#55524b' : '#a89983'],
      [3, '#e2d3b7'],
      [0, '#595e60'],
    ] as const) {
      for (const r of roads) {
        const restricted = r.access === 'no' || r.access === 'private';
        line(
          g,
          r.points,
          r.width + extra,
          extra === 0 && layer < 0 ? '#89847c' : extra === 0 && restricted ? '#786b64' : ink,
        );
      }
    }
    g.setLineDash([9, 15]);
    for (const r of roads) {
      const lanes = Math.min(12, r.lanes || (!r.oneway && r.width >= 30 ? 2 : 1));
      for (let lane = 1; lane < lanes; lane++) {
        const offset = (lane / lanes - 0.5) * r.width;
        const stripe = r.points.map(([x, y], i): Point => {
          const a = r.points[Math.max(0, i - 1)],
            b = r.points[Math.min(r.points.length - 1, i + 1)];
          const dx = b[0] - a[0],
            dy = b[1] - a[1],
            length = Math.hypot(dx, dy) || 1;
          return [x - (dy / length) * offset, y + (dx / length) * offset];
        });
        line(g, stripe, 1, '#c7bfa9');
      }
    }
    g.setLineDash([]);
  }
  for (const p of tile.paths.filter((p) => p.kind === 'tram')) {
    line(g, p.points, 7, '#7e7c74');
    line(g, p.points, 4, '#b8af9f');
  }
  for (const c of tile.crosswalks) {
    g.save();
    g.translate(c.x, c.y);
    g.rotate(c.angle);
    if (c.signal) {
      for (let y = -c.half + 1; y < c.half; y += 4)
        for (const x of [-5, 4]) rect(g, x, y, 1, 1, '#dedac9');
      rect(g, -15, -c.half, 1.5, c.half * 2, '#e4dec8');
    }
    g.restore();
  }
  for (const building of tile.buildings) {
    const [x, y] = building.rings[0][0];
    footprint(g, building, random(x + y * seedWidth));
  }
  for (const anchor of tile.labels) {
    g.save();
    g.translate(anchor.x, anchor.y);
    g.rotate(Math.cos(anchor.angle) < 0 ? anchor.angle + Math.PI : anchor.angle);
    g.strokeStyle = '#515758';
    g.lineWidth = 3;
    g.font = 'bold 7px monospace';
    g.textAlign = 'center';
    g.strokeText(anchor.name.toUpperCase(), 0, 2);
    label(g, anchor.name.toUpperCase(), 0, 2, 7, '#ebe2cf');
    if (anchor.oneway) {
      const direction = anchor.oneway * (Math.cos(anchor.angle) < 0 ? -1 : 1);
      g.scale(direction, 1);
      const tip = g.measureText(anchor.name.toUpperCase()).width / 2 + 9;
      line(
        g,
        [
          [tip - 5, 0],
          [tip, 0],
          [tip - 2, -2],
        ],
        1.3,
        '#ebe2cf',
      );
      line(
        g,
        [
          [tip, 0],
          [tip - 2, 2],
        ],
        1.3,
        '#ebe2cf',
      );
    }
    g.restore();
  }
  label(g, 'PICCADILLY GARDENS', gardenLabel.x, gardenLabel.y, 10, '#495b47');
  const outside = new Path2D(edge);
  outside.rect(left, top, tileSize, tileSize);
  g.fillStyle = '#464e49';
  g.fill(outside, 'evenodd');
  g.strokeStyle = '#b4aa8f';
  g.lineWidth = 3;
  g.stroke(edge);
  return canvas;
}

// Render the visible part of the city at full pixel-art resolution. A footprint
// or label straddling a tile edge is drawn in both tiles in world coordinates.
const gardenPoints = areas.find((area) => area.kind === 'gardens')!.points;
const gardenLabel = {
  x: gardenPoints.reduce((sum, p) => sum + p[0], 0) / gardenPoints.length,
  y: gardenPoints.reduce((sum, p) => sum + p[1], 0) / gardenPoints.length,
};
function makeTerrain() {
  const cache = new Map<string, HTMLCanvasElement>();
  const labels = new WeakMap<MapChunk, Label[]>();
  const edge = new Path2D();
  boundary.forEach(([x, y], i) => (i ? edge.lineTo(x, y) : edge.moveTo(x, y)));
  edge.closePath();

  function renderTile(left: number, top: number, chunk: MapChunk) {
    let names = labels.get(chunk);
    if (!names) {
      names = streetLabels(chunk);
      labels.set(chunk, names);
    }
    const visible = (points: Point[], pad: number) =>
      overlapsTile(points, left, top, tileSize, pad);
    return terrainTile(
      left,
      top,
      {
        roads: chunk.roads.filter((r) => visible(r.points, r.width / 2 + 5)),
        paths: chunk.paths.filter((p) => visible(p.points, p.width / 2 + 1)),
        areas: chunk.areas.filter((a) => visible(a.points, 1)),
        buildings: chunk.buildings.filter((b) => visible(b.rings[0], 3)),
        crosswalks,
        labels: names.filter((l) => visible([[l.x, l.y]], l.name.length * 3 + 12)),
      },
      edge,
    );
  }
  return (g: Context, left: number, top: number, width: number, height: number) => {
    const x0 = Math.floor(left / tileSize),
      x1 = Math.floor((left + width - 1) / tileSize);
    const y0 = Math.floor(top / tileSize),
      y1 = Math.floor((top + height - 1) / tileSize);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const key = x + ',' + y;
        let canvas = cache.get(key);
        if (!canvas) {
          const left = x * tileSize,
            top = y * tileSize;
          const chunk = mapChunk(left, top);
          if (!chunk) {
            rect(g, left, top, tileSize, tileSize, '#bfb39e');
            continue;
          }
          canvas = renderTile(left, top, chunk);
        }
        cache.delete(key);
        cache.set(key, canvas);
        g.drawImage(canvas, x * tileSize, y * tileSize);
      }
    const limit = Math.max(12, (x1 - x0 + 1) * (y1 - y0 + 1));
    while (cache.size > limit) {
      const key = cache.keys().next().value!;
      cache.get(key)!.width = 0;
      cache.delete(key);
    }
  };
}

function car(g: Context, v: CarSprite, local: boolean, time: number) {
  g.save();
  g.translate(Math.round(v.x), Math.round(v.y));
  g.rotate(v.angle);
  const model = models[v.model ?? 'hatch'];
  g.scale(model.length / 9.5, model.width / 4.8);
  const R = (x: number, y: number, w: number, h: number, c: string) => rect(g, x, y, w, h, c);
  R(-8, -4, 19, 11, '#2b333272');
  R(-8, -5, 16, 10, '#2c3736');
  R(-6, -6, 4, 2, '#293432');
  R(4, -6, 4, 2, '#293432');
  R(-6, 4, 4, 2, '#293432');
  R(4, 4, 4, 2, '#293432');
  R(-9, -4, 18, 8, v.color);
  R(-7, -5, 14, 10, v.color);
  R(-5, -4, 10, 8, '#354b50');
  R(-4, -3, 2, 6, '#79959a');
  R(2, -3, 2, 6, '#a1b8b5');
  R(-2, -4, 4, 8, v.color);
  R(-2, -4, 4, 1, '#ffffff66');
  R(5, -3, 3, 1, '#ffffff66');
  if (v.model === 'van') {
    R(-8, -4, 12, 8, v.color);
    R(-7, -3, 9, 1, '#ffffff55');
    R(-7, 2, 9, 1, '#00000030');
    R(3, -3, 2, 6, '#8ba4a2');
  } else if (v.model === 'coupe') {
    R(-5, -3, 5, 6, '#31484d');
    R(-4, -2, 3, 4, '#647e82');
    R(3, -1, 5, 2, '#efdbb3');
    R(-8, -5, 2, 10, '#303b3a');
  }
  R(8, -4, 1, 2, '#ffe8ab');
  R(8, 2, 1, 2, '#ffe8ab');
  for (const y of [-3, 2]) {
    if (v.rearLights === 'brake' || v.rearLights === 'reverse') {
      const reverse = v.rearLights === 'reverse';
      R(-12, y - 1, 4, 4, reverse ? '#e4f4ff55' : '#ff352b66');
      R(-10, y, 3, 2, reverse ? '#f4fcff' : '#ff493b');
    } else {
      R(-9, y, 1, 2, '#ab493e');
    }
  }
  R(-9, -1, 1, 2, '#efc26d');
  if (v.indicating && Math.floor(time * 3) % 2 === 0) {
    R(7, -5, 3, 2, '#ffd24a');
    R(-9, -5, 3, 2, '#ffd24a');
  }
  if (local) {
    R(-6, -8, 11, 1, '#d0f4d0');
    R(-6, 7, 11, 1, '#d0f4d0');
  }
  g.restore();
}
function character(g: Context, player: CharacterSprite, time: number) {
  g.save();
  g.translate(Math.round(player.x), Math.round(player.y));
  g.rotate(player.angle);
  const stride = player.speed > 1 ? Math.sin(time * 13) * 2 : 0;
  rect(g, -3 + stride, -2, 3, 2, '#29363a');
  rect(g, -3 - stride, 1, 3, 2, '#29363a');
  rect(g, -2, -3, 4, 6, jackets[player.jacket]);
  rect(g, -1 - stride, -4, 3, 2, jackets[player.jacket]);
  rect(g, -1 + stride, 2, 3, 2, jackets[player.jacket]);
  rect(g, 1, -2, 3, 4, skinTones[player.skin]);
  rect(g, -1, -2, 3, 4, '#453b35');
  g.restore();
}
function pedestrian(g: Context, p: Pedestrian) {
  const stride = Math.floor((p.x + p.y) / 3) % 2;
  rect(g, p.x - 2, p.y + 2, 6, 2, '#727468');
  rect(g, p.x - 2, p.y, 1, 3 - stride, '#3e4743');
  rect(g, p.x + 1, p.y, 1, 2 + stride, '#3e4743');
  rect(g, p.x - 2, p.y - 3, 4, 4, p.color);
  rect(g, p.x - 1, p.y - 5, 3, 3, '#b88b68');
  rect(g, p.x - 1, p.y - 6, 3, 2, '#55483e');
}
export function drawGarage(canvas: HTMLCanvasElement, style: Appearance) {
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.save();
  g.scale(3, 3);
  car(g, { ...style, x: 15, y: 8, angle: 0, color: '#51ccc2' }, false, 0);
  character(g, { ...style, x: 35, y: 8, angle: 0, speed: 0 }, 0);
  g.restore();
}

function drawGate(
  g: Context,
  gate: (typeof gates)[number],
  viewX: number,
  viewY: number,
  width: number,
  height: number,
) {
  g.save();
  g.translate(gate.x, gate.y);
  g.rotate(Math.atan2(gate.dy, gate.dx));
  const finish = gate === gates.at(-1);
  for (let row = 0; row < 2; row++) {
    const count = Math.ceil((gate.halfWidth * 2) / 3);
    for (let n = 0; n < count; n++) {
      const ink = (n + row) % 2 ? '#27352e' : finish ? '#fff8de' : '#ffcc65';
      rect(g, row * 3 - 3, n * 3 - gate.halfWidth, 3, Math.min(3, gate.halfWidth * 2 - n * 3), ink);
    }
  }
  g.restore();
  // Keep a direction marker in view when the next gate is beyond the camera.
  const cx = viewX + width / 2,
    cy = viewY + height / 2;
  const dx = gate.x - cx,
    dy = gate.y - cy;
  const scale = Math.min(
    1,
    (width / 2 - 12) / (Math.abs(dx) || 1),
    (height / 2 - 12) / (Math.abs(dy) || 1),
  );
  g.save();
  g.translate(Math.round(cx + dx * scale), Math.round(cy + dy * scale));
  g.rotate(scale < 1 ? Math.atan2(dy, dx) : Math.atan2(gate.dy, gate.dx));
  rect(g, -7, -7, 14, 14, '#283730');
  rect(g, -4, -1, 8, 3, '#ffcc65');
  for (let i = 0; i < 4; i++) rect(g, i, -4 + i, 1, 9 - 2 * i, '#ffcc65');
  g.restore();
}
function light(g: Context, x: number, y: number, state: string) {
  rect(g, x + 1, y + 1, 3, 13, '#666c60');
  rect(g, x, y - 1, 2, 14, '#3e4841');
  rect(g, x - 2, y - 6, 6, 12, '#313a36');
  for (const [i, s, c] of [
    [0, 'red', '#f07b66'],
    [1, 'amber', '#f2c56a'],
    [2, 'green', '#83d4a3'],
  ] as const)
    rect(g, x, y - 4 + i * 3, 2, 2, state === s ? c : '#575b4f');
}

export function viewport(canvas: HTMLCanvasElement) {
  return {
    width: Math.ceil(canvas.clientWidth / 1.7),
    height: Math.ceil(canvas.clientHeight / 1.7),
  };
}

export function makeRenderer(canvas: HTMLCanvasElement) {
  const paintTerrain = makeTerrain(),
    g = canvas.getContext('2d', { alpha: false })!;
  const buffer = document.createElement('canvas'),
    b = buffer.getContext('2d', { alpha: false })!;
  let routePath = new Path2D(), lastRoute: Gps['route'] | undefined, lastIndex = -1;
  return (world: Snapshot, me: string | undefined, focus: Position, gps?: Gps) => {
    const w = canvas.clientWidth,
      h = canvas.clientHeight,
      dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const { width: vw, height: vh } = viewport(canvas);
    if (buffer.width !== vw || buffer.height !== vh) {
      buffer.width = vw;
      buffer.height = vh;
    }
    const x = Math.round(focus.x - vw / 2);
    const y = Math.round(focus.y - vh / 2);
    b.setTransform(1, 0, 0, 1, -x, -y);
    paintTerrain(b, x, y, vw, vh);
    if (gps?.route.length && !gps.arrived) {
      if (gps.route !== lastRoute || gps.index !== lastIndex) {
        lastRoute = gps.route;
        lastIndex = gps.index;
        routePath = new Path2D();
        routePath.moveTo(lastRoute[lastIndex].x, lastRoute[lastIndex].y);
        for (let i = lastIndex + 1; i < lastRoute.length; i++) routePath.lineTo(lastRoute[i].x, lastRoute[i].y);
      }
      b.save();
      b.lineJoin = b.lineCap = 'round';
      b.strokeStyle = '#195a70';
      b.lineWidth = 6;
      b.stroke(routePath);
      b.strokeStyle = '#53d9ff';
      b.lineWidth = 3;
      b.stroke(routePath);
      b.restore();
    }
    const entry = raceEntry(world.race, me);
    if (entry && !entry.withdrawn && entry.elapsed === null && world.race?.phase !== 'open') {
      b.save();
      b.setLineDash([5, 12]);
      line(b, [...circuit.points, circuit.points[0]], 1.5, '#efc66b');
      b.restore();
      drawGate(b, gates[entry.next], x, y, vw, vh);
    }
    // Draw by ground position so people and cars can pass behind tree crowns and signs.
    const margin = 32; // Includes the tallest tree crown outside the viewport.
    const visible = (o: Position) =>
      o.x >= x - margin && o.x <= x + vw + margin && o.y >= y - margin && o.y <= y + vh + margin;
    const scene: (StreetObject | Vehicle | Pedestrian | VisiblePlayer)[] =
      streetObjects.filter(visible);
    // Chunks include a margin. Draw each regional trunk from its owning chunk once.
    for (let i = Math.floor((x - margin) / chunkSize); i <= (x + vw + margin) / chunkSize; i++) {
      for (let j = Math.floor((y - margin) / chunkSize); j <= (y + vh + margin) / chunkSize; j++) {
        const chunk = mapChunk(i * chunkSize, j * chunkSize);
        for (const p of chunk?.trees ?? []) {
          if (
            Math.floor(p[0] / chunkSize) === i &&
            Math.floor(p[1] / chunkSize) === j &&
            p[0] >= x - margin &&
            p[0] <= x + vw + margin &&
            p[1] >= y - margin &&
            p[1] <= y + vh + margin
          )
            scene.push(mapTree(p));
        }
      }
    }
    for (const actors of [world.traffic, world.people, world.players, world.parkedCars]) {
      for (const actor of actors) if (visible(actor)) scene.push(actor);
    }
    scene.sort((a, b) => a.y - b.y);
    const signal = signals(world.time).vertical;
    for (const item of scene) {
      if ('kind' in item) drawStreetObject(b, item, signal);
      else if ('parkedCarId' in item && item.parkedCarId) character(b, item, world.time);
      else if ('route' in item) pedestrian(b, item);
      else car(b, item, item.id === me, world.time);
    }
    for (const v of world.players) {
      if (!visible(v)) continue;
      const str = v.id === me ? 'YOU' : v.name;
      b.font = 'bold 7px monospace';
      const lw = Math.ceil(b.measureText(str).width) + 6;
      rect(b, v.x - lw / 2, v.y - 20, lw, 10, '#283730');
      label(b, str, v.x, v.y - 13, 7, v.id === me ? '#c6ebac' : '#fff0d4');
    }
    g.imageSmoothingEnabled = false;
    g.drawImage(buffer, 0, 0, canvas.width, canvas.height);
    return { x, y, width: vw, height: vh };
  };
}
