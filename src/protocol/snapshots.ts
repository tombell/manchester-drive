import type { ChatEvent } from './chat';
import type { Player, Position, Vehicle, World } from '../game/game-types';

export type VisiblePlayer = Omit<Player, 'parkedCar'> & { parkedCarId: string | null };

export interface Snapshot extends Omit<World, 'players'> {
  players: VisiblePlayer[];
  parkedCars: Vehicle[];
  playerCount: number;
  // Only the owner needs directions to a parked car outside the subscribed area.
  parkingPosition?: Position;
}

export function snapshotRoadUsers(snapshot: Snapshot) {
  return {
    vehicles: [
      ...snapshot.traffic,
      ...snapshot.parkedCars,
      ...snapshot.players.filter((p) => !p.parkedCarId),
    ],
    people: [...snapshot.people, ...snapshot.players.filter((p) => p.parkedCarId)],
  };
}

export const snapshotPath = '/events';
const encoder = new TextEncoder();

// Unnamed SSE events carry world snapshots. Chat uses a named event on the same stream.
export function encodeSnapshot(world: Snapshot) {
  return encoder.encode('data: ' + JSON.stringify(world) + '\n\n');
}

export function decodeSnapshot(data: string): Snapshot {
  return JSON.parse(data);
}

export function encodeChat(event: ChatEvent) {
  return encoder.encode('event: chat\ndata: ' + JSON.stringify(event) + '\n\n');
}
