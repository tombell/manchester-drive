import type { Position } from './game-types';
import type { Point } from './map-types';

export interface RoadNetwork {
  nodes: Point[];
  ways: [street: string, oneway: number, nodes: number[]][];
}

export interface RoutePoint extends Position {
  street: string; // Street taken to reach this point.
  junction: boolean;
}

export function fractionAlong(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  return Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
}

// A binary min-heap of A* candidates, ordered by estimated total driving distance.
class Frontier {
  items: { node: number; estimate: number }[] = [];

  push(node: number, estimate: number) {
    let i = this.items.length;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].estimate <= estimate) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = { node, estimate };
  }

  pop() {
    const first = this.items[0], last = this.items.pop()!;
    if (this.items.length) {
      let i = 0;
      while (2 * i + 1 < this.items.length) {
        let child = 2 * i + 1;
        if (this.items[child + 1]?.estimate < this.items[child].estimate) child++;
        if (this.items[child].estimate >= last.estimate) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = last;
    }
    return first;
  }
}

export function makeRouter({ nodes, ways }: RoadNetwork) {
  const links = nodes.map(() => [] as { to: number; length: number; way: number }[]);
  const degree = new Uint16Array(nodes.length);
  ways.forEach(([, direction, ids], way) => {
    for (let i = 1; i < ids.length; i++) {
      const a = ids[i - 1], b = ids[i];
      const length = Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1]);
      if (direction >= 0) links[a].push({ to: b, length, way });
      if (direction <= 0) links[b].push({ to: a, length, way });
      degree[a]++;
      degree[b]++;
    }
  });

  function snap({ x, y }: Position) {
    let best = Infinity;
    let match: { a: number; b: number; t: number; way: number; x: number; y: number } | undefined;
    ways.forEach(([, , ids], way) => {
      for (let i = 1; i < ids.length; i++) {
        const a = ids[i - 1], b = ids[i];
        const [ax, ay] = nodes[a], [bx, by] = nodes[b];
        const t = fractionAlong(x, y, ax, ay, bx, by);
        const px = ax + t * (bx - ax), py = ay + t * (by - ay);
        const distance = (x - px) ** 2 + (y - py) ** 2;
        if (distance < best) {
          best = distance;
          match = { a, b, t, way, x: px, y: py };
        }
      }
    });
    return match;
  }

  return (origin: Position, pin: Position): RoutePoint[] | undefined => {
    const start = snap(origin), end = snap(pin);
    if (!start || !end) return;
    const point = (p: Position, way: number, junction = false): RoutePoint =>
      ({ x: p.x, y: p.y, street: ways[way][0], junction });
    const startPoint = point(start, start.way), endPoint = point(end, end.way);
    const startDirection = ways[start.way][1], endDirection = ways[end.way][1];
    if (start.way === end.way && start.a === end.a && start.b === end.b &&
        (startDirection === 0 || (end.t - start.t) * startDirection >= 0)) {
      return [startPoint, endPoint];
    }

    // Enter and leave the graph partway along each snapped segment.
    const distanceTo = (p: Position, node: number) =>
      Math.hypot(p.x - nodes[node][0], p.y - nodes[node][1]);
    const cost = new Float64Array(nodes.length).fill(Infinity);
    const parent = new Int32Array(nodes.length).fill(-1);
    const via = new Int32Array(nodes.length);
    const queue = new Frontier();
    function seed(node: number) {
      cost[node] = distanceTo(start!, node);
      via[node] = start!.way;
      queue.push(node, cost[node] + distanceTo(end!, node));
    }
    if (startDirection <= 0 || start.t === 0) seed(start.a);
    if (startDirection >= 0 || start.t === 1) seed(start.b);
    while (queue.items.length) {
      const { node, estimate } = queue.pop();
      if (estimate > cost[node] + distanceTo(end, node)) continue;
      if ((node === end.a && (endDirection >= 0 || end.t === 0)) ||
          (node === end.b && (endDirection <= 0 || end.t === 1))) {
        const route = [endPoint];
        for (let n = node; n !== -1; n = parent[n]) {
          const [x, y] = nodes[n];
          route.push(point({ x, y }, via[n], degree[n] > 2));
        }
        route.push(startPoint);
        return route.reverse();
      }
      for (const { to, length, way } of links[node]) {
        const next = cost[node] + length;
        if (next >= cost[to]) continue;
        cost[to] = next;
        parent[to] = node;
        via[to] = way;
        queue.push(to, next + distanceTo(end, to));
      }
    }
  };
}
