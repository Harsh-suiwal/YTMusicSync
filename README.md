# MusicSync

Play the same YouTube Music playlist on your PC and your phone **at the same time, in sync**, using nothing but the **built-in speakers** of each device. No Bluetooth speaker, no extra hardware, no apps to install. Each device just opens a web page.

It runs as a small Node.js server on your PC (kept alive with pm2). Every device on your Wi-Fi opens the page, joins, and the server keeps them all playing the same song at the same moment.

## Features

- **Built-in speakers only.** Phone speaker + laptop speakers = a bigger, fuller sound. Nobody needs extra gear.
- **Auto-adjusting sync.** Each device measures its clock offset to the server with pings, then continuously corrects drift by nudging playback speed slightly (inaudible). Large drift triggers a hard seek.
- **Manual fine-tuning.** Per-device offset buttons (±10 ms / ±50 ms) for the delay the browser can't measure, like Bluetooth or slow speakers. Settings are saved on the server.
- **Per-device mute.** Mute the PC and only the phone plays, or the other way round.
- **Playlist import.** Paste a YouTube or YouTube Music playlist (or single song) link.
- **Gapless handoff between songs.** The next song is preloaded on every device and starts locally when the current one ends, with no network round trip, so transitions stay smooth.
- **Live console.** A built-in log panel shows server and client events and errors in real time, so you never have to dig through terminal output.
- **Device dashboard.** See every connected device, its ping, and its sync settings.

## How it works

1. The server (Express + WebSocket) holds the playback state: queue, current track, and an **anchor timestamp** (the server time at which position 0 of the current track plays).
2. Every client estimates its **clock offset** from the server with repeated pings, using the lowest-latency samples.
3. Each client computes `target position = (now + offset - anchor) + device offset`, and plays exactly there.
4. Every ~200 ms a sync loop compares the real position with the target:
   - small drift: playback rate is nudged by a few percent
   - large drift: hard seek
5. Audio comes from [yt-dlp](https://github.com/yt-dlp/yt-dlp), which downloads each track into a local `cache/` folder. The server serves it to all devices with HTTP Range support, so seeking works.
6. Each device preloads the next track and switches to it by itself when the current one ends. All devices compute the same next anchor (`old anchor + duration`), so they stay aligned without waiting for the network.

## Requirements

- **Node.js** 18 or newer
- **yt-dlp** (`pip install -U "yt-dlp[default]"`; the `[default]` extra includes the YouTube challenge solver)
- All devices on the **same Wi-Fi network** (some guest or hotspot networks isolate devices from each other, which breaks this)
- Optional but recommended: **pm2** (`npm i -g pm2`)

## Setup

```bash
git clone https://github.com/<your-username>/<your-repo>.git
cd <your-repo>
npm install
```

### 1. Install yt-dlp

```bash
pip install -U "yt-dlp[default]"
```

Find the executable path if it isn't on your PATH:

```bash
pip show -f yt-dlp      # look for ..\Scripts\yt-dlp.exe relative to the Location line
```

On Windows with the Microsoft Store Python, this lives somewhere under `AppData\Local\Packages\PythonSoftwareFoundation...\LocalCache\local-packages\Python3xx\Scripts\`. Alternatively, download the standalone `yt-dlp.exe` from the yt-dlp releases page.

### 2. Export your YouTube cookies

YouTube asks yt-dlp to prove it's not a bot. Reading cookies straight from Chromium browsers (Brave, Chrome) often fails on Windows, so use an exported file:

1. Open a **private/incognito window** and log in to youtube.com.
2. Use a "Get cookies.txt LOCALLY" style extension (allowed in private mode) to export the cookies for youtube.com.
3. Save the file as `cookies.txt` in the project folder.
4. Close the private window so YouTube doesn't rotate the cookies.

> **Warning:** `cookies.txt` is your logged-in YouTube session. It is git-ignored. **Never commit or share it.** Consider using a throwaway Google account.

Cookies expire after a few weeks. When the "Sign in to confirm you're not a bot" error returns, re-export them.

### 3. Configure

```bash
cp ecosystem.config.example.js ecosystem.config.js
```

Edit `ecosystem.config.js` and set `YTDLP` and `COOKIES_FILE` (double backslashes on Windows paths).

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default `3000`) |
| `YTDLP` | Path to the yt-dlp executable (default `yt-dlp`) |
| `COOKIES_FILE` | Path to your exported `cookies.txt` |
| `COOKIES_BROWSER` | Read cookies from a browser instead (often fails with Brave/Chrome on Windows; leave empty) |
| `YTDLP_JS_RUNTIME` | JS runtime for YouTube's challenge solver (default `node`) |
| `YTDLP_REMOTE_COMPONENTS` | Set to `1` to let yt-dlp fetch the solver script if it's missing |

### 4. Start with pm2

```bash
pm2 start ecosystem.config.js
```

> After changing environment values, use `pm2 delete musicsync` and then `pm2 start ecosystem.config.js`. `pm2 restart` does **not** reload env changes.

On startup the console prints the addresses, for example `http://192.168.x.x:3000`.

### 5. Allow the port through the firewall (Windows)

If your phone can't connect, run this in an admin terminal:

```bash
netsh advfirewall firewall add rule name="MusicSync" dir=in action=allow protocol=TCP localport=3000
```

## Usage

1. Open `http://<PC-LAN-IP>:3000` on the PC and on the phone (any browser; Brave and Chrome work well).
2. Enter a device name and tap **Join** on each device. This tap is required so the browser allows audio.
3. Paste a playlist or song link and press **Load**.
4. Play on both. Mute any device you don't want to hear from.
5. If two devices sound slightly echoey, adjust the offset on one of them until the echo disappears. It's saved for next time.

## Keeping screens awake (important on phones)

Mobile browsers pause or freeze background tabs when the screen turns off. That can stop audio at a song boundary. **Keep the phone's screen on while playing.**

- **Best option: Developer options -> "Stay awake"** (keeps the screen on while charging). Plug the phone in, turn brightness to minimum, and leave the page open.
- Alternatively, set the screen timeout to its longest value.
- Set the browser's battery usage to **Unrestricted** and exclude it from any "sleeping apps" or "deep sleep" list.
- The page includes a **Dim** overlay: a black full-screen layer that keeps the tab visible and awake while the display stays dark (low power on OLED screens). Tap it to bring the UI back.
- The Screen Wake Lock API can also help, but browsers only allow it on HTTPS or localhost. On plain `http://` LAN addresses it needs a browser flag (for example `brave://flags/#unsafely-treat-insecure-origin-as-secure`).

## Troubleshooting

The in-app **console** shows most errors. Common ones:

| Error | Cause | Fix |
|---|---|---|
| `spawn ... ENOENT` | yt-dlp not found | Set `YTDLP` to the full path, then `pm2 delete` and `pm2 start` |
| `Could not copy Chrome cookie database` | Browser cookie reading is blocked | Use `COOKIES_FILE` with an exported `cookies.txt`; leave `COOKIES_BROWSER` empty |
| `Sign in to confirm you're not a bot` | Missing or expired cookies | Re-export `cookies.txt` |
| `n challenge solving failed` / `Only images are available` | yt-dlp can't run YouTube's JS challenge | `pip install -U "yt-dlp[default]"`; make sure Node is on PATH; try `YTDLP_REMOTE_COMPONENTS=1` |
| Audio element `Format error` | Download failed earlier | Check the console for the yt-dlp error above it |
| Phone can't open the page | Firewall or network isolation | Add the firewall rule; make sure both devices are on the same non-isolated Wi-Fi |
| Audio stops when the phone screen turns off | Browser froze the background tab | See "Keeping screens awake" |
| Sudden failures after weeks of working | YouTube changed something | `pip install -U "yt-dlp[default]"` |

## Limitations

- Sync is typically within tens of milliseconds, not sample-accurate. In the same room you may still hear a faint echo; use the manual offset to tune it out.
- The first play of a song waits while it downloads. The next track is prefetched.
- There is **no authentication**. Anyone on your Wi-Fi who opens the page can control playback. Use it on a network you trust.
- Wi-Fi quality matters. Stable ping matters more than low ping.

## Legal note

MusicSync downloads audio with yt-dlp, which may conflict with YouTube's Terms of Service. This project is meant for **personal, private use** with content you have the right to listen to. You are responsible for how you use it. It is not affiliated with YouTube or Google.

## Project structure

```
server.js                      Express + WebSocket server, playback state, yt-dlp calls
public/index.html              Client: player, device dashboard, live console
ecosystem.config.example.js    pm2 config template (copy to ecosystem.config.js)
cache/                         Downloaded audio (git-ignored)
devices.json                   Saved per-device names, offsets, mute (git-ignored)
```

## Credits

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) for the downloading
- Inspired by [Beatsync](https://github.com/freeman-jiang/beatsync), which does multi-device sync for uploaded audio files