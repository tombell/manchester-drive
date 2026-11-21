// The separate fixture handshake prevents this runner from joining a live game.
import { cameraCells, areaKey } from '../src/protocol/view';
import type { Snapshot, VisiblePlayer } from '../src/protocol/snapshots';
import type { Credentials } from '../src/protocol/commands';

const [layout = 'crowd', countArg = '32', timeArg = '60'] = Bun.argv.slice(2);
const count = Number(countArg),
  seconds = Number(timeArg);
if (
  !['crowd', 'spread'].includes(layout) ||
  !Number.isInteger(count) ||
  count < 1 ||
  count > 512 ||
  !Number.isInteger(seconds) ||
  seconds < 1 ||
  seconds > 600
)
  throw Error('Usage: bun run load:test <crowd|spread> <1–512 players> <1–600 seconds>');
const control = new URL(Bun.env.FIXTURE_URL ?? 'http://127.0.0.1:4174');
const abort = new AbortController();
async function command(url: URL, data?: object) {
  const response = await fetch(url, {
    method: 'POST',
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw Error(url.pathname + ' ' + response.status + ' ' + (await response.text()));
  return await response.json();
}
const prepare = await command(new URL('/prepare?layout=' + layout, control));
if (prepare.fixture !== 'manchester-drive') throw Error('Expected dedicated load fixture');
const game = new URL(control);
game.port = prepare.gamePort;
const post = (path: string, data: object) => command(new URL(path, game), data);

let measuring = false,
  wireBytes = 0,
  frames = 0,
  visiblePlayers = 0;
let failures = 0,
  inputTimes: number[] = [];
type Client = Credentials & {
  seq: number;
  viewer: string;
  lastArea: string;
  actor?: VisiblePlayer;
  frames: number;
  onFoot: boolean;
  freeCam: boolean;
  index: number;
  pending: boolean;
  moved: boolean;
};
const clients: Client[] = [],
  streamTasks: Promise<void>[] = [];
let streamError: unknown,
  stopping = false;
let streamFailures = 0;

async function listen(c: Client) {
  const res = await fetch(new URL('/events', game), { signal: abort.signal });
  if (!res.ok || !res.body) throw Error('Stream failed: ' + res.status);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    if (measuring) wireBytes += chunk.byteLength;
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (event.startsWith('event: viewer\ndata: '))
        c.viewer = event.slice('event: viewer\ndata: '.length);
      if (!event.startsWith('data: ')) continue;
      const w: Snapshot = JSON.parse(event.slice(6));
      const p = w.players.find((p) => p.id === c.id);
      if (p) {
        if (measuring && c.actor && Math.hypot(p.x - c.actor.x, p.y - c.actor.y) > 0.001)
          c.moved = true;
        c.actor = p;
      }
      if (measuring) {
        frames++;
        c.frames++;
        visiblePlayers += w.players.length;
      }
    }
  }
  if (!stopping) throw Error('Stream ended during load');
}
async function view(c: Client, elapsed: number) {
  const focus = c.freeCam
    ? { x: 2380 + 500 * Math.sin(elapsed / 8 + c.index), y: 620 }
    : (c.actor ?? { x: 2678, y: 2267 });
  const area = cameraCells(focus, 800, 500),
    key = areaKey(area);
  if (key === c.lastArea) return;
  await post('/view', { viewer: c.viewer, token: c.token, area });
  c.lastArea = key;
}
async function join(index: number) {
  const cred = (await post('/join', {
    name: 'Load ' + index,
    model: index % 3 === 0 ? 'van' : 'hatch',
  })) as Credentials;
  const c: Client = {
    ...cred,
    viewer: '',
    seq: 0,
    lastArea: '',
    frames: 0,
    onFoot: false,
    freeCam: index % 8 === 0,
    index,
    pending: false,
    moved: false,
  };
  clients.push(c);
  streamTasks.push(
    listen(c).catch((e) => {
      if (!stopping) {
        streamError = e;
        streamFailures++;
      }
    }),
  );
  const until = performance.now() + 10000;
  while (!c.viewer) {
    if (streamError || performance.now() > until) throw Error('Could not open live view');
    await Bun.sleep(10);
  }
  await view(c, 0);
  if (index % 4 === 1) {
    // A driver with both doors physically blocked stays seated.
    const res = await fetch(new URL('/vehicle', game), {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ token: c.token, seq: ++c.seq, action: 'exit' }),
    });
    if (!res.ok && res.status !== 409) throw Error('Vehicle command returned ' + res.status);
    c.onFoot = res.ok;
  }
}
const pending = new Set<Promise<void>>();
let timer: ReturnType<typeof setInterval> | undefined;
let startedMeasure = false;
try {
  for (let i = 0; i < count; i += 8) {
    const batch = await Promise.allSettled(
      Array.from({ length: Math.min(8, count - i) }, (_, j) => join(i + j)),
    );
    const failure = batch.find((r) => r.status === 'rejected');
    if (failure) throw failure.reason;
  }
  const boot = performance.now();
  let step = 0;
  timer = setInterval(() => {
    const now = (performance.now() - boot) / 1000;
    for (const c of clients) {
      if (c.index % 8 !== step % 8 || c.pending) continue;
      c.pending = true;
      const task = (async () => {
        await view(c, now);
        const phase = (Math.floor(now / 2) + c.index) % 8;
        const keys = c.freeCam
          ? 0
          : c.onFoot
            ? [8, 8, 2, 2, 4, 4, 1, 1][phase]
            : [1, 1, 5, 1, 9, 2, 2, 0][phase];
        const t = performance.now(),
          sample = measuring;
        await post('/input', { token: c.token, seq: ++c.seq, onFoot: c.onFoot, keys });
        if (sample && measuring) inputTimes.push(performance.now() - t);
      })()
        .catch(() => {
          failures++;
        })
        .finally(() => {
          c.pending = false;
          pending.delete(task);
        });
      pending.add(task);
    }
    step++;
  }, 100);
  await Bun.sleep(6000);
  if (streamError) throw streamError;
  const start = await command(new URL('/start', control));
  startedMeasure = true;
  if (start.players !== count || clients.some((c) => !c.actor))
    throw Error('Missing player before measurement');
  measuring = true;
  const begin = performance.now(),
    clientCpu = process.cpuUsage();
  await Bun.sleep(seconds * 1000);
  measuring = false;
  const duration = (performance.now() - begin) / 1000;
  const metrics = await command(new URL('/finish', control));
  startedMeasure = false;
  const cpu = process.cpuUsage(clientCpu);
  inputTimes.sort((a, b) => a - b);
  const result = {
    layout,
    clients: count,
    districts: prepare.districts,
    ...metrics,
    streamFailures,
    streamsWithFrames: clients.filter((c) => c.frames).length,
    clientCpuCores: (cpu.user + cpu.system) / 1e6 / duration,
    movingPlayers: clients.filter((c) => c.moved).length,
    walkers: clients.filter((c) => c.onFoot).length,
    freeCams: clients.filter((c) => c.freeCam).length,
    averageVisiblePlayers: visiblePlayers / frames,
    framesPerClientSecond: frames / count / duration,
    sseMiBPerSecond: wireBytes / 1048576 / duration,
    inputP95Ms: inputTimes[Math.ceil(inputTimes.length * 0.95) - 1],
    acknowledgedInputs: inputTimes.length,
    commandFailures: failures,
  };
  console.log(JSON.stringify(result));
  if (failures || streamFailures || metrics.players !== count || clients.some((c) => !c.frames))
    process.exitCode = 1;
} finally {
  stopping = true;
  measuring = false;
  clearInterval(timer);
  abort.abort();
  await Promise.allSettled([...pending, ...streamTasks]);
  if (startedMeasure) await command(new URL('/finish', control)).catch(() => {});
  for (let i = 0; i < clients.length; i += 8)
    await Promise.all(clients.slice(i, i + 8).map((c) => post('/leave', { token: c.token })));
}
