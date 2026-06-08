# Deezer setup

Cupid Player can import any public Deezer playlist without a Deezer login or
developer key.

1. Open a public playlist on Deezer.
2. Copy its URL, for example `https://www.deezer.com/playlist/53362031`.
3. Open Cupid Player settings.
4. Select **deezer** under **music**.
5. Paste the URL and select **load playlist**.

Cupid uses Deezer's public API for titles, artists, albums, and artwork. Audio
is resolved through the same YouTube/yt-dlp streaming engine already used for
Spotify and Apple Music tracks. It does not extract or decrypt Deezer audio.

Private playlists and account-library browsing are not supported. Deezer is
currently not accepting new private developer API applications, so Cupid cannot
offer a normal Deezer OAuth login to new users.
