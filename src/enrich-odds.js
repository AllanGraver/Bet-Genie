import fs from 'node:fs/promises';
import path from 'node:path';
import {
  fetchFootballEvents,
  fetchUnibetOdds,
  matchOddsEvent,
  parseUnibetOver15,
  readOddsCache,
  writeOddsCache
} from './odds-api.js';

const resultsFile = path.resolve('docs/data/results.json');
const configFile = path.resolve('config/odds.json');
const cacheDirectory = path.resolve('data/cache/odds');
const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
const dashboard = JSON.parse(await fs.readFile(resultsFile, 'utf8'));
const warnings = Array.isArray(dashboard.warnings)
  ? dashboard.warnings
  : Array.isArray(dashboard.errors)
    ? dashboard.errors
    : [];

const matches = [
  ...(Array.isArray(dashboard.results) ? dashboard.results : []),
  ...(Array.isArray(dashboard.nearMisses) ? dashboard.nearMisses : [])
];

const threshold = Number(config.minimumScore ?? 80);
const candidates = matches.filter(match => Number(match.score) >= threshold);
let available = 0;
let events = [];

if (!config.enabled) {
  warnings.push('Odds-integration er deaktiveret i config/odds.json.');
} else if (!process.env.ODDS_API_KEY) {
  warnings.push('ODDS_API_KEY mangler. Analysen er publiceret uden Unibet-odds.');
} else if (candidates.length) {
  try {
    events = await fetchFootballEvents(process.env.ODDS_API_KEY);
  } catch (error) {
    warnings.push(`Odds-API.io events kunne ikke hentes: ${error.message}`);
  }
}

for (const match of matches) {
  if (Number(match.score) < threshold) {
    match.odds = {
      available: false,
      status: 'below_score_threshold',
      bookmaker: 'Unibet'
    };
    continue;
  }

  const cached = await readOddsCache(
    cacheDirectory,
    match,
    Number(config.cacheHours ?? 6)
  );

  if (cached) {
    match.odds = { ...cached, status: 'cached' };
    if (match.odds.available) available += 1;
    continue;
  }

  if (!process.env.ODDS_API_KEY || !events.length) {
    match.odds = {
      available: false,
      status: 'odds_source_unavailable',
      bookmaker: 'Unibet'
    };
    continue;
  }

  const event = matchOddsEvent(
    match,
    events,
    Number(config.kickoffToleranceHours ?? 12)
  );

  if (!event) {
    match.odds = {
      available: false,
      status: 'event_not_matched',
      bookmaker: 'Unibet'
    };
    warnings.push(
      `${match.home} - ${match.away}: kunne ikke matches med et Odds-API.io-event.`
    );
    continue;
  }

  try {
    const eventId = event.id || event.eventId || event.fixtureId;
    const payload = await fetchUnibetOdds(process.env.ODDS_API_KEY, eventId);
    match.odds = {
      ...parseUnibetOver15(payload),
      eventId
    };
    await writeOddsCache(cacheDirectory, match, match.odds);
    if (match.odds.available) available += 1;
  } catch (error) {
    match.odds = {
      available: false,
      status: 'api_error',
      bookmaker: 'Unibet'
    };
    warnings.push(`${match.home} - ${match.away}: ${error.message}`);
  }
}

dashboard.results = matches.filter(match => match.passed);
dashboard.nearMisses = matches.filter(match => !match.passed);
dashboard.oddsSummary = {
  provider: 'Odds-API.io',
  bookmaker: 'Unibet',
  market: 'Over 1,5 mål',
  threshold,
  candidates: candidates.length,
  available
};
dashboard.warnings = warnings;

await fs.writeFile(resultsFile, JSON.stringify(dashboard, null, 2), 'utf8');
console.log(
  `Unibet-odds: ${available}/${candidates.length} kandidater med score ${threshold}+.`
);
