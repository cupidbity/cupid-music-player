import { getMusicKit, initMusicKit } from './auth.ts';
import type { Track, Playlist } from '../types.ts';

export async function fetchMyPlaylists(): Promise<Playlist[]> {
  const mk = getMusicKit() ?? await initMusicKit();

  const response = await mk.api.music('/v1/me/library/playlists', { limit: 100 });

  return response.data.data.map((p) => ({
    id: p.id,
    name: p.attributes['name'] as string,
    image: p.attributes['artwork']
      ? window.MusicKit.formatArtworkURL(
          p.attributes['artwork'] as Parameters<typeof window.MusicKit.formatArtworkURL>[0],
          300,
          300,
        )
      : null,
    trackCount: (p.attributes['trackCount'] as number | undefined) ?? 0,
  }));
}

export async function fetchPlaylistTracks(playlistId: string): Promise<Track[]> {
  const mk = getMusicKit() ?? await initMusicKit();

  const response = await mk.api.music(
    `/v1/me/library/playlists/${playlistId}/tracks`,
    { limit: 100 },
  );

  return response.data.data
    .filter((t) => t.attributes)
    .map((t) => ({
      title: t.attributes['name'] as string,
      artist: t.attributes['artistName'] as string,
      art: t.attributes['artwork']
        ? window.MusicKit.formatArtworkURL(
            t.attributes['artwork'] as Parameters<typeof window.MusicKit.formatArtworkURL>[0],
            300,
            300,
          )
        : null,
      uri: `apple:track:${t.id}`,
    }));
}
