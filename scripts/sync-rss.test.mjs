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
  assert.equal(pendingReview[0].guid, 'guid-fetch-fails');

  assert.equal(events.length, 1);
  assert.equal(events[0].dateG, '2026-07-08');
  assert.equal(events[0].dateP, '۱۷ تیر ۱۴۰۵');
  assert.equal(events[0].code, '36159');
});
