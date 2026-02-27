/**
 * Markdown parsing and rendering engine.
 * Uses marked.js + highlight.js + KaTeX via CDN (loaded in index.html).
 */

import { sanitizeHTML, escapeHTML } from './utils.js';

/** @type {boolean} */
let initialized = false;

/**
 * Configure marked.js with custom renderer.
 */
export function initMarkdown() {
  if (initialized) return;
  initialized = true;

  if (typeof marked === 'undefined') {
    console.warn('marked.js not loaded');
    return;
  }

  const renderer = {
    // Open links in new tab
    link({ href, title, text }) {
      const titleAttr = title ? ` title="${escapeHTML(title)}"` : '';
      return `<a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
    },

    // Code blocks with language label + copy button
    code({ text, lang }) {
      const language = lang || '';
      const escapedCode = escapeHTML(text);
      let highlighted = escapedCode;

      if (typeof hljs !== 'undefined' && language && hljs.getLanguage(language)) {
        try {
          highlighted = hljs.highlight(text, { language, ignoreIllegals: true }).value;
        } catch { /* fall back to escaped */ }
      } else if (typeof hljs !== 'undefined') {
        try {
          highlighted = hljs.highlightAuto(text).value;
        } catch { /* fall back to escaped */ }
      }

      return `<div class="code-block">
        <div class="code-block__header">
          <span class="code-block__lang">${escapeHTML(language)}</span>
          <button class="code-block__copy" data-code="${escapedCode.replace(/"/g, '&quot;')}" aria-label="复制代码">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span>复制代码</span>
          </button>
        </div>
        <pre><code class="hljs">${highlighted}</code></pre>
      </div>`;
    },

    // Images
    image({ href, title, text }) {
      const titleAttr = title ? ` title="${escapeHTML(title)}"` : '';
      return `<img src="${escapeHTML(href)}" alt="${escapeHTML(text)}"${titleAttr} loading="lazy" />`;
    },
  };

  marked.use({
    renderer,
    gfm: true,
    breaks: true,
  });
}

/**
 * Pre-process LaTeX expressions, protecting them from marked.js processing.
 * Replaces $...$ and $$...$$ with placeholders, then restores them after parsing.
 * @param {string} text
 * @returns {{ text: string, blocks: Map<string, { content: string, display: boolean }> }}
 */
function extractMath(text) {
  const blocks = new Map();
  let counter = 0;

  // Display math: $$...$$
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_match, content) => {
    const key = `%%MATH_BLOCK_${counter++}%%`;
    blocks.set(key, { content: content.trim(), display: true });
    return key;
  });

  // Inline math: $...$  (avoid matching things like $10 or 10$)
  text = text.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_match, content) => {
    const key = `%%MATH_INLINE_${counter++}%%`;
    blocks.set(key, { content: content.trim(), display: false });
    return key;
  });

  return { text, blocks };
}

/**
 * Restore LaTeX placeholders with rendered KaTeX HTML.
 * @param {string} html
 * @param {Map<string, { content: string, display: boolean }>} blocks
 * @returns {string}
 */
function restoreMath(html, blocks) {
  for (const [key, { content, display }] of blocks) {
    let rendered;
    if (typeof katex !== 'undefined') {
      try {
        rendered = katex.renderToString(content, {
          displayMode: display,
          throwOnError: false,
          output: 'html',
        });
        if (display) {
          rendered = `<div class="math-block">${rendered}</div>`;
        } else {
          rendered = `<span class="math-inline">${rendered}</span>`;
        }
      } catch {
        rendered = display
          ? `<div class="math-block"><code>${escapeHTML(content)}</code></div>`
          : `<code>${escapeHTML(content)}</code>`;
      }
    } else {
      rendered = display
        ? `<div class="math-block"><code>${escapeHTML(content)}</code></div>`
        : `<code>${escapeHTML(content)}</code>`;
    }
    html = html.replace(key, rendered);
  }
  return html;
}

/**
 * Render a Markdown string to sanitized HTML.
 * @param {string} text - Raw markdown
 * @returns {string} Safe HTML
 */
export function renderMarkdown(text) {
  if (!text) return '';

  // Extract math first
  const { text: preprocessed, blocks } = extractMath(text);

  // Parse markdown
  let html;
  if (typeof marked !== 'undefined') {
    html = marked.parse(preprocessed);
  } else {
    // Fallback: basic newline-to-br
    html = escapeHTML(preprocessed).replace(/\n/g, '<br>');
  }

  // Restore math
  html = restoreMath(html, blocks);

  // Sanitize
  html = sanitizeHTML(html);

  return html;
}

/**
 * Render markdown incrementally during streaming.
 * Same as renderMarkdown but tolerant of incomplete blocks.
 * @param {string} text
 * @returns {string}
 */
export function renderStreamingMarkdown(text) {
  if (!text) return '';

  // Close any unclosed code fences for rendering
  const fenceCount = (text.match(/```/g) || []).length;
  let processed = text;
  if (fenceCount % 2 !== 0) {
    processed += '\n```';
  }

  return renderMarkdown(processed);
}
