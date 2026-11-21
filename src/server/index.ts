import { serveMapChunk, useServerMap } from './map';
import { mapVersion } from '../game/region';
import overview from '../game/map/overview.svg' with { type: 'file' };
import page from '../client/index.html';
import type { World } from '../game/game-types';
import { cameraCells } from '../protocol/view';
import { withinEarshot } from '../protocol/chat';
import { JUNCTION } from '../game/streets';
import type { CellBounds } from '../game/spatial';
import { neighbourhoodFrames } from './neighbourhoods';
import { encodeChat, encodeHello, restartEvent, snapshotPath } from '../protocol/snapshots';
import { GameRoom } from './room';
import { createRoutes } from './routes';

export function createGameServer({
  hostname = Bun.env.HOST || '127.0.0.1',
  port = Number(Bun.env.PORT || 4173),
  development = false,
  // Fly sets the image reference per deploy; other runs get a per-process build.
  build = Bun.env.FLY_IMAGE_REF || crypto.randomUUID(),
  room = new GameRoom(),
} = {}) {
  useServerMap();
  interface Viewer {
    stream: ReadableStreamDefaultController<Uint8Array>;
    area: CellBounds;
    token?: string;
  }
  const viewers = new Map<string, Viewer>();
  let stopping = false;
  const defaultArea = cameraCells(JUNCTION, 800, 500);
  function broadcast(frameFor: (viewer: Viewer) => Uint8Array | undefined) {
    for (const [id, viewer] of viewers) {
      const { stream } = viewer;
      if ((stream.desiredSize ?? 0) <= 0) {
        viewers.delete(id);
        stream.error(new Error('Client fell behind.'));
      } else {
        const frame = frameFor(viewer);
        if (frame) stream.enqueue(frame);
      }
    }
  }

  function publishWorld(world: World) {
    if (!viewers.size) return;
    const frame = neighbourhoodFrames(world);
    broadcast(({ area, token }) => frame(area, token ? room.sessionFor(token)?.player : undefined));
  }

  const server = Bun.serve({
    hostname,
    port,
    development,
    routes: {
      '/map/:version/:key': {
        GET(req) {
          return req.params.version === mapVersion
            ? serveMapChunk(req.params.key)
            : new Response(null, { status: 404 });
        },
      },
      '/healthz': {
        GET() {
          return new Response(stopping ? 'stopping' : 'ok', { status: stopping ? 503 : 200 });
        },
      },
      '/world-map.svg': new Response(Bun.file(overview), { headers: { 'Content-Type': 'image/svg+xml' } }),
      '/': page,
      '/index.html': page,
      [snapshotPath]: {
        GET(req, server) {
          server.timeout(req, 0);
          const id = crypto.randomUUID();
          const body = new ReadableStream<Uint8Array>(
            {
              start(stream) {
                viewers.set(id, { stream, area: defaultArea });
                stream.enqueue(encodeHello(id, build));
                stream.enqueue(neighbourhoodFrames(room.world)(defaultArea));
                stream.enqueue(encodeChat({ type: 'history', messages: room.chatHistory }));
              },
              cancel() {
                viewers.delete(id);
              },
            },
            new ByteLengthQueuingStrategy({ highWaterMark: 128 * 1024 }),
          );
          return new Response(body, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache, no-transform',
              'X-Accel-Buffering': 'no',
            },
          });
        },
      },
    },
    fetch: createRoutes(
      room,
      (event, sender) => {
        const frame = encodeChat(event);
        broadcast(({ token }) => {
          if (event.type === 'message') return frame;
          const listener = token && room.sessionFor(token)?.player;
          if (listener && withinEarshot(sender, listener)) return frame;
        });
      },
      ({ viewer, area, token }) => {
        const client = viewers.get(viewer);
        if (!client) return false;
        client.area = area;
        client.token = token;
        return true;
      },
    ).fetch,
  });

  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    room.advance(
      (now - last) / 1000,
      publishWorld,
      viewers.values().map((viewer) => viewer.area),
    );
    last = now;
  }, 1000 / 60);

  return {
    url: server.url,
    async stop() {
      stopping = true;
      clearInterval(timer);
      for (const { stream } of viewers.values()) {
        stream.enqueue(restartEvent);
        stream.close();
      }
      viewers.clear();
      // Let the closed streams flush their restart event before forcing the rest.
      await Promise.race([server.stop(), Bun.sleep(1000)]);
      return server.stop(true);
    },
  };
}

if (import.meta.main) {
  const server = createGameServer({ development: Bun.env.NODE_ENV === 'development' });
  console.log('Manchester Drive listening on ' + server.url);
  // Fly sends SIGINT by default and SIGTERM when configured; handle both.
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      console.log('Received ' + signal + ', telling viewers to reconnect');
      await server.stop();
      process.exit(0);
    });
}
