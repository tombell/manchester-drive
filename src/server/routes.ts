import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { LiveChatEvent } from '../protocol/chat';
import type { Player } from '../game/game-types';
import {
  chatCommand,
  inputCommand,
  doorCommand,
  raceCommandBody,
  viewCommand,
} from '../protocol/commands';
import type { GameRoom, RoomSession } from './room';

type Variables = { body: Record<string, unknown>; session: RoomSession };
const commandBody = z.record(z.string(), z.unknown());

export function createRoutes(
  room: GameRoom,
  publishChat: (event: LiveChatEvent, sender: Player) => void,
  updateView: (view: z.output<typeof viewCommand>) => boolean,
) {
  const api = new Hono<{ Variables: Variables }>();
  api.use(async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  const authenticatedCommands = ['/input', '/leave', '/race', '/vehicle', '/chat'];
  api.on(
    'POST',
    ['/join', '/view', ...authenticatedCommands],
    bodyLimit({ maxSize: 2048, onError: (c) => c.json({ error: 'Request too large.' }, 413) }),
    async (c, next) => {
      const origin = c.req.header('Origin');
      if (origin && URL.parse(origin)?.host !== c.req.header('Host'))
        return c.json({ error: 'Open the game on this host.' }, 403);
      // pagehide sends /leave as a text/plain beacon containing JSON.
      const body = commandBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: 'Invalid request.' }, 400);
      c.set('body', body.data);
      await next();
    },
  );

  api.post('/view', (c) => {
    const view = viewCommand.safeParse(c.var.body);
    if (!view.success) return c.json({ error: 'Invalid camera area.' }, 400);
    return updateView(view.data) ? c.json({}) : c.json({ error: 'View disconnected.' }, 404);
  });
  api.post('/join', (c) => {
    const body = c.var.body;
    const result = room.join(typeof body.name === 'string' ? body.name : '', body);
    return 'error' in result ? c.json(result, 409) : c.json(result, 201);
  });
  api.on('POST', authenticatedCommands, async (c, next) => {
    const { token } = c.var.body;
    const session = typeof token === 'string' && room.sessionFor(token);
    if (!session) return c.json({ error: 'Your car left the junction. Join again.' }, 401);
    c.set('session', session);
    await next();
  });
  api.post('/input', (c) => {
    const result = inputCommand.safeParse(c.var.body);
    if (result.success) room.input(c.var.session, result.data);
    return c.json({});
  });
  api.post('/vehicle', (c) => {
    const result = doorCommand.safeParse(c.var.body);
    if (!result.success) return c.json({ error: 'Please try the door again.' }, 409);
    const error = room.vehicle(c.var.session, result.data);
    return error ? c.json({ error }, 409) : c.json({});
  });
  api.post('/chat', (c) => {
    const result = chatCommand.safeParse(c.var.body);
    if (!result.success)
      return c.json({ error: 'Enter a message within the character limit.' }, 400);
    const { text, channel } = result.data;
    const { player } = c.var.session;
    publishChat(
      channel === 'local'
        ? { type: 'local', playerId: player.id, text }
        : { type: 'message', message: room.chat(c.var.session, text) },
      player,
    );
    return c.json({}, 201);
  });
  api.post('/race', (c) => {
    const result = raceCommandBody.safeParse(c.var.body);
    if (!result.success) return c.json({ error: 'Invalid race command.' }, 409);
    const error = room.race(c.var.session, result.data);
    return error ? c.json({ error }, 409) : c.json({});
  });
  api.post('/leave', (c) => {
    room.leave(c.var.session);
    return c.json({});
  });
  api.notFound((c) => c.json({ error: 'Unknown route.' }, 404));
  return api;
}
