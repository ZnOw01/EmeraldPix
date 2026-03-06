// Runs before first paint to apply the stored theme and prevent a flash.
(function () {
  try {
    var key = 'emeraldpix-theme';
    var stored = localStorage.getItem(key);
    var theme = stored === 'light' || stored === 'dark' || stored === 'auto' ? stored : 'auto';
    var effective = theme === 'auto'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme;
    document.documentElement.setAttribute('data-theme', effective);
  } catch (_) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
