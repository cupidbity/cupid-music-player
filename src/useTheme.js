import { useState, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';

// ── Pink theme assets ────────────────────────────────────
import pinkFrame from '../assets/pink/frame.png';
import pinkFrameNoBg from '../assets/pink/frame_no_background.png';
import pinkPlant from '../assets/pink/plant.png';
import pinkRecordPlayer from '../assets/pink/record_player.png';
import pinkAlbumFrame from '../assets/pink/album_frame.png';
import pinkBackwardsButton from '../assets/pink/backwards_button.png';
import pinkPauseButton from '../assets/pink/pause_button.png';
import pinkPlayButton from '../assets/pink/play_button.png';
import pinkForwardsButton from '../assets/pink/forwards_button.png';
import pinkExitButton from '../assets/pink/exit_button.png';
import pinkMinimizerButton from '../assets/pink/minimizer_button.png';
import pinkWindowButton from '../assets/pink/window_button.png';
import pinkFavicon from '../assets/pink/favicon.png';
import pinkProgressBar from '../assets/pink/progress_bar.png';
import pinkSettings from '../assets/pink/settings.png';

// ── Shared record animations ────────────────────────────
import recordA1 from '../assets/animations/record-pink/frame-1.png';
import recordA2 from '../assets/animations/record-pink/frame-2.png';
import recordA3 from '../assets/animations/record-pink/frame-3.png';
import recordA4 from '../assets/animations/record-pink/frame-4.png';
import recordB1 from '../assets/animations/record-blue/frame-1.png';
import recordB2 from '../assets/animations/record-blue/frame-2.png';
import recordB3 from '../assets/animations/record-blue/frame-3.png';
import recordB4 from '../assets/animations/record-blue/frame-4.png';

// ── Pink needle animations ──────────────────────────────
import pinkNeedlePlay1 from '../assets/animations/pink/needle-playing/frame-1.png';
import pinkNeedlePlay2 from '../assets/animations/pink/needle-playing/frame-2.png';
import pinkNeedlePlay3 from '../assets/animations/pink/needle-playing/frame-3.png';
import pinkNeedleChange1 from '../assets/animations/pink/needle-change/frame-1.png';
import pinkNeedleChange2 from '../assets/animations/pink/needle-change/frame-2.png';
import pinkNeedleChange3 from '../assets/animations/pink/needle-change/frame-3.png';

// ── Blue needle animations ──────────────────────────────
import blueNeedlePlay1 from '../assets/animations/blue/needle-playing/frame-1.png';
import blueNeedlePlay2 from '../assets/animations/blue/needle-playing/frame-2.png';
import blueNeedlePlay3 from '../assets/animations/blue/needle-playing/frame-3.png';
import blueNeedleChange1 from '../assets/animations/blue/needle-change/frame-1.png';
import blueNeedleChange2 from '../assets/animations/blue/needle-change/frame-2.png';
import blueNeedleChange3 from '../assets/animations/blue/needle-change/frame-3.png';

const SHARED_RECORD_FRAMES = {
  recordFramesA: [recordA1, recordA2, recordA3, recordA4],
  recordFramesB: [recordB1, recordB2, recordB3, recordB4],
};

// ── Blue theme assets ────────────────────────────────────
import blueFrame from '../assets/blue/frame.png';
import blueFrameNoBg from '../assets/blue/frame_no_background.png';
import bluePlant from '../assets/blue/plant.png';
import blueRecordPlayer from '../assets/blue/record_player.png';
import blueAlbumFrame from '../assets/blue/album_frame.png';
import blueBackwardsButton from '../assets/blue/backwards_button.png';
import bluePauseButton from '../assets/blue/pause_button.png';
import bluePlayButton from '../assets/blue/play_button.png';
import blueForwardsButton from '../assets/blue/forwards_button.png';
import blueExitButton from '../assets/blue/exit_button.png';
import blueMinimizerButton from '../assets/blue/minimizer_button.png';
import blueWindowButton from '../assets/blue/window_button.png';
import blueFavicon from '../assets/blue/favicon.png';
import blueProgressBar from '../assets/blue/progress_bar.png';
import blueSettings from '../assets/blue/settings.png';

const THEME_ASSETS = {
  pink: {
    frame: pinkFrame,
    frameNoBg: pinkFrameNoBg,
    plant: pinkPlant,
    recordPlayer: pinkRecordPlayer,
    albumFrame: pinkAlbumFrame,
    backwardsButton: pinkBackwardsButton,
    pauseButton: pinkPauseButton,
    playButton: pinkPlayButton,
    forwardsButton: pinkForwardsButton,
    exitButton: pinkExitButton,
    minimizerButton: pinkMinimizerButton,
    windowButton: pinkWindowButton,
    favicon: pinkFavicon,
    progressBar: pinkProgressBar,
    settings: pinkSettings,
    ...SHARED_RECORD_FRAMES,
    needlePlayFrames: [pinkNeedlePlay1, pinkNeedlePlay2, pinkNeedlePlay3],
    needleChangeFrames: [pinkNeedleChange1, pinkNeedleChange2, pinkNeedleChange3],
  },
  blue: {
    frame: blueFrame,
    frameNoBg: blueFrameNoBg,
    plant: bluePlant,
    recordPlayer: blueRecordPlayer,
    albumFrame: blueAlbumFrame,
    backwardsButton: blueBackwardsButton,
    pauseButton: bluePauseButton,
    playButton: bluePlayButton,
    forwardsButton: blueForwardsButton,
    exitButton: blueExitButton,
    minimizerButton: blueMinimizerButton,
    windowButton: blueWindowButton,
    favicon: blueFavicon,
    progressBar: blueProgressBar,
    settings: blueSettings,
    ...SHARED_RECORD_FRAMES,
    needlePlayFrames: [blueNeedlePlay1, blueNeedlePlay2, blueNeedlePlay3],
    needleChangeFrames: [blueNeedleChange1, blueNeedleChange2, blueNeedleChange3],
  },
};

const STORAGE_KEY = 'cupid-player-theme';

function getStoredTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'pink' || stored === 'blue') return stored;
  } catch {
    // localStorage unavailable
  }
  return 'pink';
}

/**
 * Theme hook — stores preference in localStorage and provides
 * the correct asset set for the active theme.
 */
export default function useTheme() {
  const [theme, setTheme] = useState(getStoredTheme);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'pink' ? 'blue' : 'pink';
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // ignore
      }
      invoke('set_theme', { theme: next });
      return next;
    });
  }, []);

  const assets = useMemo(() => THEME_ASSETS[theme], [theme]);

  return { theme, toggleTheme, assets };
}
