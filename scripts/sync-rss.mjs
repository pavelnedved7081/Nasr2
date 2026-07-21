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

function isJalaliLeapYear(year) {
  // 33-year cycle approximation, adequate for near-term years around 1405.
  const cycle = [1, 5, 9, 13, 17, 22, 26, 30];
  return cycle.includes(((year % 33) + 33) % 33);
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

function isRelevant(item) {
  const haystack = `${item.title || ''} ${item.description || ''}`;
  return RELEVANCE_KEYWORDS.some((kw) => haystack.includes(kw));
}

function buildSystemPrompt(locations) {
  const locList = Object.entries(locations)
    .map(([id, loc]) => `  - ${id}: ${loc.name} (${loc.country})`)
    .join('\n');
  return `شما یک استخراج‌کنندهٔ داده هستید. یک قطعه خبر فارسی از سپاه‌نیوز دریافت می‌کنید که ممکن است دربارهٔ یک حملهٔ مشخص در عملیات «نصر ۲» یا «صاعقه» باشد.

فقط از میان این مکان‌های معتبر (شناسه: نام) انتخاب کنید — هیچ شناسهٔ دیگری یا مختصات جدید نسازید:
${locList}

کشورهای معتبر: jordan, kuwait, bahrain, qatar, oman, syria, hormuz, iran
نیروهای معتبر: ground, naval, aerospace, joint, unknown
منابع معتبر: sepah (سپاه پاسداران), artesh (ارتش جمهوری اسلامی)

خروجی باید دقیقاً این ساختار JSON را داشته باشد:
{wave, force, source, loc, loc_raw_text, target, weapon, outcome, code, dateP, time}

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
      code: { type: 'string' },
      dateP: { type: 'string' },
      time: { type: 'string' },
    },
    required: ['wave', 'force', 'source', 'loc', 'loc_raw_text', 'target', 'weapon', 'outcome', 'code', 'dateP', 'time'],
  };
}

async function extractEvent(item, systemPrompt) {
  const userContent = `عنوان: ${item.title || ''}\n\nمتن: ${item.description || ''}`;
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
  return JSON.parse(content);
}

/** Validate a model extraction. Returns {ok, errors}. */
export function validateExtraction(ex, locations) {
  const errors = [];
  if (!ex || typeof ex !== 'object') return { ok: false, errors: ['not an object'] };
  for (const field of ['wave', 'force', 'source', 'target', 'weapon', 'outcome']) {
    if (typeof ex[field] !== 'string' || ex[field].trim() === '') {
      errors.push(`missing/empty required field: ${field}`);
    }
  }
  if (ex.force && !VALID_FORCES.includes(ex.force)) errors.push(`invalid force: ${ex.force}`);
  if (ex.source && !VALID_SOURCES.includes(ex.source)) errors.push(`invalid source: ${ex.source}`);
  if (ex.loc != null && !(ex.loc in locations)) errors.push(`unknown loc id: ${ex.loc}`);
  if (ex.loc == null) errors.push('loc is null');
  if (!isValidJalaliDateString(ex.dateP)) errors.push(`unparseable date: ${ex.dateP}`);
  return { ok: errors.length === 0, errors };
}

async function openPendingReviewIssue(item, extraction, errors) {
  const token = process.env.GITHUB_TOKEN;
  const repoSlug = process.env.GITHUB_REPOSITORY;
  if (!token || !repoSlug) {
    console.warn('GITHUB_TOKEN/GITHUB_REPOSITORY not set; skipping issue creation');
    return;
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
 * Each item is isolated in its own try/catch so one bad extraction (unparseable date,
 * malformed JSON, an unexpected throw anywhere in the pipeline) can't abort the run —
 * it's logged and routed to pending-review instead, and the loop moves on.
 */
export async function processItems(items, {
  locations,
  events,
  pendingReview,
  seenSet,
  systemPrompt,
  nextId,
  extractEventFn = extractEvent,
  openPendingReviewIssueFn = openPendingReviewIssue,
}) {
  const newGuids = [];
  let newEventsCount = 0;
  let pendingCount = 0;
  let id = nextId;

  for (const item of items) {
    const guid = itemGuid(item);
    if (!guid || seenSet.has(guid)) continue;

    if (!isRelevant(item)) {
      newGuids.push(guid);
      continue;
    }

    try {
      let extraction = null;
      let errors = [];
      try {
        extraction = await extractEventFn(item, systemPrompt);
        ({ ok: extraction.__ok, errors } = validateExtraction(extraction, locations));
      } catch (err) {
        errors = [`extraction failed: ${err.message}`];
      }

      if (!extraction || !extraction.__ok) {
        pendingReview.push({
          title: item.title || '',
          link: item.link || '',
          guid,
          raw_extraction: extraction ? { ...extraction, __ok: undefined } : null,
          errors,
          added_at: new Date().toISOString(),
        });
        await openPendingReviewIssueFn(item, extraction, errors);
        pendingCount++;
        newGuids.push(guid);
        continue;
      }

      const dateG = jalaliToGregorian(extraction.dateP);
      events.push({
        id: id++,
        dateG,
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
    } catch (err) {
      console.error(`sync-rss: unexpected error processing item (guid=${guid}):`, err);
      pendingReview.push({
        title: item.title || '',
        link: item.link || '',
        guid,
        raw_extraction: null,
        errors: [`unexpected error: ${err.message}`],
        added_at: new Date().toISOString(),
      });
      pendingCount++;
      newGuids.push(guid);
    }
  }

  return { newGuids, newEventsCount, pendingCount };
}

export async function main({ dataDir = DATA } = {}) {
  const locations = await readJson(dataDir, 'locations.json', {});
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

  const { newGuids, newEventsCount, pendingCount } = await processItems(items, {
    locations, events, pendingReview, seenSet, systemPrompt, nextId,
  });

  if (newGuids.length) {
    await writeJson(dataDir, 'seen-guids.json', [...seenGuids, ...newGuids]);
  }
  if (newEventsCount > 0) {
    await writeJson(dataDir, 'events.json', events);
    await writeJson(dataDir, 'meta.json', computeMeta(events));
  }
  if (pendingCount > 0) {
    await writeJson(dataDir, 'pending-review.json', pendingReview);
  }

  console.log(`Processed ${items.length} RSS items: ${newEventsCount} new events, ${pendingCount} pending review, ${newGuids.length - newEventsCount - pendingCount} irrelevant.`);

  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) {
    await fs.appendFile(outFile, `new_events_count=${newEventsCount}\npending_count=${pendingCount}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
