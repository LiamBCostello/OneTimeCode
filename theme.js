// theme.js — global light/dark toggle (default: dark)
(() => {
    const root = document.documentElement;
  
    function set(mode) {
      root.dataset.theme = mode;                 // <html data-theme="light|dark">
      localStorage.setItem('theme', mode);
      const btn = document.getElementById('themeToggle');
      if (btn) btn.setAttribute('aria-pressed', String(mode === 'light'));
    }
  
    function toggle() {
      set(root.dataset.theme === 'light' ? 'dark' : 'light');
    }
  
    // Initialize ASAP with saved or default (dark)
    const saved = localStorage.getItem('theme');
    set(saved === 'light' ? 'light' : 'dark');
  
    // Hook up the button when DOM is ready
    window.addEventListener('DOMContentLoaded', () => {
      const btn = document.getElementById('themeToggle');
      if (btn) btn.addEventListener('click', toggle);
    });
  })();  