import { expect, test, spyOn } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { followRoute, makeGps } from '../src/client/gps';
import { makeRouter } from '../src/game/routing';
import { spawns } from '../src/game/streets';

test('pins snap partway along roads and travel against a one-way street takes the detour', () => {
  const route = makeRouter({
    nodes: [[0, 0], [100, 0], [100, 100], [0, 100]],
    ways: [['One Way', -1, [0, 1]], ['Detour', 0, [0, 3, 2, 1]]],
  });
  const west = { x: 20, y: -4 }, east = { x: 80, y: 2 };
  const direct = route(east, west)!;
  expect(direct.map(({ x, y }) => [x, y])).toEqual([[80, 0], [20, 0]]);
  const detour = route(west, east)!;
  expect(detour.map(({ x, y }) => [x, y])).toEqual([[20, 0], [0, 0], [0, 100], [100, 100], [100, 0], [80, 0]]);
});

test('crossing road geometry needs a shared junction to provide a route', () => {
  const route = makeRouter({
    nodes: [[0, 50], [50, 50], [100, 50], [50, 0], [50, 50], [50, 100]],
    ways: [['Bridge', 0, [0, 1, 2]], ['Underpass', 0, [3, 4, 5]]],
  });
  expect(route({ x: 10, y: 50 }, { x: 50, y: 90 })).toBeUndefined();
});

test('guidance advances through a turn after a long segment and recognises arrival', () => {
  const route = makeRouter({
    nodes: [[0, 0], [1000, 0], [1000, 250], [1200, 0]],
    ways: [['First Street', 0, [0, 1, 3]], ['Second Street', 0, [1, 2]]],
  });
  const follow = followRoute(route({ x: 5, y: 5 }, { x: 997, y: 240 })!);
  expect(follow({ x: 800, y: 8 }).message).toBe('Right onto Second Street in 40 m · 88 m left');
  expect(follow({ x: 1005, y: 100 }).message).toBe('Head south · 28 m left');
  expect(follow({ x: 1100, y: 110 }).offRoute).toBe(true);
  expect(follow({ x: 1000, y: 227 }).arrived).toBe(true);
});

test('a wrong turn replaces the remaining route and clearing the pin ends guidance', async () => {
  const response = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
    nodes: [[0, 0], [1000, 0], [1000, 500], [0, 500]],
    ways: [['Direct', 0, [0, 1]], ['Side Street', 0, [0, 3, 2, 1]]],
  }));
  try {
    const gps = makeGps();
    await gps.setDestination({ x: 990, y: 0 });
    gps.update({ x: 5, y: 0 }, 0);
    expect(gps.route.map(p => p.street)).toEqual(['Direct', 'Direct']);
    gps.update({ x: 450, y: 500 }, 2000);
    expect(gps.route[0]).toMatchObject({ street: 'Side Street', x: 450, y: 500 });
    expect(gps.route.at(-1)).toMatchObject({ x: 990, y: 0 });
    gps.setDestination();
    gps.update({ x: 500, y: 500 }, 3000);
    expect(gps.route).toHaveLength(0);
    expect(gps.message).toBe('');
  } finally {
    response.mockRestore();
  }
});

test('the shipped driving network connects the starting bays to roads across the region', async () => {
  const packed = await Bun.file(new URL('../src/game/map/routing.pack', import.meta.url)).bytes();
  const route = makeRouter(JSON.parse(gunzipSync(packed).toString()));
  const [x, y] = spawns[0];
  for (const destination of [{ x: -46317, y: -6928 }, { x: 4340, y: 48487.5 }]) {
    const path = route({ x, y }, destination)!;
    expect(path.length).toBeGreaterThan(2);
    expect(Math.hypot(path[0].x - x, path[0].y - y)).toBeLessThan(30);
    const end = path.at(-1)!;
    expect(Math.hypot(end.x - destination.x, end.y - destination.y)).toBeLessThan(5);
  }
});
