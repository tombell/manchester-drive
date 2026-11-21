# Manchester Drive

Start at Piccadilly Gardens and explore Greater Manchester as far as the M60 on streets drawn from OpenStreetMap. One Bun process hosts a shared room with no fixed player limit. New drivers start in the Piccadilly bays or on a nearby clear street when the bays are occupied.

## Play

Use Bun 1.4.4. From this directory, install the locked dependencies and start the game.

```fish
bun install --frozen-lockfile
bun start
```

Open [the game](http://127.0.0.1:4173) in two browser windows, choose a name, vehicle, jacket and skin tone, then select **Drive**. The hatchback has balanced handling, the sports coupé accelerates faster and the panel van is longer with a wider turning circle. Use **W** to accelerate, **S** to brake and then reverse, and **A/D** to steer. Touch devices have on-screen controls. Stop and press **E** or select **Get out** to park. Walk with **WASD** or the on-screen arrows. The dashboard points back to your car. Stand beside either door and press **E** or **Enter car** to drive again. Other players can see your character and parked car. **Leave game** removes your character and car from the room.

Select **Free cam** to explore before joining, while driving or on foot. Drag the map with a mouse or finger, or pan with **WASD** or the **arrow keys**. Press **Esc** or use the camera button to return. If you already have a car, it coasts while the camera is detached.

Global chat stays visible in the bottom-left corner. Click the message field or press **T** to type, **Enter** to send and **Esc** to return to the game. Joined players can send messages from anywhere on the map, including on foot and in free cam. Spectators can read along. The room keeps its most recent 50 messages in memory until the server restarts.

Brake lights brighten red as drivers slow down. NPCs hold them on while waiting at lights, in queues, or at a crossing. Hold **S** while moving forward to brake, then keep holding it to reverse with white rear lights.

From the starting bays on Piccadilly, turn left onto Lever Street. Continue past Dale Street and Stevenson Square, then turn left onto Faraday Street. Take Spear Street to Hilton Street and return down Oldham Street to Piccadilly.

## Race a lap

Two drivers select **Drive** in the same room. One selects **Open race** and the other selects **Join race**. Both cars move to a clear grid on Piccadilly beside the gardens. The three-second countdown ends together. Traffic, pedestrians and free-drivers stay on the road.

Follow the dotted racing line and cross the gold gates on Lever Street, Faraday Street, Hilton Street and Oldham Street. The arrow points towards an off-screen gate. At the gate it shows the crossing direction. If you miss one, return and cross it in that direction. The chequered finish on Piccadilly counts after all four gates. Both racers see the server's finish order and lap times.

Use **Leave race** to return to free driving. Before the start, the other driver can wait for a replacement. Getting out of the car also withdraws you. After the start, withdrawing or disconnecting records a DNF. Select **Race again** to open another race.

For two devices on the same local network, start a LAN-accessible room on port 4174.

```fish
env HOST=0.0.0.0 PORT=4174 bun start
```

Both drivers open the host computer's LAN address on port 4174. Set `PORT` to use a different port. The default bind address is loopback. Stop the server with Ctrl-C.

For development, `bun run dev` watches the server and client sources. For production, `bun run build` creates a standalone executable for the build platform at `dist/manchester-drive`. The Dockerfile builds the Linux executable for Fly.io and runs it as an unprivileged user. Both modes use the same `HOST` and `PORT` settings.

## Verify

```fish
bun run typecheck
bun test
```

The tests cover driving and reversing, collisions and recovery, clear spawns, traffic signals, pedestrian crossings, full driving laps, turning traffic, race staging, directional checkpoints, finish order and two clients observing the same server state.

For a playtest, leave one browser on Piccadilly and pan north in the other to watch traffic on Shudehill. Bring the cameras back together at the Lever Street crossing near Dale Street. Check that both drivers see the same pedestrian and waiting traffic. Watch the gap between queued cars at a red light. Tap a parked car, then try a faster bump and a glancing hit against a building. Check both views as one driver leaves and rejoins.

## Load testing

Run the dedicated fixture with `bun run load:server`. From a second terminal, run either scenario:

```fish
bun run load:test crowd 32 60
bun run load:test spread 32 60
```

The arguments select the layout, number of connected players and measurement duration in seconds. The fixture places drivers in clear mapped bays near Piccadilly or across eight locations. Each client reads its own event stream and sends driving or walking input. Some players park or use free cam. Collection starts after six seconds of warm-up.

For measurements across two private hosts, set `HOST` on the game host to its private bind address. Set `FIXTURE_URL` on the load generator to the game host's private control URL. The control port defaults to 4174 and the game port to 4173. Use the dedicated fixture on a private network. It includes benchmark controls and spawn placement that the deployed game does not expose.

The runner prints a JSON record with simulation rate, fixed-step processing time (including snapshot publication), peak game-process RSS, received SSE bandwidth, frames per client, input HTTP acknowledgement latency and failures. Timing excludes browser rendering. Run scenarios sequentially so the room is empty at the start of each run.

## Implementation

The game runs as one Bun application. Its source is organised by responsibility.

| Directory | Responsibility |
| --- | --- |
| `src/client/` | Browser entry point, controls, camera, HUD, canvas rendering and network client |
| `src/game/` | World simulation, physics, races, garage choices and the generated Manchester map shared by client and server |
| `src/protocol/` | Command schemas, join credentials and the world snapshot format |
| `src/server/` | The live game room, Hono command routes and Bun HTTP and event-stream handling |

The HTTP routes validate incoming commands and pass them to the room. The room owns player sessions, input ordering and simulation time. It can run directly in a test with a controlled clock.

Players and nearby NPCs update at 60 Hz. Unobserved NPCs continue their routes at 10 Hz, with collision and crossing checks. Every browser receives 15 snapshots per second over Server-Sent Events. Each snapshot includes the drivers, walkers, parked cars and NPCs near the camera and the driver. A player on foot also receives directions to their own parked car. The player count, races and chat are shared across the room. Each browser sends sequenced control changes over HTTP, predicts its own car between snapshots and interpolates other road users. A lost heartbeat releases the controls and eventually removes the car. The shared room lasts for the lifetime of the server.

Cars and walkers collide with buildings, vehicles, other players and the edge of the playable area. Cars also stop at the banks of mapped water and can cross it on road bridges. Tree trunks, bus stop poles, fingerposts, traffic lights, benches, fixed bollards, litter bins, pillar boxes and planters also have solid bases. You can pass under branches and behind signs. Traffic follows four mapped circuits across Piccadilly, Shudehill and the Northern Quarter, brakes for queues and crossings, and indicates before turning. Signal timings and lane positions are game approximations. Free driving allows either direction. The race and all traffic routes follow mapped motorcar access and one-way directions.

## Map data

The playable area covers about 202.5 km² inside and along the M60, north up at five game pixels per metre. The boundary follows the mapped motorway and its connecting ramps, with a shoulder outside the carriageways so you can drive the orbital. Traffic and the checkpoint race run around Piccadilly Gardens and the Northern Quarter.

Street geometry, buildings, paths, trees, tram tracks, parks and water come from OpenStreetMap. The importer keeps individual carriageways, motorway links and pedestrianised streets. It uses mapped widths where available and estimates the rest from lanes and street class. The renderer uses mapped road layers at bridges and tunnels. Driving physics remain two-dimensional.

The starting district is bundled with the game. Elsewhere the browser requests 288-metre map squares from the game server as you explore. The server uses the same squares for collisions. The production executable embeds the map and play requires no external map service or API key.

Map data © OpenStreetMap contributors. The derived database consists of the [starting district](src/game/manchester-map.ts) and the [regional archive, index and boundary](src/game/map), distributed under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). [OpenStreetMap copyright](https://www.openstreetmap.org/copyright)

### Refresh the map

The central XML extract was retrieved on 20 November 2026. Its importer checks that selected race and traffic route ways connect and permit travel in the chosen direction. If a mapper splits a way or changes access, review the affected legs before refreshing.

```fish
python3 -m venv /tmp/manchester-map-tools
/tmp/manchester-map-tools/bin/pip install osmium==4.3.2 shapely==2.0.7
curl --fail --location 'https://api.openstreetmap.org/api/0.6/map?bbox=-2.2463,53.4760,-2.2262,53.4865' -o /tmp/manchester-centre.osm
/tmp/manchester-map-tools/bin/python scripts/import-map.py /tmp/manchester-centre.osm
```

The regional archive uses the 19 November 2026 OpenStreetMap snapshot. To refresh it, download Geofabrik’s Greater Manchester PBF and run the regional importer. Both importers use the Python environment above to cut drivable road surfaces out of the water polygons. [Geofabrik extract](https://download.geofabrik.de/europe/united-kingdom/england/greater-manchester/index.html)

```fish
curl --fail --location 'https://download.geofabrik.de/europe/united-kingdom/england/greater-manchester/greater-manchester-latest.osm.pbf' -o /tmp/greater-manchester.osm.pbf
/tmp/manchester-map-tools/bin/python scripts/import-region.py /tmp/greater-manchester.osm.pbf
bun test
```
