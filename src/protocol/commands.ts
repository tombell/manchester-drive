import { z } from 'zod';
import { maxViewSpan } from './view';
import { chatTextLimit } from './chat';
import type { Appearance } from '../game/garage';

export interface Credentials {
  id: string;
  token: string;
}

const coordinate = z.int().min(-2048).max(2048);
export const viewCommand = z.object({
  viewer: z.uuid(),
  token: z.string().optional(),
  area: z
    .object({ left: coordinate, right: coordinate, top: coordinate, bottom: coordinate })
    .refine(
      ({ left, right, top, bottom }) =>
        right >= left && right - left < maxViewSpan && bottom >= top && bottom - top < maxViewSpan,
    ),
});

export const inputCommand = z.object({
  seq: z.int(),
  keys: z.int().min(0).max(15),
  onFoot: z.boolean().default(false),
});
export const chatCommand = z.object({
  text: z.string().trim().min(1).max(chatTextLimit),
  channel: z.enum(['global', 'local']).default('global'),
});
export const doorCommand = z.object({ seq: z.int(), action: z.enum(['enter', 'exit']) });
export const raceCommandBody = z.object({
  action: z.enum(['open', 'join', 'withdraw']),
  raceId: z.string().nullable(),
});

export type InputCommand = z.output<typeof inputCommand>;
export type DoorCommand = z.output<typeof doorCommand>;
export type RaceCommand = z.output<typeof raceCommandBody>;

type Token = Pick<Credentials, 'token'>;
export interface Commands {
  '/view': z.input<typeof viewCommand>;
  '/join': Appearance & { name: string };
  '/leave': Token;
  '/chat': Token & z.input<typeof chatCommand>;
  '/input': Token & z.input<typeof inputCommand>;
  '/vehicle': Token & z.input<typeof doorCommand>;
  '/race': Token & z.input<typeof raceCommandBody>;
}
