/// <reference types="vite/client" />
/// <reference types="spotify-web-playback-sdk" />

// Asset module declarations
declare module '*.png' { const src: string; export default src; }
declare module '*.jpg' { const src: string; export default src; }
declare module '*.jpeg' { const src: string; export default src; }
declare module '*.svg' { const src: string; export default src; }
declare module '*.ttf' { const src: string; export default src; }
declare module '*.woff' { const src: string; export default src; }
declare module '*.woff2' { const src: string; export default src; }
declare module '*.css' { }

// Spotify Web Playback SDK on window
interface Window {
  Spotify: typeof Spotify;
  onSpotifyWebPlaybackSDKReady: () => void;
  MusicKit: {
    configure(config: {
      developerToken: string;
      app: { name: string; build: string };
    }): Promise<import('./types.ts').MusicKitInstance>;
    getInstance(): import('./types.ts').MusicKitInstance;
    formatArtworkURL(
      artwork: { url: string; width?: number; height?: number },
      width: number,
      height: number,
    ): string;
  };
}
