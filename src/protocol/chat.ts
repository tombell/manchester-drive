import type { Position } from '../game/game-types';

export const chatTextLimit = 240;
export const chatHistoryLimit = 50;
export const localChatMetres = 50;

export function withinEarshot(a: Position, b: Position) {
  return Math.hypot(a.x - b.x, a.y - b.y) <= localChatMetres * 5;
}

export interface ChatMessage {
  id: string;
  name: string;
  color: string;
  text: string;
}

export type LiveChatEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'local'; playerId: string; text: string };

export type ChatEvent = { type: 'history'; messages: ChatMessage[] } | LiveChatEvent;
