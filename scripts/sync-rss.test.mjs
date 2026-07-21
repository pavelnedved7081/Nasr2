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
} from './sync-rss.mjs';

const LOCATIONS = {
  princeHassan: { name: 'پایگاه هوایی پرنس حسن', country: 'jordan', lat: 30.2833, lng: 36.0833 },
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
    description: 'موج اول عملیات صاعقه',
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
  <item><guid>guid-fetch-fails</guid><link>https://sepahnews.ir/fa/news/1/one</link><title>اطلاعیه نصر ۲ یک</title><description>موج اول عملیات صاعقه</description><pubDate>Wed, 08 Jul 2026 08:00:00 +0330</pubDate></item>
  <item><guid>guid-good</guid><link>https://sepahnews.ir/fa/news/36159/two</link><title>اطلاعیه نصر ۲ دو</title><description>موج دوم عملیات صاعقه</description><pubDate>Wed, 08 Jul 2026 08:00:00 +0330</pubDate></item>
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
