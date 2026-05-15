import { getAccessToken } from './auth.ts';
import type { Track, Playlist } from '../types.ts';

const API_BASE = 'https://api.spotify.com/v1';

async function fetchWithRetry(url: string, options: RequestInit, retries = 3): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, options);
    if (res.ok || (res.status < 500 && res.status !== 429)) return res;
    if (i < retries) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  return fetch(url, options);
}

export function parsePlaylistUrl(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();

  const uriMatch = trimmed.match(/^spotify:playlist:([a-zA-Z0-9]+)$/);
  if (uriMatch) return uriMatch[1];

  try {
    const url = new URL(trimmed);
    if (url.hostname === 'open.spotify.com') {
      const parts = url.pathname.split('/');
      const idx = parts.indexOf('playlist');
      if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
    }
  } catch {
    // not a valid URL
  }

  return null;
}

export async function fetchPlaylistTracks(playlistId: string): Promise<Track[]> {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated with Spotify');

  const res = await fetchWithRetry(`${API_BASE}/playlists/${playlistId}?market=from_token`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify API error ${res.status}: ${text}`);
  }

  const data = await res.json() as {
    tracks?: { items: SpotifyPlaylistItem[] };
    items?: SpotifyPlaylistItem[];
  };

  const container = data.tracks ?? data;
  const items = (container as { items?: SpotifyPlaylistItem[] }).items ?? [];
  const tracks: Track[] = [];

  for (const entry of items) {
    const t = entry.track ?? entry.item;
    if (!t?.uri) continue;
    tracks.push({
      title: t.name,
      artist: t.artists.map((a) => a.name).join(', '),
      art: t.album?.images?.[0]?.url ?? null,
      uri: t.uri,
    });
  }

  const missing = tracks.filter((t) => !t.art);
  if (missing.length > 0) {
    await Promise.all(missing.map(async (t) => {
      try {
        const q = encodeURIComponent(`${t.title} ${t.artist}`);
        const searchRes = await fetchWithRetry(
          `${API_BASE}/search?q=${q}&type=track&limit=1&market=from_token`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (searchRes.ok) {
          const searchData = await searchRes.json() as {
            tracks?: { items?: Array<{ album?: { images?: Array<{ url: string }> } }> };
          };
          const found = searchData.tracks?.items?.[0];
          if (found?.album?.images?.[0]?.url) {
            t.art = found.album.images[0].url;
          }
        }
      } catch {
        // ignore — track just won't have art
      }
    }));
  }

  return tracks;
}

export async function fetchMyPlaylists(): Promise<Playlist[]> {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated with Spotify');

  const playlists: Playlist[] = [];
  let url: string | null = `${API_BASE}/me/playlists?limit=50`;

  while (url) {
    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Spotify API error ${res.status}: ${text}`);
    }

    const data = await res.json() as {
      items: SpotifyPlaylistSummary[];
      next: string | null;
    };

    for (const p of data.items) {
      playlists.push({
        id: p.id,
        name: p.name,
        image: p.images?.[0]?.url ?? null,
        trackCount: p.tracks?.total ?? 0,
      });
    }
    url = data.next;
  }

  return playlists;
}

export async function fetchPlaylistInfo(playlistId: string): Promise<{ name: string; image: string | null }> {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated with Spotify');

  const res = await fetchWithRetry(
    `${API_BASE}/playlists/${playlistId}?fields=name,images`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify API error ${res.status}: ${text}`);
  }

  const data = await res.json() as { name: string; images?: Array<{ url: string }> };
  return { name: data.name, image: data.images?.[0]?.url ?? null };
}

//  Internal Spotify API shapes 

interface SpotifyArtist { name: string }
interface SpotifyImage { url: string }
interface SpotifyTrack {
  name: string;
  uri: string;
  artists: SpotifyArtist[];
  album?: { images?: SpotifyImage[] };
}
interface SpotifyPlaylistItem {
  track?: SpotifyTrack;
  item?: SpotifyTrack;
}
interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  images?: SpotifyImage[];
  tracks?: { total: number };
}
