import { invoke } from '@tauri-apps/api/core';
import type { MusicKitInstance } from '../types.ts';

const DEVELOPER_TOKEN_KEY = 'apple_developer_token';
const USER_TOKEN_KEY = 'apple_user_token';

let musicKitInstance: MusicKitInstance | null = null;

function loadMusicKitScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.MusicKit) { resolve(); return; }

    if (document.querySelector('script[src*="musickit"]')) {
      const poll = setInterval(() => {
        if (window.MusicKit) { clearInterval(poll); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(poll); reject(new Error('MusicKit JS timed out')); }, 10000);
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
    script.onload = () => {
      const poll = setInterval(() => {
        if (window.MusicKit) { clearInterval(poll); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(poll); reject(new Error('MusicKit JS timed out')); }, 10000);
    };
    script.onerror = () => reject(new Error('Failed to load MusicKit JS'));
    document.head.appendChild(script);
  });
}

export async function initMusicKit(): Promise<MusicKitInstance> {
  if (musicKitInstance) return musicKitInstance;

  const devToken = await invoke<string>('get_apple_music_token');
  if (!devToken) throw new Error('No Apple Music developer token — check your .env and .p8 key file');

  localStorage.setItem(DEVELOPER_TOKEN_KEY, devToken);
  await loadMusicKitScript();

  musicKitInstance = await window.MusicKit.configure({
    developerToken: devToken,
    app: { name: 'Cupid Player', build: '1.0.0' },
  });

  return musicKitInstance;
}

export async function login(): Promise<string> {
  const mk = await initMusicKit();
  const userToken = await mk.authorize();
  localStorage.setItem(USER_TOKEN_KEY, userToken);
  return userToken;
}

export async function logout(): Promise<void> {
  if (musicKitInstance) await musicKitInstance.unauthorize();
  localStorage.removeItem(USER_TOKEN_KEY);
  localStorage.removeItem(DEVELOPER_TOKEN_KEY);
  musicKitInstance = null;
}

export function isLoggedIn(): boolean {
  return !!localStorage.getItem(USER_TOKEN_KEY);
}

export function getMusicKit(): MusicKitInstance | null {
  return musicKitInstance;
}
