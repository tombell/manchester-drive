import type { Player, Position, Racer, TrafficCar, Vehicle, World } from './game-types';
import { SpatialGrid } from './spatial';
import type { GarageOptions } from './garage';

// World coordinates are pixels, heading is measured clockwise from east.
import {
  mapTree,
  circuits,
  circuit,
  crosswalks,
  faradayMerge,
  gridDistance,
  startingPositions,
  streetObjects,
} from './streets';
import {
  boundary,
  clampToM60,
  closestBoundaryPoint,
  insideM60,
  mapChunk,
  pointInRing,
  type MapChunk,
} from './region';
import type { Point } from './map-types';
import { walking_paths as walkingPaths } from './manchester-map';
import { checkGate, heldOnGrid, withdraw } from './race';
import { appearance, models } from './garage';
export { WIDTH, HEIGHT, JUNCTION, signalPosts } from './streets';
export const COLORS = [
  '#51ccc2',
  '#f2ba52',
  '#ef8264',
  '#8ba9e4',
  '#c188bf',
  '#b0c981',
  '#ddd8be',
  '#e596b3',
];
export function signals(time: number) {
  const t = time % 24;
  const horizontal = t < 7 ? 'green' : t < 9 ? 'amber' : 'red';
  const vertical = t >= 10 && t < 17 ? 'green' : t >= 17 && t < 19 ? 'amber' : 'red';
  return { horizontal, vertical, walk: t >= 20 && t < 20.8 };
}

function box(x: number, y: number, angle: number, hx: number, hy: number) {
  return { x, y, ux: Math.cos(angle), uy: Math.sin(angle), hx, hy };
}
function vehicleBox(v: Vehicle) {
  const model = models[v.model ?? 'hatch'];
  return box(v.x, v.y, v.angle, model.length, model.width);
}
function personBox(p: Position) {
  return box(p.x, p.y, 0, 2.2, 2.2);
}
// Index building edges and street objects once for both prediction and the server.
type Box = ReturnType<typeof box>;
type Circle = Position & { radius: number };
type PersonBody = Position & { id?: string };
type Walker = PersonBody & { angle?: number; speed?: number };
interface Hit {
  nx: number;
  ny: number;
  other?: Vehicle;
  person?: PersonBody;
}
type Cells = Map<string, (Box | Circle)[]>;
const fixtures: Cells = new Map();
type WaterSurface = { rings: Point[][]; minX: number; minY: number; maxX: number; maxY: number };
const chunkWalls = new WeakMap<MapChunk, ReturnType<typeof indexChunk>>();
const cellKey = (x: number, y: number) => x + ',' + y;
function indexSolid(cells: Cells, solid: Box | Circle) {
  // Expand by the largest vehicle's corner radius so each mover only queries one cell.
  const rx = ('radius' in solid ? solid.radius : radius(solid, 1, 0)) + 13,
    ry = ('radius' in solid ? solid.radius : radius(solid, 0, 1)) + 13;
  for (let cx = Math.floor((solid.x - rx) / 64); cx <= (solid.x + rx) / 64; cx++) {
    for (let cy = Math.floor((solid.y - ry) / 64); cy <= (solid.y + ry) / 64; cy++) {
      const key = cellKey(cx, cy);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key)!.push(solid);
    }
  }
}
function indexRing(cells: Cells, ring: Point[]) {
  for (let i = 0; i < ring.length; i++) {
    const [x, y] = ring[i],
      [ex, ey] = ring[(i + 1) % ring.length];
    const length = Math.hypot(ex - x, ey - y);
    if (length)
      indexSolid(
        cells,
        box((x + ex) / 2, (y + ey) / 2, Math.atan2(ey - y, ex - x), length / 2, 0.35),
      );
  }
}
indexRing(fixtures, boundary);
for (const item of streetObjects) {
  indexSolid(fixtures, 'radius' in item ? item : box(item.x, item.y, 0, item.hx, item.hy));
}
function indexChunk(chunk: MapChunk) {
  const solids: Cells = new Map(),
    banks: Cells = new Map(),
    water: WaterSurface[] = [];
  for (const building of chunk.buildings)
    for (const ring of building.rings) indexRing(solids, ring);
  for (const tree of chunk.trees) indexSolid(solids, mapTree(tree));
  for (const area of chunk.areas) {
    if (area.kind !== 'water') continue;
    const rings = [area.points, ...(area.holes ?? [])];
    for (const ring of rings) indexRing(banks, ring);
    const xs = area.points.map(([x]) => x),
      ys = area.points.map(([, y]) => y);
    water.push({
      rings,
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    });
  }
  return { solids, banks, water };
}
function insidePolygon(x: number, y: number, rings: Point[][]) {
  return pointInRing(x, y, rings[0]) && !rings.some((ring, i) => i > 0 && pointInRing(x, y, ring));
}
function wallContact(body: Box, vehicle = false) {
  const chunk = mapChunk(body.x, body.y);
  // Hold predicted vehicles at a chunk seam until its collision geometry arrives.
  if (vehicle && !chunk) return { nx: 0, ny: 0 };
  const key = cellKey(Math.floor(body.x / 64), Math.floor(body.y / 64));
  let walls = chunk && chunkWalls.get(chunk);
  if (chunk && !walls) {
    walls = indexChunk(chunk);
    chunkWalls.set(chunk, walls);
  }
  for (const cell of [
    fixtures.get(key),
    walls?.solids.get(key),
    vehicle ? walls?.banks.get(key) : undefined,
  ]) {
    if (!cell) continue;
    for (const wall of cell) {
      const hit = 'radius' in wall ? roundContact(body, wall) : contact(body, wall);
      if (hit) return hit;
    }
  }
  // The edge tests handle bumper and side impacts. Also reject a placement
  // wholly within a water polygon, including ones larger than a map chunk.
  if (vehicle && walls) {
    for (const { rings, minX, minY, maxX, maxY } of walls.water) {
      if (body.x < minX || body.x > maxX || body.y < minY || body.y > maxY) continue;
      if (!insidePolygon(body.x, body.y, rings)) continue;
      const bank = closestBoundaryPoint(body.x, body.y, rings);
      const dx = body.x - bank.x,
        dy = body.y - bank.y,
        length = Math.hypot(dx, dy) || 1;
      return { nx: dx / length, ny: dy / length };
    }
  }
  return null;
}
function roundContact(body: Box, post: Circle) {
  // Closest point on the moving box, in its own forward/sideways coordinates.
  const dx = post.x - body.x,
    dy = post.y - body.y;
  const forward = dx * body.ux + dy * body.uy;
  const side = -dx * body.uy + dy * body.ux;
  let nx = forward - Math.max(-body.hx, Math.min(body.hx, forward));
  let ny = side - Math.max(-body.hy, Math.min(body.hy, side));
  const distance = Math.hypot(nx, ny);
  if (distance >= post.radius) return null;
  if (distance > 0) {
    nx /= distance;
    ny /= distance;
  } else if (body.hx - Math.abs(forward) < body.hy - Math.abs(side)) {
    nx = forward < 0 ? -1 : 1;
  } else {
    ny = side < 0 ? -1 : 1;
  }
  return { nx: nx * body.ux - ny * body.uy, ny: nx * body.uy + ny * body.ux };
}
function radius(b: Box, x: number, y: number) {
  return Math.abs(x * b.ux + y * b.uy) * b.hx + Math.abs(y * b.ux - x * b.uy) * b.hy;
}
// The shallowest separating axis gives the direction of a contact impulse.
function contact(a: Box, b: Box) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  let minimum = Infinity,
    nx = 0,
    ny = 0;
  for (const [x, y] of [
    [a.ux, a.uy],
    [-a.uy, a.ux],
    [b.ux, b.uy],
    [-b.uy, b.ux],
  ]) {
    const side = dx * x + dy * y;
    const depth = radius(a, x, y) + radius(b, x, y) - Math.abs(side);
    if (depth <= 0) return null;
    if (depth < minimum) {
      minimum = depth;
      const sign = side < 0 ? -1 : 1;
      nx = x * sign;
      ny = y * sign;
    }
  }
  return { nx, ny };
}
function overlap(a: Box, b: Box) {
  return contact(a, b) !== null;
}
function obstacle(
  v: PersonBody,
  vehicles: Vehicle[],
  people: PersonBody[],
  body: Box,
  vehicle = false,
): Hit | null {
  if (!insideM60(v.x, v.y)) {
    const closest = clampToM60(v.x, v.y);
    const dx = v.x - closest.x,
      dy = v.y - closest.y,
      d = Math.hypot(dx, dy) || 1;
    return { nx: dx / d, ny: dy / d };
  }
  const wall = wallContact(body, vehicle);
  if (wall) return wall;
  for (const other of vehicles) {
    if (other.id === v.id) continue;
    const hit = contact(body, vehicleBox(other));
    if (hit) return other.parked ? hit : { ...hit, other };
  }
  for (const person of people) {
    if (person.id === v.id && v.id !== undefined) continue;
    const hit = contact(body, personBox(person));
    if (hit) return { ...hit, person };
  }
  return null;
}
function vehicleObstacle(car: Vehicle, vehicles: Vehicle[], people: PersonBody[]) {
  return obstacle(car, vehicles, people, vehicleBox(car), true);
}
function velocity(car: Vehicle) {
  return {
    x: car.speed * Math.cos(car.angle) + (car.slideX || 0),
    y: car.speed * Math.sin(car.angle) + (car.slideY || 0),
  };
}
function setVelocity(car: Vehicle, x: number, y: number) {
  // Tyres regain grip after a sideways hit. NPC route control resumes after the shove.
  const ux = Math.cos(car.angle),
    uy = Math.sin(car.angle);
  car.speed = !('lane' in car) ? x * ux + y * uy : 0;
  car.slideX = x - car.speed * ux;
  car.slideY = y - car.speed * uy;
}
function dampSlide(car: Vehicle, dt: number) {
  if (!car.slideX && !car.slideY) return;
  const grip = Math.exp(-3.2 * dt);
  car.slideX = (car.slideX ?? 0) * grip;
  car.slideY = (car.slideY ?? 0) * grip;
  if (Math.hypot(car.slideX, car.slideY) < 0.08) car.slideX = car.slideY = 0;
}
function moveCar<T extends Vehicle>(
  car: T,
  next: T,
  dt: number,
  vehicles: Vehicle[],
  people: PersonBody[],
  transferImpulse: boolean,
) {
  const hit = vehicleObstacle(next, vehicles, people);
  if (!hit) {
    Object.assign(car, next);
    return;
  }
  if (hit.person) {
    setVelocity(car, 0, 0);
    if ('lane' in car) car.rearLights = 'brake';
    return;
  }

  const vx = (next.x - car.x) / dt,
    vy = (next.y - car.y) / dt;
  const target = hit.other ? velocity(hit.other) : { x: 0, y: 0 };
  const closing = (vx - target.x) * hit.nx + (vy - target.y) * hit.ny;
  if (closing <= 0) {
    car.speed = next.speed;
    return;
  }
  // Equal-mass vehicles share the impulse. Masonry absorbs it without moving.
  const restitution = closing > 10 ? 0.24 : 0;
  const impulse = (closing * (1 + restitution)) / (hit.other ? 2 : 1);
  const ix = impulse * hit.nx,
    iy = impulse * hit.ny;
  if (hit.other && transferImpulse) setVelocity(hit.other, target.x + ix, target.y + iy);
  const grip = hit.other ? 1 : 0.88;
  const outX = (vx - ix) * grip,
    outY = (vy - iy) * grip;
  setVelocity(car, outX, outY);
  const slide = { ...car, x: car.x + outX * dt, y: car.y + outY * dt };
  if (!vehicleObstacle(slide, vehicles, people)) Object.assign(car, slide);
}

// A walking player still owns exactly one parked vehicle. Keeping it on the player
// also removes both from the room together on leave or disconnect.
export function roadUsers(world: World) {
  return {
    vehicles: [...world.traffic, ...world.players.map((p) => p.parkedCar ?? p)],
    people: [...world.people, ...world.players.filter((p) => p.parkedCar)],
  };
}

export function walk(
  player: Walker,
  keys: number,
  dt: number,
  vehicles: Vehicle[],
  people: PersonBody[],
) {
  if (dt <= 0) return;
  const dx = Number(!!(keys & 8)) - Number(!!(keys & 4));
  const dy = Number(!!(keys & 2)) - Number(!!(keys & 1));
  player.speed = 0;
  if (!dx && !dy) return;
  player.angle = Math.atan2(dy, dx);
  const distance = (39 * dt) / Math.hypot(dx, dy);
  const oldX = player.x,
    oldY = player.y;
  // Try each axis separately so the walker slides along an obstructed edge.
  for (const [x, y] of [
    [dx * distance, 0],
    [0, dy * distance],
  ]) {
    const next = { ...player, x: player.x + x, y: player.y + y };
    if (!obstacle(next, vehicles, people, personBox(next))) {
      player.x = next.x;
      player.y = next.y;
    }
  }
  player.speed = Math.hypot(player.x - oldX, player.y - oldY) / dt;
}

export function useCar(world: World, player: Player, action: 'enter' | 'exit') {
  const parked = player.parkedCar;
  if (action !== (parked ? 'enter' : 'exit')) return 'Your position has changed.';
  if (
    !parked &&
    (Math.abs(player.speed) > 2 || Math.hypot(player.slideX || 0, player.slideY || 0) > 2)
  )
    return 'Stop the car before getting out.';
  const car = parked ?? player;
  const { vehicles, people } = roadUsers(world);
  const others = vehicles.filter((v) => v.id !== car.id);
  const offset = vehicleBox(car).hy + 5;
  for (const side of [1, -1]) {
    const door = {
      id: player.id,
      x: car.x - side * Math.sin(car.angle) * offset,
      y: car.y + side * Math.cos(car.angle) * offset,
    };
    if (parked && Math.hypot(player.x - door.x, player.y - door.y) > 12) continue;
    // Sweep between the actor and the seat so a wall, post or another player
    // between them also blocks the interaction.
    const start = parked ? player : car,
      end = parked ? car : door;
    const steps = Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / 2));
    let clear = true;
    for (let i = 1; i <= steps; i++) {
      const p = {
        id: player.id,
        x: start.x + ((end.x - start.x) * i) / steps,
        y: start.y + ((end.y - start.y) * i) / steps,
      };
      if (obstacle(p, others, people, personBox(p))) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;
    if (parked) {
      Object.assign(player, { x: car.x, y: car.y, angle: car.angle, parkedCar: null });
    } else {
      withdraw(world, player.id);
      player.parkedCar = {
        id: 'parked-' + player.id,
        parked: true,
        x: car.x,
        y: car.y,
        angle: car.angle,
        model: car.model,
        color: car.color,
        speed: 0,
        rearLights: 'tail',
      };
      player.x = door.x;
      player.y = door.y;
    }
    player.speed = player.slideX = player.slideY = 0;
    player.rearLights = 'tail';
    return;
  }
  return parked
    ? 'Walk up beside your parked car.'
    : 'Both doors are blocked. Move the car and try again.';
}
export function findRaceGrid(world: World, racers: Racer[]) {
  const { vehicles, people } = roadUsers(world);
  const traffic = vehicles.filter((v) => !racers.some((r) => r.id === v.id));
  const drivers = racers.map((r) => world.players.find((p) => p.id === r.id)!);
  for (const gap of [6, 30, 54, 78]) {
    const slots = [gap, gap + 24].map((back) => circuit.pose(gridDistance - back));
    const cars = slots.map((slot, i) => ({ ...drivers[i], ...slot }));
    if (cars.every((car) => !vehicleObstacle(car, [...traffic, ...cars], people))) return slots;
  }
  return null;
}

export function placePlayer(
  id: string,
  name: string,
  color: string,
  world: World,
  options?: GarageOptions,
  positions: Iterable<number[]> = startingPositions(),
): Player | null {
  const { vehicles, people } = roadUsers(world);
  const style = appearance(options);
  for (const [x, y, angle] of positions) {
    const v: Player = {
      id,
      name,
      color,
      ...style,
      parkedCar: null,
      x,
      y,
      angle,
      speed: 0,
      rearLights: 'tail',
    };
    if (vehicleObstacle(v, vehicles, people)) continue;
    // A road can pass through a building. Edge contacts alone miss a car fully inside it.
    const buildings = mapChunk(x, y)?.buildings;
    if (buildings && !buildings.some(({ rings }) => insidePolygon(x, y, rings))) return v;
  }
  return null;
}

export function drive(
  car: Vehicle,
  keys: number,
  dt: number,
  vehicles: Vehicle[],
  people: PersonBody[],
  transferImpulse = true,
) {
  if (dt <= 0) return car;
  const model = models[car.model ?? 'hatch'];
  dampSlide(car, dt);
  // Bits: W 1, S 2, A 4, D 8. Crossing zero under braking consumes a step.
  const pedal = Number(!!(keys & 1)) - Number(!!(keys & 2));
  let speed = car.speed;
  const braking = pedal * speed < 0;
  if (!pedal) speed = Math.sign(speed) * Math.max(0, Math.abs(speed) - 30 * dt);
  else if (braking) speed = Math.sign(speed) * Math.max(0, Math.abs(speed) - 180 * dt);
  else
    speed = Math.min(
      model.topSpeed,
      Math.max(-48, speed + pedal * (pedal > 0 ? model.acceleration : 56) * dt),
    );
  const steer = Number(!!(keys & 8)) - Number(!!(keys & 4));
  const angle =
    car.angle + steer * Math.sign(speed) * Math.min(Math.abs(speed) / 22, model.turn) * dt;
  const dx = (Math.cos(angle) * speed + (car.slideX || 0)) * dt;
  const dy = (Math.sin(angle) * speed + (car.slideY || 0)) * dt;
  moveCar(
    car,
    { ...car, x: car.x + dx, y: car.y + dy, angle, speed },
    dt,
    vehicles,
    people,
    transferImpulse,
  );
  if (braking) car.rearLights = 'brake';
  else if (car.speed < 0 && (pedal < 0 || car.rearLights === 'reverse')) car.rearLights = 'reverse';
  else car.rearLights = 'tail';
  return car;
}

// Leave daylight between bumpers, with extra headway when the queue is moving.
const standstillGap = 12,
  headway = 0.65,
  trafficBraking = 64;
function followTraffic(car: TrafficCar, vehicles: (Vehicle | TrafficCar)[], limit: number) {
  const body = vehicleBox(car);
  let travel = Infinity;
  for (const leader of vehicles) {
    if (leader.id === car.id) continue;
    const other = vehicleBox(leader);
    const dx = leader.x - car.x,
      dy = leader.y - car.y;
    if (Math.abs(dx) > 110 || Math.abs(dy) > 110) continue;
    let ahead = dx * body.ux + dy * body.uy;
    const sameRoute = 'lane' in leader && car.lane === leader.lane;
    if (sameRoute) {
      ahead = circuits[car.lane].wrap(leader.d - car.d);
      if (ahead > 110) continue;
    } else {
      if (
        ahead <= 0 ||
        Math.abs(dx * body.uy - dy * body.ux) >= body.hy + radius(other, -body.uy, body.ux)
      )
        continue;
      // Cross traffic follows junction priority; it is not a leader in this lane.
      if ('lane' in leader && body.ux * other.ux + body.uy * other.uy < 0.7) continue;
    }
    const leaderLength = sameRoute ? other.hx : radius(other, body.ux, body.uy);
    const free = Math.max(0, ahead - body.hx - leaderLength - standstillGap);
    const v = velocity(leader);
    const leadSpeed = Math.max(0, v.x * body.ux + v.y * body.uy);
    travel = Math.min(travel, free);
    limit = Math.min(
      limit,
      Math.sqrt(leadSpeed ** 2 + 2 * trafficBraking * free),
      4 + free / headway,
    );
  }
  return { travel, limit };
}
// Walkers cross at mapped crossing nodes. Other pedestrians follow mapped paths and pavements.
const walks = [
  ...crosswalks.map((c) => c.walk),
  ...walkingPaths.map((points) => [...points, ...points.slice(1, -1).reverse()]),
];
const stops = circuits.map((route) =>
  crosswalks.flatMap((crossing, index) => {
    const d = route.nearest(crossing.x, crossing.y),
      p = route.pose(d);
    if (Math.hypot(p.x - crossing.x, p.y - crossing.y) > crossing.half) return [];
    return [{ d: d - 16, index }];
  }),
);
export function createWorld(): World {
  const traffic = circuits.flatMap((route, lane) => {
    const count = lane === 0 ? 8 : lane === 1 ? 3 : Math.max(3, Math.floor(route.length / 280));
    return Array.from({ length: count }, (_, i) => {
      const d = (route.length * (i + 0.65)) / count;
      return {
        id: 't' + lane + '-' + i,
        lane,
        d,
        ...route.pose(d),
        speed: 0,
        rearLights: 'tail' as const,
        color: COLORS[(i + lane) % COLORS.length],
      };
    });
  });
  const people = walks.flatMap((route, i) => {
    const lengths = route.map(([x, y], j) => {
      const next = route[(j + 1) % route.length];
      return Math.hypot(next[0] - x, next[1] - y);
    });
    const length = lengths.reduce((sum, d) => sum + d, 0);
    const count = i < crosswalks.length ? 1 : Math.max(1, Math.floor(length / 220));
    return Array.from({ length: count }, (_, j) => {
      let d = (length * j) / count;
      let leg = 0;
      while (leg < route.length - 1 && d >= lengths[leg]) {
        d -= lengths[leg];
        leg++;
      }
      const next = (leg + 1) % route.length,
        t = d / (lengths[leg] || 1);
      return {
        id: j === 0 ? 'p' + i : 'p' + i + '-' + j,
        route: i,
        next,
        x: route[leg][0] + (route[next][0] - route[leg][0]) * t,
        y: route[leg][1] + (route[next][1] - route[leg][1]) * t,
        crossing: false,
        color: COLORS[(i + j + 2) % COLORS.length],
      };
    });
  });
  return { time: 0, players: [], traffic, people, race: null };
}

export function step(
  world: World,
  inputs: ReadonlyMap<string, number>,
  dt: number,
  npcStep?: (actor: Position) => number,
) {
  const tickStart = world.time;
  world.time += dt;
  if (world.race?.phase === 'countdown' && tickStart >= world.race.startAt!)
    world.race.phase = 'racing';
  const lights = signals(world.time);
  const users = roadUsers(world);
  const cars = new SpatialGrid(128, users.vehicles);
  const walkers = new SpatialGrid(128, users.people);
  const footPlayers = new SpatialGrid(
    128,
    world.players.filter((player) => player.parkedCar),
  );
  // Two vehicle corner radii plus travel during one step fit in 32 pixels.
  for (const car of world.players) {
    const vehicles = cars.near(car, 32),
      people = walkers.near(car, 32);
    if (car.parkedCar) {
      walk(car, inputs.get(car.id) ?? 0, dt, vehicles, people);
      walkers.update(car);
      footPlayers.update(car);
      continue;
    }
    if (heldOnGrid(world.race, car.id)) {
      car.speed = car.slideX = car.slideY = 0;
      continue;
    }
    const { x, y } = car;
    drive(car, inputs.get(car.id) ?? 0, dt, vehicles, people);
    cars.update(car);
    checkGate(world.race, car, x, y, tickStart, dt);
  }

  for (const p of world.people) {
    const elapsed = npcStep ? npcStep(p) : dt;
    if (!elapsed) continue;
    const vehicles = cars.near(p, 32);
    const onFoot = footPlayers.near(p, 32);
    // Give a driver room to pass after contact, even when the walker is
    // waiting for the crossing signal. Move towards the nearer side of the car.
    const approaching = vehicles.find((car) => {
      if (!('parkedCar' in car)) return false;
      const keys = inputs.get(car.id) ?? 0;
      const pedal = Number(!!(keys & 1)) - Number(!!(keys & 2));
      if (!pedal || car.parkedCar) return false;
      return overlap(
        personBox(p),
        vehicleBox({
          ...car,
          x: car.x + Math.cos(car.angle) * pedal * 1.6,
          y: car.y + Math.sin(car.angle) * pedal * 1.6,
        }),
      );
    });
    if (approaching) {
      const nx = -Math.sin(approaching.angle),
        ny = Math.cos(approaching.angle);
      const side = (p.x - approaching.x) * nx + (p.y - approaching.y) * ny < 0 ? -1 : 1;
      const next = { x: p.x + nx * side * 20 * elapsed, y: p.y + ny * side * 20 * elapsed };
      const bounds = personBox(next);
      if (
        insideM60(next.x, next.y) &&
        !wallContact(bounds) &&
        !vehicles.some((v) => overlap(bounds, vehicleBox(v))) &&
        !onFoot.some((other) => overlap(bounds, personBox(other)))
      ) {
        Object.assign(p, next);
        walkers.update(p);
        continue;
      }
    }
    const route = walks[p.route],
      [tx, ty] = route[p.next];
    const crossLeg = p.next === 1 || p.next === 4;
    const crossing = crosswalks[p.route];
    const crosses = !!crossing && crossLeg;
    if (crossing?.signal && crosses && !p.crossing && !lights.walk) continue;
    const dx = tx - p.x,
      dy = ty - p.y,
      distance = Math.hypot(dx, dy);
    const move = Math.min(distance, (crosses ? 29 : 11 + (p.route % 6)) * elapsed);
    const next = { x: p.x + (dx * move) / (distance || 1), y: p.y + (dy * move) / (distance || 1) };
    if (
      wallContact(personBox(next)) ||
      vehicles.some((v) => overlap(personBox(next), vehicleBox(v))) ||
      onFoot.some((other) => overlap(personBox(next), personBox(other)))
    )
      continue;
    Object.assign(p, next);
    walkers.update(p);
    p.crossing = crosses;
    if (distance <= move) {
      p.next = (p.next + 1) % route.length;
      p.crossing = false;
    }
  }

  const occupied = new Set<number>();
  for (const p of world.people) {
    const crossing = crosswalks[p.route];
    if (crossing && (p.crossing || (!crossing.signal && (p.next === 1 || p.next === 4)))) {
      occupied.add(p.route);
    }
  }
  const mergeBusy = world.traffic.some(
    (other) => other.lane === 1 && circuits[1].wrap(faradayMerge[1] - other.d + 16) < 80,
  );
  for (const car of world.traffic) {
    const elapsed = npcStep ? npcStep(car) : dt;
    if (!elapsed) continue;
    const vehicles = cars.near(car, 110);
    const people = walkers.near(car, 32);
    const route = circuits[car.lane];
    const following = followTraffic(car, vehicles, 40);
    let free = following.travel;
    for (const stop of stops[car.lane]) {
      const crossing = crosswalks[stop.index];
      if (occupied.has(stop.index) || (crossing.signal && lights.vertical !== 'green')) {
        const distance = stop.d - car.d;
        if (distance >= -1e-7) free = Math.min(free, Math.max(0, distance));
      }
    }
    // Give way when turning off Lever to traffic already on Faraday Street.
    if (car.lane === 0 && mergeBusy) {
      const distance = faradayMerge[0] - 26 - car.d;
      if (distance >= 0) free = Math.min(free, distance);
    }
    const target = Math.min(following.limit, Math.sqrt(2 * trafficBraking * free));
    const speed = Math.max(
      car.speed - trafficBraking * elapsed,
      Math.min(car.speed + 42 * elapsed, target),
    );
    const travel = free < 1e-7 ? 0 : Math.min(free, speed * elapsed);
    const nextSpeed = travel / elapsed;
    car.rearLights = free < 0.001 || nextSpeed < car.speed - 0.001 ? 'brake' : 'tail';
    dampSlide(car, elapsed);
    const slideX = (car.slideX || 0) * elapsed,
      slideY = (car.slideY || 0) * elapsed;
    const ux = Math.cos(car.angle),
      uy = Math.sin(car.angle);
    const along = slideX * ux + slideY * uy;
    const d = route.wrap(car.d + travel + along);
    const origin = route.pose(car.d),
      next = route.pose(d);
    // Fold longitudinal impact travel into route progress. Steer lateral displacement
    // back onto the lane gradually so a side impact survives the next AI update.
    const recovery = Math.exp(-1.4 * elapsed);
    next.x += (car.x - origin.x) * recovery + slideX - along * ux;
    next.y += (car.y - origin.y) * recovery + slideY - along * uy;
    moveCar(car, { ...car, ...next, d, speed: nextSpeed }, elapsed, vehicles, people, true);
    cars.update(car);
  }
}
