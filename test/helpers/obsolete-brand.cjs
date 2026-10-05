'use strict';

const crypto = require('node:crypto');

// SHA-256 of the lowercase obsolete product token. Only the digest lives in
// source, so the guard can recognise the name without spelling it anywhere.
const OBSOLETE_BRAND_SHA256 = '281aca1a80b52620bd717e8b14a0386b8ada92ae859ac2c8a2ac222efa02edbb';

const digests = new Map();

function matchesObsoleteBrand(value) {
  if (!digests.has(value)) {
    digests.set(value, crypto.createHash('sha256').update(value).digest('hex') === OBSOLETE_BRAND_SHA256);
  }
  return digests.get(value);
}

// Letter runs, split again on lower->Upper camelCase boundaries, lowercased.
function letterTokens(text) {
  return String(text ?? '')
    .split(/[^\p{L}]+/u)
    .flatMap(run => run.split(/(?<=\p{Ll})(?=\p{Lu})/u))
    .filter(Boolean)
    .map(token => token.toLowerCase());
}

// Returns every flagged token: the whole token or its first three letters is
// the obsolete name.
function findObsoleteBrand(text) {
  return letterTokens(text).filter(token => matchesObsoleteBrand(token)
    || (token.length > 3 && matchesObsoleteBrand(Array.from(token).slice(0, 3).join(''))));
}

module.exports = { OBSOLETE_BRAND_SHA256, findObsoleteBrand, letterTokens };
