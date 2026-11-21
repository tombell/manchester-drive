import { expect, test, onTestFinished } from 'bun:test';
import type { ChatEvent } from '../src/protocol/chat';
import type { Credentials } from '../src/protocol/commands';
import type { Snapshot } from '../src/protocol/snapshots';
import { models } from '../src/game/garage';
import { cameraCells } from '../src/protocol/view';
import { JUNCTION } from '../src/game/streets';
import { createGameServer } from '../src/server';

async function readEvents<K extends 'message' | 'chat'>(
  url: URL,
  signal: AbortSignal,
  event: K,
  onViewer?: (id: string) => void,
) {
  const res = await fetch(new URL('/events', url), { signal });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  return async (): Promise<K extends 'chat' ? ChatEvent : Snapshot> => {
    for (;;) {
      while (!buffer.includes('\n\n')) {
        const { value, done } = await reader.read();
        if (done) throw new Error('Room stream closed');
        buffer += value;
      }
      const end = buffer.indexOf('\n\n');
      const fields = buffer.slice(0, end).split('\n');
      buffer = buffer.slice(end + 2);
      const type = fields.find((line) => line.startsWith('event: '))?.slice(7) ?? 'message';
      const data = fields.find((line) => line.startsWith('data: '))!.slice(6);
      if (type === 'viewer') onViewer?.(data);
      if (type === event) return JSON.parse(data);
    }
  };
}

test('two clients share the same authoritative cars and controls belong to their driver', async () => {
  const server = createGameServer({ hostname: '127.0.0.1', port: 0 });
  const abort = new AbortController();
  onTestFinished(async () => {
    abort.abort();
    await server.stop();
  });
  const post = (path: string, payload: unknown) =>
    fetch(new URL(path, server.url), { method: 'POST', body: JSON.stringify(payload) });
  const [a, b] = await Promise.all(
    ['Ada', 'Mo'].map(async (name) => {
      const response = await post('/join', { name });
      expect(response.status).toBe(201);
      return (await response.json()) as Credentials;
    }),
  );
  const streams = await Promise.all(
    [1, 2].map(() => readEvents(server.url, abort.signal, 'message')),
  );
  const [initial] = await Promise.all(streams.map((read) => read()));
  const driver = (world: Snapshot, id: string) => world.players.find((p) => p.id === id)!;
  expect(initial.players.length).toBe(2);
  expect((await post('/input', { token: b.id, seq: 1, keys: 1 })).status).toBe(401);
  await post('/input', { token: a.token, seq: 2, keys: 1 });
  await post('/input', { token: a.token, seq: 1, keys: 0 });
  async function moving(read: () => Promise<Snapshot>) {
    for (let i = 0; i < 25; i++) {
      const frame = await read();
      if (driver(frame, a.id).x > driver(initial, a.id).x + 1) return frame;
    }
    throw new Error('The other browser never observed acceleration');
  }
  let [first, second] = await Promise.all(streams.map(moving));
  while (first.time < second.time) first = await streams[0]();
  while (second.time < first.time) second = await streams[1]();
  expect(first).toStrictEqual(second);
  expect(driver(first, b.id).x).toBe(driver(initial, b.id).x);
  expect(!JSON.stringify(first).includes(a.token)).toBeTruthy();
  // A mode change invalidates older driving inputs. Both clients observe the same
  // walker and parked car, and a duplicate exit cannot put the walker back inside.
  expect((await post('/vehicle', { token: b.id, action: 'exit', seq: 1 })).status).toBe(401);
  expect((await post('/vehicle', { token: b.token, action: 'exit', seq: 2 })).status).toBe(200);
  expect((await post('/vehicle', { token: b.token, action: 'exit', seq: 2 })).status).toBe(409);
  await post('/input', { token: b.token, seq: 1, keys: 1 });
  async function parked(read: () => Promise<Snapshot>) {
    let frame;
    do {
      frame = await read();
    } while (!driver(frame, b.id).parkedCarId);
    const walker = driver(frame, b.id);
    return { walker, car: frame.parkedCars.find(c => c.id === walker.parkedCarId)! };
  }
  const [walker, seen] = await Promise.all(streams.map(parked));
  expect(walker).toStrictEqual(seen);
  expect(walker.walker.speed).toBe(0);
  expect(walker.car.x).toBe(driver(initial, b.id).x);
  expect((await post('/vehicle', { token: b.token, action: 'enter', seq: 3 })).status).toBe(200);
  await post('/leave', { token: a.token });
  let frame;
  do {
    frame = await streams[1]();
  } while (frame.players.some((p) => p.id === a.id));
  expect(frame.players.map((p) => p.id)).toStrictEqual([b.id]);
});

test('drivers can join together after the Piccadilly bays fill up', async () => {
  const server = createGameServer({ hostname: '127.0.0.1', port: 0 });
  const abort = new AbortController();
  onTestFinished(async () => {
    abort.abort();
    await server.stop();
  });
  const drivers = await Promise.all(
    Array.from({ length: 32 }, async (_, i) => {
      const response = await fetch(new URL('/join', server.url), {
        method: 'POST',
        body: JSON.stringify({ name: 'Driver ' + i, model: 'van' }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as Credentials;
    }),
  );
  let viewer = '';
  const read = await readEvents(server.url, abort.signal, 'message', id => { viewer = id; });
  const first = await read();
  expect(first.playerCount).toBe(drivers.length);
  await fetch(new URL('/view', server.url), {
    method: 'POST', body: JSON.stringify({ viewer, area: cameraCells(JUNCTION, 4000, 4000) }),
  });
  let frame = first;
  while (frame.players.length !== drivers.length) frame = await read();
  const { players } = frame;
  expect(players.map(p => p.id).sort()).toEqual(drivers.map(d => d.id).sort());
  expect(new Set(drivers.map((d) => d.token)).size).toBe(drivers.length);
  for (const [i, player] of players.entries()) {
    expect(player.color).toMatch(/^#[0-9a-f]{6}$/i);
    for (const other of players.slice(0, i)) {
      expect(Math.hypot(other.x - player.x, other.y - player.y)).toBeGreaterThan(2 * models.van.width);
    }
  }
});

test('separate neighbourhood views converge on the same NPCs and free cam keeps local collisions', async () => {
  const server = createGameServer({ hostname: '127.0.0.1', port: 0 });
  const abort = new AbortController();
  onTestFinished(async () => {
    abort.abort();
    await server.stop();
  });
  const post = (path: string, body: object) =>
    fetch(new URL(path, server.url), { method: 'POST', body: JSON.stringify(body) });
  const { token } = (await (await post('/join', { name: 'Ada' })).json()) as Credentials;
  const viewers: string[] = [];
  const [ada, spectator] = await Promise.all(
    [0, 1].map((i) =>
      readEvents(server.url, abort.signal, 'message', (id) => {
        viewers[i] = id;
      }),
    ),
  );
  await Promise.all([ada(), spectator()]);
  const north = cameraCells({ x: 2360, y: 510 }, 800, 500);
  const south = cameraCells(JUNCTION, 800, 500);
  const setView = async (i: number, area: typeof north, driver?: string) => {
    expect((await post('/view', { viewer: viewers[i], area, token: driver })).status).toBe(200);
  };
  async function until(read: () => Promise<Snapshot>, match: (w: Snapshot) => boolean) {
    for (let i = 0; i < 20; i++) {
      const w = await read();
      if (match(w)) return w;
    }
    throw new Error('Camera subscription did not follow its viewer');
  }
  const inNorth = (w: Snapshot) => w.traffic.some((car) => car.lane === 2);
  const inSouth = (w: Snapshot) => w.traffic.some((car) => car.lane === 0);
  await Promise.all([setView(0, south, token), setView(1, north)]);
  const southFrame = await ada(),
    northFrame = await until(spectator, inNorth);
  expect(inSouth(southFrame)).toBe(true);
  expect(northFrame.playerCount).toBe(1);
  expect(northFrame.players).toHaveLength(0);
  const southIds = new Set([...southFrame.people, ...southFrame.traffic].map((v) => v.id));
  expect(northFrame.people.length).toBeGreaterThan(0);
  expect([...northFrame.people, ...northFrame.traffic].every((v) => !southIds.has(v.id))).toBe(
    true,
  );

  // Ada keeps her car on Piccadilly and pans the camera to the spectator.
  await setView(0, north, token);
  let combined = await until(ada, inNorth),
    shared = await spectator();
  while (shared.time < combined.time) shared = await spectator();
  while (combined.time < shared.time) combined = await ada();
  expect(combined.time).toBe(shared.time);
  expect(inSouth(combined)).toBe(true);
  expect(combined.players.map(p => p.name)).toEqual(['Ada']);
  for (const kind of ['traffic', 'people'] as const) {
    expect(
      combined[kind].filter((npc) => shared[kind].some((other) => other.id === npc.id)),
    ).toEqual(shared[kind]);
    expect(new Set(combined[kind].map((npc) => npc.id)).size).toBe(combined[kind].length);
  }
  // Both views now meet back on Piccadilly with no Northern Quarter NPCs in either feed.
  await Promise.all([setView(0, south, token), setView(1, south)]);
  const local = await until(ada, (w) => !inNorth(w)),
    returned = await until(spectator, inSouth);
  expect(inSouth(local)).toBe(true);
  expect(inNorth(returned)).toBe(false);
});

test('the Bun server serves the browser bundle and validates game commands', async () => {
  const server = createGameServer({ hostname: '127.0.0.1', port: 0 });
  onTestFinished(() => server.stop());
  const page = await fetch(server.url);
  expect(page.status).toBe(200);
  const html = await page.text();
  const script = html.match(/<script\b[^>]*\bsrc="([^"]+)"/)?.[1];
  expect(script).toBeDefined();
  const bundle = await fetch(new URL(script!, server.url));
  expect(bundle.status).toBe(200);
  expect(bundle.headers.get('Content-Type')).toMatch(/javascript/);

  const join = new URL('/join', server.url);
  for (const [body, status] of [
    ['{', 400],
    ['null', 400],
    ['x'.repeat(2049), 413],
  ] as const) {
    const response = await fetch(join, { method: 'POST', body });
    expect(response.status).toBe(status);
  }
  const foreign = await fetch(join, {
    method: 'POST',
    headers: { Origin: 'https://example.org' },
    body: '{}',
  });
  expect(foreign.status).toBe(403);
  const joined = await fetch(join, { method: 'POST', body: '{"name":"Ada"}' });
  const { token } = (await joined.json()) as Credentials;
  const invalidDoor = await fetch(new URL('/vehicle', server.url), {
    method: 'POST',
    body: JSON.stringify({ token, seq: 1, action: 'unknown' }),
  });
  expect(invalidDoor.status).toBe(409);
  const leave = await fetch(new URL('/leave', server.url), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ token }),
  });
  expect(leave.status).toBe(200);
});

test('global chat authenticates the sender, reaches both clients and restores history on reconnect', async () => {
  const server = createGameServer({ hostname: '127.0.0.1', port: 0 });
  const abort = new AbortController();
  onTestFinished(async () => {
    abort.abort();
    await server.stop();
  });
  const post = (path: string, body: object) =>
    fetch(new URL(path, server.url), { method: 'POST', body: JSON.stringify(body) });
  const { token } = (await (await post('/join', { name: 'Ada' })).json()) as Credentials;
  const streams = await Promise.all([1, 2].map(() => readEvents(server.url, abort.signal, 'chat')));
  for (const read of streams) expect(await read()).toEqual({ type: 'history', messages: [] });
  expect((await post('/chat', { text: 'Hello' })).status).toBe(401);
  for (const text of ['   ', 'x'.repeat(241)]) {
    expect((await post('/chat', { token, text })).status).toBe(400);
  }
  const text = '<b>Meet on Lever Street?</b>';
  expect((await post('/chat', { token, name: 'Mo', text: '  ' + text + '  ' })).status).toBe(201);
  const [a, b] = await Promise.all(streams.map((read) => read()));
  expect(a).toEqual(b);
  if (a.type !== 'message') throw new Error('Expected a live chat message');
  expect(a.message).toEqual({
    id: expect.any(String),
    name: 'Ada',
    color: expect.any(String),
    text,
  });
  await post('/leave', { token });
  expect((await post('/chat', { token, text })).status).toBe(401);
  const reconnect = await readEvents(server.url, abort.signal, 'chat');
  expect(await reconnect()).toEqual({ type: 'history', messages: [a.message] });
});

test('a restarting server reports its build and tells viewers to reconnect', async () => {
  const server = createGameServer({ hostname: '127.0.0.1', port: 0, build: 'deploy-1' });
  let stopped = false;
  onTestFinished(async () => {
    if (!stopped) await server.stop();
  });
  expect((await fetch(new URL('/healthz', server.url))).status).toBe(200);
  const res = await fetch(new URL('/events', server.url));
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let stream = '';
  while (!stream.includes('event: viewer')) stream += (await reader.read()).value;
  expect(stream).toStartWith('retry: 500\nevent: build\ndata: deploy-1\n\n');
  stopped = true;
  const stopping = server.stop();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    stream += value;
  }
  await stopping;
  expect(stream).toEndWith('event: restart\ndata: \n\n');
});

test('local speech reaches nearby players on their live streams and stays out of history', async () => {
  const server = createGameServer({ hostname: '127.0.0.1', port: 0 });
  const abort = new AbortController();
  onTestFinished(async () => {
    abort.abort();
    await server.stop();
  });
  const post = (path: string, body: object) =>
    fetch(new URL(path, server.url), { method: 'POST', body: JSON.stringify(body) });
  const drivers: Credentials[] = [];
  for (let i = 0; i < 6; i++) {
    drivers.push(await (await post('/join', { name: 'Driver ' + i })).json());
  }
  const snapshot = await readEvents(server.url, abort.signal, 'message');
  const { players } = await snapshot();
  const sender = drivers[0];
  const speaker = players.find((p) => p.id === sender.id)!;
  const distance = (driver: Credentials) => {
    const p = players.find((p) => p.id === driver.id)!;
    return Math.hypot(p.x - speaker.x, p.y - speaker.y);
  };
  const nearby = drivers.find((d) => d !== sender && distance(d) < 230)!;
  const distant = drivers.find((d) => distance(d) > 270)!;
  expect((await post('/vehicle', { token: sender.token, action: 'exit', seq: 1 })).status).toBe(200);

  async function connect(token?: string) {
    let viewer = '';
    const read = await readEvents(server.url, abort.signal, 'chat', (id) => {
      viewer = id;
    });
    expect(await read()).toEqual({ type: 'history', messages: [] });
    // Every camera watches the speaker, including the distant driver's free cam.
    const area = cameraCells(speaker, 800, 500);
    expect((await post('/view', { viewer, area, token })).status).toBe(200);
    return read;
  }
  const [own, close, far, spectator] = await Promise.all([
    connect(sender.token),
    connect(nearby.token),
    connect(distant.token),
    connect(),
  ]);
  const text = 'Meet at my car';
  expect((await post('/chat', { channel: 'local', text })).status).toBe(401);
  expect((await post('/chat', { channel: 'locl', text, token: sender.token })).status).toBe(400);
  expect((await post('/chat', { channel: 'local', text, token: sender.token })).status).toBe(201);
  const speech: ChatEvent = { type: 'local', playerId: sender.id, text };
  expect(await own()).toEqual(speech);
  expect(await close()).toEqual(speech);

  // A subsequent global message marks the end of the delivery window for every reader.
  await post('/chat', { token: sender.token, text: 'Hello everyone' });
  const global = await own();
  if (global.type !== 'message') throw new Error('Expected global chat');
  expect(await far()).toEqual(global);
  expect(await spectator()).toEqual(global);
  const reconnect = await readEvents(server.url, abort.signal, 'chat');
  expect(await reconnect()).toEqual({ type: 'history', messages: [global.message] });
});
