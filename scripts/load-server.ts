// Run on the isolated game host. The production entry point has no fixture control routes.
import { GameRoom } from '../src/server/room';
import { createGameServer } from '../src/server';
import { useServerMap } from '../src/server/map';
import { JUNCTION, startingPositions } from '../src/game/streets';
import type { GarageOptions } from '../src/game/garage';

useServerMap();
const samples = Array.from(startingPositions().take(16_000));
const centres = [
  [JUNCTION.x, JUNCTION.y],
  [2350, 540],
];
for (const point of samples) {
  if (centres.every(([x, y]) => Math.hypot(point[0] - x, point[1] - y) > 2200)) centres.push(point);
  if (centres.length === 8) break;
}
const bays = centres.map(([x, y]) => {
  const distance = (v: number[]) => (v[0] - x) ** 2 + (v[1] - y) ** 2;
  return samples.filter((v) => distance(v) < 1600 ** 2).sort((a, b) => distance(a) - distance(b));
});
let spread = false,
  joins = 0;
class LoadRoom extends GameRoom {
  override join(name: string, options?: GarageOptions) {
    return super.join(name, options, bays[spread ? joins++ % bays.length : 0]);
  }
}

let measured = false,
  ticks: number[] = [],
  peakRss = 0,
  start = 0,
  simStart = 0;
const room = new LoadRoom(Date.now, (ms) => {
  if (measured) ticks.push(ms);
});
setInterval(() => {
  if (measured) peakRss = Math.max(peakRss, process.memoryUsage.rss());
}, 250);
const hostname = Bun.env.HOST ?? '127.0.0.1';
const game = createGameServer({ hostname, port: Number(Bun.env.PORT ?? 4173), room });
const control = Bun.serve({
  hostname,
  port: Number(Bun.env.CONTROL_PORT ?? 4174),
  fetch(req) {
    const url = new URL(req.url);
    if (req.method !== 'POST') return new Response(null, { status: 405 });
    if (url.pathname === '/prepare' && !room.world.players.length) {
      const layout = url.searchParams.get('layout');
      if (layout !== 'crowd' && layout !== 'spread') return new Response(null, { status: 400 });
      joins = 0;
      spread = layout === 'spread';
      return Response.json({
        fixture: 'manchester-drive',
        gamePort: game.url.port,
        districts: spread ? bays.length : 1,
      });
    }
    if (url.pathname === '/start' && !measured) {
      start = performance.now();
      simStart = room.world.time;
      ticks = [];
      peakRss = process.memoryUsage.rss();
      measured = true;
      return Response.json({ players: room.world.players.length });
    }
    if (url.pathname === '/finish' && measured) {
      measured = false;
      const seconds = (performance.now() - start) / 1000;
      ticks.sort((a, b) => a - b);
      const p = (q: number) => ticks[Math.ceil(q * ticks.length) - 1];
      return Response.json({
        players: room.world.players.length,
        seconds,
        simulationHz: ((room.world.time - simStart) * 60) / seconds,
        tickP95Ms: p(0.95),
        tickP99Ms: p(0.99),
        lateTicks: ticks.filter((t) => t > 1000 / 60).length,
        ticks: ticks.length,
        peakRssMiB: Math.max(peakRss, process.memoryUsage.rss()) / 1048576,
      });
    }
    return new Response('Unknown operation or fixture busy', { status: 409 });
  },
});
console.log('Load fixture ready on ' + control.url);
