// Shared redaction (ADR-0003 D7 + amendment A6, rules_version 1.2.0). Pure, no I/O.
// Used by the emitter before spooling and by the sender before rendering.

export const RULES_VERSION = '1.2.0';

export const DEFAULT_REDACTION = Object.freeze({
  max_summary_chars: 500,
  max_lines: 8,
  max_task_title_chars: 120,
  strip_code_blocks: true,
  strip_diffs: true,
  mask_home_paths: true,
  extra_patterns: [],
});

const ELLIPSIS = '\u2026';

// C0/C1 controls except \t and \n, DEL, bidi overrides/isolates, zero-width chars.
// eslint-disable-next-line no-control-regex
const CONTROL_AND_BIDI = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
// Security M1: every format char and default-ignorable code point (soft hyphen, CGJ,
// Mongolian vowel separator, Hangul fillers, variation selectors, tag chars, ...).
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/** NFKC-normalize, then drop controls, bidi and invisible chars before any matching. */
export function normalizeForMatching(text) {
  return text.normalize('NFKC').replace(CONTROL_AND_BIDI, '').replace(INVISIBLE, '');
}

const FENCED_CODE = /(^|\n)[ \t]*(```|~~~)[\s\S]*?(\n[ \t]*\2[^\n]*(?=\n|$)|$)/g;
const INLINE_FENCE = /```[\s\S]*?(```|$)/g;
const DIFF_LINE = /^(?:[+-].*|@@.*|diff --git.*|index .*)$/;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

/**
 * Token patterns, applied in order. Each entry masks the whole match.
 * Exported so the config loader can scan config files for secrets.
 */
export const TOKEN_PATTERNS = Object.freeze([
  { label: 'slack-webhook', regex: /https?:\/\/hooks\.slack\.com\/services\/[^\s"'<>]+/gi },
  { label: 'slack-token', regex: /\bxox[abpre]-[A-Za-z0-9-]+/g },
  { label: 'slack-app-token', regex: /\bxapp-[A-Za-z0-9-]+/g },
  { label: 'github-token', regex: /\bgh[pos]_[A-Za-z0-9]{8,}/g },
  { label: 'github-token', regex: /\bgithub_pat_[A-Za-z0-9_]{8,}/g },
  { label: 'gitlab-token', regex: /\bglpat-[A-Za-z0-9_-]{8,}/g },
  { label: 'npm-token', regex: /\bnpm_[A-Za-z0-9]{16,}/g },
  { label: 'stripe-key', regex: /\b[sr]k_live_[A-Za-z0-9]{8,}/g },
  { label: 'api-key', regex: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { label: 'aws-key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'google-key', regex: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { label: 'atlassian-token', regex: /\bATATT[A-Za-z0-9_=-]{16,}/g },
  { label: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g },
]);

const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/:@]+:[^\s/@]+@/gi;
const ENV_ASSIGNMENT = /^([ \t]*(?:export[ \t]+)?[A-Z_][A-Z0-9_]*)=.+$/gm;
// Keyword-anchored (no unbounded leading class) so hostile input cannot cause quadratic backtracking.
// Security M2: optional closing quote on the key (JSON/Python), `:` `=` `=>` separators,
// and a value on the next line. Bounded quantifiers only (ReDoS-safe).
const SECRET_KEY_VALUE = /((?:secret|token|passw(?:or)?d|api[_-]?key)[A-Za-z0-9_.-]{0,64})(["']?[ \t]{0,16}(?:=>|[:=])[ \t]{0,16}(?:\n[ \t]{0,16})?)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi;
const BASIC_AUTH = /\b(Basic)[ \t]+([A-Za-z0-9+/]{8,}={0,2})/g;
const CLI_PASSWORD_FLAG = /(--pass(?:word|wd)?)(=|[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s;]+)/gi;
const MYSQL_P_FLAG = /\b((?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n]{0,200}?[ \t]-p)([^\s;]+)/g;
const ENTROPY_CANDIDATE = /[A-Za-z0-9+/=_-]{32,}/g;
const HOME_PATH = /(^|[^A-Za-z0-9_~])\/(?:home|Users)\/[^/\s'"`<>]+/g;
const REDACTED_MARKER = /^\[REDACTED:[a-z-]+\]$/;

function shannonEntropy(text) {
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isHighEntropy(run) {
  if (/^[0-9a-fA-F]{32,}$/.test(run)) return true;
  const hasDigit = /[0-9]/.test(run);
  const hasLower = /[a-z]/.test(run);
  const hasUpper = /[A-Z]/.test(run);
  if (!hasDigit || !(hasLower || hasUpper)) return false;
  return shannonEntropy(run) >= 3.5;
}

/** Max input (chars) redaction processes; cut at the last newline before it. */
export const MAX_REDACT_INPUT_CHARS = 64 * 1024;
/** extra_patterns run per segment of at most this many chars (bounded execution). */
export const EXTRA_PATTERN_SEGMENT_CHARS = 256;
/** Max product of per-quantifier backtracking choices (unbounded counts as one segment). */
export const MAX_PATTERN_COST = 256;
/** Max summed cost over all extra_patterns (bounds total work per redaction pass). */
export const MAX_TOTAL_PATTERN_COST = 1024;
const MAX_EXTRA_PATTERN_CHARS = 200;
const QUANTIFIER_START = /[*+?{]/;

/**
 * ReDoS guard for config.redaction.extra_patterns (BUG-QA-004). Conservative:
 * rejects backreferences, lookarounds, and any quantified group that itself
 * contains a quantifier or an alternation ((a+)+, (a*)*, (a|aa)+, ((ab)+)*...),
 * and caps backtracking cost: the product over quantifiers of their choice count
 * (? = 2, {n,m} = m-n+1, {n} = 1, *, + and {n,} = segment length 256) must be
 * <= 256 per pattern and <= 1024 summed over all patterns (patternCost()). Measured
 * worst case is ~50 ms per pattern per redaction pass on a hostile 64 KiB input.
 * Conservative by design: e.g. INTERNAL-[0-9]+ or [A-Z]{3}-[0-9]+ pass, \\w+@\\w+ is rejected
 * (write \\w{1,16}@[a-z]{1,16} instead).
 * @returns {string|undefined} rejection reason, or undefined when safe
 */
export function unsafePatternReason(source) {
  if (typeof source !== 'string' || source.length === 0 || source.length > MAX_EXTRA_PATTERN_CHARS) return 'length';
  if (/\\[1-9]|\\k</.test(source)) return 'backreference';
  if (/\(\?<?[=!]/.test(source)) return 'lookaround';
  const stack = [{ hasQuantifier: false, hasAlternation: false }];
  let cost = 1;
  const countQuantifier = (index) => {
    const char = source[index];
    let choices = EXTRA_PATTERN_SEGMENT_CHARS;
    if (char === '?') choices = 2;
    if (char === '{') {
      const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(index));
      if (match && match[2] === undefined) choices = 1;
      else if (match && match[3] !== '') choices = Math.max(1, Number(match[3]) - Number(match[1]) + 1);
    }
    cost *= choices;
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const top = stack[stack.length - 1];
    if (char === '\\') {
      index += 1;
    } else if (char === '[') {
      index += 1;
      if (source[index] === '^') index += 1;
      if (source[index] === ']') index += 1;
      while (index < source.length && source[index] !== ']') {
        if (source[index] === '\\') index += 1;
        index += 1;
      }
    } else if (char === '(') {
      stack.push({ hasQuantifier: false, hasAlternation: false });
      if (source[index + 1] === '?') index += source[index + 2] === ':' ? 2 : 1;
    } else if (char === ')') {
      if (stack.length === 1) return 'unbalanced';
      const group = stack.pop();
      const next = source[index + 1];
      const isQuantified = next !== undefined && QUANTIFIER_START.test(next);
      if (isQuantified && (group.hasQuantifier || group.hasAlternation)) return 'nested_quantifier';
      if (group.hasQuantifier || isQuantified) stack[stack.length - 1].hasQuantifier = true;
    } else if (char === '|') {
      top.hasAlternation = true;
    } else if (QUANTIFIER_START.test(char)) {
      const previous = source[index - 1];
      // lazy/possessive marker after a quantifier is not a new quantifier
      const isModifier = char === '?' && (previous === '*' || previous === '+' || previous === '?' || previous === '}');
      if (!isModifier) countQuantifier(index);
      if (char === '{') {
        const close = source.indexOf('}', index);
        if (close > index) index = close;
      }
      top.hasQuantifier = true;
    }
  }
  if (stack.length !== 1) return 'unbalanced';
  if (cost > MAX_PATTERN_COST) return 'quantifier_budget';
  return undefined;
}

/** Backtracking cost estimate used for the summed budget (Infinity when unsafe). */
export function patternCost(source) {
  if (unsafePatternReason(source)) return Infinity;
  let cost = 1;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') index += 1;
    else if (char === '[') {
      index += 1;
      while (index < source.length && source[index] !== ']') index += source[index] === '\\' ? 2 : 1;
    } else if (char === '(' && source[index + 1] === '?') index += 1;
    else if (char === '?' && '*+?}'.includes(source[index - 1])) continue;
    else if (char === '*' || char === '+') cost *= EXTRA_PATTERN_SEGMENT_CHARS;
    else if (char === '?') cost *= 2;
    else if (char === '{') {
      const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(index));
      if (match) {
        if (match[2] !== undefined) cost *= match[3] === '' ? EXTRA_PATTERN_SEGMENT_CHARS : Math.max(1, Number(match[3]) - Number(match[1]) + 1);
        index += match[0].length - 1;
      }
    }
  }
  return cost;
}

/**
 * Compile config.redaction.extra_patterns (regex sources, 200-char cap each).
 * Throws on an invalid, oversized or ReDoS-prone pattern (config validation surfaces it).
 */
export function compileExtraPatterns(sources = []) {
  let total = 0;
  return sources.map((source) => {
    if (unsafePatternReason(source)) throw new Error('invalid_extra_pattern');
    total += patternCost(source);
    if (total > MAX_TOTAL_PATTERN_COST) throw new Error('invalid_extra_pattern');
    return new RegExp(source, 'g');
  });
}

/**
 * Apply a user pattern per line, splitting long lines into fixed segments, so
 * even a polynomial pattern only ever sees EXTRA_PATTERN_SEGMENT_CHARS chars.
 * Limitation (documented): a custom match spanning a segment boundary of a
 * >256-char line is not masked; built-in patterns still run on whole text.
 */
function applyBounded(text, regex) {
  return text
    .split('\n')
    .map((line) => {
      if (line.length <= EXTRA_PATTERN_SEGMENT_CHARS) {
        regex.lastIndex = 0;
        return line.replace(regex, '[REDACTED:custom]');
      }
      let out = '';
      for (let start = 0; start < line.length; start += EXTRA_PATTERN_SEGMENT_CHARS) {
        regex.lastIndex = 0;
        out += line.slice(start, start + EXTRA_PATTERN_SEGMENT_CHARS).replace(regex, '[REDACTED:custom]');
      }
      return out;
    })
    .join('\n');
}

/** Bound input size; cut at a line boundary so no single-line secret is split. */
function capInput(input) {
  if (input.length <= MAX_REDACT_INPUT_CHARS) return input;
  const head = input.slice(0, MAX_REDACT_INPUT_CHARS);
  const lastNewline = head.lastIndexOf('\n');
  return lastNewline > 0 ? head.slice(0, lastNewline) : '';
}

function stripCodeBlocks(text) {
  return text.replace(FENCED_CODE, '$1[code removed]').replace(INLINE_FENCE, '[code removed]');
}

function stripDiffLines(text) {
  return text
    .split('\n')
    .filter((line) => !DIFF_LINE.test(line))
    .join('\n');
}

/**
 * Mask secrets and strip disallowed content. Does not truncate.
 * @param {string} input
 * @param {object} [options] config.redaction values
 * @param {RegExp[]} [extraPatterns] compiled extra patterns
 * @returns {string}
 */
export function redactText(input, options = DEFAULT_REDACTION, extraPatterns = []) {
  if (typeof input !== 'string') throw new TypeError('redact_input_not_string');
  let text = normalizeForMatching(capInput(input).replace(/\r\n?/g, '\n'));
  text = text.replace(PRIVATE_KEY_BLOCK, '[REDACTED:private-key]');
  if (options.strip_code_blocks !== false) text = stripCodeBlocks(text);
  if (options.strip_diffs !== false) text = stripDiffLines(text);
  for (const { label, regex } of TOKEN_PATTERNS) text = text.replace(regex, `[REDACTED:${label}]`);
  text = text.replace(BEARER, '$1 [REDACTED:bearer]');
  text = text.replace(URL_CREDENTIALS, '$1[REDACTED:credentials]@');
  text = text.replace(ENV_ASSIGNMENT, '$1=[REDACTED:env]');
  text = text.replace(SECRET_KEY_VALUE, (match, key, separator, value) =>
    REDACTED_MARKER.test(value) ? match : `${key}${separator}[REDACTED:secret]`,
  );
  text = text.replace(BASIC_AUTH, (match, scheme, value) =>
    // plain prose ("Basic configuration") stays; credentials have digits, +/=, or mixed case
    /[0-9+/=]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value)) ? `${scheme} [REDACTED:basic]` : match,
  );
  text = text.replace(CLI_PASSWORD_FLAG, (match, flag, separator, value) =>
    REDACTED_MARKER.test(value) ? match : `${flag}${separator}[REDACTED:secret]`,
  );
  text = text.replace(MYSQL_P_FLAG, (match, prefix, value) => (REDACTED_MARKER.test(value) ? match : `${prefix}[REDACTED:secret]`));
  for (const regex of extraPatterns) text = applyBounded(text, regex);
  text = text.replace(ENTROPY_CANDIDATE, (run) => (isHighEntropy(run) ? '[REDACTED:high-entropy]' : run));
  if (options.mask_home_paths !== false) text = text.replace(HOME_PATH, '$1~');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Truncate to max_lines then max_chars (code points). Pure.
 * @returns {{text: string, truncated: boolean}}
 */
export function truncateText(text, maxChars, maxLines) {
  let truncated = false;
  let result = text;
  const lines = result.split('\n');
  if (Number.isInteger(maxLines) && maxLines > 0 && lines.length > maxLines) {
    result = lines.slice(0, maxLines).join('\n');
    truncated = true;
  }
  const codePoints = [...result];
  if (codePoints.length > maxChars) {
    result = maxChars > 1 ? codePoints.slice(0, maxChars - 1).join('') + ELLIPSIS : '';
    truncated = true;
  }
  return { text: result, truncated };
}

/**
 * Full pipeline: redact -> truncate -> redact. Fails closed.
 * @returns {{text?: string, truncated: boolean, dropped: boolean}}
 *   text is undefined when nothing may be published.
 */
export function redactAndTruncate(input, maxChars, maxLines, options = DEFAULT_REDACTION, extraPatterns = []) {
  if (input === undefined || input === null || input === '') return { truncated: false, dropped: false };
  try {
    const first = redactText(input, options, extraPatterns);
    const { text: cut, truncated } = truncateText(first, maxChars, maxLines);
    const second = redactText(cut, options, extraPatterns);
    // Second pass can only shorten or keep length roughly; enforce the cap again.
    const { text: final, truncated: truncatedAgain } = truncateText(second, maxChars, maxLines);
    if (final.length === 0) return { truncated: truncated || truncatedAgain || first.length > 0, dropped: false };
    return { text: final, truncated: truncated || truncatedAgain, dropped: false };
  } catch {
    return { truncated: false, dropped: true };
  }
}

/** Summary per config.redaction (max_summary_chars, max_lines). */
export function redactSummary(input, redaction = DEFAULT_REDACTION, extraPatterns = []) {
  return redactAndTruncate(input, redaction.max_summary_chars, redaction.max_lines, redaction, extraPatterns);
}

/** Task title: single line, max_task_title_chars. */
export function redactTaskTitle(input, redaction = DEFAULT_REDACTION, extraPatterns = []) {
  if (typeof input !== 'string') return redactAndTruncate(input, 0, 1, redaction, extraPatterns);
  return redactAndTruncate(input.replace(/[\r\n]+/g, ' '), redaction.max_task_title_chars, 1, redaction, extraPatterns);
}

/** Escape Slack mrkdwn control characters (&, <, >). */
export function escapeMrkdwn(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
