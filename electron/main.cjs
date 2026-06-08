require('dotenv').config();
const { app, BrowserWindow, ipcMain, screen, shell, protocol, net } = require('electron');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Readable } = require('node:stream');
const http = require('node:http');

const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const execFileAsync = promisify(execFile);

// Custom protocol used by the renderer's <audio> — main fetches the actual
// stream so we can attach headers and forward Range requests for seeking.
// Must be registered as privileged before app.whenReady fires.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cupid-audio',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
  {
    scheme: 'cupid-local',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
]);

// ── Apple Music developer token ──────────────────────────
let appleMusicToken = null;
let appleMusicTokenExpiry = 0;

function generateAppleMusicToken() {
  if (appleMusicToken && Date.now() < appleMusicTokenExpiry) {
    return appleMusicToken;
  }

  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;

  if (!teamId || !keyId) return null;

  // Find the .p8 key file in project root
  const projectRoot = path.join(__dirname, '..');
  const keyFiles = fs.readdirSync(projectRoot).filter((f) => f.endsWith('.p8'));
  if (keyFiles.length === 0) return null;

  const privateKey = fs.readFileSync(path.join(projectRoot, keyFiles[0]), 'utf8');

  appleMusicToken = jwt.sign({}, privateKey, {
    algorithm: 'ES256',
    expiresIn: '180d',
    issuer: teamId,
    header: {
      alg: 'ES256',
      kid: keyId,
    },
  });

  // Cache for 179 days
  appleMusicTokenExpiry = Date.now() + 179 * 24 * 60 * 60 * 1000;
  return appleMusicToken;
}

// ── yt-dlp stream URL fetcher ────────────────────────────
// streamCache: stream URLs (expire after ~30min on YT's side)
// videoIdCache: title → video ID, persisted so repeat lookups skip search
const streamCache = new Map();
const pendingRequests = new Map();
const videoIdCache = new Map();
const CACHE_TTL = 25 * 60 * 1000;

let videoIdCacheLoaded = false;
let videoIdCacheFile = null;
let videoIdSaveTimer = null;

function loadVideoIdCache() {
  if (videoIdCacheLoaded) return;
  videoIdCacheLoaded = true;
  try {
    videoIdCacheFile = path.join(app.getPath('userData'), 'video-id-cache.json');
    const raw = fs.readFileSync(videoIdCacheFile, 'utf8');
    for (const [k, v] of Object.entries(JSON.parse(raw))) videoIdCache.set(k, v);
  } catch {
    // no cache file yet
  }
}

function persistVideoIdCache() {
  if (!videoIdCacheFile) return;
  clearTimeout(videoIdSaveTimer);
  videoIdSaveTimer = setTimeout(() => {
    const obj = Object.fromEntries(videoIdCache);
    fs.promises.writeFile(videoIdCacheFile, JSON.stringify(obj)).catch(() => {});
  }, 500);
}

// yt-dlp resolution order:
//   1. Standalone binary downloaded by scripts/install-yt-dlp.cjs into ./bin —
//      single-file native binary, no Python dependency.
//   2. In packaged builds, the same binary shipped via extraResources.
//   3. Last resort: `yt-dlp` on $PATH (lets advanced users override).
//
// We intentionally don't fall back to yt-dlp-exec's bundled Python zipapp:
// it breaks on systems whose default python3 is < 3.10 (e.g. macOS w/ Xcode's
// Python 3.9), and the standalone binary is the supported path.
let cachedYtDlpPath = null;
function getYtDlpPath() {
  if (cachedYtDlpPath) return cachedYtDlpPath;

  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';

  const candidates = [
    // Dev / cloned-from-source: scripts/install-yt-dlp.cjs drops it here
    path.join(__dirname, '..', 'bin', binName),
    // Packaged app: extraResources places it under resourcesPath/bin/
    path.join(process.resourcesPath || '', 'bin', binName),
  ];

  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) {
        cachedYtDlpPath = p;
        return p;
      }
    } catch {}
  }

  // Fall back to whatever `yt-dlp` (or `yt-dlp.exe`) resolves to on $PATH —
  // execFile on Windows needs the explicit extension.
  cachedYtDlpPath = binName;
  return cachedYtDlpPath;
}

// Common yt-dlp args, applied to every yt-dlp call. Three levers:
//
//   1. js-runtime — current yt-dlp must run YouTube's player JS to solve the
//      "n challenge" and see the full format list. Without a JS runtime it
//      falls back to a stripped extraction with no m4a audio, failing with
//      "Requested format is not available". Deno is yt-dlp's only default,
//      and most users don't have it — but they DO have Node (it runs this
//      app), so we enable Node explicitly. This is additive: machines that
//      already have Deno keep using it. Override the binary with
//      YTDLP_NODE_PATH if `node` isn't on PATH (e.g. some packaged installs).
//   2. player_client — the default web client frequently trips the "Sign in
//      to confirm you're not a bot" check. The `tv`/`web_safari` clients are
//      rarely challenged and need no login, so we prefer them. Zero setup.
//   3. cookies — when YouTube still demands a real session (common on
//      datacenter/VPN IPs), pass a logged-in YouTube session. Opt-in via:
//        YTDLP_COOKIES_FROM_BROWSER=chrome|firefox|edge|brave|safari
//        YTDLP_COOKIES=/abs/path/to/cookies.txt   (Netscape cookie file)
//      The browser form reads cookies straight from an installed browser
//      where the user is signed in to YouTube.
function ytDlpCommonArgs() {
  const nodePath = process.env.YTDLP_NODE_PATH;
  const args = [
    '--js-runtimes', nodePath ? `node:${nodePath}` : 'node',
    '--extractor-args', 'youtube:player_client=tv,web_safari,default',
  ];

  const browser = process.env.YTDLP_COOKIES_FROM_BROWSER;
  const cookieFile = process.env.YTDLP_COOKIES;
  if (browser) {
    args.push('--cookies-from-browser', browser);
  } else if (cookieFile) {
    args.push('--cookies', cookieFile);
  }

  return args;
}

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// youtubei.js handles YT Music search (audio uploads, not music videos).
// URL extraction stays on yt-dlp — YT now withholds stream URLs from WEB
// client responses without a PoToken, which youtubei.js can't generate.
let innertubePromise = null;
function getInnertube() {
  if (innertubePromise) return innertubePromise;
  innertubePromise = (async () => {
    const { Innertube, UniversalCache } = await import('youtubei.js');
    return Innertube.create({
      cache: new UniversalCache(true, path.join(app.getPath('userData'), 'innertube-cache')),
      generate_session_locally: true,
    });
  })().catch((err) => {
    innertubePromise = null;
    throw err;
  });
  return innertubePromise;
}

async function searchYouTubeMusic(title, artist) {
  const yt = await getInnertube();
  const search = await yt.music.search(`${title} ${artist}`, { type: 'song' });

  let top = search.songs?.contents?.find((c) => c?.id);
  if (!top) {
    for (const shelf of search.contents || []) {
      const item = shelf?.contents?.find?.((c) => c?.id);
      if (item) { top = item; break; }
    }
  }
  if (!top?.id) throw new Error('No song result');
  return top.id;
}

// Solving YouTube's n-challenge spins up a JS runtime (Node) and querying
// multiple player clients adds round trips, so a cold extraction now runs
// ~15-20s on a fast machine and longer on slower/Windows boxes. The old 15s
// ceiling killed these mid-run — execFile reports a bare "Command failed",
// which surfaces in the renderer as net::ERR_FAILED. Give extraction generous
// headroom; it's a ceiling, not a typical wait (prefetch warms most tracks).
const YTDLP_EXTRACT_TIMEOUT = 90000;

async function ytDlpExtract(target) {
  const { stdout } = await execFileAsync(getYtDlpPath(), [
    target,
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--no-playlist',
    '--no-warnings',
    ...ytDlpCommonArgs(),
    '-g',
  ], { timeout: YTDLP_EXTRACT_TIMEOUT });
  return stdout.trim();
}

async function ytDlpSearch(title, artist) {
  const { stdout } = await execFileAsync(getYtDlpPath(), [
    `ytsearch1:"${title}" ${artist}`,
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--no-playlist',
    '--no-warnings',
    ...ytDlpCommonArgs(),
    '--print', '%(id)s',
    '-g',
  ], { timeout: YTDLP_EXTRACT_TIMEOUT });
  const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const id = lines.find((l) => YT_ID_RE.test(l));
  const url = lines.find((l) => l.startsWith('http'));
  if (!id || !url) throw new Error('yt-dlp search returned no usable result');
  return { id, url };
}

// videoId → { url, time }. yt-dlp URLs last ~30min — same TTL as streamCache
const decipheredCache = new Map();
const pendingDecipher = new Map();

async function resolveStreamUrl(videoId) {
  const cached = decipheredCache.get(videoId);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.url;

  const inflight = pendingDecipher.get(videoId);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const url = await ytDlpExtract(`https://www.youtube.com/watch?v=${videoId}`);
      decipheredCache.set(videoId, { url, time: Date.now() });
      return url;
    } finally {
      pendingDecipher.delete(videoId);
    }
  })();

  pendingDecipher.set(videoId, promise);
  return promise;
}

async function getStreamUrl(title, artist) {
  const cacheKey = `${title}::${artist}`;
  const cached = streamCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.url;

  const inflight = pendingRequests.get(cacheKey);
  if (inflight) return inflight;

  loadVideoIdCache();
  let videoId = videoIdCache.get(cacheKey);

  const promise = (async () => {
    try {
      if (!videoId) {
        try {
          videoId = await searchYouTubeMusic(title, artist);
        } catch (err) {
          console.warn('[youtubei search] fallback to yt-dlp:', err.message);
          const result = await ytDlpSearch(title, artist);
          videoId = result.id;
          // We already have a usable URL from yt-dlp — seed the decipher cache
          decipheredCache.set(videoId, { url: result.url, time: Date.now() });
        }
        videoIdCache.set(cacheKey, videoId);
        persistVideoIdCache();
      }

      // Best-effort pre-warm so the renderer's protocol fetch hits the decipher cache
      resolveStreamUrl(videoId).catch(() => {});

      const url = `cupid-audio://stream?id=${encodeURIComponent(videoId)}`;
      streamCache.set(cacheKey, { url, time: Date.now() });
      return url;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, promise);
  return promise;
}

// Direct cupid-audio URL for a known YouTube video ID — skips the search step
// used by Spotify/Apple. Best-effort pre-warms the decipher cache.
function streamUrlForVideoId(videoId) {
  if (!YT_ID_RE.test(videoId)) throw new Error('Invalid YouTube video ID');
  resolveStreamUrl(videoId).catch(() => {});
  return `cupid-audio://stream?id=${encodeURIComponent(videoId)}`;
}

// Fetch a public/unlisted YouTube playlist via yt-dlp --flat-playlist.
// Returns an array of { videoId, title, artist, duration } — no API key
// or sign-in required.
async function fetchYouTubePlaylistViaYtDlp(url) {
  const { stdout } = await execFileAsync(getYtDlpPath(), [
    url,
    '--flat-playlist',
    '--dump-single-json',
    '--no-warnings',
    ...ytDlpCommonArgs(),
  ], { timeout: 60000, maxBuffer: 50 * 1024 * 1024 });

  const data = JSON.parse(stdout);
  const entries = data.entries || [];
  return entries
    .filter((e) => e && e.id && YT_ID_RE.test(e.id))
    .map((e) => ({
      videoId: e.id,
      title: e.title || e.id,
      artist: e.uploader || e.channel || '',
      duration: typeof e.duration === 'number' ? e.duration : null,
    }));
}

const isDev = process.env.NODE_ENV === 'development';

// ── Local audio library (user-editable playlist + mp3s) ───
// In dev: read/write directly from the project's audio/ folder so edits
// during development are picked up without a seeding dance.
// In prod: bundled audio/ ships via extraResources to process.resourcesPath;
// on first launch we copy it to userData so users can add/edit freely.
function bundledAudioDir() {
  return path.join(process.resourcesPath, 'audio');
}

function userAudioDir() {
  return isDev
    ? path.join(__dirname, '..', 'audio')
    : path.join(app.getPath('userData'), 'audio');
}

function userPlaylistFile() {
  return path.join(userAudioDir(), 'playlist.json');
}

async function seedUserAudioDirIfMissing() {
  if (isDev) return;
  const dest = userAudioDir();
  try {
    await fs.promises.access(dest);
    return;
  } catch {
    // doesn't exist yet — seed it
  }

  const src = bundledAudioDir();
  await fs.promises.mkdir(dest, { recursive: true });

  try {
    const entries = await fs.promises.readdir(src);
    await Promise.all(entries.map(async (name) => {
      const from = path.join(src, name);
      const to = path.join(dest, name);
      const stat = await fs.promises.stat(from);
      if (stat.isFile()) await fs.promises.copyFile(from, to);
    }));
  } catch (err) {
    console.warn('[seed audio]', err.message);
  }
}

// Scale factor for pixel art
// Actual drawing area within 526x526 canvas: 306x497
// (23px top at bow, 110px left, 110px right, 6px bottom at heart)
const WIDTH = 415;
const HEIGHT = Math.round(415 * (497 / 306)); // maintain 306:497 aspect ratio

function createWindow() {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    icon: path.join(__dirname, '..', 'assets', 'pink', 'favicon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Lock aspect ratio so only proportional resizing is allowed
  const ASPECT = WIDTH / HEIGHT;
  win.setAspectRatio(ASPECT);

  // Window control handlers
  let preMaxBounds = null;

  const onMinimize = () => win.minimize();
  const onMaximize = () => {
    if (preMaxBounds) {
      // Restore to previous size
      win.setBounds(preMaxBounds);
      preMaxBounds = null;
    } else {
      // Fit to screen while maintaining aspect ratio
      preMaxBounds = win.getBounds();
      const { workArea } = screen.getPrimaryDisplay();
      let newWidth = workArea.width;
      let newHeight = Math.round(newWidth / ASPECT);
      if (newHeight > workArea.height) {
        newHeight = workArea.height;
        newWidth = Math.round(newHeight * ASPECT);
      }
      const x = workArea.x + Math.round((workArea.width - newWidth) / 2);
      const y = workArea.y + Math.round((workArea.height - newHeight) / 2);
      win.setBounds({ x, y, width: newWidth, height: newHeight });
    }
  };
  const onClose = () => win.close();

  const onResize = (_e, { dx, dy, corner }) => {
    if (win.isDestroyed()) return;
    const bounds = win.getBounds();

    const isRight = corner.includes('right');
    const isBottom = corner.includes('bottom');

    const effectiveDx = isRight ? dx : -dx;
    const effectiveDy = isBottom ? dy : -dy;

    let delta;
    if (Math.abs(effectiveDx) > Math.abs(effectiveDy)) {
      delta = effectiveDx;
    } else {
      delta = effectiveDy;
    }

    const dw = Math.round(delta);
    const newWidth = bounds.width + dw;
    const newHeight = Math.round(newWidth / ASPECT);
    const dh = newHeight - bounds.height;

    const newBounds = {
      x: isRight ? bounds.x : bounds.x - dw,
      y: isBottom ? bounds.y : bounds.y - dh,
      width: newWidth,
      height: newHeight,
    };

    if (newBounds.width >= 200 && newBounds.height >= 200) {
      win.setBounds(newBounds);
    }
  };

  const onOpenExternal = (_e, url) => {
    if (typeof url === 'string' && url.startsWith('https://')) {
      if (url.includes('accounts.spotify.com/authorize')) {
        const authWin = new BrowserWindow({
          width: 500,
          height: 700,
          parent: win,
          modal: true,
          show: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true },
        });
        authWin.loadURL(url);
        const handleAuthRedirect = (event, callbackUrl) => {
          if (callbackUrl.startsWith('http://127.0.0.1:5173/callback')) {
            event.preventDefault();
            const url = new URL(callbackUrl);
            let target;
            if (isDev) {
              target = `http://127.0.0.1:5173/${url.search}`;
            } else {
              const fileUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html'));
              fileUrl.search = url.search;
              target = fileUrl.href;
            }
            win.loadURL(target);
            authWin.close();
          }
        };
        authWin.webContents.on('will-redirect', handleAuthRedirect);
        authWin.webContents.on('will-navigate', handleAuthRedirect);
        return;
      }
      shell.openExternal(url);
    }
  };

  const onSetTheme = (_e, theme) => {
    const iconPath = path.join(__dirname, '..', 'assets', theme, 'favicon.png');
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(iconPath);
    }
    win.setIcon(iconPath);
  };

  ipcMain.on('window-minimize', onMinimize);
  ipcMain.on('window-maximize', onMaximize);
  ipcMain.on('window-close', onClose);
  ipcMain.on('window-resize', onResize);
  ipcMain.on('open-external', onOpenExternal);
  ipcMain.on('set-theme', onSetTheme);

  // Clean up IPC listeners when window is destroyed
  win.on('closed', () => {
    ipcMain.removeListener('window-minimize', onMinimize);
    ipcMain.removeListener('window-maximize', onMaximize);
    ipcMain.removeListener('window-close', onClose);
    ipcMain.removeListener('window-resize', onResize);
    ipcMain.removeListener('open-external', onOpenExternal);
    ipcMain.removeListener('set-theme', onSetTheme);
  });

  // Handle Spotify OAuth callback in production.
  win.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'accounts.spotify.com') {
        event.preventDefault();
        shell.openExternal(url);
        return;
      }
      if (parsed.pathname === '/callback' && parsed.searchParams.has('code')) {
        if (!isDev) {
          event.preventDefault();
          const fileUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html'));
          fileUrl.search = parsed.search;
          win.loadURL(fileUrl.href);
        }
      }
    } catch {
      // ignore invalid URLs
    }
  });

  // Toggle DevTools with Cmd+Shift+I / Ctrl+Shift+I / F12
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const isDevToolsShortcut = input.key.toLowerCase() === 'i' && input.shift && (input.meta || input.control);
    if (isDevToolsShortcut || input.key === 'F12') {
      win.webContents.toggleDevTools({ mode: 'detach' });
    }
  });

  if (isDev) {
    win.loadURL('http://127.0.0.1:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// ── Global IPC handlers (persist across window reloads) ──
ipcMain.handle('window-set-always-on-top', (event, enabled) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return false;

  const next = Boolean(enabled);
  win.setAlwaysOnTop(next);
  return win.isAlwaysOnTop();
});

ipcMain.handle('get-apple-music-token', () => {
  return generateAppleMusicToken();
});

ipcMain.handle('get-stream-url', async (_e, title, artist) => {
  try {
    return await getStreamUrl(title, artist);
  } catch (err) {
    throw new Error(`Failed to get stream: ${err.message}`);
  }
});

ipcMain.handle('get-local-playlist', async () => {
  try {
    const raw = await fs.promises.readFile(userPlaylistFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[playlist.json]', err.message);
    return [];
  }
});

ipcMain.handle('get-local-audio-path', (_e, filename) => {
  if (typeof filename !== 'string' || !filename) return null;
  // Reject path traversal and absolute paths — filename must be a basename
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return null;
  }
  // Use a custom protocol so the dev renderer (served over http://) can play it —
  // <audio> won't load file:// URLs cross-origin.
  return `cupid-local://audio/${encodeURIComponent(filename)}`;
});

ipcMain.handle('open-music-folder', async () => {
  const dir = userAudioDir();
  await fs.promises.mkdir(dir, { recursive: true });
  await shell.openPath(dir);
  return dir;
});

ipcMain.handle('get-stream-url-by-id', (_e, videoId) => {
  return streamUrlForVideoId(videoId);
});

ipcMain.handle('youtube-fetch-playlist', async (_e, url) => {
  try {
    return await fetchYouTubePlaylistViaYtDlp(url);
  } catch (err) {
    throw new Error(`yt-dlp playlist fetch failed: ${err.message}`);
  }
});

ipcMain.handle('deezer-fetch-playlist', async (_e, playlistReference) => {
  let playlistId = String(playlistReference);

  if (!/^\d+$/.test(playlistId)) {
    let sharedUrl;
    try {
      sharedUrl = new URL(playlistId);
    } catch {
      throw new Error('Invalid Deezer playlist URL');
    }
    if (sharedUrl.protocol !== 'https:' || sharedUrl.hostname !== 'link.deezer.com' || !sharedUrl.pathname.startsWith('/s/')) {
      throw new Error('Invalid Deezer playlist URL');
    }

    const response = await fetch(sharedUrl, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Deezer share link ${response.status}`);
    const resolved = new URL(response.url);
    const match = resolved.pathname.match(/\/playlist\/(\d+)/);
    if (resolved.hostname.replace(/^www\./, '') !== 'deezer.com' || !match) {
      throw new Error('The Deezer share link does not point to a playlist');
    }
    playlistId = match[1];
  }

  const tracks = [];
  let nextUrl = `https://api.deezer.com/playlist/${playlistId}`;
  let firstPage = true;
  let pageCount = 0;

  while (nextUrl) {
    if (++pageCount > 100) throw new Error('Deezer playlist pagination limit exceeded');
    const url = new URL(nextUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'api.deezer.com') {
      throw new Error('Deezer returned an invalid pagination URL');
    }

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Deezer API ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || 'Deezer API error');

    const page = firstPage ? data.tracks : data;
    if (!Array.isArray(page?.data)) {
      throw new Error('Deezer returned an unexpected playlist response');
    }

    tracks.push(...page.data);
    nextUrl = page.next || null;
    firstPage = false;
  }

  return tracks;
});

// ── Google OAuth loopback ─────────────────────────────────
// Google's auth servers refuse to render inside Electron's BrowserWindow
// (embedded-webview policy), so we open the system browser and run a tiny
// local HTTP server to capture the redirect. Returns the auth code synchronously
// after the user completes the flow in their browser.
let activeOauthServer = null;

ipcMain.handle('youtube-oauth-start', async (_e, { clientId, scope, state, codeChallenge }) => {
  // Tear down any previous attempt
  if (activeOauthServer) {
    try { activeOauthServer.close(); } catch {}
    activeOauthServer = null;
  }

  const { port, server, codePromise } = await new Promise((resolve, reject) => {
    let resolveCode, rejectCode;
    const codePromise = new Promise((r1, r2) => { resolveCode = r1; rejectCode = r2; });

    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/youtube-callback') {
        res.writeHead(404); res.end('not found');
        return;
      }
      const code = u.searchParams.get('code');
      const returnedState = u.searchParams.get('state');
      const error = u.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (error) {
        res.end(`<!doctype html><meta charset=utf-8><title>cupid player</title><style>body{font-family:system-ui;background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style><div>Auth failed: ${error}. You can close this window.</div>`);
        rejectCode(new Error(error));
      } else if (!code) {
        res.end('<!doctype html><meta charset=utf-8><div>Missing code. You can close this window.</div>');
        rejectCode(new Error('No code in callback'));
      } else if (returnedState !== state) {
        res.end('<!doctype html><meta charset=utf-8><div>State mismatch. You can close this window.</div>');
        rejectCode(new Error('OAuth state mismatch'));
      } else {
        res.end('<!doctype html><meta charset=utf-8><title>cupid player</title><style>body{font-family:system-ui;background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style><div>✓ Signed in — you can close this window and return to Cupid Player.</div>');
        resolveCode(code);
      }

      // Close the server shortly after handling — single-shot
      setTimeout(() => { try { srv.close(); } catch {} }, 500);
    });

    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      resolve({ port: srv.address().port, server: srv, codePromise });
    });
  });

  activeOauthServer = server;

  const redirectUri = `http://127.0.0.1:${port}/youtube-callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  // Open in the user's default browser — Google refuses embedded webviews
  shell.openExternal(authUrl);

  // Auto-timeout after 5 minutes so we don't leak the server forever
  const timeout = setTimeout(() => {
    try { server.close(); } catch {}
  }, 5 * 60 * 1000);

  try {
    const code = await codePromise;
    clearTimeout(timeout);
    activeOauthServer = null;
    return { code, redirectUri };
  } catch (err) {
    clearTimeout(timeout);
    activeOauthServer = null;
    throw err;
  }
});

ipcMain.handle('youtube-oauth-cancel', () => {
  if (activeOauthServer) {
    try { activeOauthServer.close(); } catch {}
    activeOauthServer = null;
  }
});

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, '..', 'assets', 'pink', 'favicon.png'));
  }

  seedUserAudioDirIfMissing().catch((err) => console.warn('[seed]', err.message));

  protocol.handle('cupid-local', async (request) => {
    try {
      const u = new URL(request.url);
      const filename = decodeURIComponent(u.pathname.replace(/^\//, ''));
      if (!filename || filename.includes('..') || filename.includes('\\') || filename.includes('/')) {
        return new Response('forbidden', { status: 403 });
      }
      const filePath = path.join(userAudioDir(), filename);
      const stat = await fs.promises.stat(filePath);
      const total = stat.size;
      const range = request.headers.get('Range');

      const ext = path.extname(filename).toLowerCase();
      const mimeByExt = {
        '.mp3': 'audio/mpeg',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.flac': 'audio/flac',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.opus': 'audio/ogg',
      };
      const contentType = mimeByExt[ext] || 'application/octet-stream';

      if (range) {
        const match = /bytes=(\d+)-(\d*)/.exec(range);
        const start = match ? parseInt(match[1], 10) : 0;
        const end = match && match[2] ? parseInt(match[2], 10) : total - 1;
        const nodeStream = fs.createReadStream(filePath, { start, end });
        return new Response(Readable.toWeb(nodeStream), {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
            'Content-Type': contentType,
          },
        });
      }

      return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
        status: 200,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Length': String(total),
          'Content-Type': contentType,
        },
      });
    } catch (err) {
      console.error('[cupid-local]', err.message);
      return new Response('not found', { status: 404 });
    }
  });

  protocol.handle('cupid-audio', async (request) => {
    try {
      const id = new URL(request.url).searchParams.get('id');
      if (!id) return new Response('missing id', { status: 400 });

      const streamUrl = await resolveStreamUrl(id);

      const headers = {
        Origin: 'https://www.youtube.com',
        Referer: 'https://www.youtube.com/',
        'User-Agent': 'Mozilla/5.0',
      };
      const range = request.headers.get('Range');
      if (range) headers.Range = range;

      const upstream = await net.fetch(streamUrl, { headers });
      const respHeaders = new Headers(upstream.headers);
      respHeaders.set('Content-Type', 'audio/mp4');
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      console.error('[cupid-audio]', err.message);
      return new Response('failed', { status: 502 });
    }
  });

  createWindow();

  // Pre-warm both engines so the first track load skips cold-start
  getInnertube().catch(() => {});
  execFile(getYtDlpPath(), ['--version'], () => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
