/**
 * Spotify Web API helpers
 *
 * Fetches playlist data and normalises track objects into a shape
 * compatible with the local playlist format:
 *   { title, artist, art, uri }
 */

import { getAccessToken } from './auth.js';

const API_BASE = 'https://api.spotify.com/v1';

async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, options);
    if (res.ok || (res.status < 500 && res.status !== 429)) return res;
    if (i < retries) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  return fetch(url, options);
}

/**
 * Parse a Spotify playlist URL or URI and return the playlist ID.
 *
 * Accepts:
 *   - https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
 *   - https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=...
 *   - spotify:playlist:37i9dQZF1DXcBWIGoYBM5M
 *
 * @param {string} input
 * @returns {string|null} playlist ID or null if not recognised
 */
export function parsePlaylistUrl(input) {
  if (!input) return null;

  const trimmed = input.trim();

  // Spotify URI format
  const uriMatch = trimmed.match(/^spotify:playlist:([a-zA-Z0-9]+)$/);
  if (uriMatch) return uriMatch[1];

  // Web URL format
  try {
    const url = new URL(trimmed);
    if (url.hostname === 'open.spotify.com') {
      const parts = url.pathname.split('/');
      const idx = parts.indexOf('playlist');
      if (idx !== -1 && parts[idx + 1]) {
        return parts[idx + 1];
      }
    }
  } catch {
    // not a valid URL
  }

  return null;
}

/**
 * Fetch all tracks from a Spotify playlist (handles pagination).
 *
 * @param {string} playlistId
 * @returns {Promise<Array<{ title: string, artist: string, art: string, uri: string }>>}
 */
export async function fetchPlaylistTracks(playlistId) {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated with Spotify');

  const res = await fetchWithRetry(`${API_BASE}/playlists/${playlistId}?market=from_token`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const tracks = [];

  // Helper function to process an array of track items
  function processItems(items) {
    for (const entry of items) {
      const t = entry.track || entry.item;
      if (!t || !t.uri) continue;

      tracks.push({
        title: t.name,
        artist: t.artists.map((a) => a.name).join(', '),
        art: t.album?.images?.[0]?.url ?? null,
        uri: t.uri,
      });
    }
  }

  // Handle the first batch of tracks from the main playlist response
  const container = data.tracks || data.items;
  let items = container?.items || [];
  processItems(items);

  // PAGINATION LOOP: If there are more tracks, fetch them sequentially
  let nextUrl = container?.next;
  while (nextUrl) {
    try {
      const nextRes = await fetchWithRetry(nextUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!nextRes.ok) break; // Stop loop if a page fails to load

      const nextData = await nextRes.json();
      const nextItems = nextData.items || [];
      processItems(nextItems);

      // Check if there's yet another page
      nextUrl = nextData.next;
    } catch (err) {
      console.error("Error fetching next page of tracks:", err);
      break; 
    }
  }

  // Fill in missing album art via search (local files, etc.)
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
          const searchData = await searchRes.json();
          const found = searchData.tracks?.items?.[0];
          if (found?.album?.images?.[0]?.url) {
            t.art = found.album.images[0].url;
          }
        }
      } catch {
        // ignore — just won't have art
      }
    }));
  }

  return tracks;
}
/**
 * Fetch the current user's playlists.
 *
 * @returns {Promise<Array<{ id: string, name: string, image: string|null, trackCount: number }>>}
 */
export async function fetchMyPlaylists() {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated with Spotify');

  const playlists = [];
  let url = `${API_BASE}/me/playlists?limit=50`;

  while (url) {
    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Spotify API error ${res.status}: ${text}`);
    }

    const data = await res.json();
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

/**
 * Fetch basic playlist metadata (name, image).
 *
 * @param {string} playlistId
 * @returns {Promise<{ name: string, image: string|null }>}
 */
export async function fetchPlaylistInfo(playlistId) {
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

  const data = await res.json();
  return {
    name: data.name,
    image: data.images?.[0]?.url ?? null,
  };
}
