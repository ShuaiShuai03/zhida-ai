/**
 * Dark / Light mode toggle logic.
 */

import { loadTheme, saveTheme } from './storage.js';

/** @type {string} */
let currentTheme = 'light';

/**
 * Initialise the theme from localStorage or system preference.
 */
export function initTheme() {
  const saved = loadTheme();
  if (saved === 'dark' || saved === 'light') {
    currentTheme = saved;
  } else {
    // Default to system preference
    currentTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  applyTheme(currentTheme, false);

  // Listen for system preference changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!loadTheme()) {
      currentTheme = e.matches ? 'dark' : 'light';
      applyTheme(currentTheme, true);
    }
  });
}

/**
 * Apply the theme to the document.
 * @param {string} theme - 'light' | 'dark'
 * @param {boolean} [animate=true] - Whether to add transition class
 */
function applyTheme(theme, animate = true) {
  if (animate) {
    document.body.classList.add('theme-transitioning');
    setTimeout(() => document.body.classList.remove('theme-transitioning'), 350);
  }
  document.documentElement.setAttribute('data-theme', theme);
  updateToggleIcon(theme);
}

/**
 * Toggle between dark and light mode.
 */
export function toggleTheme() {
  currentTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(currentTheme, true);
  saveTheme(currentTheme);
}

/**
 * Get the current theme.
 * @returns {string}
 */
export function getTheme() {
  return currentTheme;
}

/**
 * Update the sun/moon icon in the toggle button.
 * @param {string} theme
 */
function updateToggleIcon(theme) {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  btn.innerHTML = theme === 'dark' ? SUN_ICON : MOON_ICON;
  btn.setAttribute('aria-label', theme === 'dark' ? '切换到浅色模式' : '切换到深色模式');
  btn.setAttribute('data-tooltip', theme === 'dark' ? '浅色模式' : '深色模式');
}

const SUN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;

const MOON_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
