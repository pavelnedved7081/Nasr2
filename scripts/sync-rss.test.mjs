import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  jalaliToGregorian,
  gregorianToJalali,
  pubDateToDateG,
  extractCodeFromLink,
  isValidJalaliDateString,
  validateExtraction,
  processItems,
  main,
  parseModelJson,
  resolveLocation,
  normalizeLocText,
  levenshtein,
  looksGarbled,
  isRelevant,
  extractPubDateFromArticleHtml,
  extractArticleBody,
  extractSpanContent,
  extractArteshCode,
  proxyFetch,
} from './sync-rss.mjs';

const LOCATIONS = {
  princeHassan: { name: 'پایگاه هوایی پرنس حسن', country: 'jordan', lat: 30.2833, lng: 36.0833 },
  alAzraq: { name: 'پایگاه هوایی الازرق', country: 'jordan', lat: 31.9328, lng: 36.8206 },
  aliAlSalem: { name: 'پایگاه هوایی علی‌السالم', country: 'kuwait', lat: 29.3469, lng: 47.5213 },
  ramshir: { name: 'منطقه رامشیر (پدافند هوایی)', country: 'iran', lat: 30.9, lng: 49.4 },
};

const COUNTRIES = {
  jordan: { label_fa: 'اردن', label_en: 'Jordan', label_ar: 'الأردن' },
  kuwait: { label_fa: 'کویت', label_en: 'Kuwait', label_ar: 'الكويت' },
  iran: { label_fa: 'ایران (پدافند داخلی)', label_en: 'Iran (domestic air defense)', label_ar: 'إيران' },
};

function validExtraction(overrides = {}) {
  return {
    wave: '1',
    force: 'aerospace',
    source: 'sepah',
    loc: 'princeHassan',
    loc_raw_text: null,
    target: 'پایگاه هوایی',
    weapon: 'موشک',
    outcome: 'اصابت مستقیم',
    time: '08:00',
    ...overrides,
  };
}

function rssItem(guid, overrides = {}) {
  return {
    guid,
    link: `https://sepahnews.ir/fa/news/36159/${guid}`,
    title: 'اطلاعیه نصر ۲',
    description: 'موج اول عملیات صاعقه، پایگاه دشمن منهدم شد',
    pubDate: 'Wed, 08 Jul 2026 08:00:00 +0330',
    ...overrides,
  };
}

// --- isValidJalaliDateString / jalaliToGregorian / gregorianToJalali ---

test('isValidJalaliDateString accepts a well-formed Jalali date', () => {
  assert.equal(isValidJalaliDateString('۱۷ تیر ۱۴۰۵'), true);
});

test('isValidJalaliDateString rejects "unknown"', () => {
  assert.equal(isValidJalaliDateString('unknown'), false);
});

test('isValidJalaliDateString rejects missing/empty/non-string values', () => {
  assert.equal(isValidJalaliDateString(''), false);
  assert.equal(isValidJalaliDateString(undefined), false);
  assert.equal(isValidJalaliDateString(null), false);
  assert.equal(isValidJalaliDateString(42), false);
});

test('isValidJalaliDateString rejects an unrecognized month name', () => {
  assert.equal(isValidJalaliDateString('۱۷ نامعتبر ۱۴۰۵'), false);
});

test('jalaliToGregorian still throws on unparseable input (internal invariant)', () => {
  assert.throws(() => jalaliToGregorian('unknown'));
});

test('gregorianToJalali is the inverse of jalaliToGregorian at the Tir-1-1405 epoch', () => {
  assert.equal(gregorianToJalali('2026-06-22'), '۱ تیر ۱۴۰۵');
  assert.equal(jalaliToGregorian('۱ تیر ۱۴۰۵'), '2026-06-22');
});

test('gregorianToJalali round-trips a date past the epoch', () => {
  assert.equal(gregorianToJalali('2026-07-08'), '۱۷ تیر ۱۴۰۵');
  assert.equal(jalaliToGregorian('۱۷ تیر ۱۴۰۵'), '2026-07-08');
});

test('gregorianToJalali round-trips a date before the epoch, crossing a month boundary', () => {
  const dateP = gregorianToJalali('2026-06-15');
  assert.equal(jalaliToGregorian(dateP), '2026-06-15');
});

// --- pubDate -> dateG ---

test('pubDateToDateG converts a standard RFC 822 pubDate to an ISO date', () => {
  assert.equal(pubDateToDateG('Wed, 08 Jul 2026 08:00:00 +0330'), '2026-07-08');
});

test('pubDateToDateG converts a GMT-suffixed RFC 822 pubDate to an ISO date', () => {
  assert.equal(pubDateToDateG('Mon, 22 Jun 2026 00:00:00 GMT'), '2026-06-22');
});

test('pubDateToDateG returns null for missing/empty pubDate', () => {
  assert.equal(pubDateToDateG(undefined), null);
  assert.equal(pubDateToDateG(null), null);
  assert.equal(pubDateToDateG(''), null);
  assert.equal(pubDateToDateG('   '), null);
});

test('pubDateToDateG returns null for an unparseable pubDate', () => {
  assert.equal(pubDateToDateG('not a date'), null);
});

// --- code extraction from <link> ---

test('extractCodeFromLink extracts the numeric code from a Sepah News article URL', () => {
  assert.equal(extractCodeFromLink('https://sepahnews.ir/fa/news/36159/some-slug'), '36159');
});

test('extractCodeFromLink extracts the code regardless of surrounding path segments', () => {
  assert.equal(extractCodeFromLink('https://sepahnews.ir/fa/news/1/x'), '1');
  assert.equal(extractCodeFromLink('https://sepahnews.ir/en/news/987654/another-slug/'), '987654');
});

test('extractCodeFromLink returns empty string when the URL has no /news/<id>/ segment', () => {
  assert.equal(extractCodeFromLink('https://sepahnews.ir/fa/about'), '');
  assert.equal(extractCodeFromLink(undefined), '');
  assert.equal(extractCodeFromLink(null), '');
});

// --- validateExtraction ---

test('validateExtraction rejects an otherwise-valid extraction with dateP "unknown"', () => {
  const { ok, errors } = validateExtraction(validExtraction({ dateP: 'unknown' }), LOCATIONS);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('unparseable date')));
});

test('validateExtraction accepts a fully valid extraction with dateG/dateP/code attached', () => {
  const ex = validExtraction({ dateG: '2026-07-08', dateP: '۱۷ تیر ۱۴۰۵', code: '36159' });
  const { ok } = validateExtraction(ex, LOCATIONS);
  assert.equal(ok, true);
});

test('validateExtraction does not require the model to supply code', () => {
  const ex = validExtraction({ dateG: '2026-07-08', dateP: '۱۷ تیر ۱۴۰۵', code: '' });
  const { ok } = validateExtraction(ex, LOCATIONS);
  assert.equal(ok, true);
});

// --- Fix 3: wave is optional, defaults to "—" ---

test('validateExtraction defaults a missing wave to "—" and does not fail validation on it', () => {
  const ex = validExtraction({ dateG: '2026-07-08', dateP: '۱۷ تیر ۱۴۰۵' });
  delete ex.wave;
  const { ok, errors } = validateExtraction(ex, LOCATIONS);
  assert.equal(ok, true);
  assert.equal(ex.wave, '—');
  assert.ok(!errors.some((e) => e.includes('wave')));
});

test('validateExtraction defaults an empty-string wave to "—"', () => {
  const ex = validExtraction({ wave: '  ', dateG: '2026-07-08', dateP: '۱۷ تیر ۱۴۰۵' });
  const { ok } = validateExtraction(ex, LOCATIONS);
  assert.equal(ok, true);
  assert.equal(ex.wave, '—');
});

test('validateExtraction still fails when a genuinely required field (e.g. target) is missing', () => {
  const ex = validExtraction({ target: '', dateG: '2026-07-08', dateP: '۱۷ تیر ۱۴۰۵' });
  const { ok, errors } = validateExtraction(ex, LOCATIONS);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('target')));
});

// --- Fix 4: output sanity check (garbled/mixed-script text) ---

test('looksGarbled flags Hebrew-range characters', () => {
  assert.equal(looksGarbled('به אש کشیدن یک آشیانه'), true);
});

test('looksGarbled flags a token mixing Persian and Latin letters with no separator', () => {
  assert.equal(looksGarbled('یک آochyانه پهپاد'), true);
  assert.equal(looksGarbled('صrettet 26 تير'), true);
});

test('looksGarbled flags other unusual scripts (e.g. Malayalam) mixed into Persian output', () => {
  assert.equal(looksGarbled('صampiyonനം ingresoisted در پایگاه'), true);
});

test('looksGarbled does not flag clean Persian text', () => {
  assert.equal(looksGarbled('تخریب سامانه راداری و انهدام فرودگاه'), false);
});

test('looksGarbled does not flag a field written entirely in English (untranslated, not corrupted)', () => {
  assert.equal(looksGarbled('destruction of US facilities'), false);
});

test('looksGarbled does not flag legitimate Latin abbreviations followed by Persian punctuation', () => {
  assert.equal(looksGarbled('یک آشیانه پهپادهای MQ-9، از رده خارج شد'), false);
});

test('validateExtraction rejects an extraction whose target/weapon/outcome text looks garbled', () => {
  const ex = validExtraction({
    weapon: 'شودک الاملی (fraud)',
    outcome: 'به אש کشیدن یک آشیانه',
    dateG: '2026-07-08',
    dateP: '۱۷ تیر ۱۴۰۵',
  });
  const { ok, errors } = validateExtraction(ex, LOCATIONS);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('corrupted') || e.includes('garbled')));
});

// --- Fix 1: robust JSON parsing from model output ---

test('parseModelJson parses a plain JSON object (no wrapping)', () => {
  assert.deepEqual(parseModelJson('{"a": 1}'), { a: 1 });
});

test('parseModelJson strips a ```json ... ``` code fence', () => {
  const wrapped = '```json\n{"wave": "1", "force": "aerospace"}\n```';
  assert.deepEqual(parseModelJson(wrapped), { wave: '1', force: 'aerospace' });
});

test('parseModelJson strips a plain ``` ... ``` code fence (no "json" tag)', () => {
  const wrapped = '```\n{"a": 2}\n```';
  assert.deepEqual(parseModelJson(wrapped), { a: 2 });
});

test('parseModelJson extracts the JSON object out of prose preamble', () => {
  const wrapped = 'We need to extract the event.\n\n{"a": 3, "b": "text"}';
  assert.deepEqual(parseModelJson(wrapped), { a: 3, b: 'text' });
});

test('parseModelJson extracts the JSON object out of prose both before and after it', () => {
  const wrapped = 'Here is the result:\n{"a": 4}\nHope that helps!';
  assert.deepEqual(parseModelJson(wrapped), { a: 4 });
});

test('parseModelJson handles a code fence AND prose together', () => {
  const wrapped = 'Sure, here you go:\n```json\n{"a": 5}\n```\nLet me know if you need more.';
  assert.deepEqual(parseModelJson(wrapped), { a: 5 });
});

test('parseModelJson still throws on genuinely non-JSON content', () => {
  assert.throws(() => parseModelJson('I cannot determine the event from this text.'));
});

// --- Bug B: repair JS-object-literal-style output (unquoted keys) ---

test('parseModelJson repairs a JS-object-literal-style response with unquoted keys (last-resort fallback)', () => {
  const jsLiteral = '{wave: "24", force: "aerospace", loc: null, count: 3}';
  assert.deepEqual(parseModelJson(jsLiteral), { wave: '24', force: 'aerospace', loc: null, count: 3 });
});

test('parseModelJson repairs unquoted keys even wrapped in a code fence with prose', () => {
  const wrapped = 'Here is the event:\n```json\n{wave: "1", force: "ground", source: "sepah"}\n```';
  assert.deepEqual(parseModelJson(wrapped), { wave: '1', force: 'ground', source: 'sepah' });
});

test('parseModelJson does not double-quote keys that are already quoted', () => {
  assert.deepEqual(parseModelJson('{"a": 1, "b": 2}'), { a: 1, b: 2 });
});

// --- Fix 2: fuzzy location matching ---

test('resolveLocation matches an exact location id', () => {
  const { resolvedLoc } = resolveLocation('aliAlSalem', null, LOCATIONS, COUNTRIES);
  assert.equal(resolvedLoc, 'aliAlSalem');
});

test('resolveLocation fuzzy-matches a small typo in a location id (edit distance <= 2)', () => {
  const { resolvedLoc, countryMatch } = resolveLocation('alAzrag', 'اردن', LOCATIONS, COUNTRIES);
  assert.equal(resolvedLoc, 'alAzraq');
  assert.equal(countryMatch, null);
});

test('resolveLocation matches via loc_raw_text containing a known location\'s name, tolerating ZWNJ-vs-space and missing generic words', () => {
  const { resolvedLoc } = resolveLocation(null, 'پایگاه علی السالم و جزيره بوبیان', LOCATIONS, COUNTRIES);
  assert.equal(resolvedLoc, 'aliAlSalem');
});

test('resolveLocation matches a newly-added Ramshir location via loc_raw_text substring', () => {
  const { resolvedLoc } = resolveLocation(null, 'منطقه رامشیر', LOCATIONS, COUNTRIES);
  assert.equal(resolvedLoc, 'ramshir');
});

test('resolveLocation treats a country name/typo mistakenly put in loc as loc: null with countryMatch set, not a crash or a false location match', () => {
  const { resolvedLoc, countryMatch } = resolveLocation('jordan', 'در اردن', LOCATIONS, COUNTRIES);
  assert.equal(resolvedLoc, null);
  assert.equal(countryMatch, 'jordan');
});

test('resolveLocation recognizes a close typo of a country id as a country mixup too', () => {
  const { resolvedLoc, countryMatch } = resolveLocation('jordain', 'فرودگاه ناشناخته در اردن', LOCATIONS, COUNTRIES);
  assert.equal(resolvedLoc, null);
  assert.equal(countryMatch, 'jordan');
});

test('resolveLocation returns no match plus fuzzy candidates (with distances) when nothing is confident enough', () => {
  const { resolvedLoc, countryMatch, candidates } = resolveLocation('totallyUnknownPlace', 'جایی نامشخص', LOCATIONS, COUNTRIES);
  assert.equal(resolvedLoc, null);
  assert.equal(countryMatch, null);
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((c) => typeof c.id === 'string' && typeof c.distance === 'number'));
  assert.ok(candidates[0].distance <= candidates[candidates.length - 1].distance);
});

test('normalizeLocText unifies ZWNJ with a plain space and lowercases Latin characters', () => {
  assert.equal(normalizeLocText('علی‌السالم'), normalizeLocText('علی السالم'));
  assert.equal(normalizeLocText('Aqaba'), normalizeLocText('aqaba'));
});

test('levenshtein computes edit distance correctly', () => {
  assert.equal(levenshtein('alazraq', 'alazrag'), 1);
  assert.equal(levenshtein('same', 'same'), 0);
});

// --- Fix 5: tightened relevance filter ---

test('isRelevant rejects a broad-keyword match with no military action verb (fake pages statement)', () => {
  const item = {
    title: 'بیانیه رسمی درباره صفحات جعلی منتسب به سپاه پاسداران انقلاب اسلامی',
    description: 'در پی مشاهده اطلاعیه‌های جعلی منتسب به سپاه در فضای مجازی...',
  };
  assert.equal(isRelevant(item), false);
});

test('isRelevant rejects a broad-keyword match with no military action verb (political speech)', () => {
  const item = {
    title: 'ملت ایران با حفظ وحدت و ذوب‌شدگی در ولایت، پیروز جنگ موجودیتی‌ هستند',
    description: 'در قاموس ایرانیان، تسلیم معنایی ندارد و موج حمایت مردمی ادامه دارد',
  };
  assert.equal(isRelevant(item), false);
});

test('isRelevant still accepts a genuine attack statement (broad keyword + action verb)', () => {
  const item = {
    title: 'تخریب سامانه راداری دفاع موشکی و انهدام یک فروند هواپیمای اف 15 در داخل شیلتر در اردن',
    description: 'در ادامه عملیات نصر ۲، پایگاه هوایی الازرق مورد اصابت قرار گرفت',
  };
  assert.equal(isRelevant(item), true);
});

test('isRelevant rejects an item with only the action keyword and no broad relevance keyword', () => {
  const item = { title: 'تخریب یک ساختمان مسکونی در اثر زلزله', description: '' };
  assert.equal(isRelevant(item), false);
});

// --- processItems: the core regression tests for this fix ---

test('processItems derives dateG/dateP from pubDate and code from link, not from the model', async () => {
  const items = [rssItem('guid-good')];
  const events = [];
  const pendingReview = [];

  await processItems(items, {
    locations: LOCATIONS,
    events,
    pendingReview,
    seenSet: new Set(),
    systemPrompt: 'test',
    nextId: 1,
    extractEventFn: async () => validExtraction(),
    fetchArticleTextFn: async () => 'متن کامل خبر با جزئیات بیشتر',
    openPendingReviewIssueFn: async () => {},
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].dateG, '2026-07-08');
  assert.equal(events[0].dateP, '۱۷ تیر ۱۴۰۵');
  assert.equal(events[0].code, '36159');
});

test('processItems passes the fetched article text (not the RSS description) to the model', async () => {
  const items = [rssItem('guid-good')];
  const events = [];
  const pendingReview = [];
  let receivedArticleText = null;

  await processItems(items, {
    locations: LOCATIONS,
    events,
    pendingReview,
    seenSet: new Set(),
    systemPrompt: 'test',
    nextId: 1,
    extractEventFn: async (item, systemPrompt, articleText) => {
      receivedArticleText = articleText;
      return validExtraction();
    },
    fetchArticleTextFn: async () => 'متن کامل صفحهٔ خبر شامل شمارهٔ موج و جزئیات کامل',
    openPendingReviewIssueFn: async () => {},
  });

  assert.equal(receivedArticleText, 'متن کامل صفحهٔ خبر شامل شمارهٔ موج و جزئیات کامل');
  assert.equal(events.length, 1);
});

test('processItems routes an item with missing/unparseable pubDate to pending-review without calling the model', async () => {
  const items = [rssItem('guid-bad-pubdate', { pubDate: 'not a date' })];
  const events = [];
  const pendingReview = [];
  let modelCalled = false;

  await assert.doesNotReject(() =>
    processItems(items, {
      locations: LOCATIONS,
      events,
      pendingReview,
      seenSet: new Set(),
      systemPrompt: 'test',
      nextId: 1,
      extractEventFn: async () => {
        modelCalled = true;
        return validExtraction();
      },
      fetchArticleTextFn: async () => 'متن',
      openPendingReviewIssueFn: async () => {},
    })
  );

  assert.equal(modelCalled, false);
  assert.equal(events.length, 0);
  assert.equal(pendingReview.length, 1);
  assert.equal(pendingReview[0].guid, 'guid-bad-pubdate');
  assert.ok(pendingReview[0].errors.some((e) => e.includes('pubDate')));
});

// --- extractArticleBody: stripping related-headlines noise from fetched article text ---
// Real captured stripped-text output of fetchArticleText() for news/36167 (captured via the
// "Debug article text" GitHub Actions workflow run against the live page), before this fix.
// It demonstrates the bug: a huge block of unrelated headlines (about a *different* statement
// mentioning "علی السالم"/Ali Al Salem in Kuwait, plus other unrelated events) surrounds the
// real statement body on both sides with no separator, which is what caused item 36167's
// persistent garbled/wrong-location extraction (the model saw dozens of unrelated headlines
// mixed in and produced Ali Al Salem/Kuwait instead of the real target, Al Udeid airbase/Qatar).
const CONTAMINATED_36167_TEXT = `سامانه راداری برد بلند و چندین فروند هواپیمای راهبردی سوخت‌رسان آمریکا منهدم گردید سامانه راداری برد بلند و چندین فروند هواپیمای راهبردی سوخت‌رسان آمریکا منهدم گردید مجموعه رادارهای تاکتیکی در پایگاه علی السالم و جزیره بوبیان از رده عملیاتی خارج شدند هلاکت تعدادی سرباز در هدف قرار گرفتن مجتمع محل استقرار نیروهای ارتش تروریست و کودک‌کش آمریکا در منطقه‌ی الرُکبان اردن زیرساخت مرکزی داده‌های شرکت آمریکایی آمازون در بحرین با چند فروند موشک کروز مورد هجوم قرار گرفت تخریب سامانه راداری دفاع موشکی و انهدام یک فروند هواپیمای اف 15 در داخل شیلتر در اردن پاکسازی راداری منطقه در ادامه شب سیاه سامانه ها و رادارهای آمریکایی یک سایت راداری برد بلند، یک مرکز مخابراتی و سامانه های دریافت ماهواره ای، یک رادار دفاع موشکی و یک سوله آشیانه پهپادهای MQ9 منهدم شدند شب سیاه رادارها و سامانه های پدافند هوایی آمریکا در منطقه دو نفتکش متخلف با قصد عبور از مسیر ناایمن جنوب تنگه هرمز، بر اثر انفجار دچار حریق گسترده شده و متوقف شدند ضربات سنگین دریادلان نیروی دریایی سپاه به ارتش کودک‌کش آمریکا با حمله همزمان در سه محور پیام فرماندهی کل سپاه پاسداران انقلاب اسلامی در لبیک به پیام راهبردی فرمانده معظم کل قوا سامانه رادار اخطار اولیه دشمن آمریکایی، یک سوله تجهیزات و قطعات هوایی و یک آشیانه پهپادهای MQ9 آمریکا مورد اصابت قرار گرفتند بیانیه ها و اطلاعیه ها عمومی اطلاعیه شماره ۲۴/ سامانه راداری برد بلند و چندین فروند هواپیمای راهبردی سوخت‌رسان آمریکا منهدم گردید دانلود همه تصاویر روابط عمومی سپاه پاسداران انقلاب اسلامی اعلام کرد: به منظور تنبیه متجاوز و مجازات ارتش کودک‌کش آمریکا، حمله سنگین و غافلگیرانه‌ای را به پایگاه هوایی آمریکا در العدید قطر انجام دادند که طی آن یک سامانه راداری برد بلند و چندین فروند هواپیمای راهبردی سوخت‌رسان آمریکا بطور کامل منهدم و چند فروند دیگر دچار آسیب جدی گردید. کد خبر: ۳۶۱۶۷ جمعه ۲۶ تير ۱۴۰۵ - ۱۳:۳۲ به گزارش سپاه نیوز، روابط عمومی سپاه پاسداران انقلاب اسلامی در اطلاعیه شماره ۲۴ عملیات نصر۲ اعلام کردند: بسم الله قاصم الجبارین وقاتلوهم حتی لاتکون فتنه ‌ در تکمیل عملیات مقابله به مثل شب گذشته رزمندگان غیور نیروی پرافتخار هوافضای سپاه، در موج ۱۶ عملیات نصر ۲ با رمز مبارک "یا اباصالح المهدی ادرکنی" و تقدیم به شهدای مظلوم جنایات اخیر امریکا، به منظور تنبیه متجاوز و مجازات ارتش کودک‌کش آمریکا، حمله سنگین و غافلگیرانه‌ای را به پایگاه هوایی آمریکا در العدید قطر انجام دادند که طی آن یک سامانه راداری برد بلند و چندین فروند هواپیمای راهبردی سوخت‌رسان آمریکا بطور کامل منهدم و چند فروند دیگر دچار آسیب جدی گردید. ‌ دشمن آمریکایی و میزبانان پایگاه‌های او در منطقه بدانند که عبور از خطوط قرمز و حمله به مردم و زیرساخت‌های غیرنظامی تاوان بسیار سخت و بیچاره کننده‌ای خواهد داشت و در صورت ادامه این روند توسط دشمن، پاسخ‌های خردکننده تری در راه است؛ پاسخ‌هایی که در تاریخ نبردها ماندگار خواهد شد. ‌ وماالنصر الا من عندالله العزیز الحکیم اشتراک گذاری : لینک کپی شد! کپی لینک پسندیدم ۷ گزارش خطا برچسب ها: عملیات نصر ۲ بیانیه اطلاعیه آخرین اخبار پربیننده ها پربحث ترین ها مجموعه رادارهای تاکتیکی در پایگاه علی السالم و جزیره بوبیان از رده عملیاتی خارج شدند هلاکت تعدادی سرباز در هدف قرار گرفتن مجتمع محل استقرار نیروهای ارتش تروریست و کودک‌کش آمریکا در منطقه‌ی الرُکبان اردن زیرساخت مرکزی داده‌های شرکت آمریکایی آمازون در بحرین با چند فروند موشک کروز مورد هجوم قرار گرفت تخریب سامانه راداری دفاع موشکی و انهدام یک فروند هواپیمای اف 15 در داخل شیلتر در اردن پاکسازی راداری منطقه در ادامه شب سیاه سامانه ها و رادارهای آمریکایی یک سایت راداری برد بلند، یک مرکز مخابراتی و سامانه های دریافت ماهواره ای، یک رادار دفاع موشکی و یک سوله آشیانه پهپادهای MQ9 منهدم شدند شب سیاه رادارها و سامانه های پدافند هوایی آمریکا در منطقه دو نفتکش متخلف با قصد عبور از مسیر ناایمن جنوب تنگه هرمز، بر اثر انفجار دچار حریق گسترده شده و متوقف شدند ضربات سنگین دریادلان نیروی دریایی سپاه به ارتش کودک‌کش آمریکا با حمله همزمان در سه محور پیام فرماندهی کل سپاه پاسداران انقلاب اسلامی در لبیک به پیام راهبردی فرمانده معظم کل قوا سامانه رادار اخطار اولیه دشمن آمریکایی، یک سوله تجهیزات و قطعات هوایی و یک آشیانه پهپادهای MQ9 آمریکا مورد اصابت قرار گرفتند قدردانی سپاه از اطلاعات مردم اردن؛ هواپیماهای بزرگ ترابری C17 و هواپیماهای فرمانده کنترل P8 ارتش متجاوز امریکا در فرودگاه عقبه هدف موشک بالستیک قرار گرفتند دو نفتکش که قصد تردد در مسیر ناایمن تنگه هرمز را داشتند منفجر شدند بیانیه رسمی درباره صفحات جعلی منتسب به سپاه پاسداران انقلاب اسلامی منحدراً كبيراً لتوقف الطائرات في القاعدة الأمريكية في الأزرق بالأردن حمله کوبنده و همزمان موشکی و پهپادی به شیلترهای جنگنده‌ها و یک رمپ بزرگ توقف در پایگاه آمریکا در الازرق اردن اسکله پشتیبانی سوخت ناوگان آمریکا، محل تجمع پرنده‌های جنگی دشمن، مرکز داده‌های اطلاعاتی دشمن، یک مرکز سیگنالی و مخابراتی آمریکا درهم کوبیده شدند کشورهای میزبان نظامیان متجاوز آمریکا آماده دریافت پاسخ متناظر باشند دو فروند کشتی نفتکش با عبور از مسیر ناایمن جنوب تنگه هرمز منفجر و دچار حریق گسترده شدند دپوی شمپاد های آمریکایی (شناورهای بدون سرنشین) در بحرین در هم کوبیده شد سامانه راداری برد بلند و چندین فروند هواپیمای راهبردی سوخت‌رسان آمریکا منهدم گردید سکو و موشک‌های هی‌مارس در کویت و محل استقرار نیروهای آمریکایی و ضدانقلاب در هم کوبیده شدند رادار کنترل دریایی در صخره‌های سلامه و رادار کنترل هوایی آمریکا مستقر در منطقه غنم عمان منهدم شد پایگاه دشمن در کویت در پاسخ به جنایت ارتش آمریکا، در به شهادت رساندن مردم غیر نظامی به آتش کشیده شد حمله غافلگیرانه به مرکز فرماندهی عملیات ویژه دشمن در منطقه التنف سوریه در قصاص خون سربازان شهید ایرانشهر تم تدمير رادار كشف ومراقبة المجال الجوي ومحطة ضخ خزانات وقود المقاتلات التابعة للعدو المعتدي تم تدمير مركز الاتصالات عبر الأقمار الصناعية ورادار الإنذار المبكر في القاعدة الجوية الأمريكية ورصيف العسكريين الأمريكيين رادار کشف و کنترل هوایی و ایستگاه پمپاژ مخازن سوخت جنگنده‌های دشمن در بحرین به طور کامل منهدم گردید مرکز ارتباطات ماهواره ای و رادار هشدار اولیه پایگاه هوایی آمریکا در علی السالم و اسکله نظامیان آمریکایی در شعیبیه کویت منهدم گردید رمپ نگهداری جنگنده های آمریکایی و مرکز فرماندهی و کنترل جدید آمریکا در غرب آسیا هدف موشک‌های خیبرشکن قرار گرفت رادار پیش‌هشدار سامانهء C-RAM و محل تجمع سربازان جنایت پیشه ارتش تروریستی آمریکا آماج حملات ترکیبی قرار گرفت‌ رسالة مهمة من الحرس الثوري إلى الشعب الأردني An Important Message from the Islamic Revolutionary Guard Corps (IRGC) to the People of Jordan رسالة مهمة من الحرس الثوري إلى شعب الكويت An Important Message from the IRGC to the People of Kuwait پیام مهم سپاه به مردم کویت؛ مرکز ارتباطات ماهواره ای، رادار دفاع موشکی و هوایی، مجتمع پدافند هوایی پاتریوت و آمادگاه پایگاه نظامی آمریکا و سکوهای پرتاب موشک های‌مارس در کویت منهدم شدند قدردانی سپاه از اطلاعات مردم اردن؛ هواپیماهای بزرگ ترابری C17 و هواپیماهای فرمانده کنترل P8 ارتش متجاوز امریکا در فرودگاه عقبه هدف موشک بالستیک قرار گرفتند پیام مهم سپاه به مردم کویت؛ مرکز ارتباطات ماهواره ای، رادار دفاع موشکی و هوایی، مجتمع پدافند هوایی پاتریوت و آمادگاه پایگاه نظامی آمریکا و سکوهای پرتاب موشک های‌مارس در کویت منهدم شدند حمله غافلگیرانه به مرکز فرماندهی عملیات ویژه دشمن در منطقه التنف سوریه در قصاص خون سربازان شهید ایرانشهر دو فروند کشتی نفتکش با عبور از مسیر ناایمن جنوب تنگه هرمز منفجر و دچار حریق گسترده شدند مرکز مدیریت ان اس آی، مرکز کنترل فرماندهی، انبارهای بزرگ قطعات و تجهیزات نظامی و مخازن سوخت ناوگان پنجم دریایی آمریکا در بحرین درهم کوبیده شد یک سایت راداری برد بلند، یک مرکز مخابراتی و سامانه های دریافت ماهواره ای، یک رادار دفاع موشکی و یک سوله آشیانه پهپادهای MQ9 منهدم شدند ضربات سنگین دریادلان نیروی دریایی سپاه به ارتش کودک‌کش آمریکا با حمله همزمان در سه محور حمله کوبنده و همزمان موشکی و پهپادی به شیلترهای جنگنده‌ها و یک رمپ بزرگ توقف در پایگاه آمریکا در الازرق اردن تخریب سامانه راداری دفاع موشکی و انهدام یک فروند هواپیمای اف 15 در داخل شیلتر در اردن تازه ها ضربات سنگین دریادلان نیروی دریایی سپاه به ارتش کودک‌کش آمریکا با حمله همزمان در سه محور مخازن سوخت و زاغه مهمات پایگاه هوایی پرنس حسن در اردن به آتش کشیده شد تشییع و وداع میلیونی ملت ایران و عراق تمایز حکمرانی اسلامی بر منهج امیرالمومنین (ع) با سایر مکاتب حکمرانی را آشکار ساخت مرکز فرماندهی کنترل دشمن در غرب آسیا و پایگاه هوایی الازرق اردن با ۱۰ فروند موشک بالستیک در هم کوبیده شد اطلاعیه سپاه خوزستان در پی شهادت سه نفر از سبزپوشان حریم ولایت در سحرگاه امروز انتقام الهی از آمریکای تروریست و رژیم نامشروع صهیونیستی چندان دور نیست اخبار سپاه پربازدیدها استان ها عکس`;

test('extractArticleBody strips the leading + trailing related-headlines noise from the real captured 36167 sample, keeping only the genuine statement', () => {
  const body = extractArticleBody(CONTAMINATED_36167_TEXT);
  assert.ok(
    body.startsWith('روابط عمومی سپاه پاسداران انقلاب اسلامی اعلام کرد'),
    `expected body to start with the statement opening, got: ${body.slice(0, 80)}`
  );
  assert.ok(body.includes('العدید قطر'), 'expected the real target (Al Udeid, Qatar) to survive');
  assert.ok(!body.includes('علی السالم'), 'unrelated headline (Ali Al Salem/Kuwait) leaked into the cleaned body');
  assert.ok(!body.includes('الرُکبان'), 'unrelated headline (Rukban) leaked into the cleaned body');
  assert.ok(!body.includes('آمازون'), 'unrelated headline (Amazon) leaked into the cleaned body');
  assert.ok(!body.includes('اشتراک گذاری'), 'trailing share-widget/related-headlines noise leaked into the cleaned body');
});

test('extractArticleBody falls back to the statement-opening landmark when there is no images landmark', () => {
  const statement = 'روابط عمومی سپاه پاسداران انقلاب اسلامی اعلام کرد: متن کامل بیانیه';
  const text = 'برخی عناوین نامرتبط دیگر ' + statement;
  assert.equal(extractArticleBody(text), statement);
});

test('extractArticleBody returns the text unchanged when neither landmark is found', () => {
  const text = 'یک صفحه کاملاً متفاوت بدون هیچ نشانه‌ای از ساختار شناخته‌شده';
  assert.equal(extractArticleBody(text), text);
});

test('extractArticleBody returns non-string/empty input unchanged', () => {
  assert.equal(extractArticleBody(''), '');
});

// --- pubDate fallback: extracting a publish date from the article page itself ---
// (item news/36159 was pended before pubDate-capture existed on pending entries, so its stored
// pubDate is permanently null — there's nothing to retry with unless we read it off the page.)

test('extractPubDateFromArticleHtml picks up a <meta property="article:published_time"> tag', () => {
  const html = `<!doctype html><html><head>
    <meta property="og:title" content="some title">
    <meta property="article:published_time" content="2026-07-17T13:32:20+03:30">
  </head><body>...</body></html>`;
  assert.equal(extractPubDateFromArticleHtml(html), '2026-07-17T13:32:20+03:30');
});

test('extractPubDateFromArticleHtml falls back to a <time datetime> attribute when no meta tag is present', () => {
  const html = `<html><body><time datetime="2026-07-17">۱۷ تیر</time></body></html>`;
  assert.equal(extractPubDateFromArticleHtml(html), '2026-07-17');
});

test('extractPubDateFromArticleHtml falls back to a visible Jalali date in the page text', () => {
  const html = `<html><body><div class="date">۱۷ تیر ۱۴۰۵</div><p>متن خبر</p></body></html>`;
  assert.equal(extractPubDateFromArticleHtml(html), jalaliToGregorian('۱۷ تیر ۱۴۰۵'));
});

test('extractPubDateFromArticleHtml returns null when no date is found anywhere on the page', () => {
  const html = `<html><body><p>متن خبر بدون تاریخ</p></body></html>`;
  assert.equal(extractPubDateFromArticleHtml(html), null);
});

test('processItems recovers a missing stored pubDate from the article page and resolves the item', async () => {
  const items = [rssItem('guid-missing-pubdate', { pubDate: null })];
  const events = [];
  const pendingReview = [];

  const result = await processItems(items, {
    locations: LOCATIONS,
    events,
    pendingReview,
    seenSet: new Set(),
    systemPrompt: 'test',
    nextId: 1,
    extractEventFn: async () => validExtraction(),
    fetchArticleTextFn: async () => 'متن کامل خبر',
    fetchArticleHtmlFn: async () =>
      `<html><head><meta property="article:published_time" content="2026-07-17T13:32:20+03:30"></head><body></body></html>`,
    openPendingReviewIssueFn: async () => {},
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].dateG, '2026-07-17');
  assert.equal(result.pendingCount, 0);
});

test('processItems persists the recovered pubDate onto the pending entry when extraction still fails otherwise', async () => {
  const items = [rssItem('guid-missing-pubdate-still-pending', { pubDate: null })];
  const events = [];
  const pendingReview = [];

  await processItems(items, {
    locations: LOCATIONS,
    events,
    pendingReview,
    seenSet: new Set(),
    systemPrompt: 'test',
    nextId: 1,
    extractEventFn: async () => validExtraction({ target: '' }), // missing required field -> stays pending
    fetchArticleTextFn: async () => 'متن کامل خبر',
    fetchArticleHtmlFn: async () =>
      `<html><head><meta property="article:published_time" content="2026-07-17T13:32:20+03:30"></head><body></body></html>`,
    openPendingReviewIssueFn: async () => {},
  });

  assert.equal(events.length, 0);
  assert.equal(pendingReview.length, 1);
  assert.equal(pendingReview[0].pubDate, '2026-07-17T13:32:20+03:30');
});

test('processItems leaves the item in pending-review without crashing when the article page has no recoverable date', async () => {
  const items = [rssItem('guid-missing-pubdate-unrecoverable', { pubDate: null })];
  const events = [];
  const pendingReview = [];

  await assert.doesNotReject(() =>
    processItems(items, {
      locations: LOCATIONS,
      events,
      pendingReview,
      seenSet: new Set(),
      systemPrompt: 'test',
      nextId: 1,
      extractEventFn: async () => {
        throw new Error('model should not be called: pubDate is still unrecoverable');
      },
      fetchArticleTextFn: async () => 'متن',
      fetchArticleHtmlFn: async () => '<html><body><p>متن خبر بدون تاریخ</p></body></html>',
      openPendingReviewIssueFn: async () => {},
    })
  );

  assert.equal(events.length, 0);
  assert.equal(pendingReview.length, 1);
  assert.equal(pendingReview[0].pubDate, null);
  assert.ok(pendingReview[0].errors.some((e) => e.includes('pubDate')));
});

test('processItems degrades to pending-review (not a crash) when the article page fetch fails', async () => {
  const items = [rssItem('guid-fetch-fails'), rssItem('guid-good')];
  const events = [];
  const pendingReview = [];

  await assert.doesNotReject(() =>
    processItems(items, {
      locations: LOCATIONS,
      events,
      pendingReview,
      seenSet: new Set(),
      systemPrompt: 'test',
      nextId: 1,
      extractEventFn: async () => validExtraction(),
      fetchArticleTextFn: async (link) => {
        if (link.includes('guid-fetch-fails')) throw new Error('article fetch failed: 504');
        return 'متن کامل خبر';
      },
      openPendingReviewIssueFn: async () => {},
    })
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].code, '36159');

  assert.equal(pendingReview.length, 1);
  assert.equal(pendingReview[0].guid, 'guid-fetch-fails');
  assert.ok(pendingReview[0].errors.some((e) => e.includes('article fetch failed')));
});

test('processItems still routes a low-confidence model extraction (e.g. no resolvable loc) to pending-review', async () => {
  const items = [rssItem('guid-bad-date')];

  const events = [];
  const pendingReview = [];
  const issuesOpened = [];

  await assert.doesNotReject(() =>
    processItems(items, {
      locations: LOCATIONS,
      events,
      pendingReview,
      seenSet: new Set(),
      systemPrompt: 'test',
      nextId: 1,
      extractEventFn: async () => validExtraction({ loc: null }),
      fetchArticleTextFn: async () => 'متن کامل خبر',
      openPendingReviewIssueFn: async (item, extraction, errors) => {
        issuesOpened.push({ guid: item.guid, errors });
      },
    })
  );

  assert.equal(events.length, 0);
  assert.equal(pendingReview.length, 1);
  assert.equal(pendingReview[0].guid, 'guid-bad-date');
  assert.ok(pendingReview[0].errors.some((e) => e.includes('loc is null')));

  assert.equal(issuesOpened.length, 1);
  assert.equal(issuesOpened[0].guid, 'guid-bad-date');
});

test('processItems isolates an unexpected throw from extraction to a single item', async () => {
  const items = [rssItem('guid-throws'), rssItem('guid-good')];

  const events = [];
  const pendingReview = [];

  await assert.doesNotReject(() =>
    processItems(items, {
      locations: LOCATIONS,
      events,
      pendingReview,
      seenSet: new Set(),
      systemPrompt: 'test',
      nextId: 1,
      extractEventFn: async (item) => {
        if (item.guid === 'guid-throws') throw new Error('network blew up');
        return validExtraction();
      },
      fetchArticleTextFn: async () => 'متن کامل خبر',
      openPendingReviewIssueFn: async () => {},
    })
  );

  assert.equal(events.length, 1);
  assert.equal(pendingReview.length, 1);
  assert.equal(pendingReview[0].guid, 'guid-throws');
  assert.ok(pendingReview[0].errors.some((e) => e.includes('network blew up')));
});

test('processItems isolates a throw from openPendingReviewIssueFn (e.g. GitHub API down) to a single item', async () => {
  const items = [rssItem('guid-issue-fails'), rssItem('guid-good')];
  const events = [];
  const pendingReview = [];

  await assert.doesNotReject(() =>
    processItems(items, {
      locations: LOCATIONS,
      events,
      pendingReview,
      seenSet: new Set(),
      systemPrompt: 'test',
      nextId: 1,
      extractEventFn: async (item) =>
        item.guid === 'guid-issue-fails' ? validExtraction({ loc: null }) : validExtraction(),
      fetchArticleTextFn: async () => 'متن کامل خبر',
      openPendingReviewIssueFn: async (item) => {
        if (item.guid === 'guid-issue-fails') throw new Error('GitHub API unavailable');
      },
    })
  );

  assert.equal(events.length, 1);
  assert.equal(pendingReview.length, 1);
  assert.equal(pendingReview[0].guid, 'guid-issue-fails');
  assert.equal(pendingReview[0].issue_number, null);
});

test('processItems accepts an extraction whose loc is a fuzzy typo of a known location id (Fix 2 wired end-to-end)', async () => {
  const items = [rssItem('guid-typo-loc')];
  const events = [];
  const pendingReview = [];

  await processItems(items, {
    locations: LOCATIONS,
    countries: COUNTRIES,
    events,
    pendingReview,
    seenSet: new Set(),
    systemPrompt: 'test',
    nextId: 1,
    extractEventFn: async () => validExtraction({ loc: 'alAzrag', loc_raw_text: 'اردن' }),
    fetchArticleTextFn: async () => 'متن کامل خبر',
    openPendingReviewIssueFn: async () => {},
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].loc, 'alAzraq');
  assert.equal(pendingReview.length, 0);
});

test('processItems routes a country-name-in-loc extraction to pending-review with the country match noted', async () => {
  const items = [rssItem('guid-country-mixup')];
  const events = [];
  const pendingReview = [];

  await processItems(items, {
    locations: LOCATIONS,
    countries: COUNTRIES,
    events,
    pendingReview,
    seenSet: new Set(),
    systemPrompt: 'test',
    nextId: 1,
    extractEventFn: async () => validExtraction({ loc: 'jordan', loc_raw_text: 'در اردن' }),
    fetchArticleTextFn: async () => 'متن کامل خبر',
    openPendingReviewIssueFn: async () => {},
  });

  assert.equal(events.length, 0);
  assert.equal(pendingReview.length, 1);
  assert.equal(pendingReview[0].raw_extraction.loc, null);
  assert.equal(pendingReview[0].loc_country_match, 'jordan');
  assert.ok(pendingReview[0].errors.some((e) => e.includes('loc is null')));
});

test('processItems attaches fuzzy-match candidates (with edit distances) to a pending-review entry when no location match is confident enough', async () => {
  const items = [rssItem('guid-no-loc-match')];
  const events = [];
  const pendingReview = [];

  await processItems(items, {
    locations: LOCATIONS,
    countries: COUNTRIES,
    events,
    pendingReview,
    seenSet: new Set(),
    systemPrompt: 'test',
    nextId: 1,
    extractEventFn: async () => validExtraction({ loc: 'totallyUnknownPlace', loc_raw_text: 'جایی نامشخص' }),
    fetchArticleTextFn: async () => 'متن کامل خبر',
    openPendingReviewIssueFn: async () => {},
  });

  assert.equal(events.length, 0);
  assert.equal(pendingReview.length, 1);
  assert.ok(Array.isArray(pendingReview[0].loc_candidates));
  assert.ok(pendingReview[0].loc_candidates.length > 0);
  assert.ok(pendingReview[0].loc_candidates.every((c) => typeof c.id === 'string' && typeof c.distance === 'number'));
});

test('processItems removes an item from pending-review (and closes its issue) if a retry reclassifies it as not relevant', async () => {
  const events = [];
  const pendingReview = [];
  const seenSet = new Set();
  const closedIssues = [];

  // Run 1: item is (incorrectly) judged relevant and fails extraction, so it lands in pending-review.
  const relevantItem = rssItem('guid-reclassified', {
    title: 'بیانیه رسمی درباره صفحات جعلی منتسب به سپاه',
    description: 'موج جدیدی از اطلاعیه‌های جعلی',
  });
  pendingReview.push({
    title: relevantItem.title,
    link: relevantItem.link,
    guid: 'guid-reclassified',
    raw_extraction: null,
    errors: ['extraction failed: some earlier error'],
    added_at: new Date().toISOString(),
    issue_number: 99,
  });

  // Run 2: the tightened relevance filter now (correctly) judges this item irrelevant on retry.
  const { newGuids, resolvedCount } = await processItems([relevantItem], {
    locations: LOCATIONS,
    countries: COUNTRIES,
    events,
    pendingReview,
    seenSet,
    systemPrompt: 'test',
    nextId: 1,
    extractEventFn: async () => { throw new Error('should not be called for an irrelevant item'); },
    fetchArticleTextFn: async () => { throw new Error('should not be called for an irrelevant item'); },
    fetchArticleHtmlFn: async () => { throw new Error('pubDate fallback fetch should be caught, not crash the run'); },
    openPendingReviewIssueFn: async () => { throw new Error('should not open an issue for an irrelevant item'); },
    closePendingReviewIssueFn: async (issueNumber, comment) => {
      closedIssues.push({ issueNumber, comment });
    },
  });

  assert.equal(pendingReview.length, 0);
  assert.equal(resolvedCount, 1);
  assert.ok(newGuids.includes('guid-reclassified'));
  assert.equal(closedIssues.length, 1);
  assert.equal(closedIssues[0].issueNumber, 99);
});

// --- processItems: pending-review retry/dedup regression tests ---

test('processItems does not add a pending item\'s guid to newGuids, so it is never marked seen', async () => {
  const items = [rssItem('guid-pending', { pubDate: 'not a date' })];
  const events = [];
  const pendingReview = [];

  const { newGuids, pendingCount } = await processItems(items, {
    locations: LOCATIONS,
    events,
    pendingReview,
    seenSet: new Set(),
    systemPrompt: 'test',
    nextId: 1,
    extractEventFn: async () => validExtraction(),
    fetchArticleTextFn: async () => 'متن',
    openPendingReviewIssueFn: async () => 101,
  });

  assert.equal(pendingCount, 1);
  assert.equal(newGuids.includes('guid-pending'), false);
  assert.equal(pendingReview.length, 1);
  assert.equal(pendingReview[0].issue_number, 101);
});

test('a pending item that succeeds on a later processItems() call moves to events.json and its guid is added to seen-guids', async () => {
  const events = [];
  const pendingReview = [];
  const seenSet = new Set();
  const closedIssues = [];

  // Run 1: bad pubDate -> routed to pending-review, guid never added to seenSet.
  const run1 = await processItems([rssItem('guid-retry', { pubDate: 'not a date' })], {
    locations: LOCATIONS,
    events,
    pendingReview,
    seenSet,
    systemPrompt: 'test',
    nextId: 1,
    extractEventFn: async () => validExtraction(),
    fetchArticleTextFn: async () => 'متن',
    openPendingReviewIssueFn: async () => 55,
  });

  assert.equal(run1.newGuids.includes('guid-retry'), false);
  assert.equal(pendingReview.length, 1);
  assert.equal(seenSet.has('guid-retry'), false);

  // Run 2: same guid, now with a valid pubDate -> should succeed and resolve the pending entry.
  const run2 = await processItems([rssItem('guid-retry')], {
    locations: LOCATIONS,
    events,
    pendingReview,
    seenSet,
    systemPrompt: 'test',
    nextId: 1,
    extractEventFn: async () => validExtraction(),
    fetchArticleTextFn: async () => 'متن',
    openPendingReviewIssueFn: async () => { throw new Error('should not open a new issue for an already-pending item'); },
    closePendingReviewIssueFn: async (issueNumber, comment) => {
      closedIssues.push({ issueNumber, comment });
    },
  });

  assert.equal(run2.resolvedCount, 1);
  assert.equal(pendingReview.length, 0);
  assert.equal(events.length, 1);
  assert.ok(run2.newGuids.includes('guid-retry'));
  assert.equal(closedIssues.length, 1);
  assert.equal(closedIssues[0].issueNumber, 55);
  assert.equal(closedIssues[0].comment, 'Resolved automatically on retry.');
});

test('no duplicate GitHub Issue is opened for an item still pending across two runs', async () => {
  const events = [];
  const pendingReview = [];
  const seenSet = new Set();
  let issuesOpened = 0;
  const openFn = async () => {
    issuesOpened++;
    return 77;
  };

  // Run 1: fails -> opens one issue.
  await processItems([rssItem('guid-still-pending', { pubDate: 'not a date' })], {
    locations: LOCATIONS,
    events,
    pendingReview,
    seenSet,
    systemPrompt: 'test',
    nextId: 1,
    extractEventFn: async () => validExtraction(),
    fetchArticleTextFn: async () => 'متن',
    openPendingReviewIssueFn: openFn,
  });

  assert.equal(issuesOpened, 1);
  assert.equal(pendingReview.length, 1);
  assert.equal(pendingReview[0].issue_number, 77);

  // Run 2: same guid, still fails -> must update the existing entry, not open a second issue.
  await processItems([rssItem('guid-still-pending', { pubDate: 'still not a date' })], {
    locations: LOCATIONS,
    events,
    pendingReview,
    seenSet,
    systemPrompt: 'test',
    nextId: 1,
    extractEventFn: async () => validExtraction(),
    fetchArticleTextFn: async () => 'متن',
    openPendingReviewIssueFn: openFn,
  });

  assert.equal(issuesOpened, 1, 'a second run on the same still-pending guid must not open another issue');
  assert.equal(pendingReview.length, 1);
  assert.equal(pendingReview[0].issue_number, 77);
});

// --- Bug A: retry pending items directly by their stored link, independent of the RSS window ---

test('a pending item whose link is no longer in the fresh RSS fetch still gets retried and can resolve', async () => {
  const events = [];
  const pendingReview = [
    {
      title: 'رادار کشف و کنترل هوایی و ایستگاه پمپاژ مخازن سوخت جنگنده‌های دشمن در بحرین منهدم گردید',
      link: 'https://sepahnews.ir/fa/news/36159/aged-out-item',
      guid: 'guid-aged-out',
      pubDate: 'Wed, 08 Jul 2026 08:00:00 +0330',
      raw_extraction: null,
      errors: ['unparseable date: null'],
      added_at: '2026-07-21T15:30:16.612Z',
      issue_number: 88,
    },
  ];
  const seenSet = new Set();
  const closedIssues = [];
  const fetchedLinks = [];

  // The fresh RSS fetch does NOT include this item's guid/link at all (it aged out of the feed's
  // ~100-item window) — only an unrelated item is present.
  const freshItems = [rssItem('guid-unrelated')];

  const { newGuids, resolvedCount, newEventsCount } = await processItems(freshItems, {
    locations: LOCATIONS,
    countries: COUNTRIES,
    events,
    pendingReview,
    seenSet,
    systemPrompt: 'test',
    nextId: 1,
    extractEventFn: async () => validExtraction(),
    fetchArticleTextFn: async (link) => {
      fetchedLinks.push(link);
      return 'متن کامل خبر با جزئیات موج و هدف';
    },
    openPendingReviewIssueFn: async () => { throw new Error('should not open a new issue for an already-pending item'); },
    closePendingReviewIssueFn: async (issueNumber, comment) => {
      closedIssues.push({ issueNumber, comment });
    },
  });

  assert.ok(fetchedLinks.includes('https://sepahnews.ir/fa/news/36159/aged-out-item'));
  assert.equal(events.length, 2); // the aged-out pending item + the unrelated fresh item
  assert.equal(newEventsCount, 2);
  assert.equal(resolvedCount, 1);
  assert.equal(pendingReview.length, 0);
  assert.ok(newGuids.includes('guid-aged-out'));
  assert.equal(closedIssues.length, 1);
  assert.equal(closedIssues[0].issueNumber, 88);
});

test('a pending item still within the RSS window is not double-processed by both the retry pass and the fresh-feed pass', async () => {
  const events = [];
  let extractCalls = 0;
  const pendingReview = [
    {
      title: 'اطلاعیه نصر ۲',
      link: 'https://sepahnews.ir/fa/news/36159/guid-still-in-window',
      guid: 'guid-still-in-window',
      pubDate: 'Wed, 08 Jul 2026 08:00:00 +0330',
      raw_extraction: null,
      errors: ['some earlier error'],
      added_at: '2026-07-21T15:30:16.612Z',
      issue_number: 12,
    },
  ];
  const seenSet = new Set();

  // The same guid is ALSO still present in the fresh RSS feed this run.
  const freshItems = [rssItem('guid-still-in-window')];

  const { resolvedCount, newEventsCount } = await processItems(freshItems, {
    locations: LOCATIONS,
    countries: COUNTRIES,
    events,
    pendingReview,
    seenSet,
    systemPrompt: 'test',
    nextId: 1,
    extractEventFn: async () => {
      extractCalls++;
      return validExtraction();
    },
    fetchArticleTextFn: async () => 'متن کامل خبر',
    openPendingReviewIssueFn: async () => { throw new Error('should not open a new issue'); },
    closePendingReviewIssueFn: async () => {},
  });

  assert.equal(extractCalls, 1, 'the item should only be extracted once, not once per phase');
  assert.equal(newEventsCount, 1);
  assert.equal(resolvedCount, 1);
  assert.equal(pendingReview.length, 0);
  assert.equal(events.length, 1);
});

// --- Multi-source support: Artesh (aja.ir) ---

// A minimal but structurally faithful reconstruction of a real aja.ir article page (Sigma
// Portal), based on the raw HTML captured during the aja.ir structure investigation: a decoy
// outer <td class="Content"> wraps the whole news template (title/summary/body), and the real
// body lives in a separately-nested <span class="Content">, deeply wrapped in more spans/divs,
// followed by the rating-widget ("امتیاز دهی") and print-page-link noise that must never leak in.
const ARTESH_SAMPLE_HTML = `<!doctype html><html><body>
<table><tr><td class="Content" style="white-space:normal;text-align:justify;">
  <h5 style="color:#3366ff;">سه پایگاه مهم آمریکا در کویت، هدف حملات پهپادهای انهدامی ارتش قرار گرفت</h5><br />
  <span class="Summary" style="text-align:justify;"></span><br />
  <span class="Content" style="padding:6px;font-family:Tahoma;text-align:justify;"><div style="text-align:justify"><span style="font-size:11pt"><span style="line-height:200%"><span style="direction:rtl">در نوزدهمین مرحله عملیات صاعقه، بامداد امروز، پایگاه‌های آمریکایی احمدالجابر، العدیری و کمپ عریفجان در کویت، هدف پهپادهای انهدامی ارتش جمهوری اسلامی ایران قرار گرفت.</span></span></span></div></span><hr style="color:#eef;" />
  <div id="WebPartC_x_ObjectComment_Control_Output_Panel" class="MainCommentWrapper">
    <span id="WebPartC_x_lblTitle">امتیاز دهی</span>
    <a href="/PrintPage/PrintPage.aspx?ID=x">نسخه قابل چاپ</a>
  </div>
</td></tr></table>
</body></html>`;

test('extractSpanContent extracts only the <span class="Content"> body text, skipping the decoy outer <td class="Content">', () => {
  const text = extractSpanContent(ARTESH_SAMPLE_HTML);
  assert.ok(
    text.includes('در نوزدهمین مرحله عملیات صاعقه'),
    `expected the real body text to survive, got: ${text}`
  );
  assert.ok(text.includes('احمدالجابر'), 'expected the target detail to survive');
});

test('extractSpanContent excludes trailing rating-widget/print-link noise that lives outside the span', () => {
  const text = extractSpanContent(ARTESH_SAMPLE_HTML);
  assert.ok(!text.includes('امتیاز دهی'), 'trailing rating-widget noise leaked into the extracted body');
  assert.ok(!text.includes('نسخه قابل چاپ'), 'trailing print-page link leaked into the extracted body');
});

test('extractSpanContent excludes the <h5> title, which sits outside <span class="Content"> too', () => {
  const text = extractSpanContent(ARTESH_SAMPLE_HTML);
  assert.ok(!text.includes('سه پایگاه مهم آمریکا'), 'the page title leaked into the extracted body');
});

test('extractSpanContent returns null when no <span class="Content"> element is present (unrecognized page structure)', () => {
  const html = '<html><body><p>یک صفحه کاملاً متفاوت بدون هیچ نشانه‌ای از ساختار شناخته‌شده</p></body></html>';
  assert.equal(extractSpanContent(html), null);
});

test('extractSpanContent treats an outer <td class="Content"> alone (no inner span) as not found, rather than matching the decoy', () => {
  const html = '<html><body><td class="Content"><p>فقط دکوی بیرونی</p></td></body></html>';
  assert.equal(extractSpanContent(html), null);
});

test('extractSpanContent returns null for non-string/empty input', () => {
  assert.equal(extractSpanContent(''), null);
  assert.equal(extractSpanContent(undefined), null);
  assert.equal(extractSpanContent(null), null);
});

test('extractArteshCode always returns an empty string (Artesh links carry no news-code)', () => {
  assert.equal(extractArteshCode(), '');
  assert.equal(extractArteshCode('https://www.aja.ir/Home/ShowPage.aspx?ID=abc'), '');
});

test('proxyFetch wraps the target URL through the proxy base URL and sends the X-Proxy-Secret header', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl;
  let capturedHeaders;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = String(url);
    capturedHeaders = opts?.headers;
    return { ok: true, text: async () => 'proxied body' };
  };
  try {
    const target = 'https://www.aja.ir/Home/ShowPage.aspx?Object=news&ID=abc';
    const result = await proxyFetch(target);
    assert.equal(result, 'proxied body');
    assert.equal(capturedUrl, `http://109.122.250.213:8787/?url=${encodeURIComponent(target)}`);
    assert.ok('X-Proxy-Secret' in capturedHeaders, 'expected the X-Proxy-Secret header to be sent');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('proxyFetch throws on a non-2xx response from the proxy', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 502, text: async () => 'bad gateway' });
  try {
    await assert.rejects(() => proxyFetch('https://www.aja.ir/x'), /proxy fetch failed: 502/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('processItems overrides the model-supplied source field with sourceId (source is derived, not trusted from the model)', async () => {
  const events = [];
  const pendingReview = [];
  const item = {
    guid: 'guid-source-override',
    link: 'https://www.aja.ir/Home/ShowPage.aspx?ID=guid-source-override',
    title: 'خبر ارتش',
    pubDate: 'Wed, 08 Jul 2026 08:00:00 +0330',
  };

  await processItems([item], {
    locations: LOCATIONS,
    events,
    pendingReview,
    seenSet: new Set(),
    systemPrompt: 'test',
    nextId: 1,
    sourceId: 'artesh',
    isRelevantFn: () => true, // relevance filtering isn't what this test is about
    // The model mistakenly reports "sepah" — processItems must not trust it.
    extractEventFn: async () => validExtraction({ source: 'sepah' }),
    fetchArticleTextFn: async () => 'متن ارتش',
    openPendingReviewIssueFn: async () => {},
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'artesh');
});

test('processItems namespaces guids per sourceId, so two sources sharing a bare guid and a seenSet do not false-positive-skip each other', async () => {
  const events = [];
  const pendingReview = [];
  const seenSet = new Set();

  const sepahItem = rssItem('guid-collide');
  const arteshItem = {
    guid: 'guid-collide',
    link: 'https://www.aja.ir/Home/ShowPage.aspx?ID=guid-collide',
    title: 'خبر ارتش با همان guid خام',
    pubDate: 'Wed, 08 Jul 2026 08:00:00 +0330',
  };

  const run1 = await processItems([sepahItem], {
    locations: LOCATIONS,
    events,
    pendingReview,
    seenSet,
    systemPrompt: 'test',
    nextId: 1,
    sourceId: 'sepah',
    extractEventFn: async () => validExtraction({ source: 'sepah' }),
    fetchArticleTextFn: async () => 'متن سپاه',
    openPendingReviewIssueFn: async () => {},
  });
  // Mirrors what main() does between sources: only fully-resolved guids get marked seen.
  for (const g of run1.newGuids) seenSet.add(g);

  const run2 = await processItems([arteshItem], {
    locations: LOCATIONS,
    events,
    pendingReview,
    seenSet,
    systemPrompt: 'test',
    nextId: 2,
    sourceId: 'artesh',
    isRelevantFn: () => true, // relevance filtering isn't what this test is about
    extractEventFn: async () => validExtraction({ source: 'artesh' }),
    fetchArticleTextFn: async () => 'متن ارتش',
    openPendingReviewIssueFn: async () => {},
  });

  assert.deepEqual(run1.newGuids, ['sepah:guid-collide']);
  assert.deepEqual(
    run2.newGuids,
    ['artesh:guid-collide'],
    'the artesh item must not be treated as already-seen just because its bare guid matches a sepah guid already in seenSet'
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].source, 'sepah');
  assert.equal(events[1].source, 'artesh');
});

test('main() end-to-end: syncs Sepah and Artesh independently in the same run, tagging events with the correct source, deriving code per source, and namespacing seen-guids without cross-contamination', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nasr2-sync-multi-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  await fs.writeFile(path.join(tmpDir, 'locations.json'), JSON.stringify(LOCATIONS));
  await fs.writeFile(path.join(tmpDir, 'events.json'), '[]');
  await fs.writeFile(path.join(tmpDir, 'seen-guids.json'), '[]');
  await fs.writeFile(path.join(tmpDir, 'pending-review.json'), '[]');

  const sepahRssXml = `<?xml version="1.0"?>
<rss><channel>
  <item><guid>guid-sepah</guid><link>https://sepahnews.ir/fa/news/36159/one</link><title>اطلاعیه نصر ۲</title><description>موج اول عملیات صاعقه، پایگاه دشمن منهدم شد</description><pubDate>Wed, 08 Jul 2026 08:00:00 +0330</pubDate></item>
</channel></rss>`;

  const arteshGuid = 'c9d90bbb-c976-4da3-8e98-2ce3f9e3018a';
  const arteshRssXml = `<?xml version="1.0"?>
<rss><channel>
  <item><guid>${arteshGuid}</guid><link>https://www.aja.ir//Home/ShowPage.aspx?Object=news&amp;ID=${arteshGuid}</link><title>سه پایگاه مهم آمریکا در کویت، هدف حملات پهپادهای انهدامی ارتش قرار گرفت</title><description>&lt;img src="x.jpg"/&gt;</description><pubDate>Wed, 08 Jul 2026 08:00:00 +0330</pubDate></item>
</channel></rss>`;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('sepahnews.ir/fa/rss')) return { ok: true, text: async () => sepahRssXml };
    if (u.includes('sepahnews.ir/fa/news/36159/')) {
      return { ok: true, text: async () => '<html><body><p>متن کامل خبر با جزئیات موج و هدف</p></body></html>' };
    }
    if (u.includes('109.122.250.213:8787')) {
      const target = decodeURIComponent(u.split('url=')[1]);
      if (target.includes('rsspage')) return { ok: true, text: async () => arteshRssXml };
      return { ok: true, text: async () => ARTESH_SAMPLE_HTML };
    }
    if (u.includes('openrouter.ai')) {
      const body = JSON.parse(opts?.body ?? '{}');
      const userContent = body.messages.find((m) => m.role === 'user')?.content || '';
      const source = userContent.includes('نوزدهم') ? 'artesh' : 'sepah';
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(validExtraction({ source })) } }] }),
      };
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  try {
    await assert.doesNotReject(() => main({ dataDir: tmpDir }));
  } finally {
    globalThis.fetch = originalFetch;
  }

  const events = JSON.parse(await fs.readFile(path.join(tmpDir, 'events.json'), 'utf8'));
  const seenGuids = JSON.parse(await fs.readFile(path.join(tmpDir, 'seen-guids.json'), 'utf8'));

  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.source).sort(), ['artesh', 'sepah']);

  const sepahEvent = events.find((e) => e.source === 'sepah');
  const arteshEvent = events.find((e) => e.source === 'artesh');
  assert.equal(sepahEvent.code, '36159');
  assert.equal(arteshEvent.code, '', 'Artesh events must have no code');

  assert.ok(seenGuids.includes('sepah:guid-sepah'));
  assert.ok(seenGuids.includes(`artesh:${arteshGuid}`));
});

// --- Full pipeline integration test (Phase 2 style: real fs read/write against a temp data dir) ---

test('main() end-to-end: pubDate/link-derived date+code land in events.json, article fetch failure lands in pending-review.json, run succeeds', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nasr2-sync-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  await fs.writeFile(path.join(tmpDir, 'locations.json'), JSON.stringify(LOCATIONS));
  await fs.writeFile(path.join(tmpDir, 'events.json'), '[]');
  await fs.writeFile(path.join(tmpDir, 'seen-guids.json'), '[]');
  await fs.writeFile(path.join(tmpDir, 'pending-review.json'), '[]');

  const rssXml = `<?xml version="1.0"?>
<rss><channel>
  <item><guid>guid-fetch-fails</guid><link>https://sepahnews.ir/fa/news/1/one</link><title>اطلاعیه نصر ۲ یک</title><description>موج اول عملیات صاعقه، پایگاه دشمن منهدم شد</description><pubDate>Wed, 08 Jul 2026 08:00:00 +0330</pubDate></item>
  <item><guid>guid-good</guid><link>https://sepahnews.ir/fa/news/36159/two</link><title>اطلاعیه نصر ۲ دو</title><description>موج دوم عملیات صاعقه، پایگاه دشمن منهدم شد</description><pubDate>Wed, 08 Jul 2026 08:00:00 +0330</pubDate></item>
</channel></rss>`;

  // Empty Artesh feed: this test only exercises the Sepah source's behavior; the aja.ir proxy
  // fetch just needs a well-formed (empty) response so the multi-source loop in main() runs both
  // sources cleanly, without the "one bad source" fallback path masking what's being tested here.
  const emptyRssXml = '<?xml version="1.0"?><rss><channel></channel></rss>';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('sepahnews.ir/fa/rss')) {
      return { ok: true, text: async () => rssXml };
    }
    if (u.includes('sepahnews.ir/fa/news/1/')) {
      throw new Error('simulated network failure fetching article page');
    }
    if (u.includes('sepahnews.ir/fa/news/36159/')) {
      return { ok: true, text: async () => '<html><body><p>متن کامل خبر با جزئیات موج و هدف</p></body></html>' };
    }
    if (u.includes('109.122.250.213:8787')) {
      return { ok: true, text: async () => emptyRssXml };
    }
    if (u.includes('openrouter.ai')) {
      const body = JSON.parse(opts?.body ?? '{}');
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(validExtraction()) } }],
        }),
      };
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  try {
    await assert.doesNotReject(() => main({ dataDir: tmpDir }));
  } finally {
    globalThis.fetch = originalFetch;
  }

  const pendingReview = JSON.parse(await fs.readFile(path.join(tmpDir, 'pending-review.json'), 'utf8'));
  const events = JSON.parse(await fs.readFile(path.join(tmpDir, 'events.json'), 'utf8'));

  assert.equal(pendingReview.length, 1);
  assert.equal(pendingReview[0].guid, 'sepah:guid-fetch-fails');

  assert.equal(events.length, 1);
  assert.equal(events[0].dateG, '2026-07-08');
  assert.equal(events[0].dateP, '۱۷ تیر ۱۴۰۵');
  assert.equal(events[0].code, '36159');
  assert.equal(events[0].source, 'sepah');
});
