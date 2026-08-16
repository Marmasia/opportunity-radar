/**
 * dedupe-and-merge.js
 *
 * Fixes two problems in generate.js:
 *
 *  ISSUE 1 — Duplicate events: generate.js's current dedup is an EXACT
 *  string match on name+dateStart. "Autumn Fair 2026" and "Autumn Fair
 *  2026 (incorporating Moda Fashion)" are different strings, so both
 *  survive as separate calendar entries. This file replaces that with
 *  fuzzy name matching + date-overlap checking.
 *
 *  ISSUE 2 — Baseline events not tracked at all: generate.js currently
 *  builds events.json purely from live Gemini searches each run, with
 *  no permanent seed list. If a bucket search has a bad run, or a
 *  source changes its wording, an event can vanish from the calendar
 *  with nothing to catch it. baseline-events.json is that permanent
 *  list — every event on it ships every run, enriched by a fresh
 *  Gemini match when one exists, kept as-is when one doesn't.
 *
 * Field names below match generate.js's actual schema exactly:
 * id, series, name, dateStart, dateEnd, location, category, sector,
 * desc, scores{buyer,decision,network,intel,ei}, classification,
 * confidence, primaryBenefit, source, reasons, link, dateTBC.
 */

// ---------- Normalize a name for comparison ----------
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')       // strip "(incorporating Moda Fashion)" etc.
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Word-overlap similarity, 0..1 ----------
function similarity(a, b) {
  const wordsA = new Set(normalizeName(a).split(' ').filter(Boolean));
  const wordsB = new Set(normalizeName(b).split(' ').filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const w of wordsA) if (wordsB.has(w)) shared++;
  return shared / Math.max(wordsA.size, wordsB.size);
}

const SIMILARITY_THRESHOLD = 0.6;

// ---------- Do two date ranges overlap? ----------
function datesOverlap(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !bStart) return false;
  return aStart <= (bEnd || bStart) && bStart <= (aEnd || aStart);
}

// ---------- Does a scraped event match a baseline entry (by name or alias)? ----------
function matchesBaselineEntry(scrapedEvent, baselineEntry, knownAliases) {
  if (!datesOverlap(scrapedEvent.dateStart, scrapedEvent.dateEnd, baselineEntry.dateStart, baselineEntry.dateEnd)) {
    return false;
  }
  const namesToCheck = [baselineEntry.name, ...(baselineEntry.aliases || []), ...(knownAliases[baselineEntry.series] || [])];
  return namesToCheck.some(candidate => similarity(scrapedEvent.name, candidate) >= SIMILARITY_THRESHOLD);
}

const CONFIDENCE_RANK = { High: 3, Medium: 2, Low: 1 };

// ---------- Merge two records for the same event ----------
// mode 'peer': neither side is authoritative (in-scrape dedup) — keep
//   whichever desc is longer/more complete, and for scores/classification
//   prefer whichever duplicate has the HIGHER confidence rating, not
//   just whichever happened to appear later in the array.
// mode 'baseline': baseRecord IS the canonical entry. A scraped alias
//   match enriches it (fresher desc/link/scores) but must NEVER
//   overwrite the canonical name — that's how "The Bed Show" would
//   silently get relabelled to "NBF Bed Industry Awards".
function mergeEventRecords(baseRecord, incomingRecord, mode = 'peer') {
  const longer = (a, b) => ((a || '').length >= (b || '').length ? a : b);
  const baseConf = CONFIDENCE_RANK[baseRecord.confidence] || 0;
  const incomingConf = CONFIDENCE_RANK[incomingRecord.confidence] || 0;
  const preferIncoming = mode === 'baseline' ? true : incomingConf >= baseConf;

  return {
    ...baseRecord,
    name: mode === 'baseline' ? baseRecord.name : longer(baseRecord.name, incomingRecord.name),
    desc: longer(baseRecord.desc, incomingRecord.desc),
    location: baseRecord.location || incomingRecord.location,
    dateStart: baseRecord.dateStart || incomingRecord.dateStart,
    dateEnd: baseRecord.dateEnd || incomingRecord.dateEnd,
    dateTBC: incomingRecord.dateTBC !== undefined ? incomingRecord.dateTBC : baseRecord.dateTBC,
    link: incomingRecord.link || baseRecord.link,
    scores: (preferIncoming && incomingRecord.scores) ? incomingRecord.scores : (baseRecord.scores || incomingRecord.scores),
    classification: (preferIncoming && incomingRecord.classification) ? incomingRecord.classification : (baseRecord.classification || incomingRecord.classification),
    confidence: (preferIncoming && incomingRecord.confidence) ? incomingRecord.confidence : (baseRecord.confidence || incomingRecord.confidence),
    primaryBenefit: (preferIncoming && incomingRecord.primaryBenefit) ? incomingRecord.primaryBenefit : (baseRecord.primaryBenefit || incomingRecord.primaryBenefit),
    reasons: (preferIncoming && incomingRecord.reasons && incomingRecord.reasons.length) ? incomingRecord.reasons : (baseRecord.reasons && baseRecord.reasons.length ? baseRecord.reasons : incomingRecord.reasons),
    detected: incomingRecord.detected || baseRecord.detected,
  };
}

// ---------- STEP A: dedupe within one scrape run ----------
function dedupeWithinScrape(scrapedEvents) {
  const buckets = [];
  for (const event of scrapedEvents) {
    let placed = false;
    for (const bucket of buckets) {
      const rep = bucket[0];
      if (
        datesOverlap(event.dateStart, event.dateEnd, rep.dateStart, rep.dateEnd) &&
        similarity(event.name, rep.name) >= SIMILARITY_THRESHOLD
      ) {
        bucket.push(event);
        placed = true;
        break;
      }
    }
    if (!placed) buckets.push([event]);
  }
  return buckets.map(bucket => bucket.reduce((merged, e) => mergeEventRecords(merged, e, 'peer'), bucket[0]));
}

// ---------- STEP B: merge deduped scrape results into the permanent baseline ----------
function mergeIntoBaseline(baseline, dedupedScrapedEvents) {
  const knownAliases = baseline.known_aliases || {};
  const baselineEvents = (baseline.baseline_events || []).filter(e => e.status !== 'superseded');
  const usedBaselineSeries = new Set();
  const finalList = [];

  for (const baseEvent of baselineEvents) {
    const match = dedupedScrapedEvents.find(scraped => matchesBaselineEntry(scraped, baseEvent, knownAliases));
    if (match) {
      usedBaselineSeries.add(baseEvent.series);
      finalList.push(mergeEventRecords(baseEvent, match, 'baseline'));
    } else {
      finalList.push({ ...baseEvent, notReconfirmedThisRun: true });
    }
  }

  for (const scraped of dedupedScrapedEvents) {
    const wasUsed = baselineEvents.some(
      b => usedBaselineSeries.has(b.series) && matchesBaselineEntry(scraped, b, knownAliases)
    );
    if (!wasUsed) {
      finalList.push({ ...scraped, newDiscovery: true });
    }
  }

  return finalList;
}

// ---------- Public entry point ----------
function buildFinalEventList(baseline, scrapedEvents) {
  const deduped = dedupeWithinScrape(scrapedEvents);
  return mergeIntoBaseline(baseline, deduped);
}

export { normalizeName, similarity, datesOverlap, dedupeWithinScrape, mergeIntoBaseline, buildFinalEventList };
