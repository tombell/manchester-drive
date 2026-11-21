import { chatHistoryLimit, type ChatMessage } from '../protocol/chat';
import { cellKey, type CellBounds } from '../game/spatial';
import { viewCellSize } from '../protocol/view';
import { activeCells } from './neighbourhoods';
import type { Player, Position, World } from '../game/game-types';
import type { GarageOptions } from '../game/garage';
import { raceCommand, withdraw } from '../game/race';
import { COLORS, createWorld, findRaceGrid, placePlayer, step, useCar } from '../game/world';
import type { Credentials, DoorCommand, InputCommand, RaceCommand } from '../protocol/commands';

export interface RoomSession {
  readonly token: string;
  readonly player: Player;
  lastInputAt: number;
  sequence: number;
}

const stepSeconds = 1 / 60;

export class GameRoom {
  readonly world = createWorld();
  readonly chatHistory: ChatMessage[] = [];
  private readonly sessions = new Map<string, RoomSession>();
  private readonly inputs = new Map<string, number>();
  private readonly npcSchedule = new WeakMap<Position, { lastTick: number; phase: number }>();
  private nextPhase = 0;
  private accumulator = 0;
  private tick = 0;

  constructor(
    private readonly now = Date.now,
    private readonly recordTick?: (milliseconds: number) => void,
  ) {}

  join(
    name: string,
    options: GarageOptions = {},
    positions?: Iterable<number[]>,
  ): Credentials | { error: string } {
    const id = crypto.randomUUID();
    const usage = new Map<string, number>();
    for (const { color } of this.world.players) usage.set(color, (usage.get(color) ?? 0) + 1);
    const color = COLORS.reduce((best, next) =>
      (usage.get(next) ?? 0) < (usage.get(best) ?? 0) ? next : best,
    );
    const player = placePlayer(
      id,
      name.trim().slice(0, 16) || 'Driver',
      color,
      this.world,
      options,
      positions,
    );
    if (!player) return { error: 'Could not find a clear starting position. Try again shortly.' };

    const token = crypto.randomUUID();
    this.sessions.set(token, { token, player, lastInputAt: this.now(), sequence: -1 });
    this.world.players.push(player);
    return { id, token };
  }

  sessionFor(token: string) {
    return this.sessions.get(token);
  }

  leave(session: RoomSession) {
    const id = session.player.id;
    withdraw(this.world, id);
    this.world.players = this.world.players.filter((p) => p.id !== id);
    this.inputs.delete(id);
    this.sessions.delete(session.token);
  }

  private acceptSequence(session: RoomSession, sequence: number) {
    if (sequence <= session.sequence) return false;
    session.sequence = sequence;
    session.lastInputAt = this.now();
    return true;
  }

  input(session: RoomSession, command: InputCommand) {
    if (!this.acceptSequence(session, command.seq)) return;
    if (command.onFoot === !!session.player.parkedCar)
      this.inputs.set(session.player.id, command.keys);
  }

  vehicle(session: RoomSession, command: DoorCommand) {
    if (!this.acceptSequence(session, command.seq)) return 'Please try the door again.';
    this.inputs.set(session.player.id, 0);
    return useCar(this.world, session.player, command.action);
  }

  chat(session: RoomSession, text: string): ChatMessage {
    const { name, color } = session.player;
    const message = { id: crypto.randomUUID(), name, color, text };
    this.chatHistory.push(message);
    if (this.chatHistory.length > chatHistoryLimit) this.chatHistory.shift();
    return message;
  }

  race(session: RoomSession, command: RaceCommand) {
    return raceCommand(this.world, session.player, command.action, command.raceId, findRaceGrid);
  }

  advance(
    elapsedSeconds: number,
    publish: (world: World) => void,
    views: Iterable<CellBounds> = [],
  ) {
    const now = this.now();
    for (const session of this.sessions.values()) {
      const idle = now - session.lastInputAt;
      if (idle > 15_000) this.leave(session);
      else if (idle > 2_500) this.inputs.set(session.player.id, 0);
    }

    const active = activeCells(views, this.world.players);
    const npcStep = (actor: Position) => {
      const tick = this.tick + 1;
      let schedule = this.npcSchedule.get(actor);
      if (!schedule) {
        schedule = { lastTick: this.tick, phase: this.nextPhase++ % 6 };
        this.npcSchedule.set(actor, schedule);
      }
      // Spread quiet streets across six ticks. Waking consumes exactly the time since the last move.
      const cell = cellKey(Math.floor(actor.x / viewCellSize), Math.floor(actor.y / viewCellSize));
      if (tick % 6 !== schedule.phase && !active.has(cell)) return 0;
      const elapsed = (tick - schedule.lastTick) * stepSeconds;
      schedule.lastTick = tick;
      return elapsed;
    };

    this.accumulator += Math.min(elapsedSeconds, 0.2);
    while (this.accumulator >= stepSeconds) {
      const start = this.recordTick ? performance.now() : 0;
      step(this.world, this.inputs, stepSeconds, npcStep);
      this.accumulator -= stepSeconds;
      if (++this.tick % 4 === 0) publish(this.world);
      if (this.recordTick) this.recordTick(performance.now() - start);
    }
  }
}
