import { useCallback, useRef, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import './App.css';
import useAudioPlayer from './useAudioPlayer';
import useSpotifyPlayer from './useSpotifyPlayer';
import useTheme from './useTheme';
import { login as spotifyLogin, handleCallback, isLoggedIn as isSpotifyLoggedIn, logout as spotifyLogout } from './spotify/auth.js';
import { fetchPlaylistTracks as fetchSpotifyTracks, fetchMyPlaylists as fetchSpotifyPlaylists } from './spotify/api.js';
import { login as appleLogin, logout as appleLogout, isLoggedIn as isAppleLoggedIn, initMusicKit } from './apple/auth.js';
import { fetchMyPlaylists as fetchApplePlaylists, fetchPlaylistTracks as fetchAppleTracks } from './apple/api.js';

import progressBarStars from '../assets/progress_bar_stars.png';
import star from '../assets/star.png';
import starSelected from '../assets/star_selected.png';

function useResize(corner) {
  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    let lastX = e.screenX;
    let lastY = e.screenY;

    const onMouseMove = (e) => {
      const dx = e.screenX - lastX;
      const dy = e.screenY - lastY;
      lastX = e.screenX;
      lastY = e.screenY;
      invoke('window_resize', { dx, dy, corner });
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [corner]);

  return onMouseDown;
}

function formatTime(seconds) {
  if (!seconds || !isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function MarqueeText({ className, text }) {
  const outerRef = useRef(null);
  const textRef = useRef(null);
  const [shouldScroll, setShouldScroll] = useState(false);

  useEffect(() => {
    const outer = outerRef.current;
    const textEl = textRef.current;
    if (!outer || !textEl) return;
    setShouldScroll(textEl.offsetWidth > outer.clientWidth);
  }, [text]);

  return (
    <div className={`${className} marquee-container`} ref={outerRef}>
      {/* Hidden span to measure true text width */}
      <span ref={textRef} className="marquee-measure">{text}</span>
      <span className={shouldScroll ? 'marquee-scroll' : ''}>
        {text}
        {shouldScroll && <span className="marquee-gap">{text}</span>}
      </span>
    </div>
  );
}

export default function App() {
  // ── Source state ─────────────────────────────────────────
  const [source, setSource] = useState('local'); // 'local' | 'streaming'
  const [spotifyConnected, setSpotifyConnected] = useState(isSpotifyLoggedIn());
  const [appleConnected, setAppleConnected] = useState(isAppleLoggedIn());
  const [streamTracks, setStreamTracks] = useState([]);
  const [spotifyPlaylists, setSpotifyPlaylists] = useState([]);
  const [applePlaylists, setApplePlaylists] = useState([]);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [loadingPlaylist, setLoadingPlaylist] = useState(false);
  const [settingsError, setSettingsError] = useState(null);
  const [musicService, setMusicService] = useState('spotify');
  const [shuffle, setShuffle] = useState(false);

  const local = useAudioPlayer(shuffle);
  const streaming = useSpotifyPlayer(streamTracks, shuffle);
  const player = source === 'streaming' ? streaming : local;

  const {
    track,
    isPlaying,
    progress,
    duration,
    currentTime,
    togglePlay,
    next,
    prev,
    seek,
  } = player;

  // ── Fetch Spotify playlists ────────────────────────────
  const loadSpotifyPlaylists = useCallback((silent = false) => {
    setLoadingPlaylists(true);
    if (!silent) setSettingsError(null);
    fetchSpotifyPlaylists()
      .then((p) => { setSpotifyPlaylists(p); setSettingsError(null); })
      .catch((err) => { if (!silent) setSettingsError(err.message); })
      .finally(() => setLoadingPlaylists(false));
  }, []);

  // ── Fetch Apple Music playlists ────────────────────────
  const loadApplePlaylists = useCallback(() => {
    setLoadingPlaylists(true);
    setSettingsError(null);
    fetchApplePlaylists()
      .then(setApplePlaylists)
      .catch((err) => setSettingsError(err.message))
      .finally(() => setLoadingPlaylists(false));
  }, []);

  // ── Handle Spotify OAuth callback on mount (dev: localhost redirect) ──────
  useEffect(() => {
    async function checkCallback() {
      const params = new URLSearchParams(window.location.search);
      if (params.has('code')) {
        try {
          await handleCallback();
          setSpotifyConnected(true);
          // Small delay to let token settle before fetching
          setTimeout(() => loadSpotifyPlaylists(true), 500);
        } catch (err) {
          setSettingsError(err.message);
        }
      } else {
        if (isSpotifyLoggedIn()) loadSpotifyPlaylists(true);
        if (isAppleLoggedIn()) loadApplePlaylists();
      }
    }
    checkCallback();
  }, []);

  // ── Handle Spotify OAuth deep-link callback (production: cupid://) ────────
  useEffect(() => {
    const unlistenPromise = listen('spotify-callback', async (event) => {
      try {
        const url = new URL(event.payload);
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        if (error) { setSettingsError(`Spotify auth error: ${error}`); return; }
        if (code) {
          await handleCallback(code);
          setSpotifyConnected(true);
          setTimeout(() => loadSpotifyPlaylists(true), 500);
        }
      } catch (err) {
        setSettingsError(err.message);
      }
    });
    return () => { unlistenPromise.then((fn) => fn()); };
  }, []);

  // ── Load a playlist by ID (works for both services) ───
  const loadPlaylist = useCallback(async (id, service) => {
    setLoadingPlaylist(true);
    setSettingsError(null);
    try {
      const fetcher = service === 'apple' ? fetchAppleTracks : fetchSpotifyTracks;
      const tracks = await fetcher(id);
      if (tracks.length === 0) {
        setSettingsError('Playlist is empty');
        return;
      }
      setStreamTracks(tracks);
      setSource('streaming');
    } catch (err) {
      setSettingsError(err.message);
    } finally {
      setLoadingPlaylist(false);
    }
  }, []);

  const { theme, toggleTheme, assets } = useTheme();

  const [recordFrame, setRecordFrame] = useState(0);
  const [needleFrame, setNeedleFrame] = useState(0);
  const [isPink, setIsPink] = useState(theme === 'pink');
  const [swapping, setSwapping] = useState(false);
  const [needleLifted, setNeedleLifted] = useState(false);
  const [starHovered, setStarHovered] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hoverProgress, setHoverProgress] = useState(null);
  const seekRef = useRef(null);

  useEffect(() => {
    if (!dragging) return;
    const onMouseMove = (e) => {
      const rect = seekRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      setHoverProgress(pct);
      seek(pct);
    };
    const onMouseUp = () => {
      setDragging(false);
      setStarHovered(false);
      setHoverProgress(null);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [dragging, seek]);
  const [needleChangeFrame, setNeedleChangeFrame] = useState(0);
  const prevTrackRef = useRef(track.title);

  const currentFrames = isPink ? assets.recordFramesA : assets.recordFramesB;
  const incomingFrames = isPink ? assets.recordFramesB : assets.recordFramesA;

  // Spin animation while playing
  useEffect(() => {
    if (!isPlaying || swapping) return;
    const interval = setInterval(() => {
      setRecordFrame((f) => (f + 1) % currentFrames.length);
      setNeedleFrame((f) => (f + 1) % assets.needlePlayFrames.length);
    }, 400);
    return () => clearInterval(interval);
  }, [isPlaying, swapping, currentFrames.length]);

  // Detect song change and trigger swap
  // Sequence: needle lifts (0→1→2) → records swap → needle lowers (2→1→0)
  useEffect(() => {
    if (prevTrackRef.current === track.title) return;
    prevTrackRef.current = track.title;
    if (needleLifted) return;

    setNeedleLifted(true);
    setNeedleChangeFrame(0);

    // Show needle lifted (frame 1 = index 1)
    setTimeout(() => setNeedleChangeFrame(1), 200);

    // Start record swap
    setTimeout(() => setSwapping(true), 400);

    // Finish swap, switch color
    setTimeout(() => {
      setIsPink((p) => !p);
      setRecordFrame(0);
      setSwapping(false);
    }, 1000);

    // Needle lower after swap is done, reset to frame 1
    setTimeout(() => {
      setNeedleChangeFrame(0);
      setNeedleLifted(false);
      setNeedleFrame(0);
    }, 1100);

  }, [track.title, needleLifted]);

  const resizeTL = useResize('top-left');
  const resizeTR = useResize('top-right');
  const resizeBL = useResize('bottom-left');
  const resizeBR = useResize('bottom-right');

  return (
    <div className={`player ${theme === 'blue' ? 'theme-blue' : ''}`}>
      {/* Base frame */}
      <img src={assets.frame} className="layer" alt="" draggable={false} />

      {/* Window title */}
      <div className="window-title">cupid player</div>

      {/* Record player centered in frame */}
      <img src={assets.recordPlayer} className="record-player" alt="" draggable={false} />
      <img
        src={currentFrames[recordFrame]}
        className={`record-player ${swapping ? 'record-slide-out' : ''}`}
        alt=""
        draggable={false}
      />
      {swapping && (
        <img
          src={incomingFrames[0]}
          className="record-player record-slide-in"
          alt=""
          draggable={false}
        />
      )}
      <img
        src={needleLifted ? assets.needleChangeFrames[needleChangeFrame] : assets.needlePlayFrames[needleFrame]}
        className="record-player"
        alt=""
        draggable={false}
      />

      {/* Frame overlay (no background) to clip sliding records */}
      <img src={assets.frameNoBg} className="layer frame-overlay" alt="" draggable={false} />

      {/* Decorative */}
      <img src={assets.plant} className="layer layer-ui" alt="" draggable={false} />

      {/* Progress bar layers */}
      <img src={assets.progressBar} className="layer layer-ui" alt="" draggable={false} />
      <img
        src={progressBarStars}
        className="layer layer-ui"
        alt=""
        draggable={false}
        style={{
          clipPath: `inset(0 ${(1 - (131 + (hoverProgress ?? progress) * 226 + 10) / 512) * 100}% 0 0)`,
        }}
      />
      <img
        src={starHovered ? starSelected : star}
        className={`layer layer-ui star-indicator ${starHovered ? 'star-hovered' : ''}`}
        alt=""
        draggable={false}
        style={{
          transform: `translateX(calc(-3 / 306 * 100vw + ${(hoverProgress ?? progress) * (226 / 512) * 171.9}vw))`,
        }}
      />

      {/* Playback control layers (visual only) */}
      <img src={assets.backwardsButton} className="layer layer-ui" alt="" draggable={false} />
      <img src={isPlaying? assets.pauseButton : assets.playButton} className="layer layer-ui" alt="" draggable={false} />
      <img src={assets.forwardsButton} className="layer layer-ui" alt="" draggable={false} />

      {/* Window control layers (visual only) */}
      <img src={assets.minimizerButton} className="layer layer-ui" alt="" draggable={false} />
      <img src={assets.windowButton} className="layer layer-ui" alt="" draggable={false} />
      <img src={assets.exitButton} className="layer layer-ui" alt="" draggable={false} />

      {/* Settings button layer */}
      <img src={assets.settings} className="layer layer-ui settings-layer" alt="" draggable={false} />

      {/* SVG clip-path for pixel-art album mask */}
      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <defs>
          <clipPath id="album-mask" clipPathUnits="objectBoundingBox">
            {/* 35x41 centered vertically */}
            <rect x="0.07317" y="0" width="0.85366" height="1" />
            {/* 37x39 */}
            <rect x="0.04878" y="0.02439" width="0.90244" height="0.95122" />
            {/* 39x37 */}
            <rect x="0.02439" y="0.04878" width="0.95122" height="0.90244" />
            {/* 41x35 */}
            <rect x="0" y="0.07317" width="1" height="0.85366" />
          </clipPath>
        </defs>
      </svg>

      {/* Album art clipped to pixel mask */}
      {track.art && (
        <div className="album-mask">
          <img src={track.art} className="album-art" alt="" draggable={false} />
        </div>
      )}

      {/* Album frame overlay */}
      <img src={assets.albumFrame} className="layer album-frame-layer" alt="" draggable={false} />

      {/* Now playing section */}
      <div className="now-playing">
        <div className="track-info">
          <div className="now-playing-label">
            now playing...
          </div>
          <MarqueeText className="track-title" text={track.title} />
          <div className="track-artist">by {track.artist}</div>
        </div>
      </div>

      {/* Time display */}
      <div className="time-display">
        <span className="time-current">{formatTime(currentTime)}</span>
        <span className="time-remaining">{formatTime(duration - currentTime)}</span>
      </div>

      {/* Drag region for moving the window */}
      <div className="drag-region" />

      {/* Custom resize handles at frame corners */}
      <div className="resize-handle top-left" onMouseDown={resizeTL} />
      <div className="resize-handle top-right" onMouseDown={resizeTR} />
      <div className="resize-handle bottom-left" onMouseDown={resizeBL} />
      <div className="resize-handle bottom-right" onMouseDown={resizeBR} />

      {/* Progress bar seek target */}
      <div
        className="progress-seek"
        ref={seekRef}
        onMouseEnter={() => setStarHovered(true)}
        onMouseLeave={() => { if (!dragging) { setStarHovered(false); } }}
        onMouseDown={(e) => {
          e.preventDefault();
          setDragging(true);
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          setHoverProgress(pct);
          seek(pct);
        }}
      />

      {/* Playback control click targets */}
      <div className="btn btn-prev" onClick={prev} />
      <div className="btn btn-play" onClick={togglePlay} />
      <div className="btn btn-next" onClick={next} />

      {/* Window control click targets */}
      <div className="btn btn-minimize" onClick={() => getCurrentWindow().minimize()} />
      <div className="btn btn-window" onClick={() => invoke('window_maximize')} />
      <div className="btn btn-exit" onClick={() => getCurrentWindow().close()} />

      {/* Settings button */}
      <div className="btn btn-settings" onClick={() => setShowSettings((v) => !v)} />

      {/* Settings panel */}
      {showSettings && (
        <div className="settings-panel">
          <div className="settings-panel-inner">
            <div className="settings-label">theme</div>
            <div className="settings-theme-row">
              <button
                className={`settings-theme-btn ${theme === 'pink' ? 'active' : ''}`}
                onClick={() => { if (theme !== 'pink') toggleTheme(); }}
              >
                pink
              </button>
              <button
                className={`settings-theme-btn ${theme === 'blue' ? 'active' : ''}`}
                onClick={() => { if (theme !== 'blue') toggleTheme(); }}
              >
                blue
              </button>
            </div>
            <div className="settings-label">music</div>
            <div className="settings-theme-row">
              <button
                className={`settings-theme-btn ${musicService === 'spotify' ? 'active' : ''}`}
                onClick={() => setMusicService('spotify')}
              >
                spotify
              </button>
              <button
                className={`settings-theme-btn ${musicService === 'apple' ? 'active' : ''}`}
                onClick={() => setMusicService('apple')}
              >
                apple
              </button>
              <button
                className={`settings-theme-btn settings-shuffle ${shuffle ? 'active' : ''}`}
                onClick={() => setShuffle((s) => !s)}
                title="Shuffle"
              >
                &#8645;
              </button>
            </div>

            {musicService === 'spotify' && (
              !spotifyConnected ? (
                <button className="settings-theme-btn" onClick={() => spotifyLogin()}>
                  log in
                </button>
              ) : (
                <>
                  <div className="settings-playlist-list">
                    {loadingPlaylists ? (
                      <div className="settings-label">loading...</div>
                    ) : (
                      spotifyPlaylists.map((p) => (
                        <button
                          key={p.id}
                          className={`settings-playlist-item ${loadingPlaylist ? 'disabled' : ''}`}
                          onClick={() => loadPlaylist(p.id, 'spotify')}
                          disabled={loadingPlaylist}
                        >
                          {p.name}
                        </button>
                      ))
                    )}
                  </div>
                  <div className="settings-theme-row">
                    {source === 'streaming' && (
                      <button className="settings-theme-btn" onClick={() => setSource('local')}>
                        local
                      </button>
                    )}
                    <button className="settings-theme-btn" onClick={() => {
                      spotifyLogout();
                      setSpotifyConnected(false);
                      setSpotifyPlaylists([]);
                      if (source === 'streaming') setSource('local');
                    }}>
                      logout
                    </button>
                  </div>
                </>
              )
            )}

            {musicService === 'apple' && (
              !appleConnected ? (
                <button className="settings-theme-btn" onClick={async () => {
                  try {
                    await appleLogin();
                    setAppleConnected(true);
                    loadApplePlaylists();
                  } catch (err) {
                    setSettingsError(err.message);
                  }
                }}>
                  log in
                </button>
              ) : (
                <>
                  <div className="settings-playlist-list">
                    {applePlaylists.map((p) => (
                      <button
                        key={p.id}
                        className={`settings-playlist-item ${loadingPlaylist ? 'disabled' : ''}`}
                        onClick={() => loadPlaylist(p.id, 'apple')}
                        disabled={loadingPlaylist}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                  <div className="settings-theme-row">
                    {source === 'streaming' && (
                      <button className="settings-theme-btn" onClick={() => setSource('local')}>
                        local
                      </button>
                    )}
                    <button className="settings-theme-btn" onClick={() => {
                      appleLogout();
                      setAppleConnected(false);
                      setApplePlaylists([]);
                      if (source === 'streaming') setSource('local');
                    }}>
                      logout
                    </button>
                  </div>
                </>
              )
            )}

            {settingsError && <div className="settings-error">{settingsError}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
