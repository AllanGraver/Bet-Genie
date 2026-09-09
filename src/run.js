/*
 * BetScope: CSV er hovedkilde, API-Football er valgfrit supplement.
 * Dashboardet bygges for den kommende uge, også når API-nøglen mangler
 * eller et API-kald fejler.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { discoverCsvLeagues, writeLeagueMemory } from './csv.js';
import { ApiFootball, apiFixtureToMatch } from './apiFootball.js';
import { preAnalyse, finalise, localH2H } from './analyse.js';

const root = process.cwd();
const settings = JSON.parse(await fs.readFile('config/settings.json', 'utf8'));
const leagueConfiguration = JSON.parse(await fs.readFile('config/leagues.json', 'utf8'));
const leagueDataDirectory = path.join(root, 'data', 'leagues');
const cacheDirectory = path.join(root, 'data', 'cache');
const dashboardDataDirectory = path.join(root, 'docs', 'data');
const dashboardResultFile = path.join(dashboardDataDirectory, 'results.json');
const requestLogFile = path.join(cacheDirectory, 'request-log.json');

await fs.mkdir(leagueDataDirectory, { recursive: true });
await fs.mkdir(cacheDirectory, { recursive: true });
await fs.mkdir(dashboardDataDirectory, { recursive: true });

function addDays(dateText, days) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const analysisDate = process.env.ANALYSIS_DATE || new Intl.DateTimeFormat('en-CA', {
  timeZone: settings.timezone || 'Europe/Copenhagen',
  year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());
const analysisPeriodDays = Math.max(1, Number(settings.analysisPeriodDays || 7));
const analysisEndDate = addDays(analysisDate, analysisPeriodDays - 1);

const warnings = [];
const errors = [];
const sourceStatus = {
  csv: { enabled: true, available: false, filesFound: 0, leaguesFound: 0 },
  apiFootball: {
    enabled: false,
    available: false,
    keyConfigured: false,
    requestsUsed: 0,
    requestsRemaining: null,
    error: null
  }
};

const normalizeText = value => String(value || '')
  .trim().toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9æøå]+/g, '-')
  .replace(/^-+|-+$/g, '');

function matchKey(match) {
  return match.fixtureId
    ? `fixture:${match.fixtureId}`
    : `${match.date}|${normalizeText(match.home)}|${normalizeText(match.away)}`;
}

function mergeMatches(...collections) {
  const map = new Map();
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    for (const match of collection) {
      if (!match) continue;
      const key = matchKey(match);
      const existing = map.get(key);
      if (!existing) {
        map.set(key, match);
        continue;
      }
      const existingFinished = Number.isFinite(Number(existing.homeScore)) && Number.isFinite(Number(existing.awayScore));
      const incomingFinished = Number.isFinite(Number(match.homeScore)) && Number.isFinite(Number(match.awayScore));
      if (incomingFinished && !existingFinished) {
        map.set(key, match);
      } else {
        map.set(key, {
          ...existing,
          fixtureId: existing.fixtureId || match.fixtureId || null,
          homeId: existing.homeId || match.homeId || null,
          awayId: existing.awayId || match.awayId || null,
          kickoff: existing.kickoff || match.kickoff || null,
          time: existing.time || match.time || ''
        });
      }
    }
  }
  return [...map.values()];
}

function periodFixturesFromCsv(matches, from, to) {
  return matches.filter(match => {
    if (!match.date || match.date < from || match.date > to) return false;
    const finished = match.homeScore !== null && match.homeScore !== undefined &&
      match.awayScore !== null && match.awayScore !== undefined &&
      Number.isFinite(Number(match.homeScore)) && Number.isFinite(Number(match.awayScore));
    return !finished;
  });
}

async function readH2HCache(file, maxAgeDays) {
  try {
    const cached = JSON.parse(await fs.readFile(file, 'utf8'));
    const ageDays = (Date.now() - new Date(cached.fetchedAt).getTime()) / 86400000;
    if (!Array.isArray(cached.matches) || ageDays > maxAgeDays) return null;
    return cached;
  } catch {
    return null;
  }
}

async function writeH2HCache(file, matches) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    matches
  }, null, 2), 'utf8');
}

function h2hCandidateKeys(preAnalyses, perDay, totalMaximum) {
  const byDate = new Map();
  for (const match of preAnalyses) {
    if (!byDate.has(match.date)) byDate.set(match.date, []);
    byDate.get(match.date).push(match);
  }
  const selected = [];
  for (const matches of byDate.values()) {
    selected.push(...matches.sort((a, b) => Number(b.preScore || 0) - Number(a.preScore || 0)).slice(0, perDay));
  }
  return new Set(selected
    .sort((a, b) => Number(b.preScore || 0) - Number(a.preScore || 0))
    .slice(0, totalMaximum)
    .map(matchKey));
}

const discovery = await discoverCsvLeagues(leagueDataDirectory, leagueConfiguration);
const foundLeagueFiles = Array.isArray(discovery.found) ? discovery.found : [];
const unknownCsvFiles = Array.isArray(discovery.unknown) ? discovery.unknown : [];
sourceStatus.csv.filesFound = foundLeagueFiles.length;
sourceStatus.csv.available = foundLeagueFiles.length > 0;

const activeLeagueMap = new Map();
for (const leagueFile of foundLeagueFiles) {
  const league = leagueFile.league;
  if (league?.apiLeagueId && !activeLeagueMap.has(Number(league.apiLeagueId))) {
    activeLeagueMap.set(Number(league.apiLeagueId), league);
  }
}
sourceStatus.csv.leaguesFound = activeLeagueMap.size;

let allHistory = mergeMatches(foundLeagueFiles.flatMap(file => Array.isArray(file.matches) ? file.matches : []));
const csvPeriodFixtures = periodFixturesFromCsv(allHistory, analysisDate, analysisEndDate);
let periodFixtures = [...csvPeriodFixtures];

const apiKey = String(process.env.API_FOOTBALL_KEY || '').trim();
let apiFootball = null;
if (apiKey) {
  sourceStatus.apiFootball.keyConfigured = true;
  try {
    apiFootball = new ApiFootball(apiKey, settings.apiBaseUrl, settings.dailyHardLimit);
    sourceStatus.apiFootball.enabled = true;
    sourceStatus.apiFootball.available = true;
  } catch (error) {
    warnings.push(`API-Football kunne ikke aktiveres: ${error.message}`);
    sourceStatus.apiFootball.error = error.message;
  }
} else {
  warnings.push('API_FOOTBALL_KEY er ikke konfigureret. Ugeoversigten bygges kun fra CSV-data.');
}

if (apiFootball && activeLeagueMap.size > 0) {
  try {
    const response = await apiFootball.get('/fixtures', {
      from: analysisDate,
      to: analysisEndDate,
      timezone: settings.timezone || 'Europe/Copenhagen'
    });
    const apiPeriodFixtures = response
      .filter(item => activeLeagueMap.has(Number(item.league?.id)))
      .map(item => apiFixtureToMatch(item, activeLeagueMap.get(Number(item.league.id))));
    periodFixtures = mergeMatches(csvPeriodFixtures, apiPeriodFixtures);
  } catch (error) {
    warnings.push(`Ugens fixtures kunne ikke hentes fra API-Football. CSV-data bruges: ${error.message}`);
    sourceStatus.apiFootball.available = false;
    sourceStatus.apiFootball.error = error.message;
  }
}

/* Valgfri catch-up. Fejl stopper aldrig CSV-workflowet. */
if (apiFootball && activeLeagueMap.size > 0) {
  const previousDate = addDays(analysisDate, -1);
  for (const league of activeLeagueMap.values()) {
    try {
      const response = await apiFootball.get('/fixtures', {
        league: league.apiLeagueId,
        season: league.season,
        from: previousDate,
        to: analysisDate,
        status: 'FT-AET-PEN'
      });
      const apiMatches = response.map(item => apiFixtureToMatch(item, league));
      const existing = allHistory.filter(match => match.leagueSlug === league.slug);
      const updated = mergeMatches(existing, apiMatches, periodFixtures.filter(match => match.leagueSlug === league.slug));
      await writeLeagueMemory(leagueDataDirectory, league, updated);
      allHistory = mergeMatches(allHistory.filter(match => match.leagueSlug !== league.slug), updated);
    } catch (error) {
      warnings.push(`${league.displayName}: API catch-up blev sprunget over: ${error.message}`);
    }
  }
}

let preAnalyses = periodFixtures
  .map(fixture => preAnalyse(
    fixture,
    allHistory.filter(match => match.leagueSlug === fixture.leagueSlug),
    settings
  ))
  .sort((a, b) => Number(b.preScore || 0) - Number(a.preScore || 0));

const candidateKeys = h2hCandidateKeys(
  preAnalyses,
  Number(settings.h2hCandidatesPerDay || 3),
  Number(settings.h2hCandidateLimit || 15)
);

const finalResults = [];
for (const candidate of preAnalyses) {
  let h2hMatches = localH2H(allHistory, candidate);
  let h2hSource = h2hMatches.length ? 'CSV' : 'Ingen H2H-data';
  const shouldRequest = Boolean(apiFootball) &&
    candidateKeys.has(matchKey(candidate)) &&
    h2hMatches.length < settings.h2hMinimumMatches &&
    candidate.homeId && candidate.awayId;

  if (shouldRequest) {
    const low = Math.min(candidate.homeId, candidate.awayId);
    const high = Math.max(candidate.homeId, candidate.awayId);
    const cacheFile = path.join(cacheDirectory, `h2h-${low}-${high}.json`);
    const cached = await readH2HCache(cacheFile, settings.h2hCacheDays);
    if (cached) {
      h2hMatches = cached.matches;
      h2hSource = 'API-Football cache';
    } else {
      try {
        const response = await apiFootball.get('/fixtures/headtohead', {
          h2h: `${candidate.homeId}-${candidate.awayId}`,
          last: 10
        });
        h2hMatches = response.map(item => apiFixtureToMatch(item, activeLeagueMap.get(Number(item.league?.id)) || {
          slug: candidate.leagueSlug,
          displayName: item.league?.name || candidate.leagueName,
          apiLeagueId: item.league?.id,
          season: item.league?.season
        }));
        await writeH2HCache(cacheFile, h2hMatches);
        h2hSource = 'API-Football';
      } catch (error) {
        warnings.push(`${candidate.home} - ${candidate.away}: H2H-supplement fejlede: ${error.message}`);
      }
    }
  }

  finalResults.push(finalise(candidate, h2hMatches, settings, h2hSource));
}

finalResults.sort((a, b) => Number(b.passed) - Number(a.passed) || Number(b.score || 0) - Number(a.score || 0));
const approvedResults = finalResults.filter(match => match.passed);
const nearMisses = finalResults.filter(match => !match.passed);

const leagueSummaryMap = new Map();
for (const leagueFile of foundLeagueFiles) {
  const league = leagueFile.league;
  if (!league) continue;
  const key = league.slug || normalizeText(league.displayName);
  if (!leagueSummaryMap.has(key)) {
    leagueSummaryMap.set(key, {
      slug: league.slug || key,
      name: league.displayName || league.slug || 'Ukendt liga',
      csvRows: 0,
      csvFiles: 0,
      periodMatches: 0
    });
  }
  const summary = leagueSummaryMap.get(key);
  summary.csvRows += Number(leagueFile.rowCount || 0);
  summary.csvFiles += 1;
}
for (const fixture of periodFixtures) {
  const summary = leagueSummaryMap.get(fixture.leagueSlug || normalizeText(fixture.leagueName));
  if (summary) summary.periodMatches += 1;
}
const foundLeagues = [...leagueSummaryMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'da'));

const matchesByDate = [...new Set(finalResults.map(match => match.date).filter(Boolean))]
  .sort()
  .map(date => {
    const dateMatches = finalResults.filter(match => match.date === date);
    return {
      date,
      totalMatches: dateMatches.length,
      approved: dateMatches.filter(match => match.passed).sort((a, b) => b.score - a.score),
      nearMisses: dateMatches.filter(match => !match.passed).sort((a, b) => b.score - a.score)
    };
  });

if (apiFootball) {
  sourceStatus.apiFootball.requestsUsed = apiFootball.used;
  sourceStatus.apiFootball.requestsRemaining = apiFootball.remaining;
  try {
    await apiFootball.saveLog(requestLogFile);
  } catch (error) {
    warnings.push(`Requestloggen kunne ikke gemmes: ${error.message}`);
  }
}

const output = {
  date: analysisDate,
  period: { from: analysisDate, to: analysisEndDate, days: analysisPeriodDays },
  updatedAt: new Date().toISOString(),
  totalMatches: periodFixtures.length,
  foundLeagues,
  uniqueLeagueCount: foundLeagues.length,
  unknownCsvFiles,
  results: approvedResults,
  nearMisses,
  matchesByDate,
  requestUsage: {
    enabled: Boolean(apiFootball),
    used: apiFootball ? apiFootball.used : 0,
    remaining: apiFootball ? apiFootball.remaining : null,
    hardLimit: settings.dailyHardLimit
  },
  dataSources: sourceStatus,
  warnings,
  errors
};

await fs.writeFile(dashboardResultFile, JSON.stringify(output, null, 2), 'utf8');
console.log(JSON.stringify({
  period: output.period,
  apiFootballEnabled: Boolean(apiFootball),
  csvFilesFound: foundLeagueFiles.length,
  uniqueLeaguesFound: foundLeagues.length,
  periodFixtures: periodFixtures.length,
  approved: approvedResults.length,
  notApproved: nearMisses.length,
  requestsUsed: output.requestUsage.used,
  warnings: warnings.length,
  errors: errors.length
}, null, 2));
