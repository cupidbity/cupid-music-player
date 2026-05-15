import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Track, PlayerState } from './types.ts';

export default function useSpotifyPlayer(tracks: Track[], shuffle = false): PlayerState & { loading: boolean } {
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

  const track: Track = tracks[trackIndex] ?? { title: 'No track', artist: '', art: null };

  useEffect(() => {
    if (tracks.length === 0) return;
    const t = tracks[trackIndex];
    if (!t) return;

    let cancelled = false;
    setLoading(true);

    async function loadStream() {
      try {
        const url = await invoke<string>('get_stream_url', { title: t.title, artist: t.artist });
        if (cancelled) return;
        audio.src = url;
        audio.load();
        if (isPlaying) audio.play().catch(() => {});
      } catch (err) {
        console.error('[yt-dlp] Failed to get stream:', (err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadStream();
    return () => { cancelled = true; };
  }, [trackIndex, tracks]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tracks.length === 0) return;
    const nextIdx = (trackIndex + 1) % tracks.length;
    const nextTrack = tracks[nextIdx];
    if (nextTrack) {
      invoke('get_stream_url', { title: nextTrack.title, artist: nextTrack.artist }).catch(() => {});
    }
  }, [trackIndex, tracks]);

  useEffect(() => {
    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      if (audio.duration) setProgress(audio.currentTime / audio.duration);
    };
    const onLoadedMetadata = () => setDuration(audio.duration);
    const onEnded = () => {
      setTrackIndex((prev) => {
        if (shuffleRef.current && tracks.length > 1) {
          let next: number;
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
  }, [tracks.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePlay = useCallback(() => {
    if (isPlaying) { audio.pause(); setIsPlaying(false); }
    else { audio.play().catch(() => {}); setIsPlaying(true); }
  }, [isPlaying]); // eslint-disable-line react-hooks/exhaustive-deps

  const next = useCallback(() => {
    setTrackIndex((prev) => {
      if (shuffleRef.current && tracks.length > 1) {
        let n: number;
        do { n = Math.floor(Math.random() * tracks.length); } while (n === prev);
        return n;
      }
      return (prev + 1) % tracks.length;
    });
    setIsPlaying(true);
  }, [tracks.length]);

  const prev = useCallback(() => {
    if (audio.currentTime > 3) { audio.currentTime = 0; }
    else { setTrackIndex((p) => (p - 1 + tracks.length) % tracks.length); }
    setIsPlaying(true);
  }, [tracks.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const seek = useCallback((fraction: number) => {
    if (audio.duration) audio.currentTime = Math.min(fraction, 1) * audio.duration;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { track, trackIndex, isPlaying, progress, duration, currentTime, togglePlay, next, prev, seek, loading };
}
