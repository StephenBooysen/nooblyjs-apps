// Light or dark (roadmap 8.4), set on <html data-bs-theme> before the page draws, so it never flashes the wrong one.
// A classic script in <head> (not a module: modules wait). The choice is this browser's (Settings → Appearance):
// System follows the device and changes with it; Light or Dark stays until changed. window.njTheme reads and sets it.
(() => {
  const KEY = 'nj-theme';
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const read = () => {
    try {
      const v = window.localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch {
      return 'system';
    }
  };
  const apply = () => {
    const choice = read();
    const dark = choice === 'dark' || (choice === 'system' && Boolean(media && media.matches));
    document.documentElement.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
  };
  apply();
  if (media && media.addEventListener) media.addEventListener('change', apply);
  window.njTheme = {
    /** 'system' | 'light' | 'dark' */
    get: read,
    set(choice) {
      try {
        if (choice === 'light' || choice === 'dark') window.localStorage.setItem(KEY, choice);
        else window.localStorage.removeItem(KEY);
      } catch { /* storage blocked: this page only */ }
      apply();
    },
  };
})();
