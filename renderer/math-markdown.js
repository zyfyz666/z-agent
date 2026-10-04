(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('katex'));
  else root.ZMathMarkdown = factory(root.katex);
})(globalThis, function (katex) {
  'use strict';

  const TOKEN = /\u0000MATH(?:BLOCK)?(\d+)\u0000/g;
  const MAX_TEX_LENGTH = 10000;
  const escape = value => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  function escaped(text, position) {
    let count = 0;
    while (position > 0 && text[--position] === '\\') count++;
    return count % 2 === 1;
  }

  function closingPosition(text, start, delimiter, budget) {
    for (let position = start; position < text.length; position++) {
      if (--budget.remaining < 0) return -1;
      if (delimiter === '$' && /[\r\n]/.test(text[position])) return -1;
      if (!text.startsWith(delimiter, position)) continue;
      if (!escaped(text, position) && (delimiter !== '$' || (
        text[position - 1] !== '$' && text[position + 1] !== '$'
        && !/\s/.test(text[position - 1] || '') && !/\d/.test(text[position + 1] || '')
      ))) return position;
    }
    return -1;
  }

  // Called after Markdown code has been protected and before HTML escaping.
  function extract(value) {
    const text = String(value || '');
    const expressions = [];
    const parts = [];
    // Incomplete model output may contain thousands of unmatched delimiters.
    // Bound total scanning work; leave the remaining text literal on exhaustion.
    const budget = { remaining: Math.min(1000000, Math.max(50000, text.length * 16)) };
    const openings = /\$\$|\\\[|\\\(|\$/g;
    let cursor = 0;
    let match;
    while ((match = openings.exec(text))) {
      const start = match.index;
      const left = match[0];
      if (escaped(text, start)) continue;
      // Dollar signs in URLs/file names are literal, including link targets.
      const prefix = text.slice(Math.max(0, start - 2048), start);
      budget.remaining -= prefix.length + 1;
      if (budget.remaining <= 0) break;
      if (/(?:https?:\/\/|file:\/\/|www\.|[A-Za-z]:[\\/])[^\s<>"'`]*$/i.test(prefix)) continue;
      if (left === '$' && (text[start - 1] === '$' || /\s/.test(text[start + 1] || ''))) continue;
      const right = left === '\\[' ? '\\]' : left === '\\(' ? '\\)' : left;
      const end = closingPosition(text, start + left.length, right, budget);
      if (end === -1) continue;
      const tex = text.slice(start + left.length, end);
      // Never consume protected Markdown code or link placeholders as TeX.
      if (!tex.trim() || tex.includes('\u0000')) continue;
      const displayMode = left === '$$' || left === '\\[';
      const index = expressions.length;
      expressions.push({ tex, displayMode, source: text.slice(start, end + right.length) });
      parts.push(text.slice(cursor, start), `\u0000MATH${displayMode ? 'BLOCK' : ''}${index}\u0000`);
      cursor = end + right.length;
      openings.lastIndex = cursor;
    }
    parts.push(text.slice(cursor));
    return { text: parts.join(''), expressions };
  }

  function restoreSource(text, expressions) {
    return text.replace(TOKEN, (token, index) => expressions[Number(index)]?.source || token);
  }

  function render(expression) {
    try {
      if (!katex || expression.tex.length > MAX_TEX_LENGTH) throw new Error('Math unavailable or too large');
      const html = katex.renderToString(expression.tex, {
        displayMode: expression.displayMode,
        output: 'htmlAndMathml',
        throwOnError: true,
        trust: false,
        strict: 'ignore',
        maxExpand: 1000,
        maxSize: 20,
        // Each expression has its own macros; model output cannot affect others.
        macros: {}
      });
      return `<span class="math-expression${expression.displayMode ? ' math-display' : ''}" data-preserve-language>${html}</span>`;
    } catch {
      return `<span class="math-source" data-preserve-language>${escape(expression.source)}</span>`;
    }
  }

  function restore(text, expressions) {
    return text.replace(TOKEN, (token, index) => expressions[Number(index)] ? render(expressions[Number(index)]) : '');
  }

  return { extract, restore, restoreSource };
});
