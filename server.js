const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP || 'yt-dlp';
const COOKIES_FILE = process.env.COOKIES_FILE || '';
const COOKIES_BROWSER = process.env.COOKIES_BROWSER || '';
const YTDLP_JS_RUNTIME = (process.env.YTDLP_JS_RUNTIME || 'node').trim() || 'node';
const YTDLP_REMOTE_COMPONENTS = process.env.YTDLP_REMOTE_COMPONENTS === '1';
const CACHE = path.join(__dirname, 'cache');
const DEVFILE = path.join(__dirname, 'devices.json');
const LEAD_MS = 2500; // time given to every device to load before playback starts

fs.mkdirSync(CACHE, { recursive: true });

// ---------- persisted per-device settings (offset, mute, name) ----------
let store = {};
let storeLoadError = null;
try { store = JSON.parse(fs.readFileSync(DEVFILE, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') storeLoadError = error; }
const saveStore = () => fs.writeFile(DEVFILE, JSON.stringify(store, null, 2), error => {
  if (error) log('error', 'server', 'Could not save devices.json: ' + error.message);
});

// ---------- http ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/audio/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^[\w-]{6,20}$/.test(id)) return res.sendStatus(400);
  try {
    await ensure(id);
    res.sendFile(path.join(CACHE, findFile(id))); // sendFile handles Range requests (seeking)
  } catch (e) {
    log('error', 'server', 'Audio request failed (' + id + '): ' + e.message);
    res.sendStatus(502);
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------- in-memory event log ----------
const LOG_LIMIT = 300;
const logEntries = [];
let logSequence = 0;

function log(level, source, message) {
  const entry = {
    id: Date.now() + '-' + (++logSequence),
    timestamp: new Date().toISOString(),
    level: ['info', 'warn', 'error'].includes(level) ? level : 'info',
    source: String(source || 'server').replace(/[\r\n\t]/g, ' ').slice(0, 80),
    message: String(message == null ? '' : message).slice(0, 2000)
  };
  logEntries.push(entry);
  if (logEntries.length > LOG_LIMIT) logEntries.splice(0, logEntries.length - LOG_LIMIT);
  console.log('[' + entry.timestamp + '] [' + entry.level.toUpperCase() + '] [' + entry.source + '] ' + entry.message);
  const packet = JSON.stringify({ type: 'log', entry });
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      try { client.send(packet); } catch {}
    }
  });
}

const clientSource = ws => ws.dev ? 'client:' + ws.dev.name : 'ws';
const errorText = error => error instanceof Error ? (error.stack || error.message) : String(error);

process.on('uncaughtException', error => {
  log('error', 'server', 'uncaughtException: ' + errorText(error));
});
process.on('unhandledRejection', reason => {
  log('error', 'server', 'unhandledRejection: ' + errorText(reason));
});
if (storeLoadError) log('warn', 'server', 'Could not load devices.json: ' + storeLoadError.message);

// ---------- yt-dlp helpers ----------
function ytDlpArgs(args) {
  const cookieArgs = COOKIES_FILE
    ? ['--cookies', COOKIES_FILE]
    : (COOKIES_BROWSER ? ['--cookies-from-browser', COOKIES_BROWSER] : []);
  const componentArgs = YTDLP_REMOTE_COMPONENTS
    ? ['--remote-components', 'ejs:github']
    : [];
  return [
    '--js-runtimes', YTDLP_JS_RUNTIME,
    ...componentArgs,
    ...cookieArgs,
    ...args
  ];
}

function findFile(id) {
  return fs.readdirSync(CACHE).find(f => f.startsWith(id + '.') && !f.endsWith('.part') && !f.endsWith('.ytdl'));
}

const inflight = new Map();
function ensure(id) {
  if (findFile(id)) return Promise.resolve();
  if (inflight.has(id)) return inflight.get(id);
  const p = new Promise((resolve, reject) => {
    const args = ytDlpArgs([
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '--no-playlist',
      '-o', path.join(CACHE, '%(id)s.%(ext)s'),
      'https://www.youtube.com/watch?v=' + id
    ]);
    const proc = spawn(YTDLP, args);
    let err = '';
    let settled = false;
    proc.stderr.on('data', d => {
      err = (err + d.toString()).slice(-500);
    });
    proc.on('error', e => {
      if (settled) return;
      settled = true;
      const tail = err.trim();
      log('error', 'yt-dlp', 'ensure(' + id + ') spawn failed: ' + e.message + (tail ? '\nstderr: ' + tail : ''));
      reject(e);
    });
    proc.on('close', code => {
      if (settled) return;
      settled = true;
      if (code === 0 && findFile(id)) return resolve();
      const tail = err.trim();
      const message = 'yt-dlp failed (exit ' + code + ')' + (tail ? '\nstderr: ' + tail : '');
      log('error', 'yt-dlp', 'ensure(' + id + ') ' + message);
      reject(new Error(tail || 'yt-dlp failed'));
    });
  }).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

function importPlaylist(url) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, ytDlpArgs(['--flat-playlist', '-J', url]), { maxBuffer: 200 * 1024 * 1024 }, (err, out, stderr) => {
      const tail = String(stderr || '').slice(-500).trim();
      if (err) {
        log('error', 'yt-dlp', 'importPlaylist failed: ' + err.message + (tail ? '\nstderr: ' + tail : ''));
        return reject(err);
      }
      try {
        const j = JSON.parse(out);
        const entries = j.entries || [j];
        resolve(entries.filter(e => e && e.id).map(e => ({ id: e.id, title: e.title || e.id, duration: e.duration || 0 })));
      } catch (e) {
        log('error', 'yt-dlp', 'importPlaylist returned invalid JSON: ' + e.message + (tail ? '\nstderr: ' + tail : ''));
        reject(e);
      }
    });
  });
}

// ---------- playback state ----------
let queue = [];
let cur = -1;
let loading = false;
let play = { playing: false, anchor: 0, pausedPos: 0 };

const position = () => (play.playing ? (Date.now() - play.anchor) / 1000 : play.pausedPos);

function stateMsg() {
  return { type: 'state', queue, cur, track: queue[cur] || null, loading, playing: play.playing, anchor: play.anchor, pausedPos: play.pausedPos };
}
const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const broadcast = m => wss.clients.forEach(ws => send(ws, m));
const broadcastState = () => broadcast(stateMsg());

function devicesMsg() {
  const list = [];
  wss.clients.forEach(ws => {
    if (!ws.dev) return;
    const s = store[ws.dev.id] || {};
    list.push({ id: ws.dev.id, name: s.name || ws.dev.name, rtt: ws.dev.rtt, offset: s.offset || 0, muted: !!s.muted });
  });
  return { type: 'devices', devices: list };
}
const broadcastDevices = () => broadcast(devicesMsg());

async function playIndex(i) {
  if (i < 0 || i >= queue.length) {
    play = { playing: false, anchor: 0, pausedPos: 0 };
    loading = false;
    return broadcastState();
  }
  cur = i; loading = true;
  play = { playing: false, anchor: 0, pausedPos: 0 };
  broadcastState();
  try { await ensure(queue[i].id); }
  catch (e) {
    loading = false;
    log('error', 'server', 'Could not start track ' + queue[i].title + ': ' + e.message);
    broadcast({ type: 'error', message: 'Could not fetch audio: ' + e.message });
    return broadcastState();
  }
  if (cur !== i) return; // user jumped elsewhere meanwhile
  loading = false;
  play = { playing: true, anchor: Date.now() + LEAD_MS, pausedPos: 0 };
  log('info', 'server', 'Track started: ' + queue[i].title);
  broadcastState();
  if (queue[i + 1]) ensure(queue[i + 1].id).catch(() => {}); // prefetch next
}

function toggle() {
  if (cur < 0 && queue.length) return playIndex(0);
  if (loading || cur < 0) return;
  if (play.playing) {
    play = { playing: false, anchor: 0, pausedPos: Math.max(0, position()) };
  } else {
    play = { playing: true, anchor: Date.now() + 700 - play.pausedPos * 1000, pausedPos: 0 };
  }
  broadcastState();
}

function seek(pos) {
  if (cur < 0 || loading) return;
  pos = Math.max(0, pos);
  if (play.playing) play.anchor = Date.now() + 700 - pos * 1000;
  else play.pausedPos = pos;
  broadcastState();
}

// ---------- websocket ----------
wss.on('connection', ws => {
  ws.dev = null;
  send(ws, { type: 'logs', entries: logEntries.slice() });
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); }
    catch {
      log('warn', clientSource(ws), 'Received invalid WebSocket JSON');
      return;
    }
    switch (m.type) {
      case 'ping': return send(ws, { type: 'pong', t0: m.t0, ts: Date.now() });
      case 'hello': {
        const id = String(m.id).slice(0, 40), name = String(m.name || 'Device').replace(/[\r\n\t]/g, ' ').slice(0, 30);
        ws.dev = { id, name, rtt: 0 };
        store[id] = Object.assign({ offset: 0, muted: false }, store[id], { name });
        saveStore();
        log('info', clientSource(ws), 'Connected');
        send(ws, { type: 'settings', offset: store[id].offset, muted: store[id].muted });
        send(ws, stateMsg());
        return broadcastDevices();
      }
      case 'stat': if (ws.dev) { ws.dev.rtt = Math.round(m.rtt); broadcastDevices(); } return;
      case 'play':
        log('info', clientSource(ws), 'Requested queue item ' + ((m.index | 0) + 1));
        return playIndex(m.index | 0);
      case 'toggle':
        log('info', clientSource(ws), 'Toggled playback');
        return toggle();
      case 'next':
        log('info', clientSource(ws), 'Skipped to next track');
        return playIndex(cur + 1);
      case 'prev':
        log('info', clientSource(ws), 'Skipped to previous track');
        return playIndex(position() > 3 ? cur : cur - 1);
      case 'seek':
        log('info', clientSource(ws), 'Seeked to ' + (+m.pos || 0).toFixed(1) + 's');
        return seek(+m.pos || 0);
      case 'ended':
        // many devices report this; only the one matching the current anchor advances the queue
        log('info', clientSource(ws), 'Reported track ended');
        if (m.anchor === play.anchor && play.playing && cur === m.cur) {
          log('info', 'server', 'Track finished: ' + (queue[cur] ? queue[cur].title : 'Unknown track'));
          playIndex(cur + 1);
        }
        return;
      case 'advance': {
        const durationMs = +m.durMs;
        const valid = m.cur === cur &&
          m.anchor === play.anchor &&
          play.playing &&
          cur + 1 < queue.length &&
          durationMs > 1000 &&
          durationMs < 3.6e6;
        if (!valid) {
          log('warn', 'server', 'advance ignored (stale)');
          return;
        }
        cur += 1;
        play = {
          playing: true,
          anchor: m.anchor + Math.round(durationMs),
          pausedPos: 0
        };
        loading = false;
        log('info', 'server', 'advance accepted cur=' + cur);
        broadcastState();
        if (queue[cur + 1]) ensure(queue[cur + 1].id).catch(() => {});
        return;
      }
      case 'import':
        log('info', clientSource(ws), 'Requested playlist import');
        return importPlaylist(String(m.url)).then(items => {
          if (!items.length) throw new Error('No tracks found');
          queue = items; cur = -1;
          log('info', 'server', 'Imported ' + items.length + ' tracks');
          broadcast({ type: 'info', message: `Imported ${items.length} tracks` });
          return playIndex(0);
        }).catch(e => {
          log('error', 'server', 'Playlist import failed: ' + e.message);
          send(ws, { type: 'error', message: 'Import failed: ' + e.message.slice(0, 200) });
        });
      case 'clientLog': {
        const level = ['info', 'warn', 'error'].includes(m.level) ? m.level : 'error';
        const message = String(m.message == null ? '' : m.message).slice(0, 500);
        return log(level, clientSource(ws), message);
      }
      case 'setDevice': {
        const s = store[m.id]; if (!s) return;
        if (typeof m.offset === 'number') s.offset = Math.max(-2000, Math.min(2000, Math.round(m.offset)));
        if (typeof m.muted === 'boolean') s.muted = m.muted;
        saveStore();
        log('info', clientSource(ws), 'Updated device settings');
        wss.clients.forEach(c => c.dev && c.dev.id === m.id && send(c, { type: 'settings', offset: s.offset, muted: s.muted }));
        return broadcastDevices();
      }
      default:
        log('warn', clientSource(ws), 'Unknown WebSocket message type: ' + String(m.type || '').slice(0, 40));
    }
  });
  ws.on('close', () => {
    if (ws.dev) log('info', clientSource(ws), 'Disconnected');
    broadcastDevices();
  });
  ws.on('error', error => {
    log('error', clientSource(ws), 'WebSocket error: ' + error.message);
  });
});

server.on('error', error => {
  log('error', 'server', 'HTTP server error: ' + error.message);
});

server.listen(PORT, '0.0.0.0', () => {
  log('info', 'server', 'MusicSync running on port ' + PORT);
  for (const list of Object.values(os.networkInterfaces()))
    for (const n of list) if (n.family === 'IPv4' && !n.internal) log('info', 'server', 'Available at http://' + n.address + ':' + PORT);
});
