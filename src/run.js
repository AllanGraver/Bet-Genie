/*
 * BetScope CSV-only analysepipeline
 *
 * Datakilder:
 * - FBref CSV-filer i data/leagues er eneste kilde til:
 *   - kommende fixtures
 *   - historiske resultater
 *   - form
 *   - H2H
 *
 * Der foretages ingen API-Football-kald.
 *
 * Unibet-odds fra Odds-API.io tilføjes efterfølgende af:
 *
 * node src/enrich-odds.js
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  discoverCsvLeagues
} from './csv.js';

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

const dashboardDataDirectory = path.join(
  root,
  'docs',
  'data'
);

const dashboardResultFile = path.join(
  dashboardDataDirectory,
  'results.json'
);


/*
 * Opret nødvendige mapper.
 */
await fs.mkdir(
  leagueDataDirectory,
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


/*
 * Læs konfigurationsfiler.
 */
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


/*
 * ------------------------------------------------------------
 * DATOER
 * ------------------------------------------------------------
 */


/*
 * Kontrollerer formatet YYYY-MM-DD.
 */
function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(
    String(value || '')
  );
}


/*
 * Lægger et antal dage til en dato.
 */
function addDays(
  dateText,
  numberOfDays
) {
  if (!isIsoDate(dateText)) {
    throw new Error(
      `Ugyldig dato: ${dateText}. ` +
      'Forventet format er YYYY-MM-DD.'
    );
  }

  const date = new Date(
    `${dateText}T12:00:00Z`
  );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    throw new Error(
      `Datoen kunne ikke fortolkes: ${dateText}`
    );
  }

  date.setUTCDate(
    date.getUTCDate() +
    numberOfDays
  );

  return date
    .toISOString()
    .slice(0, 10);
}


/*
 * Finder den aktuelle dato
 * i den konfigurerede tidszone.
 */
function getCurrentDateInTimezone(
  timezone
) {
  return new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }
  ).format(
    new Date()
  );
}


const timezone = String(
  settings.timezone ||
  'Europe/Copenhagen'
).trim();


const environmentAnalysisDate =
  String(
    process.env.ANALYSIS_DATE ||
    ''
  ).trim();


const analysisDate =
  environmentAnalysisDate ||
  getCurrentDateInTimezone(
    timezone
  );


if (!isIsoDate(analysisDate)) {
  throw new Error(
    `ANALYSIS_DATE er ugyldig: ${analysisDate}. ` +
    'Forventet format er YYYY-MM-DD.'
  );
}


const analysisPeriodDays =
  Math.max(
    1,
    Number(
      settings.analysisPeriodDays ||
      7
    )
  );


const analysisEndDate =
  addDays(
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
    removed: true
  },

  oddsApi: {
    enabled: false,
    appliedAfterBuild: true,
    provider: 'Odds-API.io',
    bookmaker: 'Unibet'
  }
};


/*
 * ------------------------------------------------------------
 * HJÆLPEFUNKTIONER
 * ------------------------------------------------------------
 */


/*
 * Normaliserer tekst til nøgler.
 */
function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(
      /[\u0300-\u036f]/g,
      ''
    )
    .replace(
      /[^a-z0-9æøå]+/g,
      '-'
    )
    .replace(
      /^-+|-+$/g,
      ''
    );
}


/*
 * Returnerer en stabil kampnøgle.
 */
function matchKey(match) {
  if (match.fixtureId) {
    return `fixture:${match.fixtureId}`;
  }

  return [
    match.date,
    normalizeText(
      match.home
    ),
    normalizeText(
      match.away
    )
  ].join('|');
}


/*
 * Kontrollerer, om kampen
 * indeholder et afsluttet resultat.
 */
function hasFinishedScore(match) {
  return (
    match.homeScore !== null &&
    match.homeScore !== undefined &&
    match.awayScore !== null &&
    match.awayScore !== undefined &&
    Number.isFinite(
      Number(
        match.homeScore
      )
    ) &&
    Number.isFinite(
      Number(
        match.awayScore
      )
    )
  );
}


/*
 * Samler kampe og fjerner dubletter.
 *
 * En afsluttet kamp med resultat
 * prioriteres over en planlagt kamp
 * uden resultat.
 */
function mergeMatches(
  ...collections
) {
  const matchMap =
    new Map();

  for (
    const collection
    of collections
  ) {
    if (
      !Array.isArray(
        collection
      )
    ) {
      continue;
    }

    for (
      const match
      of collection
    ) {
      if (!match) {
        continue;
      }

      const key =
        matchKey(match);

      const existing =
        matchMap.get(key);

      if (!existing) {
        matchMap.set(
          key,
          match
        );

        continue;
      }

      const existingFinished =
        hasFinishedScore(
          existing
        );

      const incomingFinished =
        hasFinishedScore(
          match
        );

      if (
        incomingFinished &&
        !existingFinished
      ) {
        matchMap.set(
          key,
          match
        );

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

          kickoff:
            existing.kickoff ||
            match.kickoff ||
            null,

          time:
            existing.time ||
            match.time ||
            '',

          source:
            existing.source ||
            match.source ||
            'CSV'
        }
      );
    }
  }

  return Array.from(
    matchMap.values()
  );
}


/*
 * Finder kommende kampe i analyseperioden.
 *
 * En kamp betragtes som kommende,
 * når resultatet er tomt.
 */
function periodFixturesFromCsv(
  matches,
  fromDate,
  toDate
) {
  return matches.filter(
    match => {
      if (
        !match.date ||
        match.date < fromDate ||
        match.date > toDate
      ) {
        return false;
      }

      return !hasFinishedScore(
        match
      );
    }
  );
}


/*
 * ------------------------------------------------------------
 * FIND OG LÆS CSV-FILER
 * ------------------------------------------------------------
 */

const discovery =
  await discoverCsvLeagues(
    leagueDataDirectory,
    leagueConfiguration
  );


const foundLeagueFiles =
  Array.isArray(
    discovery.found
  )
    ? discovery.found
    : [];


const unknownCsvFiles =
  Array.isArray(
    discovery.unknown
  )
    ? discovery.unknown
    : [];


sourceStatus.csv.filesFound =
  foundLeagueFiles.length;


sourceStatus.csv.available =
  foundLeagueFiles.length > 0;


sourceStatus.csv.leaguesFound =
  new Set(
    foundLeagueFiles
      .map(
        file =>
          file.league?.slug
      )
      .filter(Boolean)
  ).size;


if (
  foundLeagueFiles.length === 0
) {
  warnings.push(
    'Ingen genkendte CSV-filer blev fundet i data/leagues.'
  );
}


if (
  unknownCsvFiles.length > 0
) {
  warnings.push(
    `${unknownCsvFiles.length} CSV-fil(er) ` +
    'kunne ikke forbindes med en liga ' +
    'i config/leagues.json.'
  );
}


/*
 * Saml historik fra alle CSV-filer.
 *
 * Flere sæsonfiler kan derfor
 * anvendes for samme liga.
 */
const allHistory =
  mergeMatches(
    foundLeagueFiles.flatMap(
      file =>
        Array.isArray(
          file.matches
        )
          ? file.matches
          : []
    )
  );


/*
 * Find kommende fixtures
 * i den valgte syvdagesperiode.
 */
const periodFixtures =
  periodFixturesFromCsv(
    allHistory,
    analysisDate,
    analysisEndDate
  );


if (
  periodFixtures.length === 0
) {
  warnings.push(
    `Ingen kommende CSV-kampe blev fundet ` +
    `fra ${analysisDate} til ${analysisEndDate}. ` +
    'CSV-filerne skal indeholde kommende kampe ' +
    'med et tomt resultatfelt.'
  );
}


/*
 * ------------------------------------------------------------
 * PRE-ANALYSE
 * ------------------------------------------------------------
 */

const preAnalyses =
  periodFixtures
    .map(
      fixture =>
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
      (
        matchA,
        matchB
      ) =>
        Number(
          matchB.preScore ||
          0
        ) -
        Number(
          matchA.preScore ||
          0
        )
    );


/*
 * ------------------------------------------------------------
 * ENDELIG ANALYSE
 * ------------------------------------------------------------
 *
 * H2H findes kun lokalt i CSV-historikken.
 */

const finalResults = [];


for (
  const candidate
  of preAnalyses
) {
  const h2hMatches =
    localH2H(
      allHistory,
      candidate
    );


  const h2hSource =
    h2hMatches.length > 0
      ? 'CSV'
      : 'Ingen H2H-data';


  const finalResult =
    finalise(
      candidate,
      h2hMatches,
      settings,
      h2hSource
    );


  finalResults.push(
    finalResult
  );
}


/*
 * Godkendte kampe først.
 * Derefter højeste score.
 */
finalResults.sort(
  (
    matchA,
    matchB
  ) =>
    Number(
      matchB.passed
    ) -
      Number(
        matchA.passed
      ) ||
    Number(
      matchB.score ||
      0
    ) -
      Number(
        matchA.score ||
        0
      )
);


const approvedResults =
  finalResults.filter(
    match =>
      match.passed
  );


const nearMisses =
  finalResults.filter(
    match =>
      !match.passed
  );


/*
 * ------------------------------------------------------------
 * UNIKKE LIGAER
 * ------------------------------------------------------------
 */

const leagueSummaryMap =
  new Map();


for (
  const leagueFile
  of foundLeagueFiles
) {
  const league =
    leagueFile.league;

  if (!league) {
    continue;
  }


  const key =
    league.slug ||
    normalizeText(
      league.displayName
    );


  if (
    !leagueSummaryMap.has(
      key
    )
  ) {
    leagueSummaryMap.set(
      key,
      {
        slug:
          league.slug ||
          key,

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


  const summary =
    leagueSummaryMap.get(
      key
    );


  summary.csvRows +=
    Number(
      leagueFile.rowCount ||
      0
    );


  summary.csvFiles += 1;
}


/*
 * Tæl kommende kampe
 * pr. unik liga.
 */
for (
  const fixture
  of periodFixtures
) {
  const key =
    fixture.leagueSlug ||
    normalizeText(
      fixture.leagueName
    );


  const summary =
    leagueSummaryMap.get(
      key
    );


  if (summary) {
    summary.periodMatches += 1;
  }
}


const foundLeagues =
  Array.from(
    leagueSummaryMap.values()
  )
    .sort(
      (
        leagueA,
        leagueB
      ) =>
        leagueA.name.localeCompare(
          leagueB.name,
          'da'
        )
    );


/*
 * ------------------------------------------------------------
 * GRUPPÉR KAMPE PR. DATO
 * ------------------------------------------------------------
 
