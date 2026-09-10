(function () {
  const THEME_KEY = 'tukuru-color-theme';
  const THEMES = new Set(['light', 'dark', 'retro']);
  const root = document.documentElement;

  function savedTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    return THEMES.has(saved) ? saved : 'light';
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

    document.querySelectorAll('[data-theme-choice]').forEach((button) => {
      const selected = button.dataset.themeChoice === theme;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });

    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) {
      themeMeta.content = theme === 'dark' ? '#171421' : theme === 'retro' ? '#1b120c' : '#ff6b4a';
    }
  }

  function applyTheme(theme, save) {
    const nextTheme = THEMES.has(theme) ? theme : 'light';
    root.dataset.theme = nextTheme;
    root.style.colorScheme = nextTheme === 'light' ? 'light' : 'dark';
    if (save) localStorage.setItem(THEME_KEY, nextTheme);
    updateControls(nextTheme);
  }

  applyTheme(savedTheme(), false);

  document.addEventListener('DOMContentLoaded', () => {
    updateControls(root.dataset.theme || 'light');
    document.querySelectorAll('.theme-toggle').forEach((button) => {
      button.addEventListener('click', () => {
        applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', true);
      });
    });
    document.querySelectorAll('[data-theme-choice]').forEach((button) => {
      button.addEventListener('click', () => applyTheme(button.dataset.themeChoice, true));
    });
  });

  window.TukuruTheme = {
    apply: (theme) => applyTheme(theme, true),
    current: () => root.dataset.theme,
  };
})();
