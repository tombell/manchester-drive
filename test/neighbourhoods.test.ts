import { expect, test } from 'bun:test';
import { createWorld, placePlayer, useCar } from '../src/game/world';
import { decodeSnapshot, snapshotRoadUsers } from '../src/protocol/snapshots';
import { cameraCells } from '../src/protocol/view';
import { neighbourhoodFrames } from '../src/server/neighbourhoods';

test('walking players and their parked cars remain independently visible and solid', () => {
  const world = createWorld();
  const ada = placePlayer('ada', 'Ada', 'red', world)!;
  world.players.push(ada);
  expect(useCar(world, ada, 'exit')).toBeUndefined();
  const car = ada.parkedCar!;
  const nearCar = cameraCells(car, 500, 300);
  const door = { x: ada.x, y: ada.y };
  Object.assign(ada, { x: 2100, y: 540 });
  const mo = placePlayer('mo', 'Mo', 'blue', world)!;
  world.players.push(mo);
  Object.assign(mo, { x: -2000, y: -2000 });
  const nearAda = cameraCells(ada, 500, 300);
  const frames = neighbourhoodFrames(world);
  const unpack = (b: Uint8Array) => decodeSnapshot(new TextDecoder().decode(b).slice(6).trim());
  const remoteCar = unpack(frames(nearCar));
  expect(remoteCar.playerCount).toBe(2);
  expect(remoteCar.players).toHaveLength(0);
  expect(remoteCar.parkedCars).toEqual([car]);
  expect(snapshotRoadUsers(remoteCar).vehicles.filter((v) => v.id === car.id)).toEqual([car]);

  const owner = unpack(frames(nearAda, ada));
  expect(owner.parkingPosition).toEqual({ x: car.x, y: car.y });
  const remoteWalker = unpack(frames(nearAda));
  expect(remoteWalker.parkingPosition).toBeUndefined();
  expect(remoteWalker.parkedCars).toHaveLength(0);
  expect(remoteWalker.players.map((p) => [p.id, p.parkedCarId])).toEqual([[ada.id, car.id]]);
  expect(snapshotRoadUsers(remoteWalker).people.some((p) => p.id === ada.id)).toBe(true);
  expect(snapshotRoadUsers(remoteWalker).vehicles.some((p) => p.id === ada.id)).toBe(false);

  const freeCam = unpack(frames(nearCar, ada));
  expect(freeCam.players.map((p) => p.id)).toEqual([ada.id]);
  expect(freeCam.parkedCars).toEqual([car]);
  expect(freeCam.parkingPosition).toBeUndefined();
  Object.assign(ada, door);
  expect(useCar(world, ada, 'enter')).toBeUndefined();
  const returned = unpack(neighbourhoodFrames(world)(nearCar));
  expect(returned.parkedCars).toHaveLength(0);
  expect(returned.players.map((p) => [p.id, p.parkedCarId])).toEqual([[ada.id, null]]);
  expect(snapshotRoadUsers(returned).vehicles.some((p) => p.id === ada.id)).toBe(true);
});
