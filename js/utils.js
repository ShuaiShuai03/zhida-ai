/**
 * Utility functions — debounce, throttle, sanitize, format, etc.
 */

/**
 * Generate a unique identifier.
 * @returns {string} UUID-like string
 */
export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
}

/**
 * Debounce a function call.
 * @param {Function} fn - The function to debounce
 * @param {number} delay - Delay in milliseconds
 * @returns {Function}
 */
export function debounce(fn, delay) {
  let timer = null;
  const debounced = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
  };
  return debounced;
}

/**
 * Throttle a function call.
 * @param {Function} fn - The function to throttle
 * @param {number} limit - Minimum interval in milliseconds
 * @returns {Function}
 */
export function throttle(fn, limit) {
  let inThrottle = false;
  let lastArgs = null;
  return (...args) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => {
        inThrottle = false;
        if (lastArgs) {
          fn(...lastArgs);
          lastArgs = null;
        }
      }, limit);
    } else {
      lastArgs = args;
    }
  };
}

/**
 * Sanitize a string for safe HTML insertion (whitelist approach).
 * Strips all tags except a safe set of inline / block elements.
 * @param {string} html - Raw HTML string
 * @returns {string} Sanitized HTML
 */
export function sanitizeHTML(html) {
  const ALLOWED_TAGS = new Set([
    'p', 'br', 'b', 'i', 'em', 'strong', 'u', 'del', 's', 'strike',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'blockquote', 'pre', 'code',
    'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'hr', 'span', 'div', 'sub', 'sup',
    'details', 'summary',
  ]);

  const ALLOWED_ATTRS = {
    'a': ['href', 'target', 'rel', 'title'],
    'img': ['src', 'alt', 'title', 'width', 'height'],
    'code': ['class'],
    'pre': ['class'],
    'span': ['class', 'style'],
    'div': ['class', 'style'],
    'td': ['align'],
    'th': ['align'],
    'h1': ['id'],
    'h2': ['id'],
    'h3': ['id'],
    'h4': ['id'],
    'h5': ['id'],
    'h6': ['id'],
  };

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
  const IMAGE_PROTOCOLS = new Set(['http:', 'https:']);

  function isSafeUrl(value, allowedProtocols) {
    const compact = value.replace(/[\u0000-\u001F\u007F\s]+/g, '').toLowerCase();
    if (!compact) return true;
    if (compact.startsWith('javascript:') || compact.startsWith('data:') || compact.startsWith('vbscript:')) {
      return false;
    }
    try {
      return allowedProtocols.has(new URL(value, document.baseURI).protocol);
    } catch {
      return false;
    }
  }

  /**
   * Recursively clean a node tree.
   * @param {Node} node
   */
  function clean(node) {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        if (!ALLOWED_TAGS.has(tag)) {
          // Replace disallowed element with its children
          while (child.firstChild) {
            node.insertBefore(child.firstChild, child);
          }
          node.removeChild(child);
        } else {
          // Remove disallowed attributes
          const allowedForTag = ALLOWED_ATTRS[tag] ?? [];
          const attrs = Array.from(child.attributes);
          for (const attr of attrs) {
            if (!allowedForTag.includes(attr.name)) {
              child.removeAttribute(attr.name);
            }
          }
          // Sanitize href to prevent javascript: protocol
          if (tag === 'a') {
            const href = child.getAttribute('href') ?? '';
            if (!isSafeUrl(href, LINK_PROTOCOLS)) {
              child.setAttribute('href', '#');
            }
            child.setAttribute('target', '_blank');
            child.setAttribute('rel', 'noopener noreferrer');
          }
          // Sanitize img src
          if (tag === 'img') {
            const src = child.getAttribute('src') ?? '';
            if (!isSafeUrl(src, IMAGE_PROTOCOLS)) {
              child.removeAttribute('src');
            }
          }
          clean(child);
        }
      } else if (child.nodeType === Node.COMMENT_NODE) {
        node.removeChild(child);
      }
    }
  }

  clean(doc.body);
  return doc.body.innerHTML;
}

/**
 * Escape HTML special characters (for user text display).
 * @param {string} str - Raw string
 * @returns {string}
 */
export function escapeHTML(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, (ch) => map[ch]);
}

/**
 * Format a timestamp into HH:MM.
 * @param {number} ts - Unix timestamp in milliseconds
 * @returns {string}
 */
export function formatTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Format a timestamp into a relative description in Chinese.
 * @param {number} ts - Unix timestamp in milliseconds
 * @returns {string}
 */
export function formatRelativeTime(ts) {
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days === 1) return '昨天';
  if (days < 7) return `${days}天前`;
  if (days < 30) return `${Math.floor(days / 7)}周前`;

  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * Truncate a string to a max length, appending ellipsis.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
export function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}

/**
 * Copy text to the clipboard.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

/**
 * Estimate the byte size of a string (UTF-8).
 * @param {string} str
 * @returns {number}
 */
export function byteSize(str) {
  return new Blob([str]).size;
}

/**
 * Check if the platform is macOS / iOS.
 * @returns {boolean}
 */
export function isMac() {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
}
