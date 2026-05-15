/**
 * React hook for Spotify playback via yt-dlp audio streams.
 *
 * Uses Spotify API for metadata/playlists, then fetches audio
 * from YouTube via yt-dlp in the main process. Plays via HTML5 Audio.
 *
 * Exposes the same interface as useAudioPlayer.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

export default function useSpotifyPlayer(tracks, shuffle = false) {
  const audioRef = useRef(new Audio());
  const shuffleRef = useRef(shuffle);
  shuffleRef.current = shuffle;
  const [trackIndex, setTrackIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [loading, setLoading] = useState(false);

  const audio = audioRef.current;

  const track = tracks[trackIndex] ?? {
    title: 'No track',
    artist: '',
    art: null,
    uri: null,
  };

  // ── Load track via yt-dlp when index or tracks change ─────
  useEffect(() => {
    if (tracks.length === 0) return;
    const t = tracks[trackIndex];
    if (!t) return;

    let cancelled = false;
    setLoading(true);

    async function loadStream() {
      try {
        const url = await invoke('get_stream_url', { title: t.title, artist: t.artist });
        if (cancelled) return;
        audio.src = url;
        audio.load();
        if (isPlaying) {
          audio.play().catch(() => {});
        }
      } catch (err) {
        console.error('[yt-dlp] Failed to get stream:', err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadStream();

    return () => { cancelled = true; };
  }, [trackIndex, tracks]);

  // ── Prefetch next track ───────────────────────────────────
  useEffect(() => {
    if (tracks.length === 0) return;
    const nextIdx = (trackIndex + 1) % tracks.length;
    const nextTrack = tracks[nextIdx];
    if (nextTrack) {
      // Fire and forget — just warms the cache in main process
      invoke('get_stream_url', { title: nextTrack.title, artist: nextTrack.artist }).catch(() => {});
    }
  }, [trackIndex, tracks]);

  // ── Audio event listeners ─────────────────────────────────
  useEffect(() => {
    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      if (audio.duration) {
        setProgress(audio.currentTime / audio.duration);
      }
    };

    const onLoadedMetadata = () => {
      setDuration(audio.duration);
    };

    const onEnded = () => {
      setTrackIndex((prev) => {
        if (shuffleRef.current && tracks.length > 1) {
          let next;
          do { next = Math.floor(Math.random() * tracks.length); } while (next === prev);
          return next;
        }
        return (prev + 1) % tracks.length;
      });
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
    };
  }, [tracks.length]);

  // ── Playback controls ────────────────────────────────────

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play().catch(() => {});
      setIsPlaying(true);
    }
  }, [isPlaying]);

  const next = useCallback(() => {
    setTrackIndex((prev) => {
      if (shuffleRef.current && tracks.length > 1) {
        let n;
        do { n = Math.floor(Math.random() * tracks.length); } while (n === prev);
        return n;
      }
      return (prev + 1) % tracks.length;
    });
    setIsPlaying(true);
  }, [tracks.length]);

  const prev = useCallback(() => {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
    } else {
      setTrackIndex((prev) => (prev - 1 + tracks.length) % tracks.length);
    }
    setIsPlaying(true);
  }, [tracks.length]);

  const seek = useCallback((fraction) => {
    if (audio.duration) {
      audio.currentTime = Math.min(fraction, 1) * audio.duration;
    }
  }, []);

  return {
    track,
    trackIndex,
    isPlaying,
    progress,
    duration,
    currentTime,
    togglePlay,
    next,
    prev,
    seek,
    loading,
  };
}
