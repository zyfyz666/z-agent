(function exposeProtocolText(root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./legacy-compat') : root.ZLegacyCompat);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ZProtocolText = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, compat => {
  'use strict';

  const NAMED_PROTOCOLS = new Set([
    'delivery-contract', 'delivery-review', 'delivery-agreement', 'reasoning-sidepath',
    'turn-context', 'continual-harness', 'long-horizon-protocol', 'experience-edges',
    'authorized-handoff', 'long-term-memory', 'session-history', 'media-history',
    'repo-map', 'authoritative-policies'
  ]);

  function protocolTagNames(suffix) {
    if (!NAMED_PROTOCOLS.has(suffix)) throw new TypeError('Unknown application protocol tag.');
    return [`z-${suffix}`, `${compat.LEGACY_NAMESPACE.lower}-${suffix}`];
  }

  // Match a known current or historical tag with its own closing tag. Capture
  // 1 is the tag name, capture 2 is its content. Callers parse/strip a view of
  // the text; neither this matcher nor its consumers rewrite saved messages.
  function protocolBlockPattern(suffix, { allowAttributes = false } = {}) {
    const names = protocolTagNames(suffix).join('|');
    const attributes = allowAttributes ? '(?:\\s[^<>]*?)?' : '';
    return new RegExp(`<(${names})${attributes}>([\\s\\S]*?)<\\/\\1>`, 'giu');
  }

  // Track Markdown code delimiters across chunks. Protocol arguments are not
  // fed through this context, since they can contain arbitrary source code.
  class ProtocolTextContext {
    constructor() {
      this.inline = 0;
      this.fence = '';
      this.fenceLength = 0;
      this.lineStart = true;
      this.delimiter = '';
      this.delimiterLength = 0;
      this.delimiterAtLineStart = false;
    }

    resolveDelimiter() {
      const marker = this.delimiter;
      const length = this.delimiterLength;
      if (!marker) return;
      if (this.fence) {
        if (this.delimiterAtLineStart && marker === this.fence && length >= this.fenceLength) {
          this.fence = '';
          this.fenceLength = 0;
        }
      } else if (this.inline) {
        if (marker === '`' && length === this.inline) this.inline = 0;
      } else if (this.delimiterAtLineStart && length >= 3) {
        this.fence = marker;
        this.fenceLength = length;
      } else if (marker === '`') {
        this.inline = length;
      }
      this.delimiter = '';
      this.delimiterLength = 0;
    }

    write(value) {
      for (const character of value) {
        if (character === this.delimiter) {
          this.delimiterLength += 1;
          continue;
        }
        this.resolveDelimiter();
        if (character === '`' || character === '~') {
          this.delimiter = character;
          this.delimiterLength = 1;
          this.delimiterAtLineStart = this.lineStart;
        }
        if (character === '\n' || character === '\r') this.lineStart = true;
        else if (character !== ' ' && character !== '\t') this.lineStart = false;
      }
    }

    get literal() {
      this.resolveDelimiter();
      return !!(this.inline || this.fence);
    }
  }

  function findUnquotedMarkup(value, pattern, context = new ProtocolTextContext()) {
    const source = String(value || '');
    const probe = Object.assign(new ProtocolTextContext(), context);
    const matches = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '') + 'g');
    let offset = 0;
    let match;
    while ((match = matches.exec(source))) {
      probe.write(source.slice(offset, match.index));
      if (!probe.literal) return match;
      // A quoted opening tag can match all the way to a real call's closing
      // tag. Resume after its first character so that real call is still seen.
      probe.write(source[match.index]);
      offset = match.index + 1;
      matches.lastIndex = offset;
    }
    return null;
  }

  function containsDsmlMarkup(value) {
    return !!findUnquotedMarkup(value, /<\/?[|｜]{2}\s*DSML\s*[|｜]{2}/iu);
  }

  return { ProtocolTextContext, findUnquotedMarkup, containsDsmlMarkup, protocolTagNames, protocolBlockPattern };
}));
