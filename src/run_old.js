/*
 * BetScope
 *
 * CSV-filer er den primære datakilde.
 *
 * API-Football er et valgfrit supplement til:
 * - kommende fixtures
 * - catch-up af afsluttede kampe
 * - manglende H2H-data
 *
 * config/leagues.json er masterfil for:
 * - CSV-filgenkendelse
 * - ligaens visningsnavn
 * - API-Football league ID og season
 * - TheRundown sport ID
 * - fallback-link til Unibet
 *
 * Odds tilføjes efterfølgende af et separat enrichment-trin.
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

const defaultFootballOddsUrl =
  'https://www.unibet.dk/betting/sports/filter/football';

const rundownProviderName = 'TheRundown';
const rundownBookmakerName = 'Unibet';
const rundownBookmakerId = 21;

await fs.mkdir(
  leagueDataDirectory,
  {
    recursive: true
  }
);

await fs.mkdir(
  cacheDirectory,
  {
    recursive: true
  }
);

await fs.mkdir(
  dashboardDataDirectory,
  {
    recursive: true
  }
);

const settings = JSON.parse(
  await fs.readFile(
    settingsFile,
    'utf8'
  )
);

const leagueConfiguration = JSON.parse(
  await fs.readFile(
    leaguesFile,
    'utf8'
  )
);

if (!Array.isArray(leagueConfiguration)) {
  throw new Error(
    'config/leagues.json skal indeholde et JSON-array.'
  );
}

/*
 * ------------------------------------------------------------
 * VALIDÉR LEAGUES.JSON
 * ------------------------------------------------------------
 */

const missingLeagueSlugs = leagueConfiguration
  .filter(league =>
    !String(league?.slug || '').trim()
  );

if (missingLeagueSlugs.length > 0) {
  throw new Error(
    'En eller flere ligaer i config/leagues.json mangler slug.'
  );
}

const configuredLeagueSlugs = leagueConfiguration
  .map(league =>
    String(league.slug).trim()
  );

const duplicateLeagueSlugs = configuredLeagueSlugs
  .filter(
    (slug, index, slugs) =>
      slugs.indexOf(slug) !== index
  );

if (duplicateLeagueSlugs.length > 0) {
  throw new Error(
    'Dublerede liga-slugs i config/leagues.json: ' +
    [...new Set(duplicateLeagueSlugs)].join(', ')
  );
}

for (const league of leagueConfiguration) {
  if (
    league.filePatterns !== undefined &&
    !Array.isArray(league.filePatterns)
  ) {
    throw new Error(
      `${league.slug}: filePatterns skal være et array.`
    );
  }

  if (
    league.rundownSportId !== null &&
    league.rundownSportId !== undefined &&
    (
      !Number.isFinite(Number(league.rundownSportId)) ||
      Number(league.rundownSportId) <= 0
    )
  ) {
    throw new Error(
      `${league.slug}: rundownSportId skal være et positivt tal ` +
      'eller null.'
    );
  }

  if (
    league.fallbackOddsUrl !== undefined &&
    league.fallbackOddsUrl !== null
  ) {
    const fallbackUrl = String(
      league.fallbackOddsUrl
    ).trim();

    if (
      fallbackUrl &&
      !fallbackUrl.startsWith('https://')
    ) {
      throw new Error(
        `${league.slug}: fallbackOddsUrl skal bruge HTTPS.`
      );
    }
  }
}

const leagueConfigurationBySlug = new Map(
  leagueConfiguration.map(league => [
    String(league.slug).trim(),
    league
  ])
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
      `Ugyldig dato: ${dateText}. ` +
      'Forventet format er YYYY-MM-DD.'
    );
  }

  const date = new Date(
    `${dateText}T12:00:00Z`
  );

  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `Datoen kunne ikke fortolkes: ${dateText}`
    );
  }

  date.setUTCDate(
    date.getUTCDate() + days
  );

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

const analysisDate =
  environmentAnalysisDate ||
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
  },

  odds: {
    provider: rundownProviderName,
    bookmaker: rundownBookmakerName,
    bookmakerId: rundownBookmakerId,
    keyConfigured: Boolean(
      String(
        process.env.THERUNDOWN_API_KEY || ''
      ).trim()
    ),
    configuredLeagues: 0,
    supportedLeagues: 0,
    fallbackLeagues: 0,
    enrichmentPending: true
  }
};

/*
 * ------------------------------------------------------------
 * GENERELLE HJÆLPEFUNKTIONER
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

function uniqueNormalizedValues(values) {
  return [
    ...new Set(
      values
        .filter(Boolean)
        .map(normalizeText)
        .filter(Boolean)
    )
  ];
}

function findLeagueConfiguration(leagueOrMatch) {
  if (!leagueOrMatch) {
    return null;
  }

  const slug = String(
    leagueOrMatch.slug ||
    leagueOrMatch.leagueSlug ||
    ''
  ).trim();

  if (
    slug &&
    leagueConfigurationBySlug.has(slug)
  ) {
    return leagueConfigurationBySlug.get(slug);
  }

  const inputCandidates = uniqueNormalizedValues([
    leagueOrMatch.slug,
    leagueOrMatch.leagueSlug,
    leagueOrMatch.displayName,
    leagueOrMatch.name,
    leagueOrMatch.leagueName
  ]);

  if (inputCandidates.length === 0) {
    return null;
  }

  for (const configuredLeague of leagueConfiguration) {
    const configuredCandidates =
      uniqueNormalizedValues([
        configuredLeague.slug,
        configuredLeague.displayName,
        ...(
          Array.isArray(
            configuredLeague.filePatterns
          )
            ? configuredLeague.filePatterns
            : []
        )
      ]);

    const matches = inputCandidates.some(
      candidate =>
        configuredCandidates.includes(candidate)
    );

    if (matches) {
      return configuredLeague;
    }
  }

  return null;
}

function getFallbackOddsUrl(leagueOrMatch) {
  const league =
    findLeagueConfiguration(leagueOrMatch);

  const configuredUrl = String(
    league?.fallbackOddsUrl || ''
  ).trim();

  return (
    configuredUrl ||
    defaultFootballOddsUrl
  );
}

function getRundownSportId(leagueOrMatch) {
  const league =
    findLeagueConfiguration(leagueOrMatch);

  if (!league) {
    return null;
  }

  /*
   * Vigtigt:
   * Number(null) bliver 0 i JavaScript.
   * Derfor kontrolleres null og undefined eksplicit.
   */
  if (
    league.rundownSportId === null ||
    league.rundownSportId === undefined ||
    String(league.rundownSportId).trim() === ''
  ) {
    return null;
  }

  const sportId = Number(
    league.rundownSportId
  );

  if (
    !Number.isFinite(sportId) ||
    sportId <= 0
  ) {
    return null;
  }

  return sportId;
}

function hasRundownCoverage(leagueOrMatch) {
  return getRundownSportId(
    leagueOrMatch
  ) !== null;
}

function getLeagueOddsConfiguration(
  leagueOrMatch
) {
  const rundownSportId =
    getRundownSportId(leagueOrMatch);

  const rundownSupported =
    rundownSportId !== null;

  return {
    source: rundownSupported
      ? 'therundown'
      : 'external-link',

    provider: rundownProviderName,

    bookmaker: rundownBookmakerName,

    bookmakerId: rundownBookmakerId,

    rundownSupported,

    rundownSportId,

    fallbackUrl:
      getFallbackOddsUrl(leagueOrMatch),

    fallbackLabel:
      'Find odds hos Unibet'
  };
}

function enrichMatchWithOddsConfiguration(
  match
) {
  const oddsConfiguration =
    getLeagueOddsConfiguration(match);

  return {
    ...match,

    oddsConfiguration,

    /*
     * pending betyder, at enrich-odds.js skal forsøge
     * at hente odds for denne kamp.
     *
     * external-link betyder, at ligaen ikke har et
     * verificeret TheRundown sport ID.
     */
    oddsStatus:
      oddsConfiguration.rundownSupported
        ? 'pending'
        : 'external-link',

    oddsSource:
      oddsConfiguration.rundownSupported
        ? rundownProviderName
        : null,

    bookmaker:
      rundownBookmakerName,

    fallbackOddsUrl:
      oddsConfiguration.fallbackUrl,

    fallbackOddsLabel:
      oddsConfiguration.fallbackLabel
  };
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
    Number.isFinite(
      Number(match.homeScore)
    ) &&
    Number.isFinite(
      Number(match.awayScore)
    )
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

      const existingFinished =
        hasFinishedScore(existing);

      const incomingFinished =
        hasFinishedScore(match);

      if (
        incomingFinished &&
        !existingFinished
      ) {
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
            '',

          leagueSlug:
            existing.leagueSlug ||
            match.leagueSlug ||
            null,

          leagueName:
            existing.leagueName ||
            match.leagueName ||
            null
        }
      );
    }
  }

  return Array.from(
    matchMap.values()
  );
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
      await fs.readFile(
        file,
        'utf8'
      )
    );

    if (
      !cached.fetchedAt ||
      !Array.isArray(cached.matches)
    ) {
      return null;
    }

    const fetchedAtTime = new Date(
      cached.fetchedAt
    ).getTime();

    if (!Number.isFinite(fetchedAtTime)) {
      return null;
    }

    const ageInDays = (
      Date.now() -
      fetchedAtTime
    ) / 86400000;

    if (ageInDays > maximumAgeInDays) {
      return null;
    }

    return cached;
  } catch {
    return null;
  }
}

async function writeH2HCache(
  file,
  matches
) {
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
        fetchedAt:
          new Date().toISOString(),
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
      matchesByDate.set(
        match.date,
        []
      );
    }

    matchesByDate
      .get(match.date)
      .push(match);
  }

  const selected = [];

  for (
    const matches of matchesByDate.values()
  ) {
    matches.sort(
      (matchA, matchB) =>
        Number(matchB.preScore || 0) -
        Number(matchA.preScore || 0)
    );

    selected.push(
      ...matches.slice(
        0,
        maximumPerDay
      )
    );
  }

  return new Set(
    selected
      .sort(
        (matchA, matchB) =>
          Number(matchB.preScore || 0) -
          Number(matchA.preScore || 0)
      )
      .slice(
        0,
        totalMaximum
      )
      .map(matchKey)
  );
}

function validateLeagueForApiFootball(
  league
) {
  if (!league) {
    return false;
  }

  if (
    league.apiLeagueId === null ||
    league.apiLeagueId === undefined ||
    String(league.apiLeagueId).trim() === ''
  ) {
    return false;
  }

  if (
    league.season === null ||
    league.season === undefined ||
    String(league.season).trim() === ''
  ) {
    return false;
  }

  const leagueId = Number(
    league.apiLeagueId
  );

  const season = Number(
    league.season
  );

  return (
    Number.isFinite(leagueId) &&
    leagueId > 0 &&
    Number.isFinite(season) &&
    season > 0
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

sourceStatus.csv.filesFound =
  foundLeagueFiles.length;

sourceStatus.csv.available =
  foundLeagueFiles.length > 0;

/*
 * Denne map bruges kun til API-Football.
 * Den må ikke bruges som mål for alle aktive CSV-ligaer.
 */
const apiFootballLeagueMap = new Map();

for (const leagueFile of foundLeagueFiles) {
  const discoveredLeague =
    leagueFile.league;

  const league =
    findLeagueConfiguration(
      discoveredLeague
    ) ||
    discoveredLeague;

  if (!league) {
    continue;
  }

  if (
    !validateLeagueForApiFootball(league)
  ) {
    warnings.push(
      `${league.displayName || league.slug}: ` +
      'API-Football league ID eller season mangler. ' +
      'Ligaen bruger kun CSV-data.'
    );

    continue;
  }

  const apiLeagueId = Number(
    league.apiLeagueId
  );

  if (
    !apiFootballLeagueMap.has(
      apiLeagueId
    )
  ) {
    apiFootballLeagueMap.set(
      apiLeagueId,
      league
    );
  }
}

sourceStatus.csv.leaguesFound = new Set(
  foundLeagueFiles
    .map(file =>
      file.league?.slug
    )
    .filter(Boolean)
).size;

let allHistory = mergeMatches(
  foundLeagueFiles.flatMap(file =>
    Array.isArray(file.matches)
      ? file.matches
      : []
  )
);

const csvPeriodFixtures =
  periodFixturesFromCsv(
    allHistory,
    analysisDate,
    analysisEndDate
  );

let periodFixtures = [
  ...csvPeriodFixtures
];

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
  sourceStatus.apiFootball.keyConfigured =
    true;

  try {
    apiFootball = new ApiFootball(
      apiKey,
      settings.apiBaseUrl,
      settings.dailyHardLimit
    );

    sourceStatus.apiFootball.enabled =
      true;

    sourceStatus.apiFootball.available =
      true;
  } catch (error) {
    apiFootball = null;

    sourceStatus.apiFootball.error =
      error.message;

    warnings.push(
      'API-Football kunne ikke aktiveres: ' +
      error.message
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
 *
 * - league
 * - season
 * - from
 * - to
 * - timezone
 */

if (
  apiFootball &&
  apiFootballLeagueMap.size > 0
) {
  const apiPeriodFixtures = [];
  let successfulLeagueRequests = 0;

  console.log(
    'API-Football fixtureperiode:',
    {
      from: analysisDate,
      to: analysisEndDate,
      timezone,
      activeLeagues:
        apiFootballLeagueMap.size
    }
  );

  for (
    const league of
      apiFootballLeagueMap.values()
  ) {
    const fixtureParameters = {
      league:
        Number(league.apiLeagueId),

      season:
        Number(league.season),

      from:
        analysisDate,

      to:
        analysisEndDate,

      timezone
    };

    console.log(
      `Henter ugefixtures for ${league.displayName}:`,
      fixtureParameters
    );

    try {
      const response =
        await apiFootball.get(
          '/fixtures',
          fixtureParameters
        );

      apiPeriodFixtures.push(
        ...response.map(item =>
          apiFixtureToMatch(
            item,
            league
          )
        )
      );

      successfulLeagueRequests += 1;
    } catch (error) {
      warnings.push(
        `${league.displayName}: ` +
        'ugefixtures kunne ikke hentes ' +
        'fra API-Football. CSV-data bruges: ' +
        error.message
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

if (
  apiFootball &&
  apiFootballLeagueMap.size > 0
) {
  const previousDate = addDays(
    analysisDate,
    -1
  );

  for (
    const league of
      apiFootballLeagueMap.values()
  ) {
    try {
      const response =
        await apiFootball.get(
          '/fixtures',
          {
            league:
              Number(league.apiLeagueId),

            season:
              Number(league.season),

            from:
              previousDate,

            to:
              analysisDate,

            status:
              'FT-AET-PEN',

            timezone
          }
        );

      const apiMatches = response.map(
        item =>
          apiFixtureToMatch(
            item,
            league
          )
      );

      const existingLeagueHistory =
        allHistory.filter(
          match =>
            match.leagueSlug ===
            league.slug
        );

      const updatedLeagueHistory =
        mergeMatches(
          existingLeagueHistory,

          apiMatches,

          periodFixtures.filter(
            match =>
              match.leagueSlug ===
              league.slug
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
            match.leagueSlug !==
            league.slug
        ),
        updatedLeagueHistory
      );
    } catch (error) {
      warnings.push(
        `${league.displayName}: ` +
        'API catch-up blev sprunget over: ' +
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

const preAnalyses = periodFixtures
  .map(fixture =>
    preAnalyse(
      fixture,

      allHistory.filter(
        match =>
          match.leagueSlug ===
          fixture.leagueSlug
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
  Number(
    settings.h2hCandidatesPerDay || 3
  ),
  Number(
    settings.h2hCandidateLimit || 15
  )
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
    candidateKeys.has(
      matchKey(candidate)
    ) &&
    h2hMatches.length <
      Number(
        settings.h2hMinimumMatches || 5
      ) &&
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
      Number(
        settings.h2hCacheDays || 30
      )
    );

    if (cached) {
      h2hMatches = cached.matches;
      h2hSource =
        'API-Football cache';
    } else {
      try {
        const response =
          await apiFootball.get(
            '/fixtures/headtohead',
            {
              h2h:
                `${candidate.homeId}-` +
                `${candidate.awayId}`,

              last: 10
            }
          );

        h2hMatches = response.map(item => {
          const responseLeague =
            apiFootballLeagueMap.get(
              Number(item.league?.id)
            ) || {
              slug:
                candidate.leagueSlug,

              displayName:
                item.league?.name ||
                candidate.leagueName,

              apiLeagueId:
                item.league?.id,

              season:
                item.league?.season
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

        h2hSource =
          'API-Football';
      } catch (error) {
        warnings.push(
          `${candidate.home} - ` +
          `${candidate.away}: ` +
          'H2H-supplement fejlede: ' +
          error.message
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
 * TILFØJ ODDSKONFIGURATION TIL KAMPENE
 * ------------------------------------------------------------
 */

const enrichedFinalResults =
  finalResults.map(
    enrichMatchWithOddsConfiguration
  );

/*
 * ------------------------------------------------------------
 * SORTERING OG OPDELING
 * ------------------------------------------------------------
 */

enrichedFinalResults.sort(
  (matchA, matchB) =>
    Number(matchB.passed) -
      Number(matchA.passed) ||
    Number(matchB.score || 0) -
      Number(matchA.score || 0)
);

const approvedResults =
  enrichedFinalResults.filter(
    match => match.passed
  );

const nearMisses =
  enrichedFinalResults.filter(
    match => !match.passed
  );

/*
 * ------------------------------------------------------------
 * UNIKKE LIGAER
 * ------------------------------------------------------------
 */

const leagueSummaryMap = new Map();

for (const leagueFile of foundLeagueFiles) {
  const discoveredLeague =
    leagueFile.league;

  if (!discoveredLeague) {
    continue;
  }

  const configuredLeague =
    findLeagueConfiguration(
      discoveredLeague
    ) ||
    discoveredLeague;

  const key =
    configuredLeague.slug ||
    normalizeText(
      configuredLeague.displayName
    );

  if (!key) {
    continue;
  }

  if (!leagueSummaryMap.has(key)) {
    const oddsConfiguration =
      getLeagueOddsConfiguration(
        configuredLeague
      );

    leagueSummaryMap.set(
      key,
      {
        slug:
          configuredLeague.slug ||
          key,

        name:
          configuredLeague.displayName ||
          configuredLeague.slug ||
          'Ukendt liga',

        apiFootball: {
          configured:
            validateLeagueForApiFootball(
              configuredLeague
            ),

          leagueId:
            validateLeagueForApiFootball(
              configuredLeague
            )
              ? Number(
                  configuredLeague.apiLeagueId
                )
              : null,

          season:
            validateLeagueForApiFootball(
              configuredLeague
            )
              ? Number(
                  configuredLeague.season
                )
              : null
        },

        odds: {
          provider:
            oddsConfiguration.provider,

          bookmaker:
            oddsConfiguration.bookmaker,

          bookmakerId:
            oddsConfiguration.bookmakerId,

          rundownSupported:
            oddsConfiguration
              .rundownSupported,

          rundownSportId:
            oddsConfiguration
              .rundownSportId,

          status:
            oddsConfiguration
              .rundownSupported
              ? 'pending'
              : 'external-link',

          fallbackUrl:
            oddsConfiguration
              .fallbackUrl,

          fallbackLabel:
            oddsConfiguration
              .fallbackLabel
        },

        csvRows: 0,
        csvFiles: 0,
        periodMatches: 0
      }
    );
  }

  const summary =
    leagueSummaryMap.get(key);

  summary.csvRows += Number(
    leagueFile.rowCount ||
    (
      Array.isArray(
        leagueFile.matches
      )
        ? leagueFile.matches.length
        : 0
    )
  );

  summary.csvFiles += 1;
}

/*
 * Optæl periodekampe pr. liga.
 *
 * Der bruges både direkte slug-opslag og konfigurationsopslag,
 * så forskelle i CSV-navne ikke forhindrer optælling.
 */
for (const fixture of periodFixtures) {
  const configuredLeague =
    findLeagueConfiguration(fixture);

  const key =
    configuredLeague?.slug ||
    fixture.leagueSlug ||
    normalizeText(
      fixture.leagueName
    );

  const summary =
    leagueSummaryMap.get(key);

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

sourceStatus.odds.configuredLeagues =
  foundLeagues.length;

sourceStatus.odds.supportedLeagues =
  foundLeagues.filter(
    league =>
      league.odds?.rundownSupported
  ).length;

sourceStatus.odds.fallbackLeagues =
  foundLeagues.filter(
    league =>
      !league.odds?.rundownSupported
  ).length;

/*
 * ------------------------------------------------------------
 * GRUPPÉR KAMPE PR. DATO
 * ------------------------------------------------------------
 */

const matchesByDate = Array.from(
  new Set(
    enrichedFinalResults
      .map(match => match.date)
      .filter(Boolean)
  )
)
  .sort()
  .map(date => {
    const dateMatches =
      enrichedFinalResults.filter(
        match =>
          match.date === date
      );

    return {
      date,

      totalMatches:
        dateMatches.length,

      approved:
        dateMatches
          .filter(
            match => match.passed
          )
          .sort(
            (matchA, matchB) =>
              Number(
                matchB.score || 0
              ) -
              Number(
                matchA.score || 0
              )
          ),

      nearMisses:
        dateMatches
          .filter(
            match => !match.passed
          )
          .sort(
            (matchA, matchB) =>
              Number(
                matchB.score || 0
              ) -
              Number(
                matchA.score || 0
              )
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
      'Requestloggen kunne ikke gemmes: ' +
      error.message
    );
  }
}

/*
 * ------------------------------------------------------------
 * GEM DASHBOARDDATA
 * ------------------------------------------------------------
 *
 * Odds kan tilføjes efterfølgende af et separat enrichment-trin.
 *
 * Kampene har nu:
 * - oddsStatus
 * - oddsSource
 * - bookmaker
 * - oddsConfiguration
 * - fallbackOddsUrl
 * - fallbackOddsLabel
 */

const output = {
  date: analysisDate,

  period: {
    from: analysisDate,
    to: analysisEndDate,
    days: analysisPeriodDays
  },

  updatedAt:
    new Date().toISOString(),

  oddsConfiguration: {
    provider:
      rundownProviderName,

    bookmaker:
      rundownBookmakerName,

    bookmakerId:
      rundownBookmakerId,

    keyConfigured:
      sourceStatus.odds.keyConfigured,

    enrichmentPending:
      true,

    fallbackEnabled:
      true,

    defaultFallbackUrl:
      defaultFootballOddsUrl
  },

  totalMatches:
    periodFixtures.length,

  foundLeagues,

  uniqueLeagueCount:
    foundLeagues.length,

  unknownCsvFiles,

  results:
    approvedResults,

  nearMisses,

  matchesByDate,

  requestUsage: {
    enabled:
      Boolean(apiFootball),

    used:
      apiFootball
        ? apiFootball.used
        : 0,

    remaining:
      apiFootball
        ? apiFootball.remaining
        : null,

    hardLimit:
      Number(
        settings.dailyHardLimit || 85
      )
  },

  dataSources:
    sourceStatus,

  warnings,

  errors
};

await fs.writeFile(
  dashboardResultFile,
  JSON.stringify(
    output,
    null,
    2
  ),
  'utf8'
);

console.log(
  JSON.stringify(
    {
      period:
        output.period,

      apiFootballEnabled:
        Boolean(apiFootball),

      csvFilesFound:
        foundLeagueFiles.length,

      uniqueLeaguesFound:
        foundLeagues.length,

      periodFixtures:
        periodFixtures.length,

      approved:
        approvedResults.length,

      notApproved:
        nearMisses.length,

      rundownSupportedLeagues:
        sourceStatus.odds
          .supportedLeagues,

      fallbackLeagues:
        sourceStatus.odds
          .fallbackLeagues,

      requestsUsed:
        output.requestUsage.used,

      warnings:
        warnings.length,

      errors:
        errors.length
    },
    null,
    2
  )
);
