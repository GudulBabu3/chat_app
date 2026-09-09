(function () {
  const THEME_KEY = 'tukuru-color-theme';
  const root = document.documentElement;

  function savedTheme() {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  }

  function updateControls(theme) {
    const isDark = theme === 'dark';
    document.querySelectorAll('.theme-toggle').forEach((button) => {
      button.textContent = isDark ? '☀' : '☾';
      button.dataset.label = isDark ? 'Light mode' : 'Dark mode';
      button.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', String(isDark));
    });

    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.content = isDark ? '#171421' : '#ff6b4a';
  }

  function applyTheme(theme, save) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    if (save) localStorage.setItem(THEME_KEY, theme);
    updateControls(theme);
  }

  applyTheme(savedTheme(), false);

  document.addEventListener('DOMContentLoaded', () => {
    updateControls(root.dataset.theme || 'light');
    document.querySelectorAll('.theme-toggle').forEach((button) => {
      button.addEventListener('click', () => {
        applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', true);
      });
    });
  });
})();
