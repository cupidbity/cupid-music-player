import { useState, useRef, useEffect, useCallback } from 'react';
import playlist from './playlist.ts';
import type { PlayerState } from './types.ts';

export default function useAudioPlayer(shuffle = false): PlayerState {
  const audioRef = useRef(new Audio());
  const shuffleRef = useRef(shuffle);
  shuffleRef.current = shuffle;
  const [trackIndex, setTrackIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  const track = playlist[trackIndex];
  const audio = audioRef.current;

  useEffect(() => {
    audio.src = `./audio/${track.file}`;
    audio.load();
    setProgress(0);
    setCurrentTime(0);
    setDuration(0);

    if (isPlaying) audio.play().catch(() => {});
  }, [trackIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      if (audio.duration) setProgress(audio.currentTime / audio.duration);
    };
    const onLoadedMetadata = () => setDuration(audio.duration);
    const onError = () => setIsPlaying(false);
    const onEnded = () => {
      setTrackIndex((prev) => {
        if (shuffleRef.current) {
          let next: number;
          do { next = Math.floor(Math.random() * playlist.length); }
          while (next === prev && playlist.length > 1);
          return next;
        }
        return (prev + 1) % playlist.length;
      });
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('error', onError);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('error', onError);
      audio.removeEventListener('ended', onEnded);
    };
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    }
  }, [isPlaying]);  // eslint-disable-line react-hooks/exhaustive-deps

  const next = useCallback(() => {
    setTrackIndex((prev) => {
      if (shuffleRef.current && playlist.length > 1) {
        let n: number;
        do { n = Math.floor(Math.random() * playlist.length); } while (n === prev);
        return n;
      }
      return (prev + 1) % playlist.length;
    });
  }, []);

  const prev = useCallback(() => {
    if (audio.currentTime > 3) { audio.currentTime = 0; }
    else { setTrackIndex((p) => (p - 1 + playlist.length) % playlist.length); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const seek = useCallback((fraction: number) => {
    if (audio.duration) audio.currentTime = Math.min(fraction, 1) * audio.duration;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { track, trackIndex, isPlaying, progress, duration, currentTime, togglePlay, next, prev, seek };
}
