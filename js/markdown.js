/**
 * Markdown parsing and rendering engine.
 * Uses vendored marked.js + highlight.js + KaTeX assets loaded in index.html.
 */

import { sanitizeHTML, escapeHTML } from './utils.js';

/** @type {boolean} */
let initialized = false;

const DEFAULT_RENDER_OPTIONS = Object.freeze({
  highlightCode: true,
  renderMath: true,
});
let activeRenderOptions = DEFAULT_RENDER_OPTIONS;

function normalizeMarkdownText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return value == null ? '' : String(value);
}

function getRenderOptions(options = {}) {
  return {
    ...DEFAULT_RENDER_OPTIONS,
    ...options,
  };
}

function addProtectedSegment(segments, content) {
  const key = `%%CODE_SEGMENT_${segments.length}%%`;
  segments.push({ key, content });
  return key;
}

function isFenceClosingLine(line, fenceChar, minLength) {
  let index = 0;
  while (index < line.length && (line[index] === ' ' || line[index] === '\t')) {
    index += 1;
  }
  if (index > 3) return false;

  let fenceLength = 0;
  while (line[index + fenceLength] === fenceChar) {
    fenceLength += 1;
  }
  if (fenceLength < minLength) return false;

  for (let i = index + fenceLength; i < line.length; i += 1) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

function findFenceEnd(text, start, openingLineLength, fence) {
  const fenceChar = fence[0];
  let cursor = start + openingLineLength;

  while (cursor < text.length) {
    const lineEnd = text.indexOf('\n', cursor);
    const nextCursor = lineEnd === -1 ? text.length : lineEnd + 1;
    const line = text.slice(cursor, lineEnd === -1 ? text.length : lineEnd);
    if (isFenceClosingLine(line, fenceChar, fence.length)) {
      return nextCursor;
    }
    cursor = nextCursor;
  }

  return text.length;
}

function protectMarkdownCode(text) {
  const segments = [];
  const parts = [];
  let index = 0;

  while (index < text.length) {
    const remaining = text.slice(index);
    if (index === 0 || text[index - 1] === '\n') {
      const fenceMatch = /^(?: {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(remaining);
      if (fenceMatch) {
        const end = findFenceEnd(text, index, fenceMatch[0].length, fenceMatch[1]);
        parts.push(addProtectedSegment(segments, text.slice(index, end)));
        index = end;
        continue;
      }
    }

    if (text[index] === '`') {
      const tickMatch = /^`+/.exec(remaining);
      const ticks = tickMatch?.[0] ?? '`';
      const end = text.indexOf(ticks, index + ticks.length);
      if (end !== -1) {
        parts.push(addProtectedSegment(segments, text.slice(index, end + ticks.length)));
        index = end + ticks.length;
        continue;
      }
    }

    parts.push(text[index]);
    index += 1;
  }

  return { text: parts.join(''), segments };
}

function restoreProtectedSegments(text, segments) {
  let restored = text;
  for (const { key, content } of segments) {
    restored = restored.split(key).join(content);
  }
  return restored;
}

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
      const encodedCode = encodeURIComponent(text);
      let highlighted = escapedCode;

      if (activeRenderOptions.highlightCode && typeof hljs !== 'undefined' && language && hljs.getLanguage(language)) {
        try {
          highlighted = hljs.highlight(text, { language, ignoreIllegals: true }).value;
        } catch { /* fall back to escaped */ }
      } else if (activeRenderOptions.highlightCode && typeof hljs !== 'undefined') {
        try {
          highlighted = hljs.highlightAuto(text).value;
        } catch { /* fall back to escaped */ }
      }

      return `<div class="code-block">
        <div class="code-block__header">
          <span class="code-block__lang">${escapeHTML(language)}</span>
          <button class="code-block__copy" type="button" data-code="${encodedCode}" aria-label="复制代码">
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
 * @returns {{ text: string, blocks: Map<string, { content: string, display: boolean, source: string }> }}
 */
function extractMath(text) {
  const blocks = new Map();
  let counter = 0;

  // Display math: $$...$$
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (match, content) => {
    const key = `%%MATH_BLOCK_${counter++}%%`;
    blocks.set(key, { content: content.trim(), display: true, source: match });
    return key;
  });

  // Inline math: $...$  (avoid matching things like $10 or 10$)
  text = text.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (match, content) => {
    const key = `%%MATH_INLINE_${counter++}%%`;
    blocks.set(key, { content: content.trim(), display: false, source: match });
    return key;
  });

  return { text, blocks };
}

/**
 * Restore LaTeX placeholders with rendered KaTeX HTML.
 * @param {string} html
 * @param {Map<string, { content: string, display: boolean, source: string }>} blocks
 * @param {{ renderMath?: boolean }} [options]
 * @returns {string}
 */
function restoreMath(html, blocks, options = {}) {
  const renderMath = options.renderMath !== false;

  for (const [key, { content, display, source }] of blocks) {
    let rendered;
    if (!renderMath) {
      rendered = escapeHTML(source);
    } else if (typeof katex !== 'undefined') {
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
 * @param {{ highlightCode?: boolean, renderMath?: boolean }} [options]
 * @returns {string} Safe HTML
 */
function renderMarkdownInternal(text, options = {}) {
  const source = normalizeMarkdownText(text);
  if (!source) return '';
  const renderOptions = getRenderOptions(options);

  // Extract math outside Markdown code, then restore code before parsing.
  const { text: codeProtected, segments } = protectMarkdownCode(source);
  const { text: mathProtected, blocks } = extractMath(codeProtected);
  const preprocessed = restoreProtectedSegments(mathProtected, segments);

  // Parse markdown
  let html;
  if (typeof marked !== 'undefined') {
    const previousOptions = activeRenderOptions;
    activeRenderOptions = renderOptions;
    try {
      html = marked.parse(preprocessed);
    } finally {
      activeRenderOptions = previousOptions;
    }
  } else {
    // Fallback: basic newline-to-br
    html = escapeHTML(preprocessed).replace(/\n/g, '<br>');
  }

  // Restore math
  html = restoreMath(html, blocks, renderOptions);

  // Sanitize
  html = sanitizeHTML(html);

  return html;
}

export function renderMarkdown(text) {
  return renderMarkdownInternal(text);
}

/**
 * Render markdown incrementally during streaming.
 * Uses the same parser/sanitizer, but skips expensive highlighter/KaTeX work.
 * @param {string} text
 * @returns {string}
 */
export function renderStreamingMarkdown(text) {
  const source = normalizeMarkdownText(text);
  if (!source) return '';

  // Close any unclosed code fences for rendering
  const fenceCount = (source.match(/```/g) || []).length;
  let processed = source;
  if (fenceCount % 2 !== 0) {
    processed += '\n```';
  }

  return renderMarkdownInternal(processed, {
    highlightCode: false,
    renderMath: false,
  });
}
