import { useCallback, useRef, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import './App.css';
import useAudioPlayer from './useAudioPlayer.ts';
import useSpotifyPlayer from './useSpotifyPlayer.ts';
import useTheme from './useTheme.ts';
import { login as spotifyLogin, handleCallback, isLoggedIn as isSpotifyLoggedIn, logout as spotifyLogout } from './spotify/auth.ts';
import { fetchPlaylistTracks as fetchSpotifyTracks, fetchMyPlaylists as fetchSpotifyPlaylists } from './spotify/api.ts';
import { login as appleLogin, logout as appleLogout, isLoggedIn as isAppleLoggedIn, initMusicKit } from './apple/auth.ts';
import { fetchMyPlaylists as fetchApplePlaylists, fetchPlaylistTracks as fetchAppleTracks } from './apple/api.ts';
import type { Track, Playlist, MusicSource, MusicService } from './types.ts';

import progressBarStars from '../assets/progress_bar_stars.png';
import star from '../assets/star.png';
import starSelected from '../assets/star_selected.png';

function useResize(corner: string): (e: React.MouseEvent) => void {
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    let lastX = e.screenX;
    let lastY = e.screenY;

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.screenX - lastX;
      const dy = ev.screenY - lastY;
      lastX = ev.screenX;
      lastY = ev.screenY;
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

function formatTime(seconds: number): string {
  if (!seconds || !isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface MarqueeTextProps { className: string; text: string }

function MarqueeText({ className, text }: MarqueeTextProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [shouldScroll, setShouldScroll] = useState(false);

  useEffect(() => {
    const outer = outerRef.current;
    const textEl = textRef.current;
    if (!outer || !textEl) return;
    setShouldScroll(textEl.offsetWidth > outer.clientWidth);
  }, [text]);

  return (
    <div className={`${className} marquee-container`} ref={outerRef}>
      <span ref={textRef} className="marquee-measure">{text}</span>
      <span className={shouldScroll ? 'marquee-scroll' : ''}>
        {text}
        {shouldScroll && <span className="marquee-gap">{text}</span>}
      </span>
    </div>
  );
}

export default function App() {
  const [source, setSource] = useState<MusicSource>('local');
  const [spotifyConnected, setSpotifyConnected] = useState(isSpotifyLoggedIn());
  const [appleConnected, setAppleConnected] = useState(isAppleLoggedIn());
  const [streamTracks, setStreamTracks] = useState<Track[]>([]);
  const [spotifyPlaylists, setSpotifyPlaylists] = useState<Playlist[]>([]);
  const [applePlaylists, setApplePlaylists] = useState<Playlist[]>([]);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [loadingPlaylist, setLoadingPlaylist] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [musicService, setMusicService] = useState<MusicService>('spotify');
  const [shuffle, setShuffle] = useState(false);

  const local = useAudioPlayer(shuffle);
  const streaming = useSpotifyPlayer(streamTracks, shuffle);
  const player = source === 'streaming' ? streaming : local;

  const { track, isPlaying, progress, duration, currentTime, togglePlay, next, prev, seek } = player;

  const loadSpotifyPlaylists = useCallback((silent = false) => {
    setLoadingPlaylists(true);
    if (!silent) setSettingsError(null);
    fetchSpotifyPlaylists()
      .then((p) => { setSpotifyPlaylists(p); setSettingsError(null); })
      .catch((err: Error) => { if (!silent) setSettingsError(err.message); })
      .finally(() => setLoadingPlaylists(false));
  }, []);

  const loadApplePlaylists = useCallback(() => {
    setLoadingPlaylists(true);
    setSettingsError(null);
    fetchApplePlaylists()
      .then(setApplePlaylists)
      .catch((err: Error) => setSettingsError(err.message))
      .finally(() => setLoadingPlaylists(false));
  }, []);

  useEffect(() => {
    async function checkCallback() {
      const params = new URLSearchParams(window.location.search);
      if (params.has('code')) {
        try {
          await handleCallback();
          setSpotifyConnected(true);
          setTimeout(() => loadSpotifyPlaylists(true), 500);
        } catch (err) {
          setSettingsError((err as Error).message);
        }
      } else {
        if (isSpotifyLoggedIn()) loadSpotifyPlaylists(true);
        if (isAppleLoggedIn()) loadApplePlaylists();
      }
    }
    checkCallback();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const unlistenPromise = listen<string>('spotify-callback', async (event) => {
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
        setSettingsError((err as Error).message);
      }
    });
    return () => { unlistenPromise.then((fn) => fn()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadPlaylist = useCallback(async (id: string, service: MusicService) => {
    setLoadingPlaylist(true);
    setSettingsError(null);
    try {
      const fetcher = service === 'apple' ? fetchAppleTracks : fetchSpotifyTracks;
      const tracks = await fetcher(id);
      if (tracks.length === 0) { setSettingsError('Playlist is empty'); return; }
      setStreamTracks(tracks);
      setSource('streaming');
    } catch (err) {
      setSettingsError((err as Error).message);
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
  const [hoverProgress, setHoverProgress] = useState<number | null>(null);
  const seekRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dragging) return;
    const onMouseMove = (e: MouseEvent) => {
      const rect = seekRef.current!.getBoundingClientRect();
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

  useEffect(() => {
    if (!isPlaying || swapping) return;
    const interval = setInterval(() => {
      setRecordFrame((f) => (f + 1) % currentFrames.length);
      setNeedleFrame((f) => (f + 1) % assets.needlePlayFrames.length);
    }, 400);
    return () => clearInterval(interval);
  }, [isPlaying, swapping, currentFrames.length, assets.needlePlayFrames.length]);

  useEffect(() => {
    if (prevTrackRef.current === track.title) return;
    prevTrackRef.current = track.title;
    if (needleLifted) return;

    setNeedleLifted(true);
    setNeedleChangeFrame(0);
    setTimeout(() => setNeedleChangeFrame(1), 200);
    setTimeout(() => setSwapping(true), 400);
    setTimeout(() => { setIsPink((p) => !p); setRecordFrame(0); setSwapping(false); }, 1000);
    setTimeout(() => { setNeedleChangeFrame(0); setNeedleLifted(false); setNeedleFrame(0); }, 1100);
  }, [track.title, needleLifted]);

  const resizeTL = useResize('top-left');
  const resizeTR = useResize('top-right');
  const resizeBL = useResize('bottom-left');
  const resizeBR = useResize('bottom-right');

  return (
    <div className={`player ${theme === 'blue' ? 'theme-blue' : ''}`}>
      <img src={assets.frame} className="layer" alt="" draggable={false} />
      <div className="window-title">cupid player</div>
      <img src={assets.recordPlayer} className="record-player" alt="" draggable={false} />
      <img
        src={currentFrames[recordFrame]}
        className={`record-player ${swapping ? 'record-slide-out' : ''}`}
        alt=""
        draggable={false}
      />
      {swapping && (
        <img src={incomingFrames[0]} className="record-player record-slide-in" alt="" draggable={false} />
      )}
      <img
        src={needleLifted ? assets.needleChangeFrames[needleChangeFrame] : assets.needlePlayFrames[needleFrame]}
        className="record-player"
        alt=""
        draggable={false}
      />

      <img src={assets.frameNoBg} className="layer frame-overlay" alt="" draggable={false} />
      <img src={assets.plant} className="layer layer-ui" alt="" draggable={false} />

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

      <img src={assets.backwardsButton} className="layer layer-ui" alt="" draggable={false} />
      <img src={isPlaying ? assets.pauseButton : assets.playButton} className="layer layer-ui" alt="" draggable={false} />
      <img src={assets.forwardsButton} className="layer layer-ui" alt="" draggable={false} />

      <img src={assets.minimizerButton} className="layer layer-ui" alt="" draggable={false} />
      <img src={assets.windowButton} className="layer layer-ui" alt="" draggable={false} />
      <img src={assets.exitButton} className="layer layer-ui" alt="" draggable={false} />

      <img src={assets.settings} className="layer layer-ui settings-layer" alt="" draggable={false} />

      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <defs>
          <clipPath id="album-mask" clipPathUnits="objectBoundingBox">
            <rect x="0.07317" y="0" width="0.85366" height="1" />
            <rect x="0.04878" y="0.02439" width="0.90244" height="0.95122" />
            <rect x="0.02439" y="0.04878" width="0.95122" height="0.90244" />
            <rect x="0" y="0.07317" width="1" height="0.85366" />
          </clipPath>
        </defs>
      </svg>

      {track.art && (
        <div className="album-mask">
          <img src={track.art} className="album-art" alt="" draggable={false} />
        </div>
      )}

      <img src={assets.albumFrame} className="layer album-frame-layer" alt="" draggable={false} />

      <div className="now-playing">
        <div className="track-info">
          <div className="now-playing-label">now playing...</div>
          <MarqueeText className="track-title" text={track.title} />
          <div className="track-artist">by {track.artist}</div>
        </div>
      </div>

      <div className="time-display">
        <span className="time-current">{formatTime(currentTime)}</span>
        <span className="time-remaining">{formatTime(duration - currentTime)}</span>
      </div>

      <div className="drag-region" data-tauri-drag-region />

      <div className="resize-handle top-left" onMouseDown={resizeTL} />
      <div className="resize-handle top-right" onMouseDown={resizeTR} />
      <div className="resize-handle bottom-left" onMouseDown={resizeBL} />
      <div className="resize-handle bottom-right" onMouseDown={resizeBR} />

      <div
        className="progress-seek"
        ref={seekRef}
        onMouseEnter={() => setStarHovered(true)}
        onMouseLeave={() => { if (!dragging) setStarHovered(false); }}
        onMouseDown={(e) => {
          e.preventDefault();
          setDragging(true);
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          setHoverProgress(pct);
          seek(pct);
        }}
      />

      <div className="btn btn-prev" onClick={prev} />
      <div className="btn btn-play" onClick={togglePlay} />
      <div className="btn btn-next" onClick={next} />

      <div className="btn btn-minimize" onClick={() => getCurrentWindow().minimize()} />
      <div className="btn btn-window" onClick={() => invoke('window_maximize')} />
      <div className="btn btn-exit" onClick={() => getCurrentWindow().close()} />

      <div className="btn btn-settings" onClick={() => setShowSettings((v) => !v)} />

      {showSettings && (
        <div className="settings-panel">
          <div className="settings-panel-inner">
            <div className="settings-label">theme</div>
            <div className="settings-theme-row">
              <button
                className={`settings-theme-btn ${theme === 'pink' ? 'active' : ''}`}
                onClick={() => { if (theme !== 'pink') toggleTheme(); }}
              >pink</button>
              <button
                className={`settings-theme-btn ${theme === 'blue' ? 'active' : ''}`}
                onClick={() => { if (theme !== 'blue') toggleTheme(); }}
              >blue</button>
            </div>
            <div className="settings-label">music</div>
            <div className="settings-theme-row">
              <button
                className={`settings-theme-btn ${musicService === 'spotify' ? 'active' : ''}`}
                onClick={() => setMusicService('spotify')}
              >spotify</button>
              <button
                className={`settings-theme-btn ${musicService === 'apple' ? 'active' : ''}`}
                onClick={() => setMusicService('apple')}
              >apple</button>
              <button
                className={`settings-theme-btn settings-shuffle ${shuffle ? 'active' : ''}`}
                onClick={() => setShuffle((s) => !s)}
                title="Shuffle"
              >&#8645;</button>
            </div>

            {musicService === 'spotify' && (
              !spotifyConnected ? (
                <button className="settings-theme-btn" onClick={() => spotifyLogin()}>log in</button>
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
                        >{p.name}</button>
                      ))
                    )}
                  </div>
                  <div className="settings-theme-row">
                    {source === 'streaming' && (
                      <button className="settings-theme-btn" onClick={() => setSource('local')}>local</button>
                    )}
                    <button className="settings-theme-btn" onClick={() => {
                      spotifyLogout();
                      setSpotifyConnected(false);
                      setSpotifyPlaylists([]);
                      if (source === 'streaming') setSource('local');
                    }}>logout</button>
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
                    setSettingsError((err as Error).message);
                  }
                }}>log in</button>
              ) : (
                <>
                  <div className="settings-playlist-list">
                    {applePlaylists.map((p) => (
                      <button
                        key={p.id}
                        className={`settings-playlist-item ${loadingPlaylist ? 'disabled' : ''}`}
                        onClick={() => loadPlaylist(p.id, 'apple')}
                        disabled={loadingPlaylist}
                      >{p.name}</button>
                    ))}
                  </div>
                  <div className="settings-theme-row">
                    {source === 'streaming' && (
                      <button className="settings-theme-btn" onClick={() => setSource('local')}>local</button>
                    )}
                    <button className="settings-theme-btn" onClick={() => {
                      appleLogout();
                      setAppleConnected(false);
                      setApplePlaylists([]);
                      if (source === 'streaming') setSource('local');
                    }}>logout</button>
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
