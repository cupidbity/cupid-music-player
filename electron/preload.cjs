const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cupid', {
  version: process.versions.electron,
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  resize: (data) => ipcRenderer.send('window-resize', data),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('window-set-always-on-top', enabled),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  setTheme: (theme) => ipcRenderer.send('set-theme', theme),
  getStreamUrl: (title, artist) => ipcRenderer.invoke('get-stream-url', title, artist),
  getStreamUrlById: (videoId) => ipcRenderer.invoke('get-stream-url-by-id', videoId),
  getAppleMusicToken: () => ipcRenderer.invoke('get-apple-music-token'),
  getLocalPlaylist: () => ipcRenderer.invoke('get-local-playlist'),
  getLocalAudioPath: (filename) => ipcRenderer.invoke('get-local-audio-path', filename),
  openMusicFolder: () => ipcRenderer.invoke('open-music-folder'),
  deezerFetchPlaylist: (playlistReference) => ipcRenderer.invoke('deezer-fetch-playlist', playlistReference),
  youtubeFetchPlaylist: (url) => ipcRenderer.invoke('youtube-fetch-playlist', url),
  youtubeOauthStart: (opts) => ipcRenderer.invoke('youtube-oauth-start', opts),
  youtubeOauthCancel: () => ipcRenderer.invoke('youtube-oauth-cancel'),
});
