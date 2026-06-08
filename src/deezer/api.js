/**
 * Deezer public playlist helpers.
 *
 * Deezer currently does not accept new private API applications, so this
 * integration intentionally supports public playlist URLs without OAuth.
 * Playback uses Cupid Player's existing YouTube-backed streaming engine.
 */

export function parsePlaylistUrl(input) {
  if (!input) return null;
  const trimmed = input.trim();

  if (/^\d+$/.test(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'link.deezer.com' && url.pathname.startsWith('/s/')) return trimmed;
    if (host !== 'deezer.com') return null;

    const match = url.pathname.match(/\/playlist\/(\d+)/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

export function normaliseTrack(track) {
  if (!track?.title) return null;

  return {
    title: track.title,
    artist: track.artist?.name || '',
    album: track.album?.title || '',
    art: track.album?.cover_medium || track.album?.cover_big || null,
    duration: Number(track.duration) || 0,
    uri: `deezer:track:${track.id}`,
  };
}

export async function fetchPlaylistByUrl(input) {
  const playlistReference = parsePlaylistUrl(input);
  if (!playlistReference) throw new Error('Not a recognised Deezer playlist URL');
  if (!window.cupid?.deezerFetchPlaylist) {
    throw new Error('Deezer playlist fetch is unavailable in this build');
  }

  const tracks = await window.cupid.deezerFetchPlaylist(playlistReference);
  return tracks.map(normaliseTrack).filter(Boolean);
}
