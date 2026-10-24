'use strict';

// The settings page talks to the app only through `window.settingsAPI`; this
// maps it onto the app's Tauri commands (src-tauri/src/commands.rs) and events.

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  /** Subscribes to an app event; returns the unsubscribe function. */
  function on(eventName, callback) {
    const unlisten = listen(eventName, (event) => callback(event.payload));
    return () => { unlisten.then((stop) => stop()); };
  }

  window.settingsAPI = {
    getState: () => invoke('get_state'),
    setTrackedHeroes: (characterNames) => invoke('set_tracked_heroes', { characterNames }),
    setComboLayout: (layout) => invoke('set_combo_layout', { layout }),
    addHero: (hero, options) => invoke('add_hero', { hero, options }),
    updateHero: (characterName, changes) => invoke('update_hero', { characterName, changes }),
    setOnboardingDone: () => invoke('set_onboarding_done'),
    setHeroColor: (characterName, color) => invoke('set_hero_color', { characterName, color }),
    removeHero: (characterName) => invoke('remove_hero', { characterName }),
    getDiagnostics: () => invoke('get_diagnostics'),
    setOverlayPort: (port) => invoke('set_overlay_port', { port }),
    setLogsDir: (dir) => invoke('set_logs_dir', { dir }),
    browseLogsDir: () => invoke('browse_logs_dir'),
    showObsLoader: () => invoke('show_obs_loader'),
    sendTestCast: (characterName) => invoke('send_test_cast', { characterName }),
    onDebugEvent: (callback) => on('debug:event', callback),
    getLaunchAtLogin: () => invoke('get_launch_at_login'),
    setLaunchAtLogin: (enabled) => invoke('set_launch_at_login', { enabled }),
    getAppVersion: () => invoke('get_app_version'),
    checkForUpdates: () => invoke('check_for_updates'),
    onUpdateStatus: (callback) => {
      const stop = on('update:status', callback);
      // The window only exists while open: catch up on the last check's result.
      invoke('get_update_status').then((status) => { if (status) callback(status); });
      return stop;
    },
  };
})();
