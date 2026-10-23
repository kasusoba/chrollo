# chrollo

Discord bot that uploads photos and videos to Google Photos albums.

## Commands

```sh
docker compose up -d --build   # first time, or after code changes
docker compose up -d           # normal start
docker compose logs -f         # logs
docker compose down            # stop
```

## Channels and albums

The bot uploads from the channels listed in `UPLOAD_CHANNELS` (`src/utils.ts`): omoide and a private test channel (#bot-test). They can be in any server the bot is in. Each channel has its own album: run `/album` in that channel (or `/album channel:<name>` from a DM) to pick or create it. `album.json` stores one album per channel.

To add a channel: invite the bot to its server (OAuth2 URL with `bot` + `applications.commands`, permissions View Channels, Send Messages, Read Message History, Add Reactions), add the channel ID to `UPLOAD_CHANNELS`, redeploy, then run `/album` there.

## Health check

The bot checks Google, auth and the selected album at boot and every 10 minutes (`HEALTH_CHECK_INTERVAL_MINUTES`). When something breaks or recovers, it DMs `DISCORD_OWNER_ID`. A failure is rechecked after a minute before the DM goes out, so short blips stay quiet.

Run `/status` any time to see the current state, the last upload and what is waiting.

When something breaks, the alert DM has buttons for the fix: **Log in to Google**, **Recreate album** / **Choose album**, and **Check again**.

### When an upload can't go through

Members never have to post again. Photos that can't upload (Google down, login expired, album missing) are saved to `data/queue.json` and the message gets a ⏳. Once the health check sees everything working, they upload automatically, the bot's reply is edited and the ⏳ becomes ✅. The poster is only pinged when a file needs their action, e.g. a format Google Photos doesn't accept.

After adding or changing slash commands, register them once:

```sh
docker compose run --rm chrollo node dist/deployCommand.js
```

## Deploy on a Raspberry Pi

Works on a 64-bit Pi OS (arm64). Docker builds the image on the Pi, so you do not need Node or pnpm there.

### 1. Get the code and config

On the Pi:

```sh
git clone git@github.com:kasusoba/chrollo.git ~/software/chrollo
```

From the machine that has the config files:

```sh
scp .env tokens.json album.json <user>@<pi-host>:~/software/chrollo/
```

No `tokens.json` yet? Run `touch tokens.json album.json` on the Pi, then log in (step 5).

### 2. Edit `.env` on the Pi

```sh
PORT=5000
GOOGLE_REDIRECT_URI=https://chrollo.<tailnet>.ts.net/auth/callback
# Optional: temp media files go here (default ./tmp).
# Use an external disk to keep writes off the SD card.
TMP_DIR=/mnt/hdd/chrollo-tmp
```

Check that the port is free: `sudo ss -tlnp | grep :5000` must show nothing.

### 3. Start

```sh
docker compose up -d --build
docker compose ps        # STATUS must be "Up"
docker compose logs -f
```

The logs must show:

```
[GOOGLE] Loaded credentials from tokens.json
OAuth2 server listening on port 5000
Ready! On My Way! <bot tag>
[STARTUP] Google auth OK.
```

Stop the bot on any other machine. Two copies with one Discord token upload everything twice.

### 4. Tailscale Service (optional, for login from any device)

The port is bound to `127.0.0.1`, so other devices cannot reach it directly. A Tailscale Service gives it an HTTPS name on your tailnet.

1. Admin console, **Services**: add `chrollo`, port `tcp:443`. The Pi must be a tagged device (for example `tag:server`).
2. Policy file (`/admin/acls/file`), in `grants`:
   ```json
   {"src": ["autogroup:member"], "dst": ["svc:chrollo"], "ip": ["443"]},
   ```
3. On the Pi:
   ```sh
   sudo tailscale serve --bg --service=svc:chrollo --https=443 http://127.0.0.1:5000
   tailscale serve status
   ```
4. Approve the Pi as the service host in the admin console, if it is not auto-approved.
5. Test: `https://chrollo.<tailnet>.ts.net/` must show `kararanjut`.

### 5. Google OAuth

In Google Cloud Console, **Credentials**, your OAuth client, **Authorized redirect URIs**, add both:

```
https://chrollo.<tailnet>.ts.net/auth/callback
http://localhost:5000/auth/callback
```

No JavaScript origins are needed.

Log in with one of these:

- **With Tailscale:** open `https://chrollo.<tailnet>.ts.net/auth`.
- **Without Tailscale** (same network): open an SSH tunnel, then open `http://localhost:5000/auth` on that computer.
  ```sh
  ssh -L 5000:localhost:5000 <user>@<pi-lan-host>
  ```

The bot picks the callback from the address you open. Tokens refresh by themselves after the first login. If the OAuth app is in "Testing" mode, Google expires them after 7 days. Set it to "In production" to stop this.

### Update

```sh
cd ~/software/chrollo
git pull
docker compose up -d --build
```
