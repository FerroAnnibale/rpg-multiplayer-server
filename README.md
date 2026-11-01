# RPG Maker MV multiplayer server

This server provides one global chat and broadcasts player positions. The game
shows a remote character only when that player is on the same map.

## Run locally

1. Install Node.js.
2. From this folder, run `npm install`.
3. Choose a private code with at least 16 characters. Players will enter it in
   the in-game login prompt; configure it only on the server. Do not put the
   server code in a command-line argument or commit it to source control.
4. On Windows PowerShell, enter the code without putting it in the command
   history, then start the server:

   ```powershell
   $securePassword = Read-Host "Lobby code" -AsSecureString
   $env:LOBBY_PASSWORD = [Net.NetworkCredential]::new("", $securePassword).Password
   npm start
   ```

   Keep that terminal open while the server is in use. After stopping it, clear
   the environment variable with `$env:LOBBY_PASSWORD = $null`.
5. In RPG Maker MV's Plugin Manager, enable `Multiplayer` and set `Server URL`
   to `ws://localhost:3000`. For other computers on your LAN, replace
   `localhost` with the server computer's local IP address. Set a default
   `Player Name` if desired; players can change it at the login prompt.
6. At the title screen, enter the player name and shared lobby code before
   starting or continuing the game. The map remains paused until authentication
   succeeds. The code stays in memory for reconnects and is not saved in game
   files. Incoming messages appear briefly with a fade; press Enter to open the
   full chat.

The health check is available at `http://localhost:3000/`.

## Play with friends

For internet play, deploy the server behind a TLS reverse proxy with a real
domain and certificate. Point all clients to `wss://your-domain.example`, and
keep `LOBBY_PASSWORD` configured in the server's environment. Do not expose the
server over plain `ws://` on the internet: the shared code would be sent
unencrypted. Browsers also block insecure WebSockets from HTTPS-hosted games.

The shared code is entered at runtime rather than shipped inside the game
client. It is still a shared secret, not account-grade authentication. Use a
long random code, share it privately, and rotate it if it leaks. A domain, TLS
certificate, and hosting provider are not included in this project and must be
configured separately.

This first version synchronizes chat and locations only. It does not synchronize
events, battles, inventory, or game progress. The server accepts up to 20
connections by default; set `MAX_PLAYERS` or `PORT` in the server environment to
change its defaults.
