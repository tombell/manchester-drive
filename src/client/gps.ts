import type { Position } from '../game/game-types';
import { fractionAlong, makeRouter, type RoadNetwork, type RoutePoint } from '../game/routing';

const distance = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y);

function lengthLabel(pixels: number) {
  const metres = Math.round(pixels / 5);
  return metres < 1000 ? metres + ' m' : (metres / 1000).toFixed(1) + ' km';
}

function heading(from: Position, to: Position) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  return ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast'][
    (Math.round(angle / (Math.PI / 4)) + 8) % 8
  ];
}

export function followRoute(points: RoutePoint[]) {
  const remaining = new Float64Array(points.length);
  const turns = new Map<number, string>();
  for (let i = points.length - 2; i >= 0; i--) {
    const here = points[i], after = points[i + 1];
    remaining[i] = remaining[i + 1] + distance(here, after);
    if (!here.junction || !i) continue;
    const before = points[i - 1];
    const ax = here.x - before.x, ay = here.y - before.y;
    const bx = after.x - here.x, by = after.y - here.y;
    const angle = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    if (Math.abs(angle) >= Math.PI / 6) {
      const turn = Math.abs(angle) > 5 * Math.PI / 6 ? 'U-turn' : angle > 0 ? 'Right' : 'Left';
      turns.set(i, turn + (after.street ? ' onto ' + after.street : ''));
    }
  }
  let index = 0;
  return (position: Position) => {
    // Stay on the current leg at crossings and where a route doubles back.
    let nearest = Infinity, along = 0, segment = index;
    for (let i = Math.max(0, index - 1); i < points.length - 1; i++) {
      if (remaining[index + 1] - remaining[i] > 400) break;
      const a = points[i], b = points[i + 1];
      const t = fractionAlong(position.x, position.y, a.x, a.y, b.x, b.y);
      const d = Math.hypot(position.x - a.x - t * (b.x - a.x), position.y - a.y - t * (b.y - a.y));
      if (d < nearest || (d === nearest && i === segment + 1 && along === 1)) {
        nearest = d;
        segment = i;
        along = t;
      }
    }
    index = segment;
    const left = remaining[index] - along * (remaining[index] - remaining[index + 1]);
    if (nearest > 65) {
      const a = points[index], b = points[index + 1];
      const target = { x: a.x + along * (b.x - a.x), y: a.y + along * (b.y - a.y) };
      const message = 'Join ' + (b.street || 'the route') + ' · ' + heading(position, target);
      return { index, offRoute: true, arrived: false, message };
    }
    if (left < 45 && distance(position, points.at(-1)!) < 50)
      return { index, offRoute: false, arrived: true, message: 'Arrived at destination road' };
    let instruction = 'Head ' + heading(points[index], points[index + 1]);
    for (const [i, turn] of turns) {
      if (i <= index) break;
      const ahead = left - remaining[i];
      if (ahead <= 750) instruction = turn + ' in ' + lengthLabel(ahead);
    }
    return { index, offRoute: false, arrived: false, message: instruction + ' · ' + lengthLabel(left) + ' left' };
  };
}

export function makeGps() {
  let router: ReturnType<typeof makeRouter> | undefined;
  let loading = false, failed = false;
  let destination: Position | undefined, origin: Position | undefined;
  let route: RoutePoint[] = [], follow: ReturnType<typeof followRoute> | undefined;
  let index = 0, arrived = false, message = '', lastPlan = 0;

  async function load() {
    loading = true;
    try {
      const response = await fetch('/routing.json');
      if (!response.ok) throw new Error('Routing map unavailable');
      router = makeRouter(await response.json() as RoadNetwork);
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  }

  function setDestination(pin?: Position) {
    destination = pin;
    origin = follow = undefined;
    route = [];
    index = 0;
    arrived = failed = false;
    message = '';
    if (pin && !router && !loading) return load();
  }

  function update(driver?: Position, now = performance.now()) {
    if (!destination || !driver || arrived) return;
    if (!router) {
      message = failed ? 'GPS unavailable · select the destination again to retry' : 'Loading road map…';
      return;
    }
    let current = follow?.(driver);
    if (!origin || ((!current || current.offRoute) && distance(driver, origin) > 75 && now - lastPlan > 1000)) {
      origin = { x: driver.x, y: driver.y };
      lastPlan = now;
      route = router(driver, destination) ?? [];
      follow = route.length ? followRoute(route) : undefined;
      current = follow?.(driver);
    }
    index = current?.index ?? 0;
    arrived = !!current?.arrived;
    message = current?.message ?? 'No driving route · choose another destination';
  }

  return {
    setDestination, update,
    get destination() { return destination; },
    get route() { return route; },
    get index() { return index; },
    get message() { return message; },
    get arrived() { return arrived; },
  };
}

export type Gps = ReturnType<typeof makeGps>;
