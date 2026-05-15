/**
 * Spotify OAuth 2.0 PKCE Authorization Flow
 *
 * No backend needed — the entire flow runs in the browser.
 * Requires VITE_SPOTIFY_CLIENT_ID to be set in your .env file.
 */

import { open } from '@tauri-apps/plugin-shell';

const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID;
const REDIRECT_URI = import.meta.env.DEV
  ? 'http://localhost:5173/callback'
  : 'cupid://callback';
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
];

const TOKEN_KEY = 'spotify_token';
const REFRESH_KEY = 'spotify_refresh_token';
const EXPIRY_KEY = 'spotify_token_expiry';
const CODE_VERIFIER_KEY = 'spotify_code_verifier';

// ── Helpers ──────────────────────────────────────────────────

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => chars[v % chars.length]).join('');
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  return crypto.subtle.digest('SHA-256', encoder.encode(plain));
}

function base64UrlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  const str = String.fromCharCode(...bytes);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generateCodeChallenge(verifier) {
  const hashed = await sha256(verifier);
  return base64UrlEncode(hashed);
}

// ── Public API ────────────────────────────────────────────────

/**
 * Initiate the Spotify login flow.
 * Redirects the browser to Spotify's authorize endpoint.
 */
export async function login() {
  const verifier = generateRandomString(64);
  const challenge = await generateCodeChallenge(verifier);

  localStorage.setItem(CODE_VERIFIER_KEY, verifier);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(' '),
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });

  const authUrl = `https://accounts.spotify.com/authorize?${params}`;

  await open(authUrl);
}

/**
 * Handle the OAuth callback — exchange the authorization code for tokens.
 */
let _callbackInFlight = false;

export async function handleCallback(externalCode = null) {
  let code = externalCode;
  let error = null;

  if (!code) {
    const params = new URLSearchParams(window.location.search);
    code = params.get('code');
    error = params.get('error');
  }

  if (error) {
    throw new Error(`Spotify auth error: ${error}`);
  }

  if (!code) return null;

  if (_callbackInFlight) return null;
  _callbackInFlight = true;

  try {
    const verifier = localStorage.getItem(CODE_VERIFIER_KEY);
    if (!verifier) {
      throw new Error('Missing PKCE code verifier — please try logging in again.');
    }

    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });

    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    storeTokens(data);
    localStorage.removeItem(CODE_VERIFIER_KEY);

    // Clean the URL so the code isn't re-used
    window.history.replaceState({}, '', '/');

    return data.access_token;
  } finally {
    _callbackInFlight = false;
  }
}

function storeTokens({ access_token, refresh_token, expires_in }) {
  localStorage.setItem(TOKEN_KEY, access_token);
  if (refresh_token) localStorage.setItem(REFRESH_KEY, refresh_token);
  localStorage.setItem(EXPIRY_KEY, String(Date.now() + expires_in * 1000));
}

/**
 * Get a valid access token, refreshing if necessary.
 */
export async function getAccessToken() {
  const token = localStorage.getItem(TOKEN_KEY);
  const expiry = Number(localStorage.getItem(EXPIRY_KEY) || '0');

  // Token still valid
  if (token && Date.now() < expiry - 60_000) {
    return token;
  }

  // Try to refresh
  const refreshed = await refreshAccessToken();
  if (refreshed) return refreshed;

  // No refresh token but we have a token — use it anyway (may be expired)
  return token || null;
}

async function refreshAccessToken() {
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  if (!refreshToken) {
    return null;
  }

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    logout();
    return null;
  }

  const data = await response.json();
  storeTokens(data);
  return data.access_token;
}

export function isLoggedIn() {
  return !!localStorage.getItem(TOKEN_KEY);
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(EXPIRY_KEY);
  localStorage.removeItem(CODE_VERIFIER_KEY);
}
