# cupid music player

A pixel-art desktop music player built with Tauri, Vite, React, and TypeScript.

## Features

- Pixel-art UI with animated record player, spinning vinyl, and needle
- Record swap animation on song change (pink/blue vinyl alternation)
- Interactive progress bar with draggable star indicator
- Marquee scrolling for long track titles
- Pink and blue theme switching with persistent preference
- Spotify integration — browse your playlists and stream tracks via yt-dlp (no Premium required)
- Apple Music integration — browse your library playlists via MusicKit JS
- Local MP3 playback from `public/audio/`
- Custom frameless window with drag and corner resize
- Dynamic taskbar/dock icon that matches the active theme

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) — install via rustup
- **Windows:** [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (MSVC toolchain)
- **macOS:** Xcode Command Line Tools — `xcode-select --install`
- **Linux:** `libwebkit2gtk-4.1`, `libgtk-3`, `libayatana-appindicator3` — see [Tauri Linux dependencies](https://tauri.app/start/prerequisites/)

## Getting Started

```bash
npm install
npm run dev
```

`npm run dev` starts the Vite dev server and the Tauri window simultaneously.

## Adding Local Audio Files

1. Place your `.mp3` files in `public/audio/`
2. Restart the app — the player reads ID3 tags (title, artist, album art) automatically

Files without metadata still play but may show as "Unknown". To add/fix metadata:
- **Windows:** [MP3Tag](https://www.mp3tag.de/en/)
- **macOS/Linux:** [Kid3](https://kid3.kde.org/)
- **iTunes/Music.app:** right-click > Get Info

## Spotify Setup

Stream tracks from your Spotify playlists. Audio is fetched from YouTube via yt-dlp — **Spotify Premium is not required**.

1. Create a Spotify app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Add **both** of these as redirect URIs:
   - `http://localhost:5173/callback` (development)
   - `cupid://callback` (production builds)
3. Copy `.env.example` to `.env` and fill in your Client ID:
   ```
   VITE_SPOTIFY_CLIENT_ID=your_client_id_here
   ```
4. Add yourself under Settings → User Management (required while the app is in development mode)
5. Click the settings icon in the player → log in

See [SPOTIFY_SETUP.md](SPOTIFY_SETUP.md) for detailed instructions and troubleshooting.

## Apple Music Setup

Browse your Apple Music library playlists via MusicKit JS. **An Apple Music subscription is not required for playback.**

1. Create a MusicKit key at [developer.apple.com → Certificates, Identifiers & Profiles → Keys](https://developer.apple.com/account/resources/authkeys/list)
2. Download the `.p8` key file and place it in `src-tauri/` (it is gitignored automatically)
3. Add to your `.env`:
   ```
   APPLE_TEAM_ID=YOUR10CHARID
   APPLE_KEY_ID=YOURKEYID
   ```
4. Click the settings icon → switch to Apple → log in

See [APPLE_MUSIC_SETUP.md](APPLE_MUSIC_SETUP.md) for detailed instructions and troubleshooting.

> **Note:** The `.p8` private key is bundled inside the app for personal use. Do not distribute builds publicly if the key is embedded.

## yt-dlp

yt-dlp is used to stream audio for Spotify and Apple Music tracks. It is **downloaded and kept up to date automatically** — no manual installation needed.

On first stream, the app downloads the appropriate yt-dlp binary for your platform into its app data directory and caches it. On subsequent launches it checks for updates in the background.

If auto-download is blocked by a firewall, you can install yt-dlp manually and the app will fall back to the system PATH version.

## Build

```bash
npm run build
```

Produces a platform-native installer in `src-tauri/target/release/bundle/`:

| Platform | Output |
|----------|--------|
| Windows  | `nsis/*.exe` installer |
| macOS    | `macos/*.app` bundle and `.dmg` |
| Linux    | `appimage/*.AppImage` |

### Install the built app

**macOS:**
```bash
cp -r "src-tauri/target/release/bundle/macos/Cupid Player.app" /Applications/
```

> First launch may require: right-click → Open, or System Settings → Privacy & Security → Allow.

**Windows:** Run the `.exe` installer from `src-tauri/target/release/bundle/nsis/`.

**Linux:** Make the AppImage executable and run it:
```bash
chmod +x "src-tauri/target/release/bundle/appimage/cupid-player_*.AppImage"
./"src-tauri/target/release/bundle/appimage/cupid-player_*.AppImage"
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Tauri in dev mode (Vite + Tauri window) |
| `npm run vite` | Start Vite dev server only (browser preview) |
| `npm run build` | Build release bundle for the current platform |
| `npm run typecheck` | Run TypeScript type checker without emitting |
| `npm run preview` | Preview the Vite production build in a browser |

## Tech Stack

- **Tauri 2** — desktop app shell (frameless window, IPC, system tray, deep links)
- **Vite** — build tool and dev server
- **React 18** — UI framework
- **TypeScript** — type-safe frontend
- **Rust** — native backend (JWT, yt-dlp execution, window management)
- **HTML5 Audio** — local MP3 and streaming playback
- **yt-dlp** — YouTube audio streaming for Spotify/Apple Music tracks (auto-downloaded)
- **Spotify Web API** — playlist and metadata fetching (OAuth 2.0 PKCE)
- **Apple MusicKit JS** — library playlist access (JWT auth)
- **jsonwebtoken (Rust)** — Apple Music developer token generation
- **CSS** — custom properties for theming, calc-based responsive scaling
