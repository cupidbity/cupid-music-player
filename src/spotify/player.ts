// Spotify Web Playback SDK wrapper

let sdkReady: Promise<void> | null = null;
let playerInstance: Spotify.Player | null = null;
let deviceId: string | null = null;

export function loadSDK(): Promise<void> {
  if (sdkReady) return sdkReady;

  sdkReady = new Promise<void>((resolve) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve();

    if (window.Spotify) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;
    document.body.appendChild(script);
  });

  return sdkReady;
}

interface InitPlayerOptions {
  onStateChange?: (state: Spotify.PlaybackState | null) => void;
  onReady?: (args: { device_id: string }) => void;
  onTokenRefresh?: () => Promise<string>;
}

export async function initPlayer(
  accessToken: string,
  { onStateChange, onReady, onTokenRefresh }: InitPlayerOptions,
): Promise<Spotify.Player> {
  await loadSDK();

  if (playerInstance) {
    playerInstance.disconnect();
    playerInstance = null;
    deviceId = null;
  }

  const player = new window.Spotify.Player({
    name: 'Cupid Player',
    getOAuthToken: async (cb: (token: string) => void) => {
      if (onTokenRefresh) {
        const freshToken = await onTokenRefresh();
        cb(freshToken);
      } else {
        cb(accessToken);
      }
    },
    volume: 0.5,
  });

  player.addListener('ready', ({ device_id }: { device_id: string }) => {
    deviceId = device_id;
    onReady?.({ device_id });
  });

  player.addListener('not_ready', () => {
    deviceId = null;
  });

  player.addListener('player_state_changed', (state: Spotify.PlaybackState | null) => {
    onStateChange?.(state);
  });

  player.addListener('initialization_error', ({ message }: { message: string }) => {
    console.error('[Spotify SDK] Initialization error:', message);
  });
  player.addListener('authentication_error', ({ message }: { message: string }) => {
    console.error('[Spotify SDK] Authentication error:', message);
  });
  player.addListener('account_error', ({ message }: { message: string }) => {
    console.error('[Spotify SDK] Account error (Premium required):', message);
  });

  const connected = await player.connect();
  if (!connected) throw new Error('Failed to connect Spotify Web Playback SDK');

  playerInstance = player;
  return player;
}

export function disconnectPlayer(): void {
  if (playerInstance) {
    playerInstance.disconnect();
    playerInstance = null;
    deviceId = null;
  }
}

export function getDeviceId(): string | null {
  return deviceId;
}

export async function playTracks(token: string, uris: string[], offset = 0): Promise<void> {
  const id = getDeviceId();
  if (!id) throw new Error('No Spotify device connected');

  await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ uris, offset: { position: offset } }),
  });
}

export async function resume(): Promise<void> {
  if (playerInstance) await playerInstance.resume();
}

export async function pause(): Promise<void> {
  if (playerInstance) await playerInstance.pause();
}

export async function seek(ms: number): Promise<void> {
  if (playerInstance) await playerInstance.seek(ms);
}

export async function nextTrack(): Promise<void> {
  if (playerInstance) await playerInstance.nextTrack();
}

export async function previousTrack(): Promise<void> {
  if (playerInstance) await playerInstance.previousTrack();
}

export async function getCurrentState(): Promise<Spotify.PlaybackState | null> {
  if (!playerInstance) return null;
  return playerInstance.getCurrentState();
}
