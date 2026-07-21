# Sepah News RSS sync

`sync-rss.mjs` keeps `/data/events.json` up to date automatically by watching
the official Sepah News RSS feed for new statements about Operation Nasr 2 /
Sa'eqeh.

## What it does

1. Fetches `https://sepahnews.ir/fa/rss/allnews` with a clearly identifying
   User-Agent (`Nasr2DashboardBot/1.0`).
2. Skips any item already recorded in `/data/seen-guids.json`.
3. Filters the rest by keyword relevance (اطلاعیه، نصر ۲، نصر۲، صاعقه، موج،
   پایگاه، کد خبر). Irrelevant items are marked seen and otherwise ignored.
4. For each relevant item, asks an LLM (via [OpenRouter](https://openrouter.ai),
   model `openrouter/free`, structured JSON-schema output) to extract a
   structured event — wave, force, source, location, target, weapon, outcome,
   code, Persian date, time — using the location ids in
   `/data/locations.json` as the only valid set. If the model can't confidently
   match a known location, it returns `loc: null` plus `loc_raw_text` instead
   of guessing.
5. Validates every extraction (non-empty required fields, valid
   force/source, `loc` must exist in `locations.json`). Anything that
   validates cleanly is appended to `/data/events.json` with a new
   sequential id; the Persian date is converted to a Gregorian `dateG` using
   the same Tir-1-1405 = 2026-06-22 epoch the rest of the project uses.
   `target`/`weapon`/`outcome` are stored as `{fa, en: "", ar: ""}` — EN/AR
   translation for bot-added events is still a manual follow-up.
6. Anything that fails validation, or has no resolvable location, is appended
   to `/data/pending-review.json` (with the raw item title/link and the
   model's partial extraction) instead of `events.json`, and a GitHub Issue
   titled `Pending review: <item title>` labeled `needs-review` is opened so
   a human can place it by hand.
7. Recomputes `/data/meta.json` (date ranges + `last_synced`) whenever new
   events were added.
8. Updates `/data/seen-guids.json` with every item processed this run
   (accepted, pending, and irrelevant alike), so nothing is re-fetched or
   re-flagged on the next run.

## Schedule

Runs via `.github/workflows/sync-sepahnews.yml` every 6 hours
(`0 */6 * * *`), plus on-demand via the "Run workflow" button
(`workflow_dispatch`) in the Actions tab.

## Required secret

The workflow needs an OpenRouter API key in **Settings → Secrets and
variables → Actions → New repository secret**, named `OPENROUTER_API_KEY`.
This script cannot create that secret itself — add it manually before the
first scheduled run (or the run will fail on the OpenRouter request and
nothing will be committed).

`GITHUB_TOKEN` (used for committing and opening review issues) is provided
automatically by GitHub Actions — no setup needed, but the workflow does
need `permissions: contents: write, issues: write`, which is already set in
the workflow file.

## Manual review flow

When an item lands in `data/pending-review.json` (and its matching GitHub
Issue), the bot leaves it alone — it never guesses a location or invents
coordinates. To resolve one:

1. Open the corresponding `needs-review` issue and read the raw RSS text
   plus the model's partial extraction.
2. Decide the correct `loc` id from `data/locations.json` (add a new
   location entry first if the target genuinely doesn't have one yet).
3. Move the entry from `data/pending-review.json` into `data/events.json`
   by hand, giving it the next sequential `id`, filling in `dateG` (Tir-1-1405
   = 2026-06-22 epoch, same as the sync script), and wrapping
   `target`/`weapon`/`outcome` as `{fa, en, ar}` objects — or ask a future
   Claude Code session to draft that edit for you once you've picked the
   location.
4. Remove the entry from `data/pending-review.json` and close the issue.

## Local testing

```sh
npm ci
OPENROUTER_API_KEY=... node scripts/sync-rss.mjs
```

Network access to `sepahnews.ir` and `openrouter.ai` is required; there is
no offline/dry-run mode.
