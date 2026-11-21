import { serveMapChunk, useServerMap } from './map';
import { mapVersion } from '../game/region';
import page from '../client/index.html';
import type { World } from '../game/game-types';
import { cameraCells } from '../protocol/view';
import { JUNCTION } from '../game/streets';
import type { CellBounds } from '../game/spatial';
import { neighbourhoodFrames } from './neighbourhoods';
import { encodeChat, snapshotPath } from '../protocol/snapshots';
import { GameRoom } from './room';
import { createRoutes } from './routes';

export function createGameServer({
  hostname = Bun.env.HOST || '127.0.0.1',
  port = Number(Bun.env.PORT || 4173),
  development = false,
  room = new GameRoom(),
} = {}) {
  useServerMap();
  interface Viewer {
    stream: ReadableStreamDefaultController<Uint8Array>;
    area: CellBounds;
    token?: string;
  }
  const viewers = new Map<string, Viewer>();
  const defaultArea = cameraCells(JUNCTION, 800, 500);
  function broadcast(frameFor: (viewer: Viewer) => Uint8Array) {
    for (const [id, viewer] of viewers) {
      const { stream } = viewer;
      if ((stream.desiredSize ?? 0) <= 0) {
        viewers.delete(id);
        stream.error(new Error('Client fell behind.'));
      } else stream.enqueue(frameFor(viewer));
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
                stream.enqueue(new TextEncoder().encode('event: viewer\ndata: ' + id + '\n\n'));
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
      (message) => {
        const frame = encodeChat({ type: 'message', message });
        broadcast(() => frame);
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
    stop() {
      clearInterval(timer);
      for (const { stream } of viewers.values()) stream.close();
      viewers.clear();
      return server.stop(true);
    },
  };
}

if (import.meta.main) {
  const server = createGameServer({ development: Bun.env.NODE_ENV === 'development' });
  console.log('Manchester Drive listening on ' + server.url);
}
