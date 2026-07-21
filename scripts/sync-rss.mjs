#!/usr/bin/env node
/**
 * Fetches the Sepah News RSS feed, filters for items relevant to Nasr 2 / Sa'eqeh,
 * asks an LLM (via OpenRouter) to extract a structured event from each relevant
 * item, validates the result against /data/locations.json, and appends anything
 * that validates cleanly to /data/events.json. Anything that fails validation or
 * has no resolvable location goes to /data/pending-review.json plus a GitHub
 * Issue instead, for a human to place by hand. See scripts/README.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const RSS_URL = 'https://sepahnews.ir/fa/rss/allnews';
const USER_AGENT = 'Nasr2DashboardBot/1.0 (+https://github.com/pavelnedved7081/Nasr2)';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'openrouter/free';

const RELEVANCE_KEYWORDS = ['اطلاعیه', 'نصر ۲', 'نصر۲', 'صاعقه', 'موج', 'پایگاه', 'کد خبر'];

// A relevant item must ALSO mention one of these to qualify — otherwise a broad-keyword-only
// match (e.g. an "اطلاعیه" that's really an administrative notice, or a "موج"-mentioning political
// speech) is not treated as an operational statement. See isRelevant().
const ACTION_KEYWORDS = [
  'منهدم', 'هدف قرار', 'به آتش کشید', 'تخریب', 'اصابت',
  'حمله', 'حملات', 'ضربه', 'ضربات', 'انهدام', 'سرنگون', 'شلیک', 'منفجر',
];

const VALID_FORCES = ['ground', 'naval', 'aerospace', 'joint', 'unknown'];
const VALID_SOURCES = ['sepah', 'artesh'];

const JALALI_MONTHS = [
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
];
const JALALI_MONTH_DAYS_LEAP = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 30];
const JALALI_MONTH_DAYS_COMMON = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];
const TIR_1_1405_EPOCH = '2026-06-22'; // Tir 1, 1405 AP == this Gregorian date
const TIR_1_1405_DAY_OF_YEAR = 31 + 31 + 31 + 1; // Farvardin+Ordibehesht+Khordad+day1 of Tir = 94

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
function persianToLatinDigits(str) {
  return String(str).replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)));
}
function latinToPersianDigits(str) {
  return String(str).replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)]);
}

function isJalaliLeapYear(year) {
  // 33-year cycle approximation, adequate for near-term years around 1405.
  const cycle = [1, 5, 9, 13, 17, 22, 26, 30];
  return cycle.includes(((year % 33) + 33) % 33);
}
function jalaliYearLength(year) {
  return isJalaliLeapYear(year) ? 366 : 365;
}

function jalaliDayOfYear(year, monthIdx, day) {
  const table = isJalaliLeapYear(year) ? JALALI_MONTH_DAYS_LEAP : JALALI_MONTH_DAYS_COMMON;
  let doy = day;
  for (let m = 0; m < monthIdx; m++) doy += table[m];
  return doy;
}

/** Convert a Jalali date string like "۱۷ تیر ۱۴۰۵" to a Gregorian 'YYYY-MM-DD' string. */
export function jalaliToGregorian(dateP) {
  const normalized = persianToLatinDigits(dateP).trim();
  const m = normalized.match(/^(\d{1,2})\s+(\S+)\s+(\d{3,4})$/);
  if (!m) throw new Error(`Unparseable Jalali date: "${dateP}"`);
  const [, dayStr, monthName, yearStr] = m;
  const day = parseInt(dayStr, 10);
  const year = parseInt(yearStr, 10);
  const monthIdx = JALALI_MONTHS.indexOf(monthName);
  if (monthIdx === -1) throw new Error(`Unknown Jalali month: "${monthName}" in "${dateP}"`);

  const targetDoy = jalaliDayOfYear(year, monthIdx, day);
  let deltaDays = targetDoy - TIR_1_1405_DAY_OF_YEAR;

  if (year !== 1405) {
    // Walk whole Jalali years between 1405 and `year` to accumulate day offsets.
    const step = year > 1405 ? 1 : -1;
    for (let y = 1405; y !== year; y += step) {
      const len = isJalaliLeapYear(step === 1 ? y : y - 1) ? 366 : 365;
      deltaDays += step * len;
    }
  }

  const epoch = new Date(TIR_1_1405_EPOCH + 'T00:00:00Z');
  epoch.setUTCDate(epoch.getUTCDate() + deltaDays);
  return epoch.toISOString().slice(0, 10);
}

/** Convert a Gregorian 'YYYY-MM-DD' string to a Jalali date string like "۱۷ تیر ۱۴۰۵" (inverse of jalaliToGregorian). */
export function gregorianToJalali(dateG) {
  const target = new Date(dateG + 'T00:00:00Z');
  const epoch = new Date(TIR_1_1405_EPOCH + 'T00:00:00Z');
  const deltaDays = Math.round((target.getTime() - epoch.getTime()) / 86400000);

  let year = 1405;
  let doy = TIR_1_1405_DAY_OF_YEAR + deltaDays;

  while (doy > jalaliYearLength(year)) {
    doy -= jalaliYearLength(year);
    year += 1;
  }
  while (doy < 1) {
    year -= 1;
    doy += jalaliYearLength(year);
  }

  const table = isJalaliLeapYear(year) ? JALALI_MONTH_DAYS_LEAP : JALALI_MONTH_DAYS_COMMON;
  let monthIdx = 0;
  let day = doy;
  while (day > table[monthIdx]) {
    day -= table[monthIdx];
    monthIdx += 1;
  }

  return `${latinToPersianDigits(day)} ${JALALI_MONTHS[monthIdx]} ${latinToPersianDigits(year)}`;
}

/** Parse an RSS <pubDate> (RFC 822 date, e.g. "Wed, 08 Jul 2026 08:00:00 +0330") into a Gregorian
 *  'YYYY-MM-DD' string, or null if missing/unparseable. */
export function pubDateToDateG(pubDate) {
  if (typeof pubDate !== 'string' || pubDate.trim() === '') return null;
  const parsed = new Date(pubDate);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/** Extract the numeric news code from a Sepah News article URL, e.g.
 *  "https://sepahnews.ir/fa/news/36159/some-slug" -> "36159". Returns '' if no match. */
export function extractCodeFromLink(link) {
  if (typeof link !== 'string') return '';
  const m = link.match(/\/news\/(\d+)\//);
  return m ? m[1] : '';
}

const ARTICLE_FETCH_TIMEOUT_MS = 10000;

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fetch an article page and return its stripped text content. Throws on timeout/non-2xx/network error. */
export async function fetchArticleText(link, { timeoutMs = ARTICLE_FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(link, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    if (!res.ok) throw new Error(`article fetch failed: ${res.status}`);
    const html = await res.text();
    return stripHtml(html);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(dataDir, name, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(dataDir, name), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}
async function writeJson(dataDir, name, value) {
  await fs.writeFile(path.join(dataDir, name), JSON.stringify(value, null, 2) + '\n');
}

/** Does `dateP` look like a Jalali date string (day + Persian month name + year), e.g. "۳۰ تیر ۱۴۰۵"? */
export function isValidJalaliDateString(dateP) {
  if (typeof dateP !== 'string' || dateP.trim() === '') return false;
  const normalized = persianToLatinDigits(dateP).trim();
  const m = normalized.match(/^(\d{1,2})\s+(\S+)\s+(\d{3,4})$/);
  return m ? JALALI_MONTHS.includes(m[2]) : false;
}

function itemGuid(item) {
  const guid = item.guid && (typeof item.guid === 'object' ? item.guid['#text'] : item.guid);
  return guid || item.link || item.title;
}

const ZERO_WIDTH_RANGE = /[​‌‍‎‏﻿]/g;
const ARABIC_DIACRITICS_RANGE = /[ً-ْٰۖ-ۭ]/g;

/**
 * Normalizes a location id/name/model-supplied string for fuzzy comparison: strips diacritics
 * (Latin combining marks and Arabic tashkeel) and zero-width characters (unifying ZWNJ, which
 * Persian compound names commonly use in place of a space, with an actual space), folds a few
 * Arabic/Persian letter variants to their Persian equivalent, lowercases (for Latin chars), and
 * collapses whitespace.
 */
export function normalizeLocText(str) {
  if (typeof str !== 'string') return '';
  return str
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(ARABIC_DIACRITICS_RANGE, '')
    .replace(ZERO_WIDTH_RANGE, ' ')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Standard Levenshtein edit distance between two strings. */
export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

const FUZZY_LOC_EDIT_DISTANCE_MAX = 2;
const FUZZY_COUNTRY_EDIT_DISTANCE_MAX = 1;

// Generic locational descriptor words that a location's canonical name may include (e.g. "پایگاه
// هوایی علی‌السالم") but that loc_raw_text often omits (e.g. "پایگاه علی السالم") — stripped out
// before the substring-containment fallback so the comparison focuses on the distinctive part of
// the name (e.g. "علی السالم") instead of requiring the full descriptive phrase verbatim.
const GENERIC_LOCATION_WORDS = new Set(
  ['پایگاه', 'هوایی', 'فرودگاه', 'منطقه', 'منطقهٔ', 'کمپ', 'اسکله', 'بندر', 'مرکز', 'اردوگاه',
    'میناء', 'ایستگاه', 'داده', 'مخابراتی', 'پدافند', 'ناوگان', 'پنجم'].map(normalizeLocText)
);

/** Tokens of a normalized location name with generic descriptor words/punctuation stripped out. */
function coreLocationTokens(normName) {
  return normName
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !GENERIC_LOCATION_WORDS.has(t));
}

/**
 * Resolves a model-supplied `loc`/`loc_raw_text` pair against the location gazetteer, tolerating
 * the failure modes seen in real model output:
 *  - an exact match (after normalization) against a location id or name — the common case.
 *  - a small typo in the id (edit distance <= 2), e.g. "alAzrag" for "alAzraq".
 *  - `loc_raw_text` mentioning a known location's Persian name as a substring, e.g. loc came back
 *    null but loc_raw_text says "پایگاه علی السالم و جزيره بوبیان" (contains aliAlSalem's name,
 *    modulo the space-vs-ZWNJ difference normalization unifies).
 *  - the model mistakenly put a country name/id in `loc` instead of a specific location id (e.g.
 *    "jordan", or a close typo of it like "jordain") — resolves to `{ resolvedLoc: null,
 *    countryMatch: <country id> }` rather than a crash or a false location match, so loc_raw_text
 *    can carry the country-level info for a human reviewer.
 * Returns `{ resolvedLoc, countryMatch, candidates }`, where `candidates` are the location-id
 * fuzzy-match candidates considered (id + edit distance, closest first) — useful to attach to a
 * pending-review entry even when no match was confident enough to accept.
 */
export function resolveLocation(loc, locRawText, locations, countries) {
  const normLoc = normalizeLocText(loc);
  const normRawText = normalizeLocText(locRawText);

  const locEntries = Object.entries(locations || {}).map(([id, l]) => ({
    id,
    normId: normalizeLocText(id),
    normName: normalizeLocText(l?.name),
  }));

  if (normLoc) {
    const exact = locEntries.find((l) => l.normId === normLoc || (l.normName && l.normName === normLoc));
    if (exact) return { resolvedLoc: exact.id, countryMatch: null, candidates: [] };
  }

  let candidates = [];
  if (normLoc) {
    candidates = locEntries
      .map((l) => ({ id: l.id, distance: levenshtein(normLoc, l.normId) }))
      .sort((a, b) => a.distance - b.distance);
    const best = candidates[0];
    if (best && best.distance <= FUZZY_LOC_EDIT_DISTANCE_MAX) {
      return { resolvedLoc: best.id, countryMatch: null, candidates };
    }
  }

  if (normRawText) {
    const substringMatch = locEntries.find((l) => {
      if (!l.normName) return false;
      if (normRawText.includes(l.normName)) return true;
      const core = coreLocationTokens(l.normName);
      return core.length > 0 && core.every((t) => normRawText.includes(t));
    });
    if (substringMatch) return { resolvedLoc: substringMatch.id, countryMatch: null, candidates };
  }

  if (normLoc) {
    for (const [countryId, country] of Object.entries(countries || {})) {
      const labels = [countryId, country?.label_fa, country?.label_en, country?.label_ar]
        .filter(Boolean)
        .map(normalizeLocText);
      const isCountryMatch = labels.some(
        (label) => label === normLoc || levenshtein(normLoc, label) <= FUZZY_COUNTRY_EDIT_DISTANCE_MAX
      );
      if (isCountryMatch) return { resolvedLoc: null, countryMatch: countryId, candidates };
    }
  }

  return { resolvedLoc: null, countryMatch: null, candidates };
}

export function isRelevant(item) {
  const haystack = `${item.title || ''} ${item.description || ''}`;
  const hasBroadMatch = RELEVANCE_KEYWORDS.some((kw) => haystack.includes(kw));
  const hasActionMatch = ACTION_KEYWORDS.some((kw) => haystack.includes(kw));
  return hasBroadMatch && hasActionMatch;
}

function buildSystemPrompt(locations) {
  const locList = Object.entries(locations)
    .map(([id, loc]) => `  - ${id}: ${loc.name} (${loc.country})`)
    .join('\n');
  return `شما یک استخراج‌کنندهٔ داده هستید. متن کامل یک خبر فارسی از سپاه‌نیوز دریافت می‌کنید که ممکن است دربارهٔ یک حملهٔ مشخص در عملیات «نصر ۲» یا «صاعقه» باشد.

فقط از میان این مکان‌های معتبر (شناسه: نام) انتخاب کنید — هیچ شناسهٔ دیگری یا مختصات جدید نسازید:
${locList}

کشورهای معتبر: jordan, kuwait, bahrain, qatar, oman, syria, hormuz, iran
نیروهای معتبر: ground, naval, aerospace, joint, unknown
منابع معتبر: sepah (سپاه پاسداران), artesh (ارتش جمهوری اسلامی)

خروجی باید دقیقاً این ساختار JSON را داشته باشد:
{wave, force, source, loc, loc_raw_text, target, weapon, outcome, time}

اگر متن به‌روشنی یک حملهٔ مشخص با مکان معین را توصیف نمی‌کند، یا مکانِ ذکرشده با هیچ‌یک از شناسه‌های بالا مطابقت ندارد، فیلد "loc" را null بگذارید و در عوض عبارت مکانی که در متن یافتید را در "loc_raw_text" برگردانید — هرگز شناسه یا مختصات حدسی نسازید.`;
}

function eventJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      wave: { type: 'string' },
      force: { type: 'string', enum: VALID_FORCES },
      source: { type: 'string', enum: VALID_SOURCES },
      loc: { type: ['string', 'null'] },
      loc_raw_text: { type: ['string', 'null'] },
      target: { type: 'string' },
      weapon: { type: 'string' },
      outcome: { type: 'string' },
      time: { type: 'string' },
    },
    required: ['wave', 'force', 'source', 'loc', 'loc_raw_text', 'target', 'weapon', 'outcome', 'time'],
  };
}

/** Strips a leading/trailing ``` or ```json code fence, if present. */
function stripCodeFence(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

/** Returns the substring from the first "{" to the last "}", or null if no brace pair is found. */
function extractBraceSubstring(text) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  return first !== -1 && last > first ? text.slice(first, last + 1) : null;
}

/**
 * Parses a model's JSON response, tolerating common wrapping: a ```/```json code fence, and/or
 * prose before or after the JSON object (e.g. "We need to..." followed by the object). Tries the
 * raw content first, then the fence-stripped version, then the substring between the first "{"
 * and the last "}" (of both the raw and fence-stripped text). If every attempt fails, throws the
 * error from the last attempt — a genuine extraction failure that should route to pending-review.
 */
export function parseModelJson(content) {
  const candidates = [content];

  const fenceStripped = stripCodeFence(content);
  if (fenceStripped !== content) candidates.push(fenceStripped);

  const braceSubstring = extractBraceSubstring(content);
  if (braceSubstring) candidates.push(braceSubstring);

  if (fenceStripped !== content) {
    const fencedBraceSubstring = extractBraceSubstring(fenceStripped);
    if (fencedBraceSubstring) candidates.push(fencedBraceSubstring);
  }

  let lastErr;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function extractEvent(item, systemPrompt, articleText) {
  const userContent = `عنوان: ${item.title || ''}\n\nمتن: ${articleText || ''}`;
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/pavelnedved7081/Nasr2',
      'X-Title': 'Nasr2DashboardBot',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'nasr2_event', strict: true, schema: eventJsonSchema() },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter request failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter response had no message content');
  return parseModelJson(content);
}

// Hebrew has no legitimate reason to appear anywhere in this Persian-language pipeline's output;
// its presence alone is a strong signal of corrupted/garbled model output.
const HEBREW_RANGE = /[֐-׿]/;
// Other scripts that have no business appearing in Persian Sepah News text either: Cyrillic,
// Devanagari, Malayalam, Thai, Georgian, Japanese kana, CJK ideographs, Hangul syllables.
const OTHER_UNUSUAL_SCRIPT_RANGE =
  /[Ѐ-ӿऀ-ॿഀ-ൿ฀-๿Ⴀ-ჿ぀-ヿ一-鿿가-힯]/;
const PERSIAN_ARABIC_LETTER_RANGE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const LATIN_LETTER_RANGE = /[A-Za-z]/;
// Stripped from each token before checking for same-token script mixing, so that legitimate
// abbreviations followed directly by Persian punctuation (e.g. "MQ-9،") aren't misflagged.
const PUNCT_TO_STRIP = /[،؛؟٪ـ«»"'`.,!:;()[\]{}/]/g;

/**
 * Heuristically flags target/weapon/outcome text as corrupted/garbled model output: text
 * containing Hebrew-range characters or other scripts with no business in Persian Sepah News
 * text (Cyrillic, Devanagari, Malayalam, CJK, etc.), or a single "word" (whitespace-delimited
 * token) that mixes Persian/Arabic letters directly against Latin letters with no separator
 * (e.g. "میش奸", "تحریمейystème", "آochyانه") — the signature of a model response that degenerated
 * mid-token. Doesn't flag a field that's simply written entirely in English (e.g. "destroyed"),
 * since that's a legitimate (if untranslated) value, not corruption.
 */
export function looksGarbled(text) {
  if (typeof text !== 'string' || text === '') return false;
  if (HEBREW_RANGE.test(text)) return true;
  if (OTHER_UNUSUAL_SCRIPT_RANGE.test(text)) return true;
  const tokens = text.split(/\s+/);
  for (const token of tokens) {
    const cleaned = token.replace(PUNCT_TO_STRIP, '');
    if (PERSIAN_ARABIC_LETTER_RANGE.test(cleaned) && LATIN_LETTER_RANGE.test(cleaned)) return true;
  }
  return false;
}

/**
 * Validate a merged extraction: the model's fields (wave, force, source, loc, target, weapon,
 * outcome) plus dateG/dateP/code, which are derived independently from the RSS <pubDate> and
 * <link> (see pubDateToDateG/gregorianToJalali/extractCodeFromLink) and attached by the caller
 * before validation — the model is never asked for date or code. `loc` is expected to already
 * have gone through resolveLocation() (fuzzy/country-mixup resolution) by the time it reaches
 * here. Returns {ok, errors}.
 */
export function validateExtraction(ex, locations) {
  const errors = [];
  if (!ex || typeof ex !== 'object') return { ok: false, errors: ['not an object'] };

  // wave is commonly absent from real statements (existing events.json uses "—" for this); default
  // rather than fail validation on it alone.
  if (typeof ex.wave !== 'string' || ex.wave.trim() === '') {
    ex.wave = '—';
  }

  for (const field of ['force', 'source', 'target', 'weapon', 'outcome']) {
    if (typeof ex[field] !== 'string' || ex[field].trim() === '') {
      errors.push(`missing/empty required field: ${field}`);
    }
  }
  if (ex.force && !VALID_FORCES.includes(ex.force)) errors.push(`invalid force: ${ex.force}`);
  if (ex.source && !VALID_SOURCES.includes(ex.source)) errors.push(`invalid source: ${ex.source}`);
  if (ex.loc != null && !(ex.loc in locations)) errors.push(`unknown loc id: ${ex.loc}`);
  if (ex.loc == null) errors.push('loc is null');
  if (!isValidJalaliDateString(ex.dateP)) errors.push(`unparseable date: ${ex.dateP}`);
  if (looksGarbled(`${ex.target || ''} ${ex.weapon || ''} ${ex.outcome || ''}`)) {
    errors.push('target/weapon/outcome text looks corrupted/garbled (unexpected script mixing)');
  }
  return { ok: errors.length === 0, errors };
}

/** Opens a needs-review GitHub Issue for a pending item. Returns the issue number, or null if
 *  issue creation was skipped (no token) or failed. */
async function openPendingReviewIssue(item, extraction, errors) {
  const token = process.env.GITHUB_TOKEN;
  const repoSlug = process.env.GITHUB_REPOSITORY;
  if (!token || !repoSlug) {
    console.warn('GITHUB_TOKEN/GITHUB_REPOSITORY not set; skipping issue creation');
    return null;
  }
  const body = [
    `**RSS item title:** ${item.title || '(none)'}`,
    `**RSS item link:** ${item.link || '(none)'}`,
    '',
    '**Model extraction (partial/unvalidated):**',
    '```json',
    JSON.stringify(extraction ?? null, null, 2),
    '```',
    '',
    errors && errors.length ? `**Validation errors:** ${errors.join('; ')}` : '',
    '',
    '**Raw description:**',
    item.description || '(none)',
  ].join('\n');

  const res = await fetch(`https://api.github.com/repos/${repoSlug}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json',
    },
    body: JSON.stringify({
      title: `Pending review: ${item.title || '(untitled item)'}`,
      body,
      labels: ['needs-review'],
    }),
  });
  if (!res.ok) {
    console.warn(`Failed to open GitHub issue: ${res.status} ${await res.text()}`);
    return null;
  }
  const created = await res.json();
  return created?.number ?? null;
}

/** Closes a previously-opened pending-review Issue (with a comment) once the item has resolved
 *  on a later retry. Best-effort: warns and returns on failure rather than throwing, so it can
 *  never take down a run that otherwise succeeded. */
async function closePendingReviewIssue(issueNumber, comment) {
  const token = process.env.GITHUB_TOKEN;
  const repoSlug = process.env.GITHUB_REPOSITORY;
  if (!token || !repoSlug || !issueNumber) return;

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/vnd.github+json',
  };

  const commentRes = await fetch(`https://api.github.com/repos/${repoSlug}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body: comment }),
  });
  if (!commentRes.ok) {
    console.warn(`Failed to comment on issue #${issueNumber}: ${commentRes.status} ${await commentRes.text()}`);
  }

  const closeRes = await fetch(`https://api.github.com/repos/${repoSlug}/issues/${issueNumber}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
  });
  if (!closeRes.ok) {
    console.warn(`Failed to close issue #${issueNumber}: ${closeRes.status} ${await closeRes.text()}`);
  }
}

function computeMeta(events) {
  const dates = events.map((e) => e.dateG).sort();
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  const first = events.find((e) => e.dateG === minDate);
  const last = [...events].reverse().find((e) => e.dateG === maxDate);

  function faParts(dateP) {
    const m = dateP.match(/^([۰-۹]+)\s+(\S+)\s+([۰-۹]+)$/);
    return m ? { day: m[1], month: m[2], year: m[3] } : null;
  }
  const faFirst = faParts(first.dateP);
  const faLast = faParts(last.dateP);
  const date_range_fa = faFirst && faLast && faFirst.month === faLast.month && faFirst.year === faLast.year
    ? `${faFirst.day} تا ${faLast.day} ${faLast.month} ${faLast.year}`
    : `${first.dateP} تا ${last.dateP}`;

  const minD = new Date(minDate + 'T00:00:00Z');
  const maxD = new Date(maxDate + 'T00:00:00Z');
  const enMonthFmt = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
  const date_range_en = minD.getUTCMonth() === maxD.getUTCMonth() && minD.getUTCFullYear() === maxD.getUTCFullYear()
    ? `${enMonthFmt.format(minD)} ${minD.getUTCDate()}–${maxD.getUTCDate()}, ${maxD.getUTCFullYear()}`
    : `${enMonthFmt.format(minD)} ${minD.getUTCDate()}, ${minD.getUTCFullYear()} – ${enMonthFmt.format(maxD)} ${maxD.getUTCDate()}, ${maxD.getUTCFullYear()}`;

  const AR_INDIC = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
  const toArabicIndic = (n) => String(n).replace(/[0-9]/g, (d) => AR_INDIC[d]);
  const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const date_range_ar = minD.getUTCMonth() === maxD.getUTCMonth() && minD.getUTCFullYear() === maxD.getUTCFullYear()
    ? `${toArabicIndic(minD.getUTCDate())}–${toArabicIndic(maxD.getUTCDate())} ${AR_MONTHS[maxD.getUTCMonth()]} ${toArabicIndic(maxD.getUTCFullYear())}`
    : `${toArabicIndic(minD.getUTCDate())} ${AR_MONTHS[minD.getUTCMonth()]} ${toArabicIndic(minD.getUTCFullYear())} – ${toArabicIndic(maxD.getUTCDate())} ${AR_MONTHS[maxD.getUTCMonth()]} ${toArabicIndic(maxD.getUTCFullYear())}`;

  return {
    last_synced: new Date().toISOString(),
    date_range_fa,
    date_range_en,
    date_range_ar,
  };
}

/**
 * Processes RSS items one at a time, appending to `events` or `pendingReview` in place.
 * Each item is isolated in its own try/catch so one bad extraction (unparseable/missing
 * pubDate, a failed article-page fetch, malformed JSON, an unexpected throw anywhere in the
 * pipeline) can't abort the run — it's logged and routed to pending-review instead, and the
 * loop moves on.
 *
 * date/code are derived independently rather than asked of the model: dateG comes from the
 * RSS <pubDate>, dateP is derived from dateG, and code is parsed out of the item's <link>. The
 * model only ever supplies wave/force/source/loc/loc_raw_text/target/weapon/outcome/time, from
 * the full article page text (not just the terse RSS <description>).
 *
 * A GUID is only added to `seenSet`/`newGuids` (and thus to seen-guids.json) once it's fully
 * resolved: added to events, or confidently classified irrelevant. Items routed to
 * pending-review are never marked seen, so they're retried from scratch on every subsequent
 * run until they succeed or a human resolves them by hand. Pending items already present in
 * `pendingReview` (from an earlier run) are matched by guid and updated in place rather than
 * appended again, and no second GitHub Issue is opened for them; the existing `issue_number` is
 * carried over so a later success can close it.
 */
export async function processItems(items, {
  locations,
  countries = {},
  events,
  pendingReview,
  seenSet,
  systemPrompt,
  nextId,
  extractEventFn = extractEvent,
  openPendingReviewIssueFn = openPendingReviewIssue,
  closePendingReviewIssueFn = closePendingReviewIssue,
  fetchArticleTextFn = fetchArticleText,
  pubDateToDateGFn = pubDateToDateG,
  gregorianToJalaliFn = gregorianToJalali,
  extractCodeFromLinkFn = extractCodeFromLink,
  resolveLocationFn = resolveLocation,
}) {
  const newGuids = [];
  let newEventsCount = 0;
  let pendingCount = 0;
  let resolvedCount = 0;
  let id = nextId;

  async function routeToPending(item, guid, extraction, errors, locInfo) {
    const extra = {};
    if (locInfo && locInfo.candidates && locInfo.candidates.length) {
      extra.loc_candidates = locInfo.candidates.slice(0, 5);
    }
    if (locInfo && locInfo.countryMatch) {
      extra.loc_country_match = locInfo.countryMatch;
    }

    const existingIdx = pendingReview.findIndex((p) => p.guid === guid);
    if (existingIdx !== -1) {
      // Already flagged in a previous run: refresh the record but don't open a duplicate Issue.
      const existing = pendingReview[existingIdx];
      pendingReview[existingIdx] = {
        ...existing,
        raw_extraction: extraction ? { ...extraction, __ok: undefined } : null,
        errors,
        ...extra,
        last_checked_at: new Date().toISOString(),
      };
    } else {
      let issueNumber = null;
      try {
        issueNumber = await openPendingReviewIssueFn(item, extraction, errors);
      } catch (err) {
        console.warn(`sync-rss: failed to open pending-review issue (guid=${guid}): ${err.message}`);
      }
      pendingReview.push({
        title: item.title || '',
        link: item.link || '',
        guid,
        raw_extraction: extraction ? { ...extraction, __ok: undefined } : null,
        errors,
        ...extra,
        added_at: new Date().toISOString(),
        issue_number: issueNumber ?? null,
      });
    }
    pendingCount++;
  }

  for (const item of items) {
    const guid = itemGuid(item);
    if (!guid || seenSet.has(guid)) continue;

    if (!isRelevant(item)) {
      // A previously-pending item can be reclassified as irrelevant once a filter change (e.g. the
      // action-keyword requirement) tightens; don't leave it orphaned in pending-review forever.
      const existingIdx = pendingReview.findIndex((p) => p.guid === guid);
      if (existingIdx !== -1) {
        const [removed] = pendingReview.splice(existingIdx, 1);
        resolvedCount++;
        if (removed.issue_number) {
          await closePendingReviewIssueFn(
            removed.issue_number,
            'Resolved automatically: item reclassified as not relevant on retry.'
          );
        }
      }
      newGuids.push(guid);
      continue;
    }

    try {
      let extraction = null;
      let errors = [];
      let locInfo = null;
      try {
        const dateG = pubDateToDateGFn(item.pubDate);
        if (!dateG) throw new Error(`missing/unparseable pubDate: "${item.pubDate ?? ''}"`);
        const dateP = gregorianToJalaliFn(dateG);
        const code = extractCodeFromLinkFn(item.link);

        const articleText = await fetchArticleTextFn(item.link);

        extraction = await extractEventFn(item, systemPrompt, articleText);
        extraction.dateG = dateG;
        extraction.dateP = dateP;
        extraction.code = code;

        locInfo = resolveLocationFn(extraction.loc, extraction.loc_raw_text, locations, countries);
        extraction.loc = locInfo.resolvedLoc;

        ({ ok: extraction.__ok, errors } = validateExtraction(extraction, locations));
      } catch (err) {
        errors = [`extraction failed: ${err.message}`];
      }

      if (!extraction || !extraction.__ok) {
        await routeToPending(item, guid, extraction, errors, locInfo);
        continue;
      }

      const existingIdx = pendingReview.findIndex((p) => p.guid === guid);
      let resolvedIssueNumber = null;
      if (existingIdx !== -1) {
        resolvedIssueNumber = pendingReview[existingIdx].issue_number;
        pendingReview.splice(existingIdx, 1);
        resolvedCount++;
      }

      events.push({
        id: id++,
        dateG: extraction.dateG,
        dateP: extraction.dateP,
        time: extraction.time || '',
        wave: extraction.wave,
        force: extraction.force,
        source: extraction.source,
        loc: extraction.loc,
        target: { fa: extraction.target, en: '', ar: '' },
        weapon: { fa: extraction.weapon, en: '', ar: '' },
        outcome: { fa: extraction.outcome, en: '', ar: '' },
        code: extraction.code || '',
      });
      newEventsCount++;
      newGuids.push(guid);

      if (resolvedIssueNumber) {
        await closePendingReviewIssueFn(resolvedIssueNumber, 'Resolved automatically on retry.');
      }
    } catch (err) {
      console.error(`sync-rss: unexpected error processing item (guid=${guid}):`, err);
      await routeToPending(item, guid, null, [`unexpected error: ${err.message}`]);
    }
  }

  return { newGuids, newEventsCount, pendingCount, resolvedCount };
}

export async function main({ dataDir = DATA } = {}) {
  const locations = await readJson(dataDir, 'locations.json', {});
  const countries = await readJson(dataDir, 'countries.json', {});
  const events = await readJson(dataDir, 'events.json', []);
  const seenGuids = await readJson(dataDir, 'seen-guids.json', []);
  const pendingReview = await readJson(dataDir, 'pending-review.json', []);
  const seenSet = new Set(seenGuids);

  const res = await fetch(RSS_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const feed = parser.parse(xml);
  const rawItems = feed?.rss?.channel?.item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

  const systemPrompt = buildSystemPrompt(locations);
  const nextId = events.reduce((max, e) => Math.max(max, e.id), 0) + 1;

  const { newGuids, newEventsCount, pendingCount, resolvedCount } = await processItems(items, {
    locations, countries, events, pendingReview, seenSet, systemPrompt, nextId,
  });

  if (newGuids.length) {
    await writeJson(dataDir, 'seen-guids.json', [...seenGuids, ...newGuids]);
  }
  if (newEventsCount > 0) {
    await writeJson(dataDir, 'events.json', events);
    await writeJson(dataDir, 'meta.json', computeMeta(events));
  }
  if (pendingCount > 0 || resolvedCount > 0) {
    await writeJson(dataDir, 'pending-review.json', pendingReview);
  }

  console.log(`Processed ${items.length} RSS items: ${newEventsCount} new events (${resolvedCount} resolved from pending), ${pendingCount} pending review, ${newGuids.length - newEventsCount} irrelevant.`);

  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) {
    await fs.appendFile(outFile, `new_events_count=${newEventsCount}\npending_count=${pendingCount}\nresolved_count=${resolvedCount}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
