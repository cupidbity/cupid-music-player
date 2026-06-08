import { describe, expect, it } from 'vitest';
import { normaliseTrack, parsePlaylistUrl } from './api.js';

describe('parsePlaylistUrl', () => {
  it('accepts Deezer playlist URLs and bare IDs', () => {
    expect(parsePlaylistUrl('https://www.deezer.com/fr/playlist/53362031')).toBe('53362031');
    expect(parsePlaylistUrl('https://deezer.com/playlist/53362031?utm_source=test')).toBe('53362031');
    expect(parsePlaylistUrl('https://link.deezer.com/s/example')).toBe('https://link.deezer.com/s/example');
    expect(parsePlaylistUrl('53362031')).toBe('53362031');
  });

  it('rejects non-playlist and foreign URLs', () => {
    expect(parsePlaylistUrl('https://www.deezer.com/album/123')).toBeNull();
    expect(parsePlaylistUrl('https://example.com/playlist/53362031')).toBeNull();
    expect(parsePlaylistUrl('not a playlist')).toBeNull();
  });
});

describe('normaliseTrack', () => {
  it('maps Deezer metadata to Cupid Player tracks', () => {
    expect(normaliseTrack({
      id: 42,
      title: 'Digital Love',
      duration: 301,
      artist: { name: 'Daft Punk' },
      album: {
        title: 'Discovery',
        cover_medium: 'https://example.com/cover.jpg',
      },
    })).toEqual({
      title: 'Digital Love',
      artist: 'Daft Punk',
      album: 'Discovery',
      art: 'https://example.com/cover.jpg',
      duration: 301,
      uri: 'deezer:track:42',
    });
  });

  it('skips malformed entries', () => {
    expect(normaliseTrack(null)).toBeNull();
    expect(normaliseTrack({ id: 42 })).toBeNull();
  });
});
