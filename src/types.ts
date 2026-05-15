export type ThemeName = 'pink' | 'blue';
export type MusicSource = 'local' | 'streaming';
export type MusicService = 'spotify' | 'apple';

export interface Track {
  title: string;
  artist: string;
  art: string | null;
  uri?: string;
  file?: string;
  album?: string;
}

export interface Playlist {
  id: string;
  name: string;
  image: string | null;
  trackCount: number;
}

export interface PlayerState {
  track: Track;
  trackIndex: number;
  isPlaying: boolean;
  progress: number;
  duration: number;
  currentTime: number;
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  seek: (fraction: number) => void;
  loading?: boolean;
}


export interface MusicKitInstance {
  authorize(): Promise<string>;
  unauthorize(): Promise<void>;
  api: {
    music(
      path: string,
      params?: Record<string, unknown>,
    ): Promise<{ data: { data: MusicKitResource[] } }>;
  };
}

export interface MusicKitResource {
  id: string;
  attributes: Record<string, unknown>;
}
