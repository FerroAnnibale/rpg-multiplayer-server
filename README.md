# RPG Maker MV multiplayer server

The server provides global and private chat, same-map player visibility and
interactions, item trades, saved player accounts, persistent Character Creator
appearances, moderation, and administrator commands. Account records and
moderation state are stored in PostgreSQL; the game itself still does not
synchronize maps, battles, quests, or save files.

## Database and server configuration

Use a durable PostgreSQL database such as Neon. Create a database and copy its
connection string (including `sslmode=require`). On Render, add these environment
variables under the multiplayer web service's **Environment** settings:

- `DATABASE_URL`: the PostgreSQL connection string.
- `LOBBY_PASSWORD`: the existing shared lobby code (at least 16 characters).
- `ADMIN_USERNAME`: `Ferro`.
- `ADMIN_BOOTSTRAP_SECRET`: a private random secret of at least 32 characters.
- `MAX_PLAYERS`: optional; defaults to `20`.

Keep the database URL, lobby code, and bootstrap secret out of the game files
and source control. The bootstrap secret is required only when creating the
first account named `Ferro`; the admin role is assigned by the server, never by
the client. Keep it private and rotate it after registration.

For local development, install Node.js and run `npm install` from this folder.
In PowerShell, configure the same values and start the service:

```powershell
$env:DATABASE_URL = Read-Host "Neon PostgreSQL connection string"
$secureLobby = Read-Host "Lobby code" -AsSecureString
$env:LOBBY_PASSWORD = [Net.NetworkCredential]::new("", $secureLobby).Password
$env:ADMIN_USERNAME = "Ferro"
$secureBootstrap = Read-Host "Admin bootstrap secret" -AsSecureString
$env:ADMIN_BOOTSTRAP_SECRET = [Net.NetworkCredential]::new("", $secureBootstrap).Password
npm start
```

The server creates its account table automatically on startup. PostgreSQL
stores unique usernames (case-insensitive), scrypt password hashes, saved
Character Creator appearance data, bans, and mutes. The health check is
available at `http://localhost:3000/`.

## Register and log in

At the title screen, each player chooses **Registrati** the first time and
enters a unique name, a password of at least 12 characters, and the shared
lobby code. Names use 3-24 ASCII letters, numbers, or underscores and are
case-insensitive. On later visits, players choose **Accedi** with the same
account credentials and lobby code. Account credentials are not stored in the
game's save file.

The first registration using the configured admin name also requires the
bootstrap secret. After creating the `Ferro` account, rotate that secret in
Render and keep the replacement configured for server startup. Passwords are
stored as salted scrypt hashes.

Character Creator appearance metadata is saved to the account record and sent
to other players when they join, including after server or browser restarts.
If the local save has no appearance, the game restores the account's saved
appearance when the account logs in.

## Player interactions

Click another visible player on the same map to open the interaction panel;
the click still sets the map destination. Players can start a private chat
(press Enter or click **Invia**) or request an item trade. Private messages are
delivered only to the two participants and are not saved. Trades support one
offer per player at a time: an unequipped inventory item, weapon, or armor and
a quantity. Both players must confirm; the game checks each local inventory
and available capacity before applying the exchange. Leaving the map,
disconnecting, or closing the trade cancels it. These exchanges update each
player's local save; the server does not synchronize inventories or game
progress.

The client and server must both include the interaction protocol. If a request
is not acknowledged, update the hosted server from this `server.js`; until then
the client reports that the feature may be unavailable rather than waiting
indefinitely.

## Global chat and admin commands

Press Enter on a map to open global chat. Normal messages are visible to
everyone. Only the server-authorized admin account can use commands beginning
with `!`:

- `!kick nome` disconnects an online player.
- `!ban nome [minuti]` blocks an account from logging in; without a duration
  the ban is permanent. Timed bans accept 1-525600 minutes.
- `!unban nome` removes a ban.
- `!mute nome [minuti]` blocks chat; without a duration the mute is permanent.
- `!unmute nome` removes a mute.
- `!item nome id quantita` grants a database item to that online player's
  local party.
- `!weapon nome id quantita` and `!armor nome id quantita` grant equipment.
- `!actor nome id` and `!unactor nome id` add or remove a party member.
- `!help` prints the command list.

Item and actor commands are delivered only to the named player while online.
They affect that player's local game save and require matching game database
IDs; offline commands are not queued. The game does not synchronize inventory,
party membership, battles, or progress between players.

## Hosting

Set the `Server URL` plugin parameter to `ws://localhost:3000` for local tests
or `wss://rpg-multiplayer-server-get3.onrender.com` for the hosted server.
Use `wss://` for internet play; browsers block insecure WebSockets from
HTTPS-hosted games. Free Render services can spin down after inactivity, so
the first connection may take around a minute to wake up.
