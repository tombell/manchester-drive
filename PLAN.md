# Accounts, characters, first car and starting areas

Players can sign up, design a character, pick and customise a first car, and choose where they start. Guests can still play without an account. The game stays easy to deploy as a single Fly machine.

## Decisions

- **Guests stay.** Spectating and guest play work as they do now. Guests save nothing.
- **One character per account** to start with.
- **Players will acquire more vehicles later.** The schema treats vehicles as owned items from day one.
- **SQLite, no Redis yet.** See below.

## Storage

The game already runs as one Bun process with the whole world in memory (`GameRoom`, sessions, viewers). SQLite on a Fly volume also ties the app to one machine. Sessions, profiles and rate limits can therefore be cached in process memory, which is faster and costs nothing. Redis would add a second service, a secret and a network hop per request with no benefit. Reconsider it if the game moves to several rooms on several machines. That change also needs shared presence, chat fan-out, and either Postgres or LiteFS.

- Use `bun:sqlite`. It is built into Bun, works with `bun build --compile` and adds no dependency.
- `src/server/db.ts` opens `Bun.env.DATABASE_PATH ?? 'data/game.db'` and sets `PRAGMA journal_mode=WAL; foreign_keys=ON; busy_timeout=5000`. It runs migrations at startup, tracked with `PRAGMA user_version`.
- Tests use `:memory:`.

```sql
users      (id TEXT PK, username TEXT UNIQUE COLLATE NOCASE, password_hash TEXT,
            created_at INT, start_area TEXT, active_vehicle_id TEXT,
            credits INT NOT NULL DEFAULT 0)
sessions   (token_hash TEXT PK, user_id TEXT REFERENCES users ON DELETE CASCADE,
            expires_at INT)
characters (user_id TEXT PK REFERENCES users ON DELETE CASCADE,
            figure TEXT NOT NULL CHECK (figure IN ('feminine','masculine')),
            skin TEXT NOT NULL, hair_style TEXT NOT NULL, hair TEXT NOT NULL,
            jacket TEXT NOT NULL, trousers TEXT NOT NULL, updated_at INT)
vehicles   (id TEXT PK, user_id TEXT REFERENCES users ON DELETE CASCADE,
            model TEXT, paint TEXT, trim TEXT, stripe TEXT, plate TEXT,
            acquired_via TEXT CHECK (acquired_via IN ('starter','purchase','reward')),
            acquired_at INT)
CREATE UNIQUE INDEX one_starter ON vehicles(user_id) WHERE acquired_via = 'starter';
```

`characters` is keyed by `user_id`. Supporting several characters per account later means giving it its own `id` and adding `users.active_character_id`, a small migration.

## Accounts

- Username and password. Passwords are hashed with `Bun.password` (argon2id).
- Login sets a 30-day `HttpOnly; Secure; SameSite=Lax` session cookie. The database stores only the SHA-256 of the token.
- Hono routes: `/account/signup`, `/account/login`, `/account/logout` and `/account/me`.
- Failed logins are rate-limited in memory, per IP and per username.
- Room tokens stay as they are. `/join` reads the account cookie when present and loads the stored character and active vehicle, ignoring any appearance fields in the request body. It still returns `{ id, token }`, so `/input`, `/vehicle`, `/race`, `/chat` and `/leave` are unchanged.
- A player's in-game and chat name is their username, so it is unique and cannot be spoofed.
- There is no password reset without email. Add email or passkeys later.

### Guests

- A guest sends a name, starter-only car and outfit options, and a starting area in the `/join` body, as today.
- `/join` rejects a guest name that matches a registered username (case-insensitive).
- Guests carry a "guest" tag on their name and in chat.
- Signing up during a guest session prefills the character creator and first-car screen with the guest's current look.

## Character design

The on-foot sprite is about 8px seen from above, so customisation uses palettes and outline changes rather than detailed art.

- **Figure:** feminine or masculine appearance only. It is not a gender field and nothing else in the game reads it.
  - Masculine: shoulders 1px wider, the current torso.
  - Feminine: narrower shoulders, a slightly shorter stride, and a waist taper. Picking that trousers option swaps in a 1px wider skirt or dress outline.
- **Hair style:** short, long, ponytail (sways with the stride) or bun. Every style works with either figure. At this size, hair style tells the two figures apart more than the body shape does.
- **Colours:** skin, hair, jacket and trousers palettes.
- `src/game/garage.ts` gains `figures`, `hairStyles`, `hairColours` and `trousers` next to `jackets` and `skinTones`. `appearance()` validates every key, on the server and the client, with fallbacks.
- `character()` in `src/client/renderer.ts` reads `figure`, `hair_style`, `hair` and `trousers` instead of the hard-coded hair and trouser colours.
- The creator screen shows a live, scaled-up preview drawn by the same `character()` function. The figure picker is two preview tiles labelled **Feminine** and **Masculine**.

## Vehicles

- The vehicle catalogue stays in code. Each entry in `models` in `garage.ts` gains `kind` (`'car' | 'van'`, so other vehicle types can fit later), `starter: boolean` and an optional `price`. New vehicles ship with a release, because each needs rendering and handling.
- **First car:** only models marked `starter` can be picked. The `one_starter` index stops a repeated request from creating a second free car.
- **Customisation is cosmetic:** curated paint palette, stripe or roof colour, and a plate of up to 7 characters shown on the name tag. Handling stays tied to the model so races stay fair.
- Paint replaces the server-assigned colour from `COLORS` in `room.join`. Chat names use the paint colour too.
- **Garage:** returning players see the vehicles they own, choose the active one and repaint it. Repainting is free for now.
- `credits` exists so earning (for example from races) and a shop can be added later. Nothing uses it yet.

## Starting area

- `src/game/areas.ts` holds about 8 curated named areas with a centre point. For example: Piccadilly (the default), Deansgate, Ancoats, Salford Quays, the Etihad, Didsbury, Chorlton and Old Trafford.
- `startingPositions(centre)` in `src/game/streets.ts` orders chunks by distance from the chosen centre instead of always starting from the Piccadilly bays.
- The picker shows the areas as pins on the existing minimap. Accounts store their choice in `users.start_area`, and guests pick one each time.
- A curated list is preferred over importing OSM suburbs: each area can be checked to have a clear road to start on.
- Later: an option to resume where the player last parked.

## Player flow

```
landing ─┬─ Spectate (free cam, as now)
         ├─ Play as guest: name, look, starter car, area → Drive
         └─ Sign up / Log in
              ├─ new account: Character → First car → Start area → Drive
              └─ returning: Drive (Garage to edit character, vehicles, area)
```

## Fly

```toml
[mounts]
  source = "data"
  destination = "/data"

[env]
  DATABASE_PATH = "/data/game.db"
```

```fish
fly volumes create data --size 1 --region lhr
fly scale count 1
```

- The volume mounts as root, but the image runs as `65532:65532`. Fix this with a startup `chown` or a different start step, chosen in phase 1.
- One volume means one machine. That is already effectively the case, because the room lives in memory. Deploys cause a short restart, as they do today.
- Fly takes daily volume snapshots. Add Litestream streaming to Tigris if losing up to a day of data becomes unacceptable.

## Phases

Each phase is a separate, reviewable commit.

1. Database module, migrations and the Fly volume, with no feature change.
2. Accounts and sessions, auth screens, reserved names and the guest tag.
3. Character creator: figures, hair styles, palettes, renderer support and a saved character.
4. First car: vehicle records, the starter-only rule, paint, stripe and plate, wired into `/join`.
5. Starting areas for guests and accounts.
6. Garage for returning players, guest-to-account carry-over and README updates.

## Tests

- Signup and login, including duplicate usernames, wrong passwords and expired sessions.
- `/join` with an account uses the stored character and active vehicle and ignores appearance in the body.
- `/join` rejects a guest name that matches a registered username.
- Invalid palette, figure or hair-style keys fall back safely.
- A first car with a non-starter model is rejected, and so is a second starter car.
- Players spawn inside or near their chosen area.
- Every figure and hair-style combination renders without reading a missing palette key.
