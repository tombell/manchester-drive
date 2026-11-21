import type { Player, Position, World } from '../game/game-types';
import { cellKey, SpatialGrid, type CellBounds } from '../game/spatial';
import { encodeSnapshot } from '../protocol/snapshots';
import { areaKey, cameraCells, viewCellSize } from '../protocol/view';

function inArea(area: CellBounds, p: Position) {
  const col = Math.floor(p.x / viewCellSize),
    row = Math.floor(p.y / viewCellSize);
  return col >= area.left && col <= area.right && row >= area.top && row <= area.bottom;
}

// A single simulation owns every actor. Cameras with the same coverage share encoded frames.
export function neighbourhoodFrames(world: World) {
  const cars = new SpatialGrid(viewCellSize, world.traffic);
  const people = new SpatialGrid(viewCellSize, world.people);
  const players = new SpatialGrid(
    viewCellSize,
    world.players.map(({ parkedCar, ...body }) => ({
      ...body,
      parkedCarId: parkedCar?.id ?? null,
    })),
  );
  const parked = new SpatialGrid(
    viewCellSize,
    world.players.flatMap((p) => (p.parkedCar ? [p.parkedCar] : [])),
  );
  const frames = new Map<string, Uint8Array>();
  return (camera: CellBounds, driver?: Player) => {
    const local = driver && cameraCells(driver, 0, 0);
    const extra =
      local &&
      (local.left < camera.left ||
        local.right > camera.right ||
        local.top < camera.top ||
        local.bottom > camera.bottom)
        ? local
        : undefined;
    const parking = driver?.parkedCar;
    const marker =
      parking && !inArea(camera, parking) && !(extra && inArea(extra, parking))
        ? parking
        : undefined;
    const areas = extra ? areaKey(camera) + '/' + areaKey(extra) : areaKey(camera);
    const key = marker ? areas + '/' + marker.id : areas;
    let frame = frames.get(key);
    if (!frame) {
      function visible<T extends Position>(grid: SpatialGrid<T>) {
        const inView = grid.inCells(camera);
        return extra ? [...new Set([...inView, ...grid.inCells(extra)])] : inView;
      }
      frame = encodeSnapshot({
        time: world.time,
        race: world.race,
        playerCount: world.players.length,
        players: visible(players),
        parkedCars: visible(parked),
        traffic: visible(cars),
        people: visible(people),
        parkingPosition: marker && { x: marker.x, y: marker.y },
      });
      frames.set(key, frame);
    }
    return frame;
  };
}

// Wake one extra row of cells before an NPC becomes visible or reaches a player.
export function activeCells(views: Iterable<CellBounds>, players: Player[]) {
  const active = new Set<number>();
  const included = new Set<string>();
  function include(area: CellBounds) {
    const key = areaKey(area);
    if (included.has(key)) return;
    included.add(key);
    for (let col = area.left - 1; col <= area.right + 1; col++) {
      for (let row = area.top - 1; row <= area.bottom + 1; row++) active.add(cellKey(col, row));
    }
  }
  for (const view of views) include(view);
  for (const player of players) include(cameraCells(player, 0, 0));
  return active;
}
