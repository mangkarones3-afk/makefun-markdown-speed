// parse.js — a dependency-free Markdown to HTML renderer.
//
// parse(markdown) returns the HTML for a Markdown document, byte for byte the
// output marked 18.1.3 produces with its default options (GFM enabled, line
// breaks off). Written from scratch as a two-phase parser: a container-stack
// block parser (CommonMark structure with GFM tables) followed by a
// delimiter-stack inline parser (emphasis, links, code spans, GFM
// strikethrough and extended autolinks).
//
// No state is kept between calls: each call re-parses from its argument
// alone, so parse is a pure function of the markdown it is given.

'use strict';

/* ------------------------------------------------------------------ *
 * Character classes and escaping
 * ------------------------------------------------------------------ */

// ASCII punctuation, per the CommonMark definition.
const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

function isAsciiPunct(ch) {
  return ch !== undefined && ASCII_PUNCT.has(ch);
}

const WS_RE = /\s/;
function isWs(ch) {
  // String boundaries count as whitespace for flanking purposes.
  return ch === undefined || WS_RE.test(ch);
}

const PUNCT_CACHE = new Map();
function isPunct(ch) {
  if (ch === undefined) return false;
  if (ch.codePointAt(0) < 128) return ASCII_PUNCT.has(ch);
  let v = PUNCT_CACHE.get(ch);
  if (v === undefined) {
    v = /[\p{P}\p{S}]/u.test(ch);
    PUNCT_CACHE.set(ch, v);
  }
  return v;
}

// Escape a string for HTML text content. An ampersand is left alone when it
// begins an entity-shaped sequence (&name;, &#1234567;, &#xabcdef;), matching
// the reference renderer's escaping; any other & becomes &amp;.
const AMP_RE = /&(?![A-Za-z0-9]+;|#[0-9]{1,7};|#[xX][0-9A-Fa-f]{1,6};)/g;
function escapeText(s) {
  if (!/[&<>"']/.test(s)) return s;
  const out = s
    .replace(AMP_RE, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return out.includes('\u0001') ? out.replace(/\u0001/g, '') : out;
}

// Escape a string for a double-quoted attribute value.
function escapeAttr(s) {
  if (!/[&<>"]/.test(s)) return s;
  const out = s
    .replace(AMP_RE, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return out.includes('\u0001') ? out.replace(/\u0001/g, '') : out;
}

// Escape code block / code span content: every special char is escaped.
function escapeCode(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Try to read a numeric character reference at s[i] === '&'.
// Returns { ch, len } or null. Decimal references take 1-7 digits, hex 1-6;
// value 0, a surrogate, or a value above U+10FFFF decodes to U+FFFD.
function numericEntityAt(s, i) {
  let m = /^&#([0-9]{1,7});/.exec(s.slice(i, i + 10));
  let v;
  if (m) {
    v = parseInt(m[1], 10);
  } else {
    m = /^&#[xX]([0-9A-Fa-f]{1,6});/.exec(s.slice(i, i + 10));
    if (!m) return null;
    v = parseInt(m[1], 16);
  }
  if (v === 0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) v = 0xfffd;
  return { ch: String.fromCodePoint(v), len: m[0].length };
}

// A named entity reference shape (&word;) at s[i] === '&', or null. Named
// references are passed through unchanged (never decoded).
const NAMED_ENTITY_RE = /^&[A-Za-z0-9]+;/;
function namedEntityAt(s, i) {
  const m = NAMED_ENTITY_RE.exec(s.slice(i, i + 34));
  return m ? m[0] : null;
}

// URL cleanup applied to link destinations and image sources: percent-encode
// what encodeURI encodes, but leave existing % signs alone.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return href;
  }
}

// Link label normalization: collapse internal whitespace, trim, and fold
// case with a lower-upper-lower round trip (so SS, ß, and ẞ all agree).
function normalizeLabel(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().toUpperCase().toLowerCase();
}

/* ------------------------------------------------------------------ *
 * Inline parsing
 *
 * Inline content is parsed into a doubly linked list of nodes:
 *   { k: 't', s }                    plain text (unescaped)
 *   { k: 'code', s }                 code span content
 *   { k: 'html', s }                 raw HTML, emitted verbatim
 *   { k: 'br' }                      hard line break
 *   { k: 'em' | 'strong' | 'del', kids: [nodes] }
 *   { k: 'link', href, title, kids: [nodes] }
 *   { k: 'img', href, title, kids: [nodes] }
 * Emphasis and strikethrough are resolved with a delimiter stack;
 * links and images with a bracket stack, following the CommonMark
 * inline algorithm, plus GFM extended autolinks in plain text.
 * ------------------------------------------------------------------ */

function flanking(ch, prev, next) {
  const prevWs = isWs(prev);
  const nextWs = isWs(next);
  const prevPunct = isPunct(prev);
  const nextPunct = isPunct(next);
  const left = !nextWs && (!nextPunct || prevWs || prevPunct);
  const right = !prevWs && (!prevPunct || nextWs || nextPunct);
  if (ch === '_') {
    return {
      canOpen: left && (!right || prevPunct),
      canClose: right && (!left || nextPunct),
    };
  }
  return { canOpen: left, canClose: right };
}

function findCodeSpanClose(s, from, runLen) {
  const n = s.length;
  let i = from;
  while (i < n) {
    if (s[i] === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      if (j - i === runLen) return { start: i, end: j };
      i = j;
    } else {
      i++;
    }
  }
  return null;
}

// Resolve backslash escapes of ASCII punctuation in a link destination or
// title; a backslash before anything else is kept. An escaped '&' is
// followed by a sentinel (\u0001) so it cannot combine with following text
// into an entity reference when the value is escaped for output.
function unescapeBackslash(s) {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      out += s[i + 1];
      if (s[i + 1] === '&') out += '\u0001';
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

function parseLinkTitle(s, i) {
  const n = s.length;
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < n) {
      if (s[j] === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { j += 2; continue; }
      if (s[j] === q) return { title: unescapeBackslash(s.slice(i + 1, j)), end: j + 1 };
      j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1;
    while (j < n) {
      if (s[j] === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { j += 2; continue; }
      if (s[j] === '(') return null;
      if (s[j] === ')') return { title: unescapeBackslash(s.slice(i + 1, j)), end: j + 1 };
      j++;
    }
    return null;
  }
  return null;
}

// Parse "( destination title )" starting at s[pos] === '('.
function parseInlineLink(s, pos) {
  const n = s.length;
  let i = pos + 1;
  const skipWs = () => { while (i < n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++; };
  skipWs();
  let dest;
  if (s[i] === '<') {
    let j = i + 1;
    let ok = false;
    while (j < n) {
      const ch = s[j];
      if (ch === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { j += 2; continue; }
      if (ch === '>') { ok = true; break; }
      if (ch === '<' || ch === '\n') break;
      j++;
    }
    if (!ok) return null;
    dest = unescapeBackslash(s.slice(i + 1, j));
    i = j + 1;
  } else {
    const start = i;
    let depth = 0;
    while (i < n) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < n && isAsciiPunct(s[i + 1])) { i += 2; continue; }
      if (ch === '(') { depth++; i++; continue; }
      if (ch === ')') {
        if (depth === 0) break;
        depth--;
        i++;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '<' || ch < ' ') break;
      i++;
    }
    dest = unescapeBackslash(s.slice(start, i));
  }
  skipWs();
  if (s[i] === ')') return { dest, title: null, end: i + 1 };
  const t = parseLinkTitle(s, i);
  if (!t) return null;
  i = t.end;
  skipWs();
  if (s[i] === ')') return { dest, title: t.title, end: i + 1 };
  return null;
}

// Scan a link label starting just after s[openIdx] === '[' with the
// token rules of the reference label pattern: a token is a backslash
// escape, one bracket group whose content has no unescaped bracket, a
// backtick run paired with the NEXT backtick run (the content between
// holds no backticks, and the two runs may differ in length), a run of
// 2+ backticks directly before the closing bracket, or any other single
// character. Returns the index of the ']' ending the shortest label
// the pattern can match, or -1 when it cannot match at all.
function scanMarkedLabel(s, openIdx) {
  const n = s.length;
  let i = openIdx + 1;
  while (i < n) {
    const c = s[i];
    if (c === ']') return i;
    if (c === '\\') { i += 2; continue; }
    if (c === '[') {
      // One bracket group; its content (backticks are plain there) may
      // itself hold one further group whose content is bracket-free.
      let j = i + 1;
      let ok = false;
      while (j < n) {
        const d = s[j];
        if (d === '\\') { j += 2; continue; }
        if (d === ']') { ok = true; break; }
        if (d === '[') {
          let k = j + 1;
          let innerOk = false;
          while (k < n) {
            const e = s[k];
            if (e === '\\') { k += 2; continue; }
            if (e === ']') { innerOk = true; break; }
            if (e === '[') break;
            k++;
          }
          if (!innerOk) return -1;
          j = k + 1;
          continue;
        }
        j++;
      }
      if (!ok) return -1;
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      if (j - i >= 2 && s[j] === ']') return j;
      let k = j;
      while (k < n && s[k] !== '`') k++;
      if (k >= n) return -1;
      while (k < n && s[k] === '`') k++;
      i = k;
      continue;
    }
    i++;
  }
  return -1;
}

// Scan a shortcut-reference label starting just after s[openIdx] === '['
// with the plainer nolink pattern: backslash escapes and any characters
// except unescaped brackets (backticks are ordinary here), at least one
// character, and not only whitespace. Returns { label, end } with end
// just past the ']', or null.
function scanNolinkLabel(s, openIdx) {
  const n = s.length;
  let j = openIdx + 1;
  let wsOnly = true;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n) { wsOnly = false; j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') {
      if (j === openIdx + 1 || wsOnly) return null;
      return { label: s.slice(openIdx + 1, j), end: j + 1 };
    }
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') wsOnly = false;
    j++;
  }
  return null;
}

// Parse a link label starting at s[pos] === '['; returns { label, end }.
function parseLinkLabel(s, pos) {
  const n = s.length;
  let j = pos + 1;
  while (j < n) {
    const ch = s[j];
    if (ch === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { j += 2; continue; }
    if (ch === '[') return null;
    if (ch === ']') {
      if (j - pos - 1 > 999) return null;
      return { label: s.slice(pos + 1, j), end: j + 1 };
    }
    j++;
  }
  return null;
}

const HTML_COMMENT_RE = /^<!--(?:-?>|[\s\S]*?-->)/;
const HTML_CDATA_RE = /^<!\[CDATA\[[\s\S]*?\]\]>/;
const HTML_PI_RE = /^<\?[\s\S]*?\?>/;
const HTML_DECL_RE = /^<![A-Z][\s\S]*?>/;
const TAG_NAME_SRC = '[A-Za-z][A-Za-z0-9-]*';
const ATTR_SRC = "\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:[^ \\t\\n\"'=<>`]+|'[^']*'|\"[^\"]*\"))?";
const HTML_OPEN_TAG_RE = new RegExp('^<' + TAG_NAME_SRC + '(?:' + ATTR_SRC + ')*\\s*/?>');
const HTML_CLOSE_TAG_RE = new RegExp('^</' + TAG_NAME_SRC + '\\s*>');
const AUTOLINK_URI_RE = /^<([A-Za-z][A-Za-z0-9+.\-]{1,31}:[^<>\s]*)>/;
const AUTOLINK_EMAIL_RE = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/;

// Match an autolink (<scheme:...> or <email>) or a raw HTML span at s[i]==='<'.
function matchAngle(s, i) {
  const rest = s.slice(i, i + 2000);
  let m = HTML_COMMENT_RE.exec(rest) || HTML_CDATA_RE.exec(rest) || HTML_PI_RE.exec(rest) || HTML_DECL_RE.exec(rest);
  if (m) return { node: { k: 'html', s: m[0] }, end: i + m[0].length };
  m = AUTOLINK_URI_RE.exec(rest);
  if (m) {
    return { node: { k: 'link', href: m[1], title: null, kids: [{ k: 't', s: m[1] }] }, end: i + m[0].length };
  }
  m = AUTOLINK_EMAIL_RE.exec(rest);
  if (m) {
    return { node: { k: 'link', href: 'mailto:' + m[1], title: null, kids: [{ k: 't', s: m[1] }] }, end: i + m[0].length };
  }
  m = HTML_OPEN_TAG_RE.exec(rest) || HTML_CLOSE_TAG_RE.exec(rest);
  if (m) return { node: { k: 'html', s: m[0] }, end: i + m[0].length };
  return null;
}

// Trim a candidate extended-autolink URL the way the reference does:
// keep the longest prefix that decomposes into chunks of ordinary
// characters, balanced "(...)" groups, '&' not starting an entity at
// the very end, and punctuation runs that do not reach the end; repeat
// until the text is stable (each pass can expose a new trailing run).
const AUTOLINK_PUNCT = new Set('?!.,:;*_\'"~)'.split(''));
function autolinkBackpedalPrefix(t) {
  const n = t.length;
  let i = 0;
  while (i < n) {
    const c = t[i];
    if (c === '(') {
      const close = t.indexOf(')', i + 1);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (c === '&') {
      if (/^[A-Za-z0-9]+;$/.test(t.slice(i + 1))) break;
      i++;
      continue;
    }
    if (AUTOLINK_PUNCT.has(c)) {
      let j = i;
      while (j < n && AUTOLINK_PUNCT.has(t[j])) j++;
      if (j >= n) break;
      i = j;
      continue;
    }
    let j = i;
    while (j < n) {
      const d = t[j];
      if (d === '(' || d === '&' || AUTOLINK_PUNCT.has(d)) break;
      j++;
    }
    i = j;
  }
  return i;
}
function autolinkTrim(s) {
  let cur = s;
  for (;;) {
    const keep = autolinkBackpedalPrefix(cur);
    if (keep >= cur.length) return cur.length;
    cur = cur.slice(0, keep);
  }
}

const EMAIL_LOCAL_SRC = "[A-Za-z0-9.!#$%&'*+\\/=?^_`{|}~-]+";
const EMAIL_DOMAIN_SRC = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+";
const EMAIL_RE = new RegExp('^(' + EMAIL_LOCAL_SRC + ')@(' + EMAIL_DOMAIN_SRC + ')');
// Characters that, immediately before a position, block an email autolink
// attempt there (they would belong to the address itself). '/' is notably
// absent: an address after a path separator still links.
const EMAIL_BLOCK_PREV = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+=?^_`{|}~-@".split(''));

function matchExtendedAutolink(s, i) {
  const n = s.length;
  const prev = i > 0 ? s[i - 1] : undefined;
  const prevAlnum = prev !== undefined && /[A-Za-z0-9]/.test(prev);
  // mailto: / xmpp: followed by an email address
  const schemeEmail = /^(mailto|xmpp):/i.exec(s.slice(i, i + 8));
  if (schemeEmail && !prevAlnum) {
    const at = i + schemeEmail[0].length;
    const m = EMAIL_RE.exec(s.slice(at));
    if (m) {
      const after = s[at + m[0].length];
      if (after !== '-' && after !== '_') {
        let end = at + m[0].length;
        // xmpp addresses may carry one path segment: /seg (no second /).
        if (schemeEmail[1].toLowerCase() === 'xmpp' && s[end] === '/') {
          let j = end + 1;
          while (j < n && /[A-Za-z0-9@.]/.test(s[j])) j++;
          if (j > end + 1) end = j;
        }
        const text0 = s.slice(i, end);
        const keep = autolinkTrim(text0);
        const text = text0.slice(0, keep);
        return { href: text, text, end: i + keep };
      }
    }
  }
  // www. or scheme:// URLs
  let hrefPrefix = null;
  let isWww = false;
  // "www." is lowercase-only and needs a boundary before it (start,
  // whitespace, or one of *_~(); scheme URLs link after any character.
  if (s.startsWith('www.', i) &&
      (prev === undefined || isWs(prev) || prev === '*' || prev === '_' ||
       prev === '~' || prev === '(')) {
    hrefPrefix = 'http://';
    isWww = true;
  } else if (/^(?:https?|ftp):\/\//i.test(s.slice(i, i + 10))) {
    hrefPrefix = '';
  }
  if (hrefPrefix !== null) {
    let j = i;
    while (j < n) {
      const ch = s[j];
      if (ch === '<' || WS_RE.test(ch)) break;
      j++;
    }
    const candidate = s.slice(i, j);
    const keep = autolinkTrim(candidate);
    const text = candidate.slice(0, keep);
    if (isWww) {
      if (!/^www\.[A-Za-z0-9]/i.test(text)) return null;
    } else if (text.length <= text.indexOf('://') + 3) {
      return null;
    }
    return { href: hrefPrefix + text, text, end: i + keep };
  }
  // bare email address
  if (prev !== undefined && EMAIL_BLOCK_PREV.has(prev)) return null;
  const m = EMAIL_RE.exec(s.slice(i));
  if (m) {
    const after = s[i + m[0].length];
    if (after === '-' || after === '_') return null;
    return { href: 'mailto:' + m[0], text: m[0], end: i + m[0].length };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Emphasis / strikethrough scanning.
 *
 * The reference renderer resolves emphasis with a single-opener scan:
 * at a potential opening delimiter run it scans forward over the
 * (masked) text, classifying each later run of the same character by
 * the characters around it, keeping a balance counter: runs that look
 * like openers add to the counter, runs that look like closers subtract
 * from it, and the first closer that brings the counter to zero ends
 * the span. Intraword closers can be skipped by a modulo-3 rule. The
 * scan runs over a masked copy of the text (same length) in which code
 * spans, links, HTML tags, escapes, and resolved reference links are
 * blanked out, so delimiter characters inside them stay invisible.
 * ------------------------------------------------------------------ */

const PS_CLASS = /[\p{P}\p{S}]/u;
const PS_SPACE_CLASS = /[\s\p{P}\p{S}]/u;
// Character classes used by the scan, in single-code-point form.
function cpIsPunctN(ch) { return ch !== '' && PS_CLASS.test(ch); }
function cpIsPunctG(ch) { return ch !== '' && ch !== '~' && PS_CLASS.test(ch); }
function cpIsPSN(ch) { return ch !== '' && PS_SPACE_CLASS.test(ch); }
function cpIsPSG(ch) { return ch !== '' && ch !== '~' && PS_SPACE_CLASS.test(ch); }
function cpIsNPSN(ch) { return ch !== '' && !PS_SPACE_CLASS.test(ch); }
function cpIsNPSG(ch) { return ch !== '' && (ch === '~' || !PS_SPACE_CLASS.test(ch)); }
function cpIsWs(ch) { return ch !== '' && /\s/.test(ch); }

// The code point starting at index i, or null at the end.
function cpAt(s, i) {
  if (i >= s.length) return null;
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const c2 = s.charCodeAt(i + 1);
    if (c2 >= 0xdc00 && c2 <= 0xdfff) return { ch: s.slice(i, i + 2), len: 2 };
  }
  return { ch: s[i], len: 1 };
}

// The code point ending at index i, or null at the start.
function cpBefore(s, i) {
  if (i <= 0) return null;
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const c1 = s.charCodeAt(i - 2);
    if (c1 >= 0xd800 && c1 <= 0xdbff) return { ch: s.slice(i - 2, i), len: 2 };
  }
  return { ch: s[i - 1], len: 1 };
}

// For each delimiter character, the start index of the last run in the
// masked text whose preceding character is not blank (or -1). A closer
// for an opener can never start past that index.
function lastCloserBounds(masked) {
  const out = { '*': -1, '_': -1, '~': -1 };
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    const o = s === 0 ? '\n' : masked[s - 1];
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') out[r] = s;
    s = i - 1;
  }
  return out;
}

// Classify a delimiter run at masked[j..j+runLen) by its neighbours.
// Returns the alternative number (1-6) of the reference scan pattern, or
// 0 when the run can neither open nor close. kind is 'ast', 'und', 'del'.
function classifyRun(masked, j, runLen, kind) {
  const before = cpBefore(masked, j);
  if (!before) return 0;
  const c0 = before.ch;
  const after = cpAt(masked, j + runLen);
  const c1 = after ? after.ch : '';
  const atEnd = after === null;
  let P, PS, NPS;
  if (kind === 'ast') { P = cpIsPunctG; PS = cpIsPSG; NPS = cpIsNPSG; }
  else { P = cpIsPunctN; PS = cpIsPSN; NPS = cpIsNPSN; }
  if (P(c0) && (atEnd || cpIsWs(c1))) return 1;
  if (NPS(c0) && (atEnd || PS(c1))) return 2;
  if (PS(c0) && NPS(c1)) return 3;
  if (cpIsWs(c0) && P(c1)) return 4;
  if (P(c0) && P(c1)) return 5;
  if (kind !== 'und' && NPS(c0) && NPS(c1)) return 6;
  return 0;
}

// A "__ ... __" span (or "** ... **") whose content holds exactly one
// star (or underscore) and no other marker character is skipped whole by
// the reference scan. If the text at pos starts such a span, return the
// index of the closing marker; otherwise return -1.
// Whether the no-capture span alternative of the reference closer scan
// matches at pos: plain text, a doubled other-delimiter, plain text
// containing exactly one of this scan's delimiter, then plain text up
// to a second doubled other-delimiter. Returns the position of that
// second pair (where scanning resumes), or -1. The reference scan only
// attempts this at restart positions (the scan start and just after a
// processed run), never in the middle of a text stretch.
function spanSkipAt(s, pos, inner, other) {
  const n = s.length;
  let j = pos;
  while (j < n && s[j] !== '*' && s[j] !== '_') j++;
  if (s[j] !== other || s[j + 1] !== other) return -1;
  j += 2;
  let seenInner = false;
  while (j < n) {
    const c = s[j];
    if (c === other) {
      return s[j + 1] === other && seenInner ? j : -1;
    }
    if (c === inner) {
      if (seenInner) return -1;
      seenInner = true;
    }
    j++;
  }
  return -1;
}
// Mask step 1: blank out resolved reference-style links (their labels
// and texts may contain delimiter characters that must stay invisible).
function maskReflinks(s, refs) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const isImg = s[i] === '!' && s[i + 1] === '[';
    if (s[i] === '[' || isImg) {
      const openIdx = isImg ? i + 1 : i;
      const close = findBracketClose(s, openIdx);
      if (close > 0) {
        let matchEnd = close + 1;
        let isRefForm = false;
        if (s[close + 1] === '[') {
          const lab = parseLinkLabel(s, close + 1);
          if (lab) { matchEnd = lab.end; isRefForm = true; }
        }
        if (!isRefForm) {
          if (s.slice(close + 1, close + 3) === '[]') matchEnd = close + 3;
          if (s[matchEnd] === '(') matchEnd = -1; // nolink excludes a following (
        }
        if (matchEnd > 0) {
          const match = s.slice(i, matchEnd);
          const o = match.lastIndexOf('[');
          const label = match.slice(o + 1, match.length - 1);
          if (!refs.has(normalizeLabel(label))) {
            out += match;
          } else if (o > 1 && match[0] !== '!') {
            const textPart = match.slice(1, o - 1);
            if (textContainsLink(textPart, refs)) {
              out += '[' + maskReflinks(textPart, refs) + '][' +
                'a'.repeat(match.length - o - 2) + ']';
            } else {
              out += '[' + 'a'.repeat(match.length - 2) + ']';
            }
          } else {
            out += '[' + 'a'.repeat(match.length - 2) + ']';
          }
          i = matchEnd;
          continue;
        }
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

function textContainsLink(text, refs) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[' && blockSkipLinkEnd(text, i) > 0) return true;
    if (text[i] === '[' || (text[i] === '!' && text[i + 1] === '[')) {
      const openIdx = text[i] === '!' ? i + 1 : i;
      const close = findBracketClose(text, openIdx);
      if (close > 0) {
        const t = text.slice(openIdx + 1, close);
        if (refs.has(normalizeLabel(t))) return true;
        if (text[close + 1] === '[') {
          const lab = parseLinkLabel(text, close + 1);
          if (lab && refs.has(normalizeLabel(lab.label === '' ? t : lab.label))) return true;
        }
      }
    }
  }
  return false;
}

// Mask step 2: escapes of punctuation become '++', and backticks inside
// code spans become '+' (the spans themselves are blanked in step 3).
function maskEscapesAndCode(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      const runLen = j - i;
      const run = s.slice(i, j);
      let closeStart = -1;
      if (j < n && s[j] !== '`') {
        let e = j + 1;
        while (e <= n) {
          if (s[e - 1] !== '`' && s.startsWith(run, e) && s[e + runLen] !== '`') {
            closeStart = e;
            break;
          }
          e++;
        }
      }
      if (closeStart >= 0) {
        out += run + s.slice(j, closeStart).replace(/`/g, '+') + run;
        i = closeStart + runLen;
      } else {
        out += run;
        i = j;
      }
      continue;
    }
    if (c === '\\' && i + 1 < n && cpIsPunctN(s[i + 1])) {
      out += '++';
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// The end index (exclusive) of a block-skip style link shape starting at
// s[i] === '[', or -1. The text part holds no brackets or backslashes
// (code spans aside); the destination allows escapes and one level of
// balanced parentheses.
function blockSkipLinkEnd(s, i) {
  const n = s.length;
  let j = i + 1;
  for (;;) {
    if (j >= n) return -1;
    const c = s[j];
    if (c === ']') break;
    if (c === '[' || c === '\\') return -1;
    if (c === '`') {
      let k = j;
      while (k < n && s[k] === '`') k++;
      const close = findCodeSpanClose(s, k, k - j);
      if (!close) return -1;
      j = close.end;
      continue;
    }
    j++;
  }
  if (s[j + 1] !== '(') return -1;
  let k = j + 2;
  for (;;) {
    if (k >= n) return -1;
    const c = s[k];
    if (c === '\\') { k += 2; continue; }
    if (c === '(') {
      let d = k + 1;
      for (;;) {
        if (d >= n) return -1;
        if (s[d] === '\\') { d += 2; continue; }
        if (s[d] === '(') return -1;
        if (s[d] === ')') break;
        d++;
      }
      k = d + 1;
      continue;
    }
    if (c === ')') return k + 1;
    k++;
  }
}

// Mask step 3: blank out inline links, code spans, and HTML-tag-shaped
// spans as [aaa...] of the same length.
function maskBlockSkip(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '[') {
      const end = blockSkipLinkEnd(s, i);
      if (end > 0) {
        out += '[' + 'a'.repeat(end - i - 2) + ']';
        i = end;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      const close = findCodeSpanClose(s, j, j - i);
      if (close) {
        out += '[' + 'a'.repeat(Math.max(0, close.end - i - 2)) + ']';
        i = close.end;
        continue;
      }
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (c === '<' && s[i + 1] !== ' ') {
      let j = i + 1;
      while (j < n && s[j] !== '>' && s[j] !== '<') j++;
      if (j < n && s[j] === '>') {
        out += '[' + 'a'.repeat(Math.max(0, j + 1 - i - 2)) + ']';
        i = j + 1;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function buildMask(s, refs) {
  let t = s;
  if (refs.size > 0 && t.includes('[')) t = maskReflinks(t, refs);
  t = maskEscapesAndCode(t);
  t = maskBlockSkip(t);
  return t;
}

// Find the ']' matching the '[' at s[openIdx], honouring nesting,
// backslash escapes, and code spans. Returns its index or -1.
function findBracketClose(s, openIdx) {
  const n = s.length;
  let depth = 1;
  let i = openIdx + 1;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n && isAsciiPunct(s[i + 1])) { i += 2; continue; }
    if (c === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      const close = findCodeSpanClose(s, j, j - i);
      if (close) { i = close.end; continue; }
      i = j;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// The emphasis scan. s is the original text, masked its masked twin,
// bounds the last-closer table for masked, i the index of a '*' or '_'
// run, prevChar the reference renderer's prevChar value. Returns
// { end, contentStart, contentEnd, kind } or null.
function scanEmStrong(s, masked, bounds, i, prevChar) {
  const r = s[i];
  let runEnd = i;
  while (runEnd < s.length && s[runEnd] === r) runEnd++;
  const runLen = runEnd - i;
  const afterCp = cpAt(s, runEnd);
  const afterCh = afterCp ? afterCp.ch : '';
  let gPunct = '';
  let gOther = '';
  if (afterCh !== '' && afterCh !== r) {
    if (cpIsPunctG(afterCh)) gPunct = afterCh;
    else if (!cpIsWs(afterCh)) gOther = afterCh;
  }
  if (gPunct === '' && gOther === '') return null;
  const d = gPunct;
  let l = i;
  while (l > 0 && masked[l - 1] === r) l--;
  const beforeCp = cpBefore(masked, l);
  const p = beforeCp ? beforeCp.ch : '';
  const h = p !== '' && PS_SPACE_CLASS.test(p);
  let n = prevChar;
  if (l < i) n = p;
  const u = l < i ? h
    : (n !== '' && n !== '*' && n !== '_' && PS_SPACE_CLASS.test(n));
  if (r === '_' && gOther !== '' && /[\p{L}\p{N}]/u.test(n)) return null;
  if (d !== '' && n !== '' && !u) return null;
  const k = runLen;
  let m = k;
  let f = 0;
  const y = (i - l) + k;
  const R = p !== '' && p.trim() !== '' && (d !== '' || (r === '*' && !h));
  const o = prevChar === r;
  const bound = bounds[r];
  const Q = i + k;
  if (bound < Q) return null;
  const ee = bound - Q;
  const kind = r === '*' ? 'ast' : 'und';
  const other = r === '*' ? '_' : '*';
  const nMasked = masked.length;
  let pos = Q;
  // The no-capture span alternative of the reference scan pattern is
  // anchored to the start of the scan, so it is attempted only here,
  // before any run is processed — never after a processed run.
  let jump = spanSkipAt(masked, pos, r, other);
  while (jump > 0) {
    pos = jump;
    jump = spanSkipAt(masked, pos, r, other);
  }
  while (pos < nMasked) {
    if (pos - Q > ee) break;
    let rs = pos;
    while (rs < nMasked && masked[rs] !== r) rs++;
    if (rs >= nMasked) break;
    pos = rs;
    let re = pos;
    while (re < nMasked && masked[re] === r) re++;
    const rl = re - pos;
    const ctx = cpBefore(masked, pos);
    const te = ctx ? ctx.len : 1;
    const sIndex = pos - te - Q;
    if (sIndex > ee) break;
    const g = classifyRun(masked, pos, rl, kind);
    if (g === 3 || g === 4) {
      m += rl;
      pos = re;
      continue;
    }
    if (g === 5 || g === 6 || R) {
      if (o && (g === 5 || g === 6)) return null;
      if (y % 3 !== 0 && (y + rl) % 3 === 0) {
        f += rl;
        pos = re;
        continue;
      }
    }
    if (g !== 0) {
      m -= rl;
      if (m <= 0) {
        const bUsed = Math.min(rl, rl + m + f);
        const end = Q + sIndex + te + bUsed;
        const take = Math.min(k, bUsed) % 2 === 1 ? 1 : 2;
        return {
          end,
          contentStart: i + take,
          contentEnd: end - take,
          kind: take === 1 ? 'em' : 'strong',
        };
      }
    }
    pos = re;
  }
  return null;
}

// The strikethrough scan, mirroring the emphasis scan's structure with
// its own opener/closer rules: opener and closer runs must have equal
// length (1 or 2), and there is no modulo-3 rule.
function scanDel(s, masked, bounds, i, prevChar) {
  let runLen = 0;
  while (s[i + runLen] === '~') runLen++;
  if (runLen > 2) return null;
  const o = runLen;
  const afterCp = cpAt(s, i + o);
  const afterCh = afterCp ? afterCp.ch : '';
  let gPunct = '';
  if (afterCh !== '' && afterCh !== '~') {
    if (cpIsPunctN(afterCh)) gPunct = afterCh;
    else if (cpIsWs(afterCh)) return null;
  } else {
    return null;
  }
  const gate = gPunct === '' || prevChar === '' ||
    (prevChar !== '*' && prevChar !== '_' && PS_SPACE_CLASS.test(prevChar));
  if (!gate) return null;
  const bound = bounds['~'];
  const Q = i + o;
  if (bound < Q) return null;
  const ee = bound - Q;
  let m = o;
  const nMasked = masked.length;
  let pos = Q;
  while (pos < nMasked) {
    if (masked[pos] !== '~') { pos++; continue; }
    let re = pos;
    while (re < nMasked && masked[re] === '~') re++;
    const rl = re - pos;
    const ctx = cpBefore(masked, pos);
    const te = ctx ? ctx.len : 1;
    const sIndex = pos - te - Q;
    if (sIndex > ee) break;
    const g = classifyRun(masked, pos, rl, 'del');
    if (g !== 0 && rl === o) {
      if (g === 3 || g === 4) {
        m += rl;
        pos = re;
        continue;
      }
      m -= rl;
      if (m <= 0) {
        const end = Q + sIndex + te + o;
        return { end, contentStart: i + o, contentEnd: end - o };
      }
    }
    pos = re;
  }
  return null;
}

// Whether a tag or autolink starting inside the label text at offset
// (in the full string s) reaches past the end of the label; the
// reference renderer rejects such link labels. Code spans and escaped
// characters inside the label are skipped.
function labelCrossesTag(s, text, offset) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let j = i;
      while (j < n && text[j] === '`') j++;
      const close = findCodeSpanClose(text, j, j - i);
      i = close ? close.end : j;
      continue;
    }
    if (c === '<') {
      const m = matchTagOrAutolink(s, offset + i);
      if (m > 0) {
        if (m > n - i) return true;
        i += m;
        continue;
      }
    }
    i++;
  }
  return false;
}

// Length of the raw-HTML or autolink match starting at s[i] === '<',
// or 0. HTML shapes are tried before the autolink shapes.
function matchTagOrAutolink(s, i) {
  const rest = s.slice(i, i + 2000);
  let m = HTML_COMMENT_RE.exec(rest) || HTML_CDATA_RE.exec(rest) ||
    HTML_PI_RE.exec(rest) || HTML_DECL_RE.exec(rest) ||
    HTML_OPEN_TAG_RE.exec(rest) || HTML_CLOSE_TAG_RE.exec(rest);
  if (m) return m[0].length;
  m = AUTOLINK_URI_RE.exec(rest) || AUTOLINK_EMAIL_RE.exec(rest);
  return m ? m[0].length : 0;
}

// Try to form a link or image at s[i] ('[' or '!['). On success returns
// { node, end }; the link text is tokenized recursively, and a link
// formed inside the text of another link makes the outer one literal.
function tryLinkConstruct(s, i, refs, state, isImage) {
  const openIdx = isImage ? i + 1 : i;
  let text = null;
  let dest = null;
  let title = null;
  let end = -1;
  const close = scanMarkedLabel(s, openIdx);
  if (close >= 0) {
    text = s.slice(openIdx + 1, close);
    if (s[close + 1] === '(') {
      const p = parseInlineLink(s, close + 1);
      if (p) {
        dest = p.dest;
        title = p.title;
        end = p.end;
      }
    } else if (s[close + 1] === '[') {
      const lab = parseLinkLabel(s, close + 1);
      if (lab) {
        const key = normalizeLabel(lab.label === '' ? text : lab.label);
        const ref = refs.get(key);
        if (ref) {
          dest = ref.href;
          title = ref.title;
          end = lab.end;
        } else {
          return null; // explicit label, no definition: no shortcut fallback
        }
      }
    }
  }
  if (dest === null) {
    // Shortcut or collapsed reference: the label follows the nolink
    // pattern, which scans differently (no nesting, plain backticks).
    const nl = scanNolinkLabel(s, openIdx);
    if (nl) {
      const ref = refs.get(normalizeLabel(nl.label));
      if (ref) {
        text = nl.label;
        dest = ref.href;
        title = ref.title;
        end = nl.end;
        if (s[end] === '[' && s[end + 1] === ']') end += 2;
      }
    }
  }
  if (dest === null) return null;
  if (labelCrossesTag(s, text, openIdx + 1)) return null;
  const savedInLink = state.inLink;
  const savedEmitted = state.linkEmitted;
  state.inLink = true;
  state.linkEmitted = false;
  const kids = parseInline(text, refs, state);
  const innerEmitted = state.linkEmitted;
  state.inLink = savedInLink;
  state.linkEmitted = savedEmitted;
  if (!isImage) {
    if (innerEmitted) return null;
    state.linkEmitted = true;
  }
  return { node: { k: isImage ? 'img' : 'link', href: dest, title, kids }, end };
}

function parseInline(s, refs, state) {
  const masked = buildMask(s, refs);
  const bounds = lastCloserBounds(masked);
  const nodes = [];
  const n = s.length;
  let buf = '';
  // prevChar bookkeeping mirroring the reference tokenizer: the value is
  // the last character of the most recent plain-text chunk, except that a
  // chunk ending in '_' leaves the previous value in place, and any
  // non-text token clears it.
  let emPrev = '';
  let prevChunkR = '';
  let emPrevValid = false;
  let chunkStart = 0;
  let i = 0;

  const flushText = () => {
    if (buf !== '') {
      nodes.push({ k: 't', s: buf });
      buf = '';
      chunkStart = 0;
    }
  };
  const computeR = () => {
    const chunk = buf.slice(chunkStart);
    if (chunk === '') return emPrevValid ? emPrev : '';
    const last = chunk[chunk.length - 1];
    return last === '_' ? prevChunkR : last;
  };
  const endChunk = () => {
    const r = computeR();
    emPrev = r;
    prevChunkR = r;
    emPrevValid = true;
  };
  const noteNonText = () => {
    emPrev = '';
    prevChunkR = '';
    emPrevValid = false;
  };
  const emitNode = (node) => {
    flushText();
    nodes.push(node);
    noteNonText();
  };

  while (i < n) {
    const c = s[i];
    if (c === '\\') {
      const d = s[i + 1];
      if (d === '\n') {
        flushText();
        nodes.push({ k: 'br' });
        noteNonText();
        i += 2;
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
      } else if (d !== undefined && isAsciiPunct(d)) {
        endChunk();
        flushText();
        noteNonText();
        buf += d;
        if (d === '&') buf += '\u0001'; // sentinel: not an entity start
        chunkStart = 0;
        i += 2;
      } else {
        buf += '\\';
        i += 1;
      }
      continue;
    }
    if (c === '<') {
      const m = matchAngle(s, i);
      if (m) {
        // An <a ...> start tag switches the lexer-wide in-link state on
        // (and </a> off) for everything tokenized afterwards in the
        // document; while it is on, bare-URL autolinking is suppressed.
        if (m.node.k === 'html') {
          if (state.inLink) {
            if (/^<\/a>/i.test(m.node.s)) state.inLink = false;
          } else if (/^<a /i.test(m.node.s)) {
            state.inLink = true;
          }
        }
        emitNode(m.node);
        i = m.end;
      } else {
        buf += '<';
        i++;
      }
      continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      const r = tryLinkConstruct(s, i, refs, state, true);
      if (r) {
        emitNode(r.node);
        i = r.end;
      } else {
        buf += '!';
        i++;
      }
      continue;
    }
    if (c === '[') {
      const r = tryLinkConstruct(s, i, refs, state, false);
      if (r) {
        emitNode(r.node);
        i = r.end;
      } else {
        buf += '[';
        i++;
      }
      continue;
    }
    if (c === '*' || c === '_') {
      const prevChar = computeR();
      const hit = scanEmStrong(s, masked, bounds, i, prevChar);
      if (hit) {
        const kids = parseInline(s.slice(hit.contentStart, hit.contentEnd), refs, state);
        emitNode({ k: hit.kind, kids });
        i = hit.end;
      } else {
        // A failed opener retries from the second character of the run:
        // the reference text scanner consumes one character and the rest
        // of the run is attempted again as a shorter opener.
        endChunk();
        chunkStart = buf.length;
        buf += c;
        i++;
      }
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      const close = findCodeSpanClose(s, j, j - i);
      if (!close) {
        buf += s.slice(i, j);
        i = j;
      } else {
        let content = s.slice(j, close.start).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' &&
            content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        emitNode({ k: 'code', s: content });
        i = close.end;
      }
      continue;
    }
    if (c === '~') {
      const prevChar = computeR();
      const hit = scanDel(s, masked, bounds, i, prevChar);
      if (hit) {
        const kids = parseInline(s.slice(hit.contentStart, hit.contentEnd), refs, state);
        emitNode({ k: 'del', kids });
        i = hit.end;
      } else {
        endChunk();
        chunkStart = buf.length;
        let j = i;
        while (j < n && s[j] === '~') j++;
        buf += s.slice(i, j);
        i = j;
      }
      continue;
    }
    if (c === '&') {
      const num = numericEntityAt(s, i);
      if (num) {
        buf += num.ch;
        i += num.len;
        continue;
      }
      const named = namedEntityAt(s, i);
      if (named) {
        buf += named;
        i += named.length;
        continue;
      }
      buf += '&';
      i++;
      continue;
    }
    if (c === '\n') {
      let sp = 0;
      while (sp < buf.length && buf[buf.length - 1 - sp] === ' ') sp++;
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flushText();
        nodes.push({ k: 'br' });
        noteNonText();
        i++;
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
      } else {
        buf += '\n';
        i++;
      }
      continue;
    }
    if (!state.inLink &&
        (c === 'w' || c === 'W' || c === 'h' || c === 'H' || c === 'f' || c === 'F' ||
         c === 'm' || c === 'M' || c === 'x' || c === 'X' ||
         (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) {
      const m = matchExtendedAutolink(s, i);
      if (m) {
        emitNode({ k: 'link', href: m.href, title: null, kids: [{ k: 't', s: m.text }] });
        i = m.end;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flushText();
  return nodes;
}

function renderKids(kids) {
  let out = '';
  for (const node of kids) out += renderInlineNode(node);
  return out;
}

function plainTextOf(kids) {
  let out = '';
  for (const node of kids) {
    if (node.k === 't' || node.k === 'code') out += node.s;
    else if (node.kids) out += plainTextOf(node.kids);
  }
  return out;
}

function renderInlineNode(node) {
  switch (node.k) {
    case 't': return escapeText(node.s);
    case 'code': return '<code>' + escapeCode(node.s) + '</code>';
    case 'html': return node.s;
    case 'br': return '<br>';
    case 'em': return '<em>' + renderKids(node.kids) + '</em>';
    case 'strong': return '<strong>' + renderKids(node.kids) + '</strong>';
    case 'del': return '<del>' + renderKids(node.kids) + '</del>';
    case 'link': {
      let out = '<a href="' + escapeAttr(cleanUrl(node.href)) + '"';
      if (node.title !== null && node.title !== undefined) out += ' title="' + escapeAttr(node.title) + '"';
      return out + '>' + renderKids(node.kids) + '</a>';
    }
    case 'img': {
      let out = '<img src="' + escapeAttr(cleanUrl(node.href)) + '" alt="' + escapeAttr(plainTextOf(node.kids)) + '"';
      if (node.title !== null && node.title !== undefined) out += ' title="' + escapeAttr(node.title) + '"';
      return out + '>';
    }
    default: return '';
  }
}

function renderInline(s, refs) {
  if (!s) return '';
  const nodes = parseInline(s, refs, currentInlineState);
  let out = '';
  for (const node of nodes) out += renderInlineNode(node);
  return out;
}

/* ------------------------------------------------------------------ *
 * Block parsing
 *
 * A container-stack parser over source lines. Each line is processed
 * against a column-aware cursor ({ s, i, col, pad }), where `col` is
 * the visual column and `pad` is the number of spaces still owed by a
 * partially consumed tab.
 * ------------------------------------------------------------------ */

function peekIndent(cur) {
  let i = cur.i;
  let col = cur.col;
  let cols = 0;
  if (cur.pad > 0) {
    cols += cur.pad;
    col += cur.pad;
  }
  const s = cur.s;
  while (i < s.length) {
    if (s[i] === ' ') {
      i++;
      col++;
      cols++;
    } else if (s[i] === '\t') {
      const w = 4 - (col % 4);
      i++;
      col += w;
      cols += w;
    } else {
      break;
    }
  }
  return { cols, i, col };
}

function advCols(cur, n) {
  const s = cur.s;
  while (n > 0) {
    if (cur.pad > 0) {
      const take = Math.min(cur.pad, n);
      cur.pad -= take;
      cur.col += take;
      n -= take;
    } else if (cur.i < s.length && s[cur.i] === ' ') {
      cur.i++;
      cur.col++;
      n--;
    } else if (cur.i < s.length && s[cur.i] === '\t') {
      const w = 4 - (cur.col % 4);
      if (w <= n) {
        cur.i++;
        cur.col += w;
        n -= w;
      } else {
        cur.i++;
        cur.pad = w - n;
        cur.col += n;
        n = 0;
      }
    } else {
      break;
    }
  }
}

function curRest(cur) {
  return cur.pad > 0 ? ' '.repeat(cur.pad) + cur.s.slice(cur.i) : cur.s.slice(cur.i);
}

function isBlankCur(cur) {
  return peekIndent(cur).i >= cur.s.length;
}

function applyCur(cur, state) {
  cur.i = state.i;
  cur.col = state.col;
  cur.pad = state.pad;
}

function tryQuoteStart(cur) {
  const p = peekIndent(cur);
  if (p.cols > 3 || cur.s[p.i] !== '>') return null;
  const nc = { s: cur.s, i: p.i + 1, col: p.col + 1, pad: 0 };
  // The reference blockquote tokenizer expands tabs in the whitespace
  // run after the '>' marker (tab stops counted from the marker's
  // frame-relative length) and then strips the marker plus one
  // whitespace character. Mirror that: measure the run's expanded
  // width, consume the whole run, and leave the expansion minus one
  // character as padding.
  let j = nc.i;
  let ecol = p.cols + 1;
  let expanded = 0;
  while (j < nc.s.length && (nc.s[j] === ' ' || nc.s[j] === '\t')) {
    if (nc.s[j] === ' ') {
      expanded++;
      ecol++;
    } else {
      const w = 4 - (ecol % 4);
      expanded += w;
      ecol += w;
    }
    j++;
  }
  if (expanded > 0) {
    nc.i = j;
    nc.pad = expanded - 1;
    nc.col = p.col + 1 + expanded - 1;
  }
  return { cur: nc };
}

function tryAtx(cur) {
  const p = peekIndent(cur);
  if (p.cols > 3) return null;
  const s = cur.s;
  let i = p.i;
  if (s[i] !== '#') return null;
  let level = 0;
  while (i < s.length && s[i] === '#') {
    level++;
    i++;
  }
  if (level > 6) return null;
  if (i < s.length && s[i] !== ' ' && s[i] !== '\t') return null;
  let rest = s.slice(i).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  const m = /[ \t](#+)$/.exec(rest);
  if (m) rest = rest.slice(0, m.index).replace(/[ \t]+$/, '');
  else if (/^#+$/.test(rest)) rest = '';
  return { level, content: rest };
}

function tryFenceStart(cur) {
  const p = peekIndent(cur);
  if (p.cols > 3) return null;
  const s = cur.s;
  const ch = s[p.i];
  if (ch !== '`' && ch !== '~') return null;
  let j = p.i;
  while (j < s.length && s[j] === ch) j++;
  const len = j - p.i;
  if (len < 3) return null;
  const info = s.slice(j).trim();
  if (ch === '`' && info.includes('`')) return null;
  return { char: ch, len, indent: p.cols, info };
}

function tryThematicBreak(cur) {
  const p = peekIndent(cur);
  if (p.cols > 3) return null;
  const s = cur.s;
  let ch = null;
  let count = 0;
  for (let i = p.i; i < s.length; i++) {
    const c = s[i];
    if (c === ' ' || c === '\t') continue;
    if (c !== '-' && c !== '*' && c !== '_') return null;
    if (ch === null) ch = c;
    else if (c !== ch) return null;
    count++;
  }
  return count >= 3 ? { ok: true } : null;
}

const HTML_TYPE1_TAGS = new Set(['pre', 'script', 'style', 'textarea']);
const HTML_TYPE6_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Begin-of-block tests the reference list gatherer applies, with an
// indent allowance of n plain spaces before the construct: a fence,
// heading, HTML block, or thematic break (and, for a candidate next
// line, also a blockquote or a list bullet). cols is the line's first
// non-space column and rest the line from that column on.
function htmlBeginAt(rest) {
  if (/^<(?:script|pre|style|textarea)(?:[\s>]|$)/i.test(rest)) return true;
  if (rest.startsWith('<!--') || rest.startsWith('<?') || rest.startsWith('<![CDATA[')) return true;
  if (/^<![A-Za-z]/.test(rest)) return true;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?: +|$|\/?>)/.exec(rest);
  return !!m && HTML_TYPE6_TAGS.has(m[1].toLowerCase());
}
function beginBlockAt(cols, rest, n, forPrev) {
  if (cols > n) return false;
  if (rest.startsWith('```') || rest.startsWith('~~~')) return true;
  if (/^#{1,6}(?:[ \t]|$)/.test(rest)) return true;
  if (/^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/.test(rest)) return true;
  if (htmlBeginAt(rest)) return true;
  if (!forPrev) {
    if (rest[0] === '>') return true;
    if (/^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(rest)) return true;
  }
  return false;
}

// A fence content line as the reference computes it: for backtick
// fences only, strip up to the opener's leading-whitespace character
// count of whitespace characters from the line (a tab counts as one
// character, not as a tab stop); tilde fences keep content untouched.
function fenceContentLine(text, leaf) {
  if (leaf.char !== '`') return text;
  let k = leaf.indentChars || 0;
  let i = 0;
  while (k > 0 && i < text.length && (text[i] === ' ' || text[i] === '\t')) { i++; k--; }
  return text.slice(i);
}

function tryHtmlBlockStart(cur, allow7) {
  const p = peekIndent(cur);
  if (p.cols > 3) return null;
  const rest = cur.s.slice(p.i);
  if (rest[0] !== '<') return null;
  let m = /^<(pre|script|style|textarea)(?=[ \t>]|\/>|$)/i.exec(rest);
  if (m) return { kind: 1, endMarker: '</' + m[1].toLowerCase() };
  if (rest.startsWith('<![CDATA[')) return { kind: 5, endMarker: ']]>' };
  if (rest.startsWith('<!--')) return { kind: 2, endMarker: '-->' };
  if (rest.startsWith('<?')) return { kind: 3, endMarker: '?>' };
  if (/^<![A-Z]/.test(rest)) return { kind: 4, endMarker: '>' };
  m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[ \t>]|\/>|$)/.exec(rest);
  if (m && HTML_TYPE6_TAGS.has(m[1].toLowerCase())) return { kind: 6, endMarker: null };
  if (allow7) {
    const tag = HTML_OPEN_TAG_RE.exec(rest) || HTML_CLOSE_TAG_RE.exec(rest);
    if (tag) {
      // Type 7: the line must consist of that one complete tag alone
      // (plus trailing whitespace).
      if (/^[ \t]*$/.test(rest.slice(tag[0].length))) {
        return { kind: 7, endMarker: null };
      }
    }
  }
  return null;
}

// Whether a line ends a GFM table's body rows (the line itself is then
// reprocessed as a new block). Mirrors the stop set in the reference
// table pattern: spaces-only lines, thematic breaks, ATX headings,
// blockquote starts, indented-code starts, fence starts, list starts
// (ordered lists only with the number 1), and HTML block starts of
// kinds 1-6. A whitespace-only line containing a tab is NOT a stop:
// it becomes a row of empty cells.
function tableRowStops(cur) {
  const rest = curRest(cur);
  if (/^ *$/.test(rest)) return true;
  if (tryThematicBreak(cur)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(rest)) return true;
  if (/^ {0,3}>/.test(rest)) return true;
  const p = peekIndent(cur);
  if (p.cols >= 4 && rest.trim() !== '') return true;
  if (tryFenceStart(cur)) return true;
  if (/^ {0,3}(?:[*+-]|1[.)])[ \t]/.test(rest)) return true;
  if (tryHtmlBlockStart(cur, false)) return true;
  return false;
}

function tryListItemStart(cur) {
  const p = peekIndent(cur);
  if (p.cols > 3) return null;
  const s = cur.s;
  let i = p.i;
  let ordered = false;
  let bullet = null;
  let delim = null;
  let num = null;
  const c = s[i];
  if (c === '*' || c === '-' || c === '+') {
    bullet = c;
    i++;
  } else if (c >= '0' && c <= '9') {
    let j = i;
    while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
    if (j - i > 9) return null;
    if (s[j] !== '.' && s[j] !== ')') return null;
    ordered = true;
    delim = s[j];
    num = parseInt(s.slice(i, j), 10);
    i = j + 1;
  } else {
    return null;
  }
  if (i < s.length && s[i] !== ' ' && s[i] !== '\t') return null;
  const markerWidth = i - p.i;
  const afterMarker = { s, i, col: p.col + markerWidth, pad: 0 };
  const bp = peekIndent(afterMarker);
  let contentIndent;
  const nc = { s, i, col: p.col + markerWidth, pad: 0 };
  if (bp.i >= s.length) {
    contentIndent = markerWidth + 1;
  } else if (bp.cols >= 5) {
    contentIndent = markerWidth + 1;
    applyCur(nc, afterMarker);
    advCols(nc, 1);
  } else {
    contentIndent = markerWidth + bp.cols;
    nc.i = bp.i;
    nc.col = bp.col;
    nc.pad = 0;
  }
  return {
    ordered,
    bullet,
    delim,
    num,
    contentCol: p.col + contentIndent,
    blankContent: bp.i >= s.length,
    cur: nc,
  };
}

function sameListType(list, li) {
  if (list.ordered !== li.ordered) return false;
  return list.ordered ? list.delim === li.delim : list.bullet === li.bullet;
}

/* ------------------------- tables ------------------------- */

function splitTableRow(line) {
  const cells = [];
  let cell = '';
  const n = line.length;
  let i = 0;
  while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
  if (line[i] === '|') i++;
  for (; i < n; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      cell += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += ch;
  }
  cells.push(cell);
  // A trailing unescaped pipe produces a phantom final cell; drop it.
  if (cells.length > 1) {
    const tail = line.replace(/[ \t]+$/, '');
    if (tail.endsWith('|')) {
      let backslashes = 0;
      for (let k = tail.length - 2; k >= 0 && tail[k] === '\\'; k--) backslashes++;
      if (backslashes % 2 === 0 && cells[cells.length - 1].trim() === '') cells.pop();
    }
  }
  return cells.map((c) => c.trim());
}

function parseDelimiterRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const parts = s.split('|');
  const aligns = [];
  for (const part of parts) {
    const t = part.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    if (t.startsWith(':') && t.endsWith(':')) aligns.push('center');
    else if (t.endsWith(':')) aligns.push('right');
    else if (t.startsWith(':')) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

/* ------------------- link reference definitions ------------------- */

function skipDefWs(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  return i;
}

// Parse one link reference definition at the start of s.
// Returns { label, href, title, consumed } or null.
function parseLinkDef(s) {
  const n = s.length;
  let i = 0;
  let col = 0;
  while (i < n && (s[i] === ' ' || s[i] === '\t')) {
    col = s[i] === ' ' ? col + 1 : col + (4 - (col % 4));
    i++;
    if (col > 3) return null;
  }
  if (s[i] !== '[') return null;
  const lab = parseLinkLabel(s, i);
  if (!lab || lab.label === '') return null;
  i = lab.end;
  if (s[i] !== ':') return null;
  i++;
  i = skipDefWs(s, i);
  let href;
  if (s[i] === '<') {
    let j = i + 1;
    let ok = false;
    while (j < n) {
      const ch = s[j];
      if (ch === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { j += 2; continue; }
      if (ch === '>') { ok = true; break; }
      if (ch === '<' || ch === '\n') break;
      j++;
    }
    if (!ok) return null;
    href = unescapeBackslash(s.slice(i + 1, j));
    i = j + 1;
  } else {
    const start = i;
    let depth = 0;
    while (i < n) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < n && isAsciiPunct(s[i + 1])) { i += 2; continue; }
      if (ch === '(') { depth++; i++; continue; }
      if (ch === ')') {
        if (depth === 0) return null; // unbalanced parens: not a definition
        depth--;
        i++;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\n') break;
      i++;
    }
    if (i === start || depth !== 0) return null;
    href = unescapeBackslash(s.slice(start, i));
  }
  const afterDest = i;
  // Optional title, possibly on the next line. If the title is malformed or
  // followed by other text on its line, the definition still stands without
  // a title, ending at the destination's own line.
  let j = afterDest;
  while (j < n && (s[j] === ' ' || s[j] === '\t')) j++;
  if (s[j] === '\n') {
    j++;
    while (j < n && (s[j] === ' ' || s[j] === '\t')) j++;
  }
  if (j < n && j > afterDest && (s[j] === '"' || s[j] === "'" || s[j] === '(')) {
    const t = parseLinkTitle(s, j);
    if (t) {
      let k = t.end;
      while (k < n && (s[k] === ' ' || s[k] === '\t')) k++;
      if (k >= n || s[k] === '\n') return { label: lab.label, href, title: t.title, consumed: k };
    }
  }
  let k = afterDest;
  while (k < n && (s[k] === ' ' || s[k] === '\t')) k++;
  if (k >= n) return { label: lab.label, href, title: null, consumed: k };
  if (s[k] === '\n') return { label: lab.label, href, title: null, consumed: k };
  return null;
}

function extractLinkDefs(content, refs) {
  let rest = content;
  while (rest.length) {
    const d = parseLinkDef(rest);
    if (!d) break;
    const key = normalizeLabel(d.label);
    // A whitespace-only label is not a valid definition; leave the text.
    if (key === '') break;
    if (!refs.has(key)) refs.set(key, { href: d.href, title: d.title });
    rest = rest.slice(d.consumed);
    if (rest.startsWith('\n')) rest = rest.slice(1);
    else if (rest !== '') break;
  }
  return rest;
}

/* ------------------------------------------------------------------ *
 * parse(markdown) -> html string
 * ------------------------------------------------------------------ */

export function parse(markdown) {
  const refs = new Map();
  const doc = { type: 'doc', children: [], parent: null };
  const openBlocks = [doc];
  // The most recently closed HTML block whose trailing newline has not yet
  // been decided: a following blank line removes it, anything else keeps it.
  let pendingHtml = null;
  // A whitespace-only line (with at least one space/tab of content) seen
  // while a paragraph directly under the document or a blockquote is open.
  // The reference lexer's paragraph pattern only treats such a line as a
  // separator when another line follows it in the same frame, so the
  // decision is deferred: if the frame continues, the paragraph closes
  // without it; if the frame ends (or input ends), it is absorbed as the
  // paragraph's last line.
  let pendingWsPara = null;
  let pendingWsText = '';
  // Whether the line currently being processed is blank (post-matching).
  let curLineBlank = false;

  function addBlock(parent, b) {
    if (parent.type === 'item') {
      if (parent.children.length > 0 && parent._sawBlank) parent.blankBetween = true;
      parent._sawBlank = false;
    }
    parent.children.push(b);
    b.parent = parent;
    if (b.type !== 'heading' && b.type !== 'hr') openBlocks.push(b);
  }

  function removeFromParent(b) {
    const idx = b.parent.children.indexOf(b);
    if (idx >= 0) b.parent.children.splice(idx, 1);
  }

  function finalizeBlock(b) {
    if (b.type === 'para') {
      b.content = extractLinkDefs(b.content, refs);
      if (b.content === '') removeFromParent(b);
    } else if (b.type === 'code') {
      while (b.lines.length && b.lines[b.lines.length - 1] === '') b.lines.pop();
    } else if (b.type === 'list') {
      let loose = false;
      b.children.forEach((item, idx) => {
        if (item.blankBetween) loose = true;
        if (item._endsBlank && idx < b.children.length - 1) loose = true;
      });
      b.tight = !loose;
      // The reference list tokenizer's capture trims trailing
      // whitespace from the last item's text; the item's terminal
      // block (a paragraph, or an indented code block) inherits it.
      const lastItem = b.children[b.children.length - 1];
      if (lastItem) {
        let term = lastItem;
        while (term.children && term.children.length) {
          term = term.children[term.children.length - 1];
        }
        if (term.type === 'para') {
          term.content = term.content.replace(/[ \t\n]+$/, '');
        } else if (term.type === 'code') {
          while (term.lines.length && /^[ \t]*$/.test(term.lines[term.lines.length - 1])) {
            term.lines.pop();
          }
          if (term.lines.length) {
            const li = term.lines.length - 1;
            term.lines[li] = term.lines[li].replace(/[ \t]+$/, '');
          }
        }
      }
    }
  }

  function closeBlocksFrom(idx) {
    for (let j = openBlocks.length - 1; j >= idx; j--) {
      const b = openBlocks[j];
      // An HTML block that ends because its container's text ended (rather
      // than at its own end marker) loses its trailing newline, as does one
      // terminated by the blank line currently being processed.
      if (b.type === 'html' && !b._markerClosed && (b.parent !== doc || curLineBlank)) {
        b.trailingNl = false;
      }
      finalizeBlock(b);
    }
    openBlocks.length = idx;
  }

  function startsInterruptingBlock(cur) {
    if (tryQuoteStart(cur)) return true;
    if (tryAtx(cur)) return true;
    if (tryFenceStart(cur)) return true;
    if (tryHtmlBlockStart(cur, false)) return true;
    if (tryThematicBreak(cur)) return true;
    const li = tryListItemStart(cur);
    if (li) {
      if (li.blankContent) return false;
      if (li.ordered && li.num !== 1) return false;
      return true;
    }
    return false;
  }

  // Handle a line whose leaf is an open paragraph. Returns 'done' when the
  // line was consumed, or 'reprocess' when the paragraph was closed and the
  // line must go through block starts.
  function paraLine(para, cur) {
    // Inside a list item, a continuation line indented by 4+ columns (in the
    // item's frame) is merged into the paragraph text with four columns
    // stripped, like an indented code chunk absorbed by a text token; it
    // cannot form a table, heading, or other block.
    if (para.parent && para.parent.type === 'item' && peekIndent(cur).cols >= 4) {
      advCols(cur, 4);
      para.content += '\n' + curRest(cur);
      para._lastLazy = false;
      para._lazyCode = false;
      return 'done';
    }
    const rest = curRest(cur);
    if (rest.includes('|') || rest.includes(':')) {
      const aligns = parseDelimiterRow(rest);
      if (aligns) {
        const extracted = extractLinkDefs(para.content, refs);
        if (extracted === '') {
          closeBlocksFrom(openBlocks.length - 1);
          return 'reprocess';
        }
        const lines = extracted.split('\n');
        const header = splitTableRow(lines[lines.length - 1]);
        if (header.length === aligns.length) {
          const remaining = lines.slice(0, -1).join('\n');
          const table = { type: 'table', header, aligns, rows: [], parent: para.parent };
          if (remaining === '') {
            const idx = para.parent.children.indexOf(para);
            para.parent.children[idx] = table;
            openBlocks[openBlocks.length - 1] = table;
          } else {
            para.content = remaining;
            const idx = para.parent.children.indexOf(para);
            para.parent.children.splice(idx + 1, 0, table);
            openBlocks[openBlocks.length - 1] = table;
          }
          return 'done';
        }
      }
    }
    const setext = /^[ \t]{0,3}(=+|-+)[ \t]*$/.exec(rest);
    if (setext) {
      const extracted = extractLinkDefs(para.content, refs);
      if (extracted === '') {
        closeBlocksFrom(openBlocks.length - 1);
        return 'reprocess';
      }
      const heading = {
        type: 'heading',
        level: setext[1][0] === '=' ? 1 : 2,
        content: extracted.trim(),
        parent: para.parent,
      };
      const idx = para.parent.children.indexOf(para);
      para.parent.children[idx] = heading;
      openBlocks.pop();
      return 'done';
    }
    if (startsInterruptingBlock(cur) ||
        (para.parent && para.parent.type === 'item' && isListItemStart(cur))) {
      closeBlocksFrom(openBlocks.length - 1);
      return 'reprocess';
    }
    para.content += '\n' + rest;
    para._lastLazy = false;
    para._lazyCode = false;
    return 'done';
  }

  // Any list item start with non-blank content. Inside a list item (or as a
  // would-be sibling), such a line begins a list rather than continuing a
  // paragraph, even when an ordered list does not start at 1.
  function isListItemStart(cur) {
    const li = tryListItemStart(cur);
    return !!li && !li.blankContent;
  }

  function blockStartLoop(cur) {
    while (true) {
      const container = openBlocks[openBlocks.length - 1];
      if (isBlankCur(cur)) return;
      const inList = container.type === 'list';
      const q = tryQuoteStart(cur);
      if (q) {
        if (inList) { closeBlocksFrom(openBlocks.length - 1); continue; }
        addBlock(container, { type: 'quote', children: [] });
        applyCur(cur, q.cur);
        continue;
      }
      const atx = tryAtx(cur);
      if (atx) {
        if (inList) { closeBlocksFrom(openBlocks.length - 1); continue; }
        addBlock(container, { type: 'heading', level: atx.level, content: atx.content });
        return;
      }
      const fence = tryFenceStart(cur);
      if (fence) {
        if (inList) { closeBlocksFrom(openBlocks.length - 1); continue; }
        const frameLine = curRest(cur);
        addBlock(container, { type: 'fence', char: fence.char, len: fence.len, indent: fence.indent, info: fence.info, lines: [], _lastRaw: frameLine, indentChars: /^[ \t]*/.exec(frameLine)[0].length });
        return;
      }
      const html = tryHtmlBlockStart(cur, true);
      if (html) {
        if (inList) { closeBlocksFrom(openBlocks.length - 1); continue; }
        const b = { type: 'html', kind: html.kind, endMarker: html.endMarker, lines: [curRest(cur)], trailingNl: true };
        addBlock(container, b);
        if (html.endMarker && b.lines[0].toLowerCase().includes(html.endMarker)) {
          b._markerClosed = true;
          closeBlocksFrom(openBlocks.length - 1);
          pendingHtml = b;
        }
        return;
      }
      if (tryThematicBreak(cur)) {
        if (inList) { closeBlocksFrom(openBlocks.length - 1); continue; }
        addBlock(container, { type: 'hr' });
        return;
      }
      const frameCol = cur.col;
      const li = tryListItemStart(cur);
      if (li) {
        let listBlock;
        if (inList && sameListType(container, li)) {
          listBlock = container;
        } else {
          if (inList) { closeBlocksFrom(openBlocks.length - 1); continue; }
          listBlock = { type: 'list', children: [], ordered: li.ordered, bullet: li.bullet, delim: li.delim, start: li.num, tight: true };
          addBlock(container, listBlock);
        }
        addBlock(listBlock, {
          type: 'item', children: [], relIndent: li.contentCol - frameCol,
          _endsBlank: false, _sawBlank: false, blankBetween: false,
          _blankStart: li.blankContent,
        });
        applyCur(cur, li.cur);
        if (isBlankCur(cur)) return;
        continue;
      }
      const p = peekIndent(cur);
      if (p.cols >= 4) {
        if (inList) { closeBlocksFrom(openBlocks.length - 1); continue; }
        const b = { type: 'code', lines: [] };
        addBlock(container, b);
        advCols(cur, 4);
        b.lines.push(curRest(cur));
        return;
      }
      if (inList) { closeBlocksFrom(openBlocks.length - 1); continue; }
      addBlock(container, { type: 'para', content: curRest(cur) });
      return;
    }
  }

  function processLine(rawLine) {
    const cur = { s: rawLine, i: 0, col: 0, pad: 0 };
    // Phase 1: match open containers. matchEnd[k] is the source index just
    // after openBlocks[k] matched on this line.
    const matchEnd = [];
    let itemMatched = false;
    let mi = 1;
    let failed = false;
    while (mi < openBlocks.length) {
      const b = openBlocks[mi];
      if (b.type === 'quote') {
        const q = tryQuoteStart(cur);
        if (q) {
          applyCur(cur, q.cur);
          matchEnd[mi] = cur.i;
          mi++;
        } else {
          failed = true;
          break;
        }
      } else if (b.type === 'item') {
        if (isBlankCur(cur)) {
          // An item whose first line was blank ends at a second blank line
          // before any content: the blank is not part of the item, but the
          // item still counts as blank-terminated for looseness.
          if (b._blankStart && b.children.length === 0) {
            b._endsBlank = true;
            failed = true;
            break;
          }
          matchEnd[mi] = cur.i;
          mi++;
        } else {
          const p = peekIndent(cur);
          if (p.cols >= b.relIndent) {
            advCols(cur, b.relIndent);
            matchEnd[mi] = cur.i;
            itemMatched = true;
            mi++;
          } else {
            failed = true;
            break;
          }
        }
      } else if (b.type === 'list') {
        mi++;
      } else {
        break; // leaf block
      }
    }
    // Item text is assembled from tab-expanded lines: when an item match
    // ends exactly at a tab, that tab becomes its expansion spaces in the
    // item's frame.
    if (itemMatched && cur.pad === 0 && cur.s[cur.i] === '\t' &&
        openBlocks[mi - 1].type !== 'quote') {
      cur.pad = 4 - (cur.col % 4);
      cur.i++;
    }
    const blank = isBlankCur(cur);
    curLineBlank = blank;
    // Resolve the pending HTML block's trailing newline with this line:
    // the reference's trailing group swallows only further newlines, so
    // an empty line here strips the newline, while a whitespace-only
    // line (never part of the raw) leaves it in place.
    if (pendingHtml) {
      if (curRest(cur).length === 0) pendingHtml.trailingNl = false;
      pendingHtml = null;
    }
    // Resolve a deferred whitespace-only line for an open paragraph.
    if (pendingWsPara) {
      const pIdx = openBlocks.indexOf(pendingWsPara);
      if (pIdx === -1) {
        pendingWsPara = null;
      } else if (!failed || mi >= pIdx) {
        // The frame continued: the line was a plain separator.
        closeBlocksFrom(pIdx);
        pendingWsPara = null;
      } else {
        // The frame ended: absorb the whitespace line into the paragraph.
        pendingWsPara.content += '\n' + pendingWsText;
        pendingWsPara = null;
      }
    }
    const leafIdx = openBlocks.length - 1;
    const leaf = openBlocks[leafIdx];
    const leafReachable = !failed && mi === leafIdx && leaf && leaf.type !== 'doc' &&
      leaf.type !== 'quote' && leaf.type !== 'list' && leaf.type !== 'item';
    // A fence leaf inside a list item: the reference lexer assembles the
    // item's raw text line by line, and a line that misses the item's
    // indent still joins the item (becoming fence content) only as a
    // lazy continuation — never when the line itself begins a new block
    // within the gatherer's small indent allowance, when the previously
    // gathered line begins a fence, heading, HTML block, or rule or
    // starts at column 4 or beyond, or after a blank line. (A blockquote
    // boundary does end a fence: its lines must carry the quote marker.)
    // A lazy line keeps its raw text; the fence's own indent is stripped
    // as far as the line offers it.
    let fenceRescue = false;
    if (failed && !blank && leaf && leaf.type === 'fence' &&
        openBlocks[mi] && openBlocks[mi].type === 'item') {
      let quoteBetween = false;
      for (let k = mi + 1; k < openBlocks.length; k++) {
        if (openBlocks[k].type === 'quote') { quoteBetween = true; break; }
      }
      if (!quoteBetween) {
        const item = openBlocks[mi];
        const n = Math.max(0, Math.min(3, item.relIndent - 1));
        const p = peekIndent(cur);
        const m = leaf._lastRaw ?? '';
        const mCol = m.search(/[^ ]/);
        if (!beginBlockAt(p.cols, cur.s.slice(p.i), n, false) &&
            mCol >= 0 && mCol < 4 &&
            !beginBlockAt(mCol, m.slice(mCol), n, true)) {
          fenceRescue = true;
        }
      }
    }

    let needBlockStart = false;
    if (leafReachable || fenceRescue) {
      if (blank && leaf.type === 'para' &&
          (leaf.parent.type === 'doc' || leaf.parent.type === 'quote') &&
          curRest(cur).length > 0) {
        // Defer: the whitespace line may still be absorbed (see above).
        pendingWsPara = leaf;
        pendingWsText = curRest(cur);
        needBlockStart = true;
      } else if (blank && (leaf.type === 'para' ||
          (leaf.type === 'table' && /^ *$/.test(curRest(cur))) ||
          (leaf.type === 'html' && leaf.endMarker === null))) {
        if (leaf.type === 'html') leaf.trailingNl = false;
        closeBlocksFrom(leafIdx);
        needBlockStart = true;
      } else if (leaf.type === 'fence') {
        const p = peekIndent(cur);
        let closed = false;
        if (p.cols <= 3) {
          const rest = cur.s.slice(p.i);
          if (rest[0] === leaf.char) {
            let run = 0;
            while (rest[run] === leaf.char) run++;
            if (run >= leaf.len && /^[ \t]*$/.test(rest.slice(run))) closed = true;
          }
        }
        if (closed) {
          closeBlocksFrom(leafIdx);
        } else if (fenceRescue) {
          leaf.lines.push(fenceContentLine(curRest(cur), leaf));
          leaf._lastRaw = leaf.lines[leaf.lines.length - 1];
        } else {
          leaf._lastRaw = curRest(cur);
          leaf.lines.push(fenceContentLine(curRest(cur), leaf));
        }
      } else if (leaf.type === 'code') {
        const p = peekIndent(cur);
        if (p.cols >= 4) {
          advCols(cur, 4);
          leaf.lines.push(curRest(cur));
        } else if (p.i >= cur.s.length) {
          leaf.lines.push('');
        } else {
          closeBlocksFrom(leafIdx);
          needBlockStart = true;
        }
      } else if (leaf.type === 'html') {
        if (blank && !leaf.endMarker) {
          // Types 6 and 7 end at a blank line (the line is not content).
          closeBlocksFrom(leafIdx);
        } else {
          leaf.lines.push(curRest(cur));
          if (leaf.endMarker && curRest(cur).toLowerCase().includes(leaf.endMarker)) {
            leaf._markerClosed = true;
            closeBlocksFrom(leafIdx);
            pendingHtml = leaf;
          }
        }
      } else if (leaf.type === 'table') {
        if (tableRowStops(cur)) {
          closeBlocksFrom(leafIdx);
          needBlockStart = true;
        } else {
          const cells = splitTableRow(curRest(cur));
          while (cells.length < leaf.header.length) cells.push('');
          leaf.rows.push(cells.slice(0, leaf.header.length));
        }
      } else if (leaf.type === 'para') {
        if (paraLine(leaf, cur) === 'reprocess') needBlockStart = true;
      }
    } else {
      // Phase 2.5: lazy paragraph continuation. The reference renderer
      // re-lexes such lines in the failed containers' frame, which has two
      // visible effects reproduced here: a setext-shaped lazy line is
      // indented by four spaces (so it cannot form a heading), and — in
      // blockquote context — a lazy run that starts with a deeply indented
      // line is treated like an indented code chunk merged into the
      // paragraph, losing four columns of indent per line.
      let lazyOk = failed && !blank && leaf && leaf.type === 'para' &&
        !startsInterruptingBlock(cur) && !isListItemStart(cur);
      if (lazyOk) {
        // A blank-content item start is lazy text at document level, but it
        // ends the current item when it would be a sibling in an open list.
        const li = tryListItemStart(cur);
        if (li && li.blankContent) {
          for (let k = leafIdx - 1; k >= 1; k--) {
            if (openBlocks[k].type === 'list') {
              if (sameListType(openBlocks[k], li)) lazyOk = false;
              break;
            }
          }
        }
      }
      if (lazyOk) {
        let rest = curRest(cur);
        const failedTypes = [];
        for (let k = mi; k < openBlocks.length; k++) failedTypes.push(openBlocks[k].type);
        const lastItem = failedTypes.lastIndexOf('item');
        const lastQuote = failedTypes.lastIndexOf('quote');
        const listMode = lastItem > lastQuote;
        if (/^ {0,3}(=+|-+)[ \t]*$/.test(rest)) {
          if (listMode || leaf._lastLazy) rest = '    ' + rest.replace(/^ {0,3}/, '');
          leaf._lazyCode = false;
        } else if (listMode) {
          if (leaf.parent && leaf.parent.type === 'item' && peekIndent(cur).cols >= 4) {
            advCols(cur, 4);
            rest = curRest(cur);
          }
        } else {
          const p = peekIndent(cur);
          if (p.cols >= 4 && (leaf._lazyCode || !leaf._lastLazy)) {
            advCols(cur, 4);
            rest = curRest(cur);
            leaf._lazyCode = true;
          } else {
            leaf._lazyCode = false;
          }
        }
        leaf.content += '\n' + rest;
        leaf._lastLazy = true;
      } else {
        if (failed) closeBlocksFrom(mi);
        needBlockStart = true;
      }
    }
    if (needBlockStart && !blank) blockStartLoop(cur);
    // Item blank bookkeeping for the final open chain. A line counts as
    // blank for an item when nothing but whitespace follows that item's own
    // match point on the line (deeper container markers make it non-blank).
    for (let k = 0; k < openBlocks.length; k++) {
      const b = openBlocks[k];
      if (b.type === 'item') {
        const blankForItem = matchEnd[k] !== undefined &&
          /^[ \t]*$/.test(rawLine.slice(matchEnd[k]));
        if (blankForItem) {
          b._endsBlank = true;
          b._sawBlank = true;
        } else {
          b._endsBlank = false;
        }
      }
    }
  }

  const input = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const endsWithNl = input.endsWith('\n');
  const lines = input.split('\n');
  if (endsWithNl) lines.pop();
  if (input === '') lines.length = 0;
  for (const line of lines) processLine(line);
  if (pendingWsPara) {
    pendingWsPara.content += '\n' + pendingWsText;
    pendingWsPara = null;
  }
  if (!endsWithNl) {
    const leaf = openBlocks[openBlocks.length - 1];
    if (leaf && leaf.type === 'html') leaf.trailingNl = false;
    if (pendingHtml) pendingHtml.trailingNl = false;
  }
  closeBlocksFrom(1);
  currentRefs = refs;
  currentInlineState = { inLink: false, linkEmitted: false };
  const html = renderChildren(doc, false);
  currentRefs = null;
  currentInlineState = null;
  return html;
}

/* ------------------------- block rendering ------------------------- */

function renderChildren(block, tight) {
  let out = '';
  for (const child of block.children) out += renderBlock(child, tight);
  return out;
}

function renderBlock(b, tight) {
  switch (b.type) {
    case 'para': {
      const inner = renderInline(b.content, currentRefs);
      return tight ? inner : '<p>' + inner + '</p>\n';
    }
    case 'heading':
      return '<h' + b.level + '>' + renderInline(b.content, currentRefs) + '</h' + b.level + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'code': {
      const content = b.lines.length ? b.lines.join('\n') + '\n' : '';
      return '<pre><code>' + escapeCode(content) + '</code></pre>\n';
    }
    case 'fence': {
      const word = b.info ? unescapeBackslash(b.info).split(/\s+/)[0] : '';
      const cls = word ? ' class="language-' + escapeAttr(word) + '"' : '';
      let content = b.lines.join('\n');
      if (content !== '' && !content.endsWith('\n')) content += '\n';
      return '<pre><code' + cls + '>' + escapeCode(content) + '</code></pre>\n';
    }
    case 'html':
      return b.lines.join('\n') + (b.trailingNl && b.lines.length ? '\n' : '');
    case 'quote':
      return '<blockquote>\n' + renderChildren(b, false) + '</blockquote>\n';
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const start = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
      return '<' + tag + start + '>\n' + renderChildren(b, false) + '</' + tag + '>\n';
    }
    case 'item': {
      const list = b.parent;
      const isTight = list.tight;
      let out = '<li>';
      b.children.forEach((child, idx) => {
        if (idx === 0 && child.type === 'para') {
          const raw = child.content;
          if (/^\[[ xX]\][ \t]+\S/.test(raw)) {
            const box = raw[1] === ' '
              ? '<input disabled="" type="checkbox"> '
              : '<input checked="" disabled="" type="checkbox"> ';
            const inner = box + renderInline(raw.replace(/^\[[ xX]\][ \t]+/, ''), currentRefs);
            out += isTight ? inner : '<p>' + inner + '</p>\n';
            return;
          }
        }
        out += renderBlock(child, isTight && child.type === 'para');
      });
      return out + '</li>\n';
    }
    case 'table': {
      const alignAttr = (a) => (a ? ' align="' + a + '"' : '');
      let out = '<table>\n<thead>\n<tr>\n';
      out += b.header.map((c, i) => '<th' + alignAttr(b.aligns[i]) + '>' + renderInline(c, currentRefs) + '</th>').join('\n');
      out += '\n</tr>\n</thead>\n';
      if (b.rows.length) {
        out += '<tbody>';
        out += b.rows.map((row) => '<tr>\n' + row.map((c, i) => '<td' + alignAttr(b.aligns[i]) + '>' + renderInline(c, currentRefs) + '</td>').join('\n') + '\n</tr>').join('\n');
        out += '\n</tbody></table>\n';
      } else {
        out += '</table>\n';
      }
      return out;
    }
    default:
      return '';
  }
}

// The refs map for the parse currently being rendered. Rendering happens
// synchronously at the end of parse(), so a module-level slot is safe and
// keeps renderBlock signatures small.
let currentRefs = null;

// The inline state shared by the whole render pass of one document:
// the reference lexer keeps a single in-link flag across blocks, set by
// raw <a ...> tags and cleared by </a>.
let currentInlineState = null;
