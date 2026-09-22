/*
 * BetScope
 *
 * CSV-filer er den primære datakilde.
 * API-Football er et valgfrit supplement til:
 * - kommende fixtures
 * - catch-up af afsluttede kampe
 * - manglende H2H-data
 *
 * Unibet-odds fra Odds-API.io tilføjes bagefter af:
 *   node src/enrich-odds.js
 *
 * Vigtigt:
 * API-Football-kald med from/to udføres pr. liga og inkluderer både
 * league og season. Det undgår fejlen om, at from/to/timezone mangler
 * nødvendige ledsageparametre.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  discoverCsvLeagues,
  writeLeagueMemory
} from './csv.js';

import {
  ApiFootball,
  apiFixtureToMatch
} from './apiFootball.js';

import {
  preAnalyse,
  finalise,
  localH2H
} from './analyse.js';

/*
 * ------------------------------------------------------------
 * STIER OG KONFIGURATION
 * ------------------------------------------------------------
 */

const root = process.cwd();

const settingsFile = path.join(
  root,
  'config',
  'settings.json'
);

const leaguesFile = path.join(
  root,
  'config',
  'leagues.json'
);

const leagueDataDirectory = path.join(
  root,
  'data',
  'leagues'
);

const cacheDirectory = path.join(
  root,
  'data',
  'cache'
);

const dashboardDataDirectory = path.join(
  root,
  'docs',
  'data'
);

const dashboardResultFile = path.join(
  dashboardDataDirectory,
  'results.json'
);

const requestLogFile = path.join(
  cacheDirectory,
  'request-log.json'
);

await fs.mkdir(leagueDataDirectory, {
  recursive: true
});

await fs.mkdir(cacheDirectory, {
  recursive: true
});

await fs.mkdir(dashboardDataDirectory, {
  recursive: true
});

const settings = JSON.parse(
  await fs.readFile(settingsFile, 'utf8')
);

const leagueConfiguration = JSON.parse(
  await fs.readFile(leaguesFile, 'utf8')
);

/*
 * ------------------------------------------------------------
 * DATOER
 * ------------------------------------------------------------
 */

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(
    String(value || '')
  );
}

function addDays(dateText, days) {
  if (!isIsoDate(dateText)) {
    throw new Error(
      `Ugyldig dato: ${dateText}. Forventet format er YYYY-MM-DD.`
    );
  }

  const date = new Date(`${dateText}T12:00:00Z`);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Datoen kunne ikke fortolkes: ${dateText}`);
  }

  date.setUTCDate(date.getUTCDate() + days);

  return date
    .toISOString()
    .slice(0, 10);
}

function getCurrentDateInTimezone(timezone) {
  return new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }
  ).format(new Date());
}

const timezone = String(
  settings.timezone || 'Europe/Copenhagen'
).trim();

const environmentAnalysisDate = String(
  process.env.ANALYSIS_DATE || ''
).trim();

const analysisDate = environmentAnalysisDate ||
  getCurrentDateInTimezone(timezone);

if (!isIsoDate(analysisDate)) {
  throw new Error(
    `ANALYSIS_DATE er ugyldig: ${analysisDate}. ` +
    'Forventet format er YYYY-MM-DD.'
  );
}

const analysisPeriodDays = Math.max(
  1,
  Number(settings.analysisPeriodDays || 7)
);

const analysisEndDate = addDays(
  analysisDate,
  analysisPeriodDays - 1
);

/*
 * ------------------------------------------------------------
 * STATUS OG ADVARSLER
 * ------------------------------------------------------------
 */

const warnings = [];
const errors = [];

const sourceStatus = {
  csv: {
    enabled: true,
    available: false,
    filesFound: 0,
    leaguesFound: 0
  },

  apiFootball: {
    enabled: false,
    available: false,
    keyConfigured: false,
    requestsUsed: 0,
    requestsRemaining: null,
    error: null
  }
};

/*
 * ------------------------------------------------------------
 * HJÆLPEFUNKTIONER
 * ------------------------------------------------------------
 */

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9æøå]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function matchKey(match) {
  if (match.fixtureId) {
    return `fixture:${match.fixtureId}`;
  }

  return [
    match.date,
    normalizeText(match.home),
    normalizeText(match.away)
  ].join('|');
}

function hasFinishedScore(match) {
  return (
    match.homeScore !== null &&
    match.homeScore !== undefined &&
    match.awayScore !== null &&
    match.awayScore !== undefined &&
    Number.isFinite(Number(match.homeScore)) &&
    Number.isFinite(Number(match.awayScore))
  );
}

function mergeMatches(...collections) {
  const matchMap = new Map();

  for (const collection of collections) {
    if (!Array.isArray(collection)) {
      continue;
    }

    for (const match of collection) {
      if (!match) {
        continue;
      }

      const key = matchKey(match);
      const existing = matchMap.get(key);

      if (!existing) {
        matchMap.set(key, match);
        continue;
      }

      const existingFinished = hasFinishedScore(existing);
      const incomingFinished = hasFinishedScore(match);

      if (incomingFinished && !existingFinished) {
        matchMap.set(key, match);
        continue;
      }

      matchMap.set(
        key,
        {
          ...existing,
          fixtureId:
            existing.fixtureId ||
            match.fixtureId ||
            null,
          homeId:
            existing.homeId ||
            match.homeId ||
            null,
          awayId:
            existing.awayId ||
            match.awayId ||
            null,
          kickoff:
            existing.kickoff ||
            match.kickoff ||
            null,
          time:
            existing.time ||
            match.time ||
            ''
        }
      );
    }
  }

  return Array.from(matchMap.values());
}

function periodFixturesFromCsv(
  matches,
  fromDate,
  toDate
) {
  return matches.filter(match => {
    if (
      !match.date ||
      match.date < fromDate ||
      match.date > toDate
    ) {
      return false;
    }

    return !hasFinishedScore(match);
  });
}

async function readH2HCache(
  file,
  maximumAgeInDays
) {
  try {
    const cached = JSON.parse(
      await fs.readFile(file, 'utf8')
    );

    if (
      !cached.fetchedAt ||
      !Array.isArray(cached.matches)
    ) {
      return null;
    }

    const ageInDays = (
      Date.now() -
      new Date(cached.fetchedAt).getTime()
    ) / 86400000;

    if (ageInDays > maximumAgeInDays) {
      return null;
    }

    return cached;
  } catch {
    return null;
  }
}

async function writeH2HCache(file, matches) {
  await fs.mkdir(
    path.dirname(file),
    {
      recursive: true
    }
  );

  await fs.writeFile(
    file,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        matches
      },
      null,
      2
    ),
    'utf8'
  );
}

function h2hCandidateKeys(
  preAnalyses,
  maximumPerDay,
  totalMaximum
) {
  const matchesByDate = new Map();

  for (const match of preAnalyses) {
    if (!matchesByDate.has(match.date)) {
      matchesByDate.set(match.date, []);
    }

    matchesByDate
      .get(match.date)
      .push(match);
  }

  const selected = [];

  for (const matches of matchesByDate.values()) {
    matches.sort(
      (matchA, matchB) =>
        Number(matchB.preScore || 0) -
        Number(matchA.preScore || 0)
    );

    selected.push(
      ...matches.slice(0, maximumPerDay)
    );
  }

  return new Set(
    selected
      .sort(
        (matchA, matchB) =>
          Number(matchB.preScore || 0) -
          Number(matchA.preScore || 0)
      )
      .slice(0, totalMaximum)
      .map(matchKey)
  );
}

function validateLeagueForApi(league) {
  return Boolean(
    league &&
    Number.isFinite(Number(league.apiLeagueId)) &&
    Number.isFinite(Number(league.season))
  );
}

/*
 * ------------------------------------------------------------
 * FIND OG LÆS CSV-FILER
 * ------------------------------------------------------------
 */

const discovery = await discoverCsvLeagues(
  leagueDataDirectory,
  leagueConfiguration
);

const foundLeagueFiles = Array.isArray(
  discovery.found
)
  ? discovery.found
  : [];

const unknownCsvFiles = Array.isArray(
  discovery.unknown
)
  ? discovery.unknown
  : [];

sourceStatus.csv.filesFound = foundLeagueFiles.length;
sourceStatus.csv.available = foundLeagueFiles.length > 0;

const activeLeagueMap = new Map();

for (const leagueFile of foundLeagueFiles) {
  const league = leagueFile.league;

  if (!validateLeagueForApi(league)) {
    if (league) {
      warnings.push(
        `${league.displayName || league.slug}: ` +
        'API league ID eller season mangler. ' +
        'Ligaen bruger kun CSV-data.'
      );
    }

    continue;
  }

  const apiLeagueId = Number(league.apiLeagueId);

  if (!activeLeagueMap.has(apiLeagueId)) {
    activeLeagueMap.set(apiLeagueId, league);
  }
}

sourceStatus.csv.leaguesFound = new Set(
  foundLeagueFiles
    .map(file => file.league?.slug)
    .filter(Boolean)
).size;

let allHistory = mergeMatches(
  foundLeagueFiles.flatMap(file =>
    Array.isArray(file.matches)
      ? file.matches
      : []
  )
);

const csvPeriodFixtures = periodFixturesFromCsv(
  allHistory,
  analysisDate,
  analysisEndDate
);

let periodFixtures = [...csvPeriodFixtures];

/*
 * ------------------------------------------------------------
 * AKTIVÉR API-FOOTBALL VALGFRIT
 * ------------------------------------------------------------
 */

const apiKey = String(
  process.env.API_FOOTBALL_KEY || ''
).trim();

let apiFootball = null;

if (apiKey) {
  sourceStatus.apiFootball.keyConfigured = true;

  try {
    apiFootball = new ApiFootball(
      apiKey,
      settings.apiBaseUrl,
      settings.dailyHardLimit
    );

    sourceStatus.apiFootball.enabled = true;
    sourceStatus.apiFootball.available = true;
  } catch (error) {
    apiFootball = null;
    sourceStatus.apiFootball.error = error.message;

    warnings.push(
      `API-Football kunne ikke aktiveres: ${error.message}`
    );
  }
} else {
  warnings.push(
    'API_FOOTBALL_KEY er ikke konfigureret. ' +
    'Ugeoversigten bygges kun fra CSV-data.'
  );
}

/*
 * ------------------------------------------------------------
 * HENT UGENS FIXTURES PR. LIGA
 * ------------------------------------------------------------
 *
 * API-Football kræver ledsageparametre ved brug af from/to.
 * Derfor foretages kaldet pr. aktiv liga med:
 * - league
 * - season
 * - from
 * - to
 * - timezone
 */

if (apiFootball && activeLeagueMap.size > 0) {
  const apiPeriodFixtures = [];
  let successfulLeagueRequests = 0;

  console.log('API-Football fixtureperiode:', {
    from: analysisDate,
    to: analysisEndDate,
    timezone,
    activeLeagues: activeLeagueMap.size
  });

  for (const league of activeLeagueMap.values()) {
    const fixtureParameters = {
      league: Number(league.apiLeagueId),
      season: Number(league.season),
      from: analysisDate,
      to: analysisEndDate,
      timezone
    };

    console.log(
      `Henter ugefixtures for ${league.displayName}:`,
      fixtureParameters
    );

    try {
      const response = await apiFootball.get(
        '/fixtures',
        fixtureParameters
      );

      apiPeriodFixtures.push(
        ...response.map(item =>
          apiFixtureToMatch(item, league)
        )
      );

      successfulLeagueRequests += 1;
    } catch (error) {
      warnings.push(
        `${league.displayName}: ugefixtures kunne ikke hentes ` +
        `fra API-Football. CSV-data bruges: ${error.message}`
      );
    }
  }

  periodFixtures = mergeMatches(
    csvPeriodFixtures,
    apiPeriodFixtures
  );

  sourceStatus.apiFootball.available =
    successfulLeagueRequests > 0;

  if (successfulLeagueRequests === 0) {
    sourceStatus.apiFootball.error =
      'Ingen ligakald efter ugefixtures lykkedes.';
  }
}

/*
 * ------------------------------------------------------------
 * VALGFRIT CATCH-UP AF AFSLUTTEDE KAMPE
 * ------------------------------------------------------------
 */

if (apiFootball && activeLeagueMap.size > 0) {
  const previousDate = addDays(analysisDate, -1);

  for (const league of activeLeagueMap.values()) {
    try {
      const response = await apiFootball.get(
        '/fixtures',
        {
          league: Number(league.apiLeagueId),
          season: Number(league.season),
          from: previousDate,
          to: analysisDate,
          status: 'FT-AET-PEN',
          timezone
        }
      );

      const apiMatches = response.map(item =>
        apiFixtureToMatch(item, league)
      );

      const existingLeagueHistory = allHistory.filter(
        match =>
          match.leagueSlug === league.slug
      );

      const updatedLeagueHistory = mergeMatches(
        existingLeagueHistory,
        apiMatches,
        periodFixtures.filter(
          match =>
            match.leagueSlug === league.slug
        )
      );

      await writeLeagueMemory(
        leagueDataDirectory,
        league,
        updatedLeagueHistory
      );

      allHistory = mergeMatches(
        allHistory.filter(
          match =>
            match.leagueSlug !== league.slug
        ),
        updatedLeagueHistory
      );
    } catch (error) {
      warnings.push(
        `${league.displayName}: API catch-up blev sprunget over: ` +
        error.message
      );
    }
  }
}

/*
 * ------------------------------------------------------------
 * PRE-ANALYSE
 * ------------------------------------------------------------
 */

let preAnalyses = periodFixtures
  .map(fixture =>
    preAnalyse(
      fixture,
      allHistory.filter(
        match =>
          match.leagueSlug === fixture.leagueSlug
      ),
      settings
    )
  )
  .sort(
    (matchA, matchB) =>
      Number(matchB.preScore || 0) -
      Number(matchA.preScore || 0)
  );

const candidateKeys = h2hCandidateKeys(
  preAnalyses,
  Number(settings.h2hCandidatesPerDay || 3),
  Number(settings.h2hCandidateLimit || 15)
);

/*
 * ------------------------------------------------------------
 * ENDELIG ANALYSE OG VALGFRIT H2H-SUPPLEMENT
 * ------------------------------------------------------------
 */

const finalResults = [];

for (const candidate of preAnalyses) {
  let h2hMatches = localH2H(
    allHistory,
    candidate
  );

  let h2hSource = h2hMatches.length
    ? 'CSV'
    : 'Ingen H2H-data';

  const shouldRequestH2H = (
    Boolean(apiFootball) &&
    candidateKeys.has(matchKey(candidate)) &&
    h2hMatches.length <
      Number(settings.h2hMinimumMatches || 5) &&
    candidate.homeId &&
    candidate.awayId
  );

  if (shouldRequestH2H) {
    const lowerTeamId = Math.min(
      Number(candidate.homeId),
      Number(candidate.awayId)
    );

    const higherTeamId = Math.max(
      Number(candidate.homeId),
      Number(candidate.awayId)
    );

    const cacheFile = path.join(
      cacheDirectory,
      `h2h-${lowerTeamId}-${higherTeamId}.json`
    );

    const cached = await readH2HCache(
      cacheFile,
      Number(settings.h2hCacheDays || 30)
    );

    if (cached) {
      h2hMatches = cached.matches;
      h2hSource = 'API-Football cache';
    } else {
      try {
        const response = await apiFootball.get(
          '/fixtures/headtohead',
          {
            h2h:
              `${candidate.homeId}-${candidate.awayId}`,
            last: 10
          }
        );

        h2hMatches = response.map(item => {
          const responseLeague = activeLeagueMap.get(
            Number(item.league?.id)
          ) || {
            slug: candidate.leagueSlug,
            displayName:
              item.league?.name ||
              candidate.leagueName,
            apiLeagueId: item.league?.id,
            season: item.league?.season
          };

          return apiFixtureToMatch(
            item,
            responseLeague
          );
        });

        await writeH2HCache(
          cacheFile,
          h2hMatches
        );

        h2hSource = 'API-Football';
      } catch (error) {
        warnings.push(
          `${candidate.home} - ${candidate.away}: ` +
          `H2H-supplement fejlede: ${error.message}`
        );
      }
    }
  }

  finalResults.push(
    finalise(
      candidate,
      h2hMatches,
      settings,
      h2hSource
    )
  );
}

/*
 * ------------------------------------------------------------
 * SORTERING OG OPDELING
 * ------------------------------------------------------------
 */

finalResults.sort(
  (matchA, matchB) =>
    Number(matchB.passed) -
      Number(matchA.passed) ||
    Number(matchB.score || 0) -
      Number(matchA.score || 0)
);

const approvedResults = finalResults.filter(
  match => match.passed
);

const nearMisses = finalResults.filter(
  match => !match.passed
);

/*
 * ------------------------------------------------------------
 * UNIKKE LIGAER
 * ------------------------------------------------------------
 */

const leagueSummaryMap = new Map();

for (const leagueFile of foundLeagueFiles) {
  const league = leagueFile.league;

  if (!league) {
    continue;
  }

  const key = league.slug ||
    normalizeText(league.displayName);

  if (!leagueSummaryMap.has(key)) {
    leagueSummaryMap.set(
      key,
      {
        slug: league.slug || key,
        name:
          league.displayName ||
          league.slug ||
          'Ukendt liga',
        csvRows: 0,
        csvFiles: 0,
        periodMatches: 0
      }
    );
  }

  const summary = leagueSummaryMap.get(key);

  summary.csvRows += Number(
    leagueFile.rowCount || 0
  );

  summary.csvFiles += 1;
}

for (const fixture of periodFixtures) {
  const key = fixture.leagueSlug ||
    normalizeText(fixture.leagueName);

  const summary = leagueSummaryMap.get(key);

  if (summary) {
    summary.periodMatches += 1;
  }
}

const foundLeagues = Array.from(
  leagueSummaryMap.values()
).sort(
  (leagueA, leagueB) =>
    leagueA.name.localeCompare(
      leagueB.name,
      'da'
    )
);

/*
 * ------------------------------------------------------------
 * GRUPPÉR KAMPE PR. DATO
 * ------------------------------------------------------------
 */

const matchesByDate = Array.from(
  new Set(
    finalResults
      .map(match => match.date)
      .filter(Boolean)
  )
)
  .sort()
  .map(date => {
    const dateMatches = finalResults.filter(
      match => match.date === date
    );

    return {
      date,
      totalMatches: dateMatches.length,
      approved: dateMatches
        .filter(match => match.passed)
        .sort(
          (matchA, matchB) =>
            Number(matchB.score || 0) -
            Number(matchA.score || 0)
        ),
      nearMisses: dateMatches
        .filter(match => !match.passed)
        .sort(
          (matchA, matchB) =>
            Number(matchB.score || 0) -
            Number(matchA.score || 0)
        )
    };
  });

/*
 * ------------------------------------------------------------
 * API-STATUS OG REQUESTLOG
 * ------------------------------------------------------------
 */

if (apiFootball) {
  sourceStatus.apiFootball.requestsUsed =
    apiFootball.used;

  sourceStatus.apiFootball.requestsRemaining =
    apiFootball.remaining;

  try {
    await apiFootball.saveLog(
      requestLogFile
    );
  } catch (error) {
    warnings.push(
      `Requestloggen kunne ikke gemmes: ${error.message}`
    );
  }
}

/*
 * ------------------------------------------------------------
 * GEM DASHBOARDDATA
 * ------------------------------------------------------------
 *
 * Odds tilføjes efterfølgende af src/enrich-odds.js.
 */

const output = {
  date: analysisDate,

  period: {
    from: analysisDate,
    to: analysisEndDate,
    days: analysisPeriodDays
  },

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
    used: apiFootball
      ? apiFootball.used
      : 0,
    remaining: apiFootball
      ? apiFootball.remaining
      : null,
    hardLimit: Number(
      settings.dailyHardLimit || 85
    )
  },

  dataSources: sourceStatus,

  warnings,

  errors
};

await fs.writeFile(
  dashboardResultFile,
  JSON.stringify(output, null, 2),
  'utf8'
);

console.log(
  JSON.stringify(
    {
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
    },
    null,
    2
  )
);
