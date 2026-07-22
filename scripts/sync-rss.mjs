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
import { parse as parseHtml } from 'node-html-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

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

const ARTESH_RELEVANCE_KEYWORDS = ['صاعقه', 'ارتش', 'پدافند', 'پهپاد'];

// Artesh (aja.ir) RSS items' <description> only ever contains an <img> tag, never text (confirmed
// during the aja.ir structure investigation), so unlike Sepah, the relevance filter has only the
// item's <title> to work with. Real titles don't always contain an explicit destruction verb —
// e.g. "سامانه‌های موشکی هیمارس در کویت هدف موشک‌های زمین به زمین ارتش" has no verb at all beyond
// "هدف" — so the bare word "هدف" is included here even though it's more generic than the others.
// A false positive from that just lands an unrelated item in pending-review (visible to a human,
// self-correcting) rather than the worse failure mode of a relevant item being silently discarded
// as "irrelevant" with no article text to have caught it on.
const ARTESH_ACTION_KEYWORDS = [
  'منهدم', 'هدف قرار', 'به آتش کشید', 'تخریب', 'اصابت', 'انهدام', 'آماج', 'هدف',
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

/** Artesh (aja.ir) article links carry no numeric news-code — the only identifier is a GUID, and
 *  it only ever appears in page-plumbing contexts (comment-widget data-ids, print-page links),
 *  never as a human-visible reference number (confirmed during the aja.ir structure
 *  investigation) — so `code` is deliberately left empty, same as existing manually-entered
 *  Artesh events. */
export function extractArteshCode() {
  return '';
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

/** Fetch an article page and return its raw HTML (unlike fetchArticleText, which strips markup).
 *  Used by the pubDate fallback (extractPubDateFromArticleHtml), which needs the meta
 *  tags/attributes that plain-text stripping discards. Throws on timeout/non-2xx/network error. */
export async function fetchArticleHtml(link, { timeoutMs = ARTICLE_FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(link, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    if (!res.ok) throw new Error(`article fetch failed: ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// aja.ir (Artesh) is unreachable directly from GitHub Actions (and this held true even from an
// interactive session's own network), so both its RSS feed and every article page instead go
// through an Iranian VPS proxy that fetches on our behalf. Address/secret are config — env vars,
// with only the (non-secret) address defaulted — not embedded in logic, so they're easy to swap
// if the VPS ever changes.
const AJA_PROXY_BASE_URL = process.env.AJA_PROXY_URL || 'http://109.122.250.213:8787';
const AJA_PROXY_SECRET = process.env.AJA_PROXY_SECRET || '';

/** Fetches `url` through the aja.ir proxy (see AJA_PROXY_BASE_URL/AJA_PROXY_SECRET above); used
 *  as the transport for both the Artesh RSS feed and every Artesh article page. Same timeout/
 *  error-handling contract as fetchArticleHtml. Throws on timeout/non-2xx/network error. */
export async function proxyFetch(url, { timeoutMs = ARTICLE_FETCH_TIMEOUT_MS } = {}) {
  const proxiedUrl = `${AJA_PROXY_BASE_URL.replace(/\/$/, '')}/?url=${encodeURIComponent(url)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(proxiedUrl, {
      headers: { 'X-Proxy-Secret': AJA_PROXY_SECRET },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`proxy fetch failed: ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Sepah News article pages interleave a large "related headlines" sidebar/widget before
// (and after) the real statement body, with no HTML separator once tags are stripped — a
// page has no per-article content container to select instead (confirmed by inspecting the
// raw HTML of news/36167: the only candidate div, "body main", wraps the whole page, not
// just the article). This was the root cause of item 36167 extracting the wrong location
// (a headline about a different, unrelated statement bled into the model's input). These
// two text landmarks reliably bracket the real body instead:
//   - start: right after "دانلود همه تصاویر" (the download-all-images button that
//     immediately precedes every genuine statement's opening line), or the first
//     "روابط عمومی سپاه پاسداران انقلاب اسلامی" if that's missing (some statements have no
//     image gallery).
//   - end: the first "اشتراک گذاری" (share widget) after the start landmark — UI chrome
//     marking the end of the article body and the start of the tags/most-viewed widget.
const IMAGES_LANDMARK = 'دانلود همه تصاویر';
const STATEMENT_OPENING = 'روابط عمومی سپاه پاسداران انقلاب اسلامی';
const SHARE_WIDGET_LANDMARK = 'اشتراک گذاری';

/** Strips the related-headlines noise from a fetched article page's stripped text, keeping
 *  only the real statement body. Returns `strippedText` unchanged (but logs distinctly) if
 *  neither landmark is found, rather than guessing at an unfamiliar page structure. */
export function extractArticleBody(strippedText) {
  if (typeof strippedText !== 'string' || strippedText === '') return strippedText;

  let startIdx = strippedText.lastIndexOf(IMAGES_LANDMARK);
  if (startIdx !== -1) {
    startIdx += IMAGES_LANDMARK.length;
  } else {
    startIdx = strippedText.indexOf(STATEMENT_OPENING);
  }
  if (startIdx === -1) {
    console.error(
      'extractArticleBody: neither the images-landmark nor the statement-opening landmark ' +
        'was found; sending the full stripped text unchanged (page structure may have changed)'
    );
    return strippedText;
  }

  let body = strippedText.slice(startIdx).trim();
  const endIdx = body.indexOf(SHARE_WIDGET_LANDMARK);
  if (endIdx !== -1) {
    body = body.slice(0, endIdx).trim();
  }
  return body;
}

/** Fetch an article page and return its stripped, noise-free text content (see
 *  extractArticleBody). Throws on timeout/non-2xx/network error. */
export async function fetchArticleText(link, opts) {
  return extractArticleBody(stripHtml(await fetchArticleHtml(link, opts)));
}

/** Like stripHtml, but first turns <br>/</p>/</div> into newlines and preserves them (collapsing
 *  only intra-line whitespace) instead of flattening everything into one run-on line — used by
 *  extractSpanContent so a multi-paragraph article body keeps its paragraph breaks. */
function stripHtmlPreservingBreaks(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// Sigma Portal (aja.ir's CMS) wraps the real article body in a plain `<span class="Content">` —
// confirmed identical across every sample fetched during the aja.ir structure investigation. It's
// deeply nested (spans inside spans inside a wrapping div), so a real HTML parser is used to find
// it rather than a regex to the next closing tag, which breaks on that nesting. There's also a
// decoy `<td class="Content">` one level up, wrapping the whole news template (title + summary +
// body) — querying specifically for `span.Content` skips it. Everything outside the span (the
// rating widget starting at "امتیاز دهی", the comment form, the site's global footer nav) is page
// chrome, not part of the article, and is excluded automatically since it's never descended into —
// unlike Sepah, no separate trailing-noise landmark search is needed.
/** Extracts and returns the clean text of aja.ir's `<span class="Content">` article-body element
 *  from a fetched article page's raw HTML, or null if the element isn't found — routes the item
 *  to pending-review instead of guessing at an unrecognized page structure. */
export function extractSpanContent(html) {
  if (typeof html !== 'string' || html === '') return null;
  let root;
  try {
    root = parseHtml(html, { lowerCaseTagName: true });
  } catch {
    return null;
  }
  const span = root.querySelector('span.Content');
  if (!span) return null;
  const text = stripHtmlPreservingBreaks(span.innerHTML);
  return text || null;
}

/** Fetches an Artesh (aja.ir) article page via the proxy and extracts its clean body text (see
 *  extractSpanContent). Throws if the page fetch fails/times out, or if the expected content span
 *  isn't found, so the item routes to pending-review instead of sending the model an empty
 *  string. */
export async function fetchArteshArticleText(link, opts) {
  const html = await proxyFetch(link, opts);
  const body = extractSpanContent(html);
  if (body == null) {
    throw new Error('article body extraction returned no content (span.Content not found)');
  }
  return body;
}

const META_PUBLISHED_TIME_PROPS = [
  'article:published_time',
  'og:article:published_time',
  'article:publish_date',
  'pubdate',
  'publishdate',
  'date',
];

/** Returns the `content="..."` value of the first `<meta>` tag in `html` whose `property`/`name`
 *  attribute (case-insensitively) is one of `props`, or null if none matches. */
function extractMetaContent(html, props) {
  const wanted = new Set(props.map((p) => p.toLowerCase()));
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const propMatch = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i);
    const contentMatch = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i);
    if (propMatch && contentMatch && wanted.has(propMatch[1].toLowerCase())) {
      return contentMatch[1];
    }
  }
  return null;
}

/** Returns the first `<time>` element's `datetime` attribute (if present) and stripped inner
 *  text, or null if the page has no `<time>` element. */
function extractTimeElement(html) {
  const withDatetime = html.match(/<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/time>/i);
  if (withDatetime) return { datetime: withDatetime[1], text: stripHtml(withDatetime[2]) };
  const bare = html.match(/<time\b[^>]*>([\s\S]*?)<\/time>/i);
  if (bare) return { datetime: null, text: stripHtml(bare[1]) };
  return null;
}

const JALALI_DATE_IN_TEXT_RE = new RegExp(`([۰-۹]{1,2})\\s+(${JALALI_MONTHS.join('|')})\\s+([۰-۹]{2,4})`);

/** Finds the first Persian-digit Jalali date (e.g. "۱۷ تیر ۱۴۰۵") in free text, or null. */
function findJalaliDateInText(text) {
  const m = typeof text === 'string' ? text.match(JALALI_DATE_IN_TEXT_RE) : null;
  return m ? m[0] : null;
}

/**
 * Attempts to recover a publish date directly from a fetched article page's raw HTML, for
 * pending-review entries whose stored pubDate is missing (e.g. flagged before pubDate-capture
 * existed on pending entries, so there's no RSS <pubDate> left to retry with). Tries, in order:
 * a `<meta property="article:published_time">`-style tag, a `<time>` element's `datetime`
 * attribute or inner text, and a Jalali date string in the page's visible text. Returns a string
 * parseable by pubDateToDateG(), or null if nothing was found.
 */
export function extractPubDateFromArticleHtml(html) {
  if (typeof html !== 'string' || html === '') return null;

  const metaContent = extractMetaContent(html, META_PUBLISHED_TIME_PROPS);
  if (metaContent && pubDateToDateG(metaContent)) return metaContent;

  const timeEl = extractTimeElement(html);
  if (timeEl) {
    if (timeEl.datetime && pubDateToDateG(timeEl.datetime)) return timeEl.datetime;
    const jalaliFromTime = findJalaliDateInText(timeEl.text);
    if (jalaliFromTime) return jalaliToGregorian(jalaliFromTime);
  }

  const jalaliInBody = findJalaliDateInText(stripHtml(html).slice(0, 4000));
  if (jalaliInBody) return jalaliToGregorian(jalaliInBody);

  return null;
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

export function isRelevant(item, { broadKeywords = RELEVANCE_KEYWORDS, actionKeywords = ACTION_KEYWORDS } = {}) {
  const haystack = `${item.title || ''} ${item.description || ''}`;
  const hasBroadMatch = broadKeywords.some((kw) => haystack.includes(kw));
  const hasActionMatch = actionKeywords.some((kw) => haystack.includes(kw));
  return hasBroadMatch && hasActionMatch;
}

function buildSystemPrompt(locations) {
  const locList = Object.entries(locations)
    .map(([id, loc]) => `  - ${id}: ${loc.name} (${loc.country})`)
    .join('\n');
  return `شما یک استخراج‌کنندهٔ داده هستید. متن کامل یک خبر فارسی از سپاه‌نیوز یا پایگاه اطلاع‌رسانی ارتش (aja.ir) دریافت می‌کنید که ممکن است دربارهٔ یک حملهٔ مشخص در عملیات «نصر ۲» یا «صاعقه» باشد.

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
 * Last-resort repair for JS-object-literal-style output (e.g. {wave: "24", force: "aerospace"}) —
 * valid JS syntax but invalid JSON, since its keys aren't quoted. Quotes any identifier-like token
 * that sits in a key position (immediately after "{" or "," and immediately before ":") and isn't
 * already quoted; an already-quoted key's opening quote means the identifier pattern itself won't
 * match there, so real JSON is left untouched.
 */
function quoteBareKeys(text) {
  return text.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, '$1"$2"$3');
}

/**
 * Parses a model's JSON response, tolerating common wrapping: a ```/```json code fence, and/or
 * prose before or after the JSON object (e.g. "We need to..." followed by the object). Tries the
 * raw content first, then the fence-stripped version, then the substring between the first "{"
 * and the last "}" (of both the raw and fence-stripped text). If all of those fail, makes one more
 * last-resort pass over the same candidates with quoteBareKeys() applied, to recover JS-object-
 * literal-style output with unquoted keys. If every attempt fails, throws the error from the last
 * attempt — a genuine extraction failure that should route to pending-review.
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

  for (const candidate of candidates) {
    try {
      return JSON.parse(quoteBareKeys(candidate));
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

// --- time field validation ---
//
// A genuine statement's `time` is either empty (many Artesh events carry no time at all — an
// existing, accepted convention) or a bare "HH:MM", optionally prefixed with the Persian weekday
// and Jalali date the article itself was time-stamped with (e.g. "دوشنبه ۲۹ تیر ۱۴۰۵، ۱۴:۴۵", or
// the "-"-separated style real feed items actually use: "سه‌شنبه ۳۰ تیر ۱۴۰۵ - ۰۹:۲۸"). Anything
// else — a full descriptive sentence, a bare ISO 8601 timestamp, a placeholder word like
// "morning"/"today", or a date whose year falls outside this project's known timeline — is a sign
// the model dumped free text into the field instead of extracting a clock time.
const TIME_HHMM_ONLY_RE = /^([۰-۹0-9]{1,2}):([۰-۹0-9]{2})$/;
const PERSIAN_WEEKDAY_RE = '(?:شنبه|یکشنبه|دوشنبه|سه[‌ ]?شنبه|چهارشنبه|پنج[‌ ]?شنبه|جمعه)';
const TIME_WITH_DATE_PREFIX_RE = new RegExp(
  `^${PERSIAN_WEEKDAY_RE}\\s+([۰-۹0-9]{1,2})\\s+(${JALALI_MONTHS.join('|')})\\s+([۰-۹0-9]{2,4})[\\s،,\\-–]+([۰-۹0-9]{1,2}):([۰-۹0-9]{2})$`
);
const KNOWN_JALALI_YEAR_MIN = 1404;
const KNOWN_JALALI_YEAR_MAX = 1406;
const KNOWN_GREGORIAN_YEAR_MIN = 2026;
const KNOWN_GREGORIAN_YEAR_MAX = 2027;

/** Folds the Arabic-yeh/kaf/hamza variants a real feed sometimes uses (e.g. "تير" instead of
 *  "تیر") to their standard Persian equivalents, without touching digits or anything else — used
 *  only to make the weekday/month match in isValidTimeField tolerant of that letter variance. */
function foldPersianLetterVariants(str) {
  return str.replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک');
}

function isKnownYear(yearStr) {
  const year = parseInt(persianToLatinDigits(yearStr), 10);
  if (Number.isNaN(year)) return false;
  return (
    (year >= KNOWN_JALALI_YEAR_MIN && year <= KNOWN_JALALI_YEAR_MAX) ||
    (year >= KNOWN_GREGORIAN_YEAR_MIN && year <= KNOWN_GREGORIAN_YEAR_MAX)
  );
}

// --- report-relative time phrase detection ---
//
// Some Artesh statements give the time relative to when the statement/report itself was issued
// ("ساعاتی پیش از گزارش" - a few hours before this report, "لحظاتی پیش" - moments ago, "امروز صبح" /
// "بامداد امروز" - this morning) rather than a clock time or omitting time entirely. These carry no
// reliable absolute time, so they're accepted by the validator but normalized to the empty string
// (the existing convention for Artesh events with no known time) — see normalizeTimeField below —
// rather than being rejected or stored as free text. This is a generous keyword/pattern whitelist
// rather than an exhaustive phrase list, since real feed items phrase this in varying ways; note it
// deliberately matches only "پیش" (not "قبل") for the bare "<unit> ago" shape, since a bare "<unit>
// قبل" with no other context (e.g. "ساعاتی قبل") is still too vague/placeholder-like to trust and is
// rejected, same as before this change.
const RELATIVE_TIME_PATTERNS = [
  /(?:لحظ[ه‌]*ات?[یی]?|دقایق[یی]?|دقیقه[یی]?|ساعات[یی]?|ساعتی)[\s‌]*پیش/, // "لحظاتی/دقایقی/ساعاتی پیش" - moments/minutes/hours ago
  /پیش[\s‌]*از[\s‌]*(?:این[\s‌]*)?گزارش/, // "پیش از (این) گزارش" - before (this) report
  /امروز[\s‌]*(?:صبح|بامداد|ظهر|عصر|شب|شامگاه)|(?:صبح|بامداد|ظهر|عصر|شب|شامگاه)[\s‌]*امروز/, // "امروز صبح" / "بامداد امروز" and similar day-part + "امروز" combos
  /دیشب|امشب/, // "دیشب" (last night) / "امشب" (tonight)
  /هم[‌\s]*اکنون|همین[‌\s]*حالا/, // "هم‌اکنون" / "همین حالا" - right now
  /به[‌\s]*تازگی|اخیرا/, // "به تازگی" / "اخیراً" - recently
];

/** True if `str` is a report-relative time phrase (see RELATIVE_TIME_PATTERNS above) rather than an
 *  absolute clock time — e.g. "ساعاتی پیش از گزارش", "لحظاتی پیش", "امروز صبح". */
export function isRelativeTimePhrase(str) {
  if (typeof str !== 'string') return false;
  const trimmed = foldPersianLetterVariants(str.trim());
  if (trimmed === '') return false;
  return RELATIVE_TIME_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Validates the `time` field: empty/missing is fine (an accepted convention for Artesh events
 * with no reported time), as is a bare "HH:MM", a "<weekday> <day> <month> <year><sep>HH:MM"
 * string in the style real feed items use, or a report-relative phrase (see isRelativeTimePhrase
 * above). Rejects anything else — a full sentence, an ISO 8601 timestamp, a bare placeholder word
 * ("morning"/"today"), or a date whose year isn't in this project's known range — since those are
 * signs of the model dumping free text into the field.
 */
export function isValidTimeField(time) {
  if (time == null) return true;
  if (typeof time !== 'string') return false;
  const trimmed = time.trim();
  if (trimmed === '') return true;
  if (TIME_HHMM_ONLY_RE.test(trimmed)) return true;
  if (isRelativeTimePhrase(trimmed)) return true;

  const m = foldPersianLetterVariants(trimmed).match(TIME_WITH_DATE_PREFIX_RE);
  if (m) return isKnownYear(m[3]);
  return false;
}

/** Normalizes a report-relative time phrase (see isRelativeTimePhrase) to the empty string — the
 *  existing convention for Artesh events with no known absolute time — leaving any other value
 *  (empty, absolute HH:MM, weekday+date+HH:MM) untouched. */
export function normalizeTimeField(time) {
  if (typeof time === 'string' && isRelativeTimePhrase(time)) return '';
  return time;
}

// --- wave field normalization/validation ---
//
// Real statements commonly omit a wave number entirely (see the "—" default below); a model
// occasionally returns the literal word "unknown"/"null"/"none" instead of just leaving it empty,
// which is normalized the same way. Anything containing characters outside Persian text, digits,
// spaces, and "/()-" (e.g. a stray "|" or Latin letters, as in "|mizan") is rejected outright
// rather than silently accepted, since it's a sign of corrupted model output, not a real wave label.
const WAVE_NULL_LITERALS = new Set(['unknown', 'null', 'none']);
const WAVE_ALLOWED_CHARS_RE = /^[؀-ۿ‌0-9\s/()—-]*$/;

// --- weapon/outcome/target "unknown"/"null" literal normalization ---
//
// Same failure mode as `wave` above: a model occasionally returns the literal English word
// "unknown"/"null"/"none" for target/weapon/outcome instead of the dataset's actual placeholder
// for "not specified" — existing events.json already uses "نامشخص" 13 times for `weapon`, so that's
// the established convention to normalize to (rather than wave's "—", which is specific to that
// field). Applied to target/outcome too for consistency, since both are required fields and a
// literal "unknown" is just as wrong there.
const TEXT_NULL_LITERALS = WAVE_NULL_LITERALS;
const UNSPECIFIED_TEXT_PLACEHOLDER = 'نامشخص';

// --- language-purity check on target/weapon/outcome ---
//
// Both Sepah and Artesh are Persian-language outlets; a field that comes back majority-Latin is a
// sign the model translated (or hallucinated in English) instead of extracting the source text.
// Short embedded Latin tokens — weapon/aircraft model names like "MQ-9", "F-15", "HIMARS", "C-RAM"
// — are common and legitimate in genuine output, so this counts letters across the whole combined
// target+weapon+outcome text rather than flagging on any Latin character at all: a couple of model
// names surrounded by Persian sentences stays Persian-majority, while whole English sentences
// ("US forces", "United Nations") tip the balance the other way.
const LATIN_LETTER_COUNT_RE = /[A-Za-z]/g;
const PERSIAN_ARABIC_LETTER_COUNT_RE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g;

/** True if `text`'s Latin letters outnumber its Persian/Arabic letters — see comment above. */
export function isLatinMajority(text) {
  if (typeof text !== 'string' || text === '') return false;
  const latinCount = (text.match(LATIN_LETTER_COUNT_RE) || []).length;
  const persianCount = (text.match(PERSIAN_ARABIC_LETTER_COUNT_RE) || []).length;
  return latinCount > persianCount;
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
  // rather than fail validation on it alone. A model-returned "unknown"/"null"/"none" literal gets
  // the same treatment.
  if (typeof ex.wave !== 'string' || ex.wave.trim() === '') {
    ex.wave = '—';
  } else if (WAVE_NULL_LITERALS.has(ex.wave.trim().toLowerCase())) {
    ex.wave = '—';
  } else if (!WAVE_ALLOWED_CHARS_RE.test(ex.wave)) {
    errors.push(`wave contains disallowed characters: ${ex.wave}`);
  }

  for (const field of ['target', 'weapon', 'outcome']) {
    if (typeof ex[field] === 'string' && TEXT_NULL_LITERALS.has(ex[field].trim().toLowerCase())) {
      ex[field] = UNSPECIFIED_TEXT_PLACEHOLDER;
    }
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
  if (!isValidTimeField(ex.time)) errors.push(`invalid time field value: ${ex.time}`);
  else ex.time = normalizeTimeField(ex.time);
  if (looksGarbled(`${ex.target || ''} ${ex.weapon || ''} ${ex.outcome || ''}`)) {
    errors.push('target/weapon/outcome text looks corrupted/garbled (unexpected script mixing)');
  }
  if (isLatinMajority(`${ex.target || ''} ${ex.weapon || ''} ${ex.outcome || ''}`)) {
    errors.push('target/weapon/outcome text is majority Latin-script (likely untranslated/English output)');
  }
  return { ok: errors.length === 0, errors };
}

// --- code-based deduplication against existing events (Sepah only — see extractArteshCode) ---
//
// The 91 hand-curated events entered before the RSS pipeline existed were never tracked in
// seen-guids.json, so the RSS crawl can rediscover the same real-world statement and try to add it
// as a brand-new entry. Sepah's `code` (the numeric news-article id parsed out of the link, see
// extractCodeFromLink) is a reliable identifier for "same underlying statement" — Artesh has no
// such id (extractArteshCode always returns ''), so this only ever matches on a non-empty code,
// which naturally limits it to Sepah.
const CODE_DIGITS_RE = /[۰-۹0-9]/;

/** Existing `events` entries whose `code` matches `code` once both sides are digit-normalized
 *  (existing hand-curated events store Persian-digit codes; freshly-parsed ones are Latin-digit —
 *  see extractCodeFromLink). Returns [] if `code` is empty (e.g. every Artesh extraction). */
export function findEventsBySameCode(events, code) {
  if (!code || !CODE_DIGITS_RE.test(code)) return [];
  const normCode = persianToLatinDigits(code).trim();
  if (!normCode) return [];
  return events.filter((e) => e.code && persianToLatinDigits(e.code).trim() === normCode);
}

/**
 * Checks a resolved extraction's `code` against `events` for a hand-curated (or earlier-synced)
 * event sharing the same underlying news article. Returns null if there's no code match at all.
 * Otherwise returns `{ matches, isDuplicate }`: `isDuplicate` is true when the new extraction's
 * resolved `loc` agrees with at least one matching event's `loc` (a genuinely redundant
 * rediscovery), false when every match has a different `loc` (a real conflict — the new
 * extraction might be adding missing detail, might have the wrong location, or both; a human
 * should decide, so this routes to pending-review rather than either silently dropping it or
 * silently adding a contradicting second entry).
 */
export function checkCodeDuplicate(events, extraction) {
  const matches = findEventsBySameCode(events, extraction?.code);
  if (matches.length === 0) return null;
  const isDuplicate = matches.some((m) => m.loc === extraction.loc);
  return { matches, isDuplicate };
}

/** Builds the pending-review note describing why a code-duplicate extraction needs a human
 *  decision — which existing event id(s) it collides with and how the location differs. */
export function formatDedupConflictNote(extraction, matches) {
  const ids = matches.map((m) => m.id).join(', ');
  const existingLocs = [...new Set(matches.map((m) => m.loc))].join(' / ');
  return (
    `duplicate code ${extraction.code}, conflicts with existing event id ${ids}: ` +
    `loc differs (existing: ${existingLocs}, new: ${extraction.loc ?? extraction.loc_raw_text ?? 'null'})`
  );
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

function buildEventRecord(id, extraction) {
  return {
    id,
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
  };
}

// The two RSS sources this pipeline watches. Everything that differs between them — how their
// feed/article pages are fetched, how a "code" is derived (if at all), and what keyword combo
// counts as relevant — lives here; the extraction/validation pipeline below (processItems) is
// otherwise identical for both, driven entirely by these per-source functions/lists.
const SOURCES = [
  {
    id: 'sepah',
    rssUrl: 'https://sepahnews.ir/fa/rss/allnews',
    fetchFn: fetchArticleHtml,
    fetchArticleTextFn: fetchArticleText,
    codeFromLink: extractCodeFromLink,
    relevanceKeywords: { broad: RELEVANCE_KEYWORDS, action: ACTION_KEYWORDS },
  },
  {
    id: 'artesh',
    rssUrl: 'https://www.aja.ir/portal/rsspage/?fa-ir/news/45459/45608/اخبار',
    fetchFn: proxyFetch,
    fetchArticleTextFn: fetchArteshArticleText,
    codeFromLink: extractArteshCode,
    relevanceKeywords: { broad: ARTESH_RELEVANCE_KEYWORDS, action: ARTESH_ACTION_KEYWORDS },
  },
];

/**
 * Processes pending-review entries (retried directly by their own stored `link`) and fresh RSS
 * items, appending to `events` or `pendingReview` in place.
 *
 * Runs in two phases:
 *  1. Every entry currently in `pendingReview` is retried directly, using its own stored `link`
 *     (and `pubDate`, captured when it was first flagged) — independent of whether it still
 *     appears in the current RSS fetch. This is what lets a pending item recover even after it
 *     has aged out of the feed's ~100-item window, which the fresh-feed pass below can never
 *     reach again on its own.
 *  2. The fresh RSS feed is processed as before. An item whose guid was already resolved in
 *     phase 1 is skipped here (it's already in `events`; reprocessing it would create a
 *     duplicate). An item that's still pending after phase 1 (e.g. phase 1 failed on stale
 *     stored data) is *not* skipped — if it's still within the feed's window, this fresh-item
 *     pass gets another chance at it with up-to-date data, same as before this fix.
 *
 * Each item/entry is isolated in its own try/catch so one bad extraction (unparseable/missing
 * pubDate, a failed article-page fetch, malformed JSON, an unexpected throw anywhere in the
 * pipeline) can't abort the run — it's logged and routed to pending-review instead, and
 * processing moves on.
 *
 * date/code are derived independently rather than asked of the model: dateG comes from the
 * RSS <pubDate>, dateP is derived from dateG, and code is parsed out of the item's <link>. The
 * model only ever supplies wave/force/source/loc/loc_raw_text/target/weapon/outcome/time, from
 * the full article page text (not just the terse RSS <description>).
 *
 * A GUID is only added to `seenSet`/`newGuids` (and thus to seen-guids.json) once it's fully
 * resolved: added to events, or confidently classified irrelevant. Items routed to
 * pending-review are never marked seen, so they're retried on every subsequent run until they
 * succeed or a human resolves them by hand. Pending items already present in `pendingReview`
 * (from an earlier run) are matched by guid and updated in place rather than appended again,
 * and no second GitHub Issue is opened for them; the existing `issue_number` is carried over so
 * a later success can close it.
 *
 * `sourceId` (e.g. "sepah"/"artesh") is optional and, when provided: (1) is namespaced onto every
 * freshly-computed guid ("<sourceId>:<guid>") before it's checked against `seenSet`/pendingReview
 * or added to `newGuids`, so two sources can never collide on a bare guid that happens to match
 * (see main(), which keeps one shared seen-guids.json/pending-review.json across both sources);
 * and (2) overrides the model-supplied `source` field with `sourceId` directly, the same way
 * dateG/dateP/code are derived independently rather than trusted from the model. Left `null`
 * (the default), guids are used bare and `source` is left exactly as the model returned it —
 * this is what every pre-existing (single-source) caller/test still gets.
 */
export async function processItems(items, {
  locations,
  countries = {},
  events,
  pendingReview,
  seenSet,
  systemPrompt,
  nextId,
  sourceId = null,
  extractEventFn = extractEvent,
  openPendingReviewIssueFn = openPendingReviewIssue,
  closePendingReviewIssueFn = closePendingReviewIssue,
  fetchArticleTextFn = fetchArticleText,
  fetchArticleHtmlFn = fetchArticleHtml,
  extractPubDateFromArticleHtmlFn = extractPubDateFromArticleHtml,
  pubDateToDateGFn = pubDateToDateG,
  gregorianToJalaliFn = gregorianToJalali,
  extractCodeFromLinkFn = extractCodeFromLink,
  resolveLocationFn = resolveLocation,
  isRelevantFn = isRelevant,
  checkCodeDuplicateFn = checkCodeDuplicate,
}) {
  const newGuids = [];
  let newEventsCount = 0;
  let pendingCount = 0;
  let resolvedCount = 0;
  let duplicateCount = 0;
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
        title: item.title || existing.title || '',
        link: item.link || existing.link || '',
        pubDate: item.pubDate || existing.pubDate || null,
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
        pubDate: item.pubDate || null,
        raw_extraction: extraction ? { ...extraction, __ok: undefined } : null,
        errors,
        ...extra,
        added_at: new Date().toISOString(),
        issue_number: issueNumber ?? null,
      });
    }
    pendingCount++;
  }

  /** Runs fetch → model extraction → location resolution → validation for one item. Never throws:
   *  any failure is captured into `errors` and reported back so the caller can route to pending. */
  async function attemptExtraction(item) {
    let extraction = null;
    let errors = [];
    let locInfo = null;
    try {
      let dateG = pubDateToDateGFn(item.pubDate);
      if (!dateG && (item.pubDate === null || item.pubDate === undefined || item.pubDate === '')) {
        // No stored pubDate to retry with (e.g. a pending entry flagged before pubDate-capture
        // existed): fall back to reading a publish date off the article page itself, and persist
        // it onto `item` so routeToPending() saves it and future runs don't repeat this fallback.
        try {
          const html = await fetchArticleHtmlFn(item.link);
          const fallbackPubDate = extractPubDateFromArticleHtmlFn(html);
          const fallbackDateG = fallbackPubDate ? pubDateToDateGFn(fallbackPubDate) : null;
          if (fallbackDateG) {
            dateG = fallbackDateG;
            item.pubDate = fallbackPubDate;
          }
        } catch (fallbackErr) {
          console.warn(`sync-rss: pubDate fallback failed for ${item.link}: ${fallbackErr.message}`);
        }
      }
      if (!dateG) throw new Error(`missing/unparseable pubDate: "${item.pubDate ?? ''}"`);
      const dateP = gregorianToJalaliFn(dateG);
      const code = extractCodeFromLinkFn(item.link);

      const articleText = await fetchArticleTextFn(item.link);

      extraction = await extractEventFn(item, systemPrompt, articleText);
      extraction.dateG = dateG;
      extraction.dateP = dateP;
      extraction.code = code;
      if (sourceId) extraction.source = sourceId;

      locInfo = resolveLocationFn(extraction.loc, extraction.loc_raw_text, locations, countries);
      extraction.loc = locInfo.resolvedLoc;

      const dedup = checkCodeDuplicateFn(events, extraction);

      ({ ok: extraction.__ok, errors } = validateExtraction(extraction, locations));
      return { extraction, errors, locInfo, dedup };
    } catch (err) {
      errors = [`extraction failed: ${err.message}`];
    }
    return { extraction, errors, locInfo, dedup: null };
  }

  /** Attempts extraction for one item/guid and routes the result to events or pending-review.
   *  Returns true if the item resolved (added to `events`, or confirmed a redundant rediscovery
   *  of one already there). */
  async function tryResolveOrRoute(item, guid) {
    try {
      const { extraction, errors, locInfo, dedup } = await attemptExtraction(item);

      // Code-based dedup against existing events.json (see checkCodeDuplicate) takes priority
      // over ordinary quality validation: a code match means this is the same underlying news
      // article as an already-recorded event, so it's either a redundant rediscovery (same loc —
      // resolve silently, no second entry) or a genuine conflict a human needs to reconcile
      // (different loc — pending-review, regardless of whether the extraction would otherwise
      // have passed validation).
      if (dedup) {
        const existingIdx = pendingReview.findIndex((p) => p.guid === guid);

        if (dedup.isDuplicate) {
          let resolvedIssueNumber = null;
          if (existingIdx !== -1) {
            resolvedIssueNumber = pendingReview[existingIdx].issue_number;
            pendingReview.splice(existingIdx, 1);
            resolvedCount++;
          }
          duplicateCount++;
          newGuids.push(guid);
          if (resolvedIssueNumber) {
            const matchIds = dedup.matches.map((m) => m.id).join(', ');
            await closePendingReviewIssueFn(
              resolvedIssueNumber,
              `Resolved automatically: duplicate of existing event id ${matchIds} (same code, same location).`
            );
          }
          return true;
        }

        const conflictNote = formatDedupConflictNote(extraction, dedup.matches);
        await routeToPending(item, guid, extraction, [...errors, conflictNote], locInfo);
        return false;
      }

      if (!extraction || !extraction.__ok) {
        await routeToPending(item, guid, extraction, errors, locInfo);
        return false;
      }

      const existingIdx = pendingReview.findIndex((p) => p.guid === guid);
      let resolvedIssueNumber = null;
      if (existingIdx !== -1) {
        resolvedIssueNumber = pendingReview[existingIdx].issue_number;
        pendingReview.splice(existingIdx, 1);
        resolvedCount++;
      }

      events.push(buildEventRecord(id++, extraction));
      newEventsCount++;
      newGuids.push(guid);

      if (resolvedIssueNumber) {
        await closePendingReviewIssueFn(resolvedIssueNumber, 'Resolved automatically on retry.');
      }
      return true;
    } catch (err) {
      console.error(`sync-rss: unexpected error processing item (guid=${guid}):`, err);
      await routeToPending(item, guid, null, [`unexpected error: ${err.message}`]);
      return false;
    }
  }

  // Phase 1: retry every pending-review entry directly by its own stored link/pubDate, before
  // touching the fresh feed at all — see the function-level doc comment above.
  const resolvedThisRun = new Set();
  for (const pending of [...pendingReview]) {
    const guid = pending.guid;
    if (!guid) continue;
    const pseudoItem = { guid, link: pending.link, title: pending.title, pubDate: pending.pubDate ?? null };
    const resolved = await tryResolveOrRoute(pseudoItem, guid);
    if (resolved) resolvedThisRun.add(guid);
  }

  // Phase 2: process the fresh RSS feed as before.
  for (const item of items) {
    const rawGuid = itemGuid(item);
    const guid = rawGuid && sourceId ? `${sourceId}:${rawGuid}` : rawGuid;
    if (!guid || seenSet.has(guid) || resolvedThisRun.has(guid)) continue;

    if (!isRelevantFn(item)) {
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

    await tryResolveOrRoute(item, guid);
  }

  return { newGuids, newEventsCount, pendingCount, resolvedCount, duplicateCount };
}

/** True source ids (e.g. "sepah") for the split guid's leading segment, false for anything else
 *  (including a bare legacy guid with no colon at all, or a URL-shaped guid like
 *  "https://sepahnews.ir/..." whose first segment is "https"). */
function hasKnownSourcePrefix(guid) {
  if (typeof guid !== 'string') return false;
  const colonIdx = guid.indexOf(':');
  const prefix = colonIdx === -1 ? '' : guid.slice(0, colonIdx);
  return SOURCES.some((s) => s.id === prefix);
}

/** Namespaces a guid onto its source ("<sourceId>:<guid>"), unless it's already namespaced.
 *  seen-guids.json/pending-review.json predate multi-source support and hold bare guids that were
 *  all produced by the Sepah pipeline (the only source that existed then) — those get the "sepah:"
 *  prefix applied here on read, so they line up with the namespaced format new entries use without
 *  needing a one-off migration script, and so an old pending Sepah item keeps being retried
 *  (matched, source-filtered) exactly as before. */
function namespaceLegacyGuid(guid) {
  if (typeof guid !== 'string' || guid === '') return guid;
  return hasKnownSourcePrefix(guid) ? guid : `sepah:${guid}`;
}

function sourceLabel(id) {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export async function main({ dataDir = DATA } = {}) {
  const locations = await readJson(dataDir, 'locations.json', {});
  const countries = await readJson(dataDir, 'countries.json', {});
  const events = await readJson(dataDir, 'events.json', []);
  const rawSeenGuids = await readJson(dataDir, 'seen-guids.json', []);
  const pendingReview = await readJson(dataDir, 'pending-review.json', []);

  const seenGuids = rawSeenGuids.map(namespaceLegacyGuid);
  const seenSet = new Set(seenGuids);
  for (const pending of pendingReview) {
    if (pending && typeof pending === 'object') pending.guid = namespaceLegacyGuid(pending.guid);
  }

  const systemPrompt = buildSystemPrompt(locations);
  const allNewGuids = [];
  let totalNewEvents = 0;
  let totalPending = 0;
  let totalResolved = 0;
  let totalDuplicates = 0;
  const summaryLines = [];

  for (const source of SOURCES) {
    const sourcePrefix = `${source.id}:`;
    // Scope pending-review retries (processItems' Phase 1) to this source's own entries only —
    // otherwise e.g. Sepah's direct-fetch transport would be used to retry an Artesh pending item
    // (an aja.ir link), which can only ever fail, and would wastefully double-process every
    // pending item once per source on every run.
    const sourcePending = pendingReview.filter((p) => (p.guid || '').startsWith(sourcePrefix));
    const otherPending = pendingReview.filter((p) => !(p.guid || '').startsWith(sourcePrefix));

    try {
      const xml = await source.fetchFn(source.rssUrl);
      const parser = new XMLParser({ ignoreAttributes: false });
      const feed = parser.parse(xml);
      const rawItems = feed?.rss?.channel?.item;
      const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

      const nextId = events.reduce((max, e) => Math.max(max, e.id), 0) + 1;

      const { newGuids, newEventsCount, pendingCount, resolvedCount, duplicateCount } = await processItems(items, {
        locations, countries, events, pendingReview: sourcePending, seenSet, systemPrompt, nextId,
        sourceId: source.id,
        fetchArticleTextFn: source.fetchArticleTextFn,
        fetchArticleHtmlFn: source.fetchFn,
        extractCodeFromLinkFn: source.codeFromLink,
        isRelevantFn: (item) => isRelevant(item, source.relevanceKeywords),
      });

      pendingReview.length = 0;
      pendingReview.push(...otherPending, ...sourcePending);

      allNewGuids.push(...newGuids);
      totalNewEvents += newEventsCount;
      totalPending += pendingCount;
      totalResolved += resolvedCount;
      totalDuplicates += duplicateCount;

      summaryLines.push(
        `${sourceLabel(source.id)}: ${items.length} items — ${newEventsCount} new, ${pendingCount} pending, ` +
          `${duplicateCount} duplicate (existing code), ${newGuids.length - newEventsCount - duplicateCount} irrelevant.`
      );
    } catch (err) {
      // A whole-source failure (e.g. the aja.ir proxy VPS is down) must not prevent the other
      // source from syncing — restore its pending entries untouched and move on, same "one bad
      // part can't crash the run" guarantee processItems already gives per-item.
      pendingReview.length = 0;
      pendingReview.push(...otherPending, ...sourcePending);
      console.error(`sync-rss: source "${source.id}" failed entirely, skipping this run: ${err.message}`);
      summaryLines.push(`${sourceLabel(source.id)}: failed to sync (${err.message}).`);
    }
  }

  if (allNewGuids.length) {
    await writeJson(dataDir, 'seen-guids.json', [...seenGuids, ...allNewGuids]);
  }
  if (totalNewEvents > 0) {
    await writeJson(dataDir, 'events.json', events);
    await writeJson(dataDir, 'meta.json', computeMeta(events));
  }
  if (totalPending > 0 || totalResolved > 0) {
    await writeJson(dataDir, 'pending-review.json', pendingReview);
  }

  for (const line of summaryLines) console.log(line);

  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) {
    await fs.appendFile(outFile, `new_events_count=${totalNewEvents}\npending_count=${totalPending}\nresolved_count=${totalResolved}\nduplicate_count=${totalDuplicates}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
