# cupid music player

A pixel-art desktop music player built with Electron, Vite, and React.

## Features

- Pixel-art UI with animated record player, spinning vinyl, and needle
- Record swap animation on song change (pink/blue vinyl alternation)
- Interactive progress bar with draggable star indicator
- Marquee scrolling for long track titles
- Pink and blue theme switching with persistent preference
- Spotify integration — browse your playlists and play tracks via yt-dlp
- Apple Music integration — browse your library playlists via MusicKit JS
- YouTube playlists — paste any public playlist URL (no sign-in) or sign in with Google to browse your own
- Deezer playlists — paste any public playlist URL with no sign-in or API key
- Local MP3 playback
- Custom frameless window with drag and resize
- Dynamic dock/taskbar icon that matches the active theme

## Getting Started
You only need 4 commands. Copy them one at a time:

```bash
# 1. Download the code
git clone https://github.com/cupidbity/cupid-music-player.git

# 2. Step INTO the folder you just downloaded (this step is required!)
cd cupid-music-player

# 3. Set up the app (installs deps, downloads the yt-dlp binary, and
#    auto-checks/repairs the Electron binary issue some hit on Windows)
npm run setup

# 4. Run the app in dev mode
npm run dev
```

`npm run setup` is the recommended one-command setup — it installs dependencies, downloads the yt-dlp binary, and automatically checks for and repairs the Electron binary issue that can otherwise break `npm run dev` on Windows. If anything was off, just re-run `npm run setup`. (Plain `npm install` still works too.)

> Hitting an Electron `path.txt` / "failed to install correctly" error, or streaming not working? See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — including the manual Electron binary fix for too-new Node versions.


### Prerequisites

Before the commands above will work, you need these installed:

| Tool | Why | Install link |
|------|-----|--------------|
| **Node.js 18 or newer** | Runs `npm` and the app's build tools | [nodejs.org](https://nodejs.org/) — download the LTS version |
| **Git** | Used by the `git clone` command above | [git-scm.com](https://git-scm.com/downloads) — usually pre-installed on macOS/Linux |

To check if you already have them, run:

```bash
node --version    # should print v18.x.x or higher
npm --version     # should print 9.x or higher
git --version     # should print git version 2.x.x
```

If any of those says "command not found," install that tool first.

> No Python is needed. The `npm install` step automatically downloads a standalone `yt-dlp` binary for your OS into the project's `bin/` folder.

---


## Adding Local Audio Files

The local playlist is driven by a single file, `playlist.json`, that lives next to your audio files. Drop your songs into the audio folder, list them in the JSON, and the player picks them up.

### Where the audio folder lives

- **Running from source (dev):** `audio/` in the project root.
- **Installed app (macOS):** `~/Library/Application Support/Cupid Player/audio/`
- **Installed app (Windows):** `%APPDATA%\Cupid Player\audio\`
- **Installed app (Linux):** `~/.config/Cupid Player/audio/`

On first launch, the installed app seeds this folder with the bundled defaults. After that it's yours to edit — the app never overwrites it.

### Building your playlist

1. Drop `.mp3` files into the audio folder.
2. Open `playlist.json` in the same folder and add one entry per song:

   ```json
   [
     { "file": "my-song.mp3", "title": "My Song", "artist": "Some Artist", "album": "Album Name", "art": "https://example.com/cover.jpg" },
     { "file": "another.mp3", "title": "Another Song", "artist": "Someone Else" }
   ]
   ```

   - `file` and `title` are required.
   - `artist`, `album`, and `art` are optional. `art` is a URL to a cover image.
   - The `file` value must match the mp3 filename exactly (spaces and case included).

3. In the app, hit the settings icon and the local tab is selected by default. Reload the app to pick up new edits — `playlist.json` is read on launch.

### Supported formats

`.mp3`, `.m4a`, `.aac`, `.flac`, `.wav`, `.ogg`, `.opus`.

## Spotify Setup

Stream any track from your Spotify playlists. Audio is fetched from YouTube via yt-dlp.

> **Note:** As of February 2026, Spotify requires the developer account that creates the app to have an active Premium subscription ([announcement](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security)). Without it, the Spotify API returns 403 for all users.

1. Create a Spotify app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Add `http://127.0.0.1:5173/callback` as a redirect URI
3. Copy `.env.example` to `.env` and add your Client ID
4. Add yourself under Settings > User Management
5. Click the settings icon in the player > log in

See [SPOTIFY_SETUP.md](SPOTIFY_SETUP.md) for detailed instructions and troubleshooting.

## Apple Music Setup

Browse your Apple Music library playlists. Requires an Apple Developer account. **Apple Music subscription is not required for playback.**

1. Create a MusicKit key at [developer.apple.com/account/resources/authkeys](https://developer.apple.com/account/resources/authkeys/list)
2. Download the `.p8` key file and place it in the project root
3. Add `APPLE_TEAM_ID` and `APPLE_KEY_ID` to your `.env`
4. Click the settings icon > switch to apple > log in

See [APPLE_MUSIC_SETUP.md](APPLE_MUSIC_SETUP.md) for detailed instructions and troubleshooting.

## YouTube Setup

Two flows — pick whichever you want by configuring (or not) your `.env`. **No YouTube Premium / no subscription required** in either case.

**Paste any public playlist URL** (zero setup):

1. Click the settings icon in the player > switch to youtube
2. Paste a YouTube/YouTube Music playlist URL into the box
3. Hit `load playlist`

**Browse your own playlists** (requires Google OAuth setup):

1. Create a Google Cloud project at [console.cloud.google.com](https://console.cloud.google.com/), enable **YouTube Data API v3**
2. Configure the OAuth consent screen (External, add yourself as a test user, scope `youtube.readonly`)
3. Create OAuth credentials of type **Desktop app**
4. Add `VITE_YOUTUBE_CLIENT_ID` and `VITE_YOUTUBE_CLIENT_SECRET` to your `.env`
5. Click the settings icon > switch to youtube > log in with google

The sign-in option only appears when `VITE_YOUTUBE_CLIENT_ID` is set; otherwise the URL-paste box shows instead.

See [YOUTUBE_SETUP.md](YOUTUBE_SETUP.md) for detailed instructions and troubleshooting.

## Deezer Setup

Select **deezer** in the player settings and paste a public Deezer playlist URL.
No login or developer key is required. See [DEEZER_SETUP.md](DEEZER_SETUP.md)
for details and current limitations.

## Build

```bash
npm run package
```

### Install as Desktop App

**macOS:**
```bash
cp -r "out/mac-arm64/Cupid Player.app" /Applications/
```

**Windows:** Run the installer from `out/Cupid Player Setup.exe`. If `npm run package` fails at the NSIS step with "Cannot create symbolic link," enable **Developer Mode** in Settings → System → For developers, then re-run. The unpacked app at `out/win-unpacked/Cupid Player.exe` is fully runnable in the meantime — no installer required.

**Linux:** Run the AppImage from `out/`.

> Note: The macOS build is unsigned. On first launch you may need to right-click > Open, or go to System Settings > Privacy & Security to allow it.

## Tech Stack

- **Electron** — desktop app shell (frameless window, IPC, system tray)
- **Vite** — build tool and dev server
- **React** — UI framework
- **HTML5 Audio** — local MP3 playback
- **yt-dlp** — YouTube audio streaming for Spotify/Apple/YouTube tracks; also fetches public YouTube playlist contents via `--flat-playlist`
- **Spotify Web API** — playlist and metadata fetching (OAuth PKCE)
- **Apple MusicKit JS** — library playlist access (JWT auth)
- **YouTube Data API v3** — sign-in browsing of the user's own playlists (Google OAuth PKCE, free quota)
- **CSS** — custom properties for theming, calc-based responsive scaling
- **Node.js** — main process (JWT generation, yt-dlp execution)
- **jsonwebtoken** — Apple Music developer token generation
