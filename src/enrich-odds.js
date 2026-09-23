/*
 * BetScope odds-enrichment
 *
 * Læser kampene fra:
 *   docs/data/results.json
 *
 * Ligaernes TheRundown-konfiguration kommer fra de oddsConfiguration-
 * felter, som src/run.js har tilføjet på hver kamp.
 *
 * For ligaer med et rundownSportId:
 * - hentes events pr. liga og dato
 * - data filtreres til Unibet, affiliate ID 21
 * - kampen matches på holdnavne og kickoff
 * - Over 1,5 mål forsøges udtrukket
 *
 * Hvis odds ikke findes:
 * - kampen bevares
 * - oddsStatus sættes til external-link
 * - fallbackOddsUrl fra leagues.json bevares
 *
 * Denne fil skal køres efter src/run.js.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  fetchRundownEvents,
  matchRundownEvent,
  parseUnibetOver15,
  readRundownCache,
  writeRundownCache
} from './theRundown.js';

/*
 * ------------------------------------------------------------
 * STIER
 * ------------------------------------------------------------
 */

const root = process.cwd();

const resultsFile = path.join(
  root,
  'docs',
  'data',
  'results.json'
);

const oddsConfigFile = path.join(
  root,
  'config',
  'odds.json'
);

const cacheDirectory = path.join(
  root,
  'data',
  'cache',
  'therundown'
);

/*
 * ------------------------------------------------------------
 * STANDARDKONFIGURATION
 * ------------------------------------------------------------
 */

const defaultConfiguration = {
  enabled: true,
  provider: 'TheRundown',
  bookmaker: 'Unibet',
  bookmakerId: 21,
  minimumScore: 80,
  cacheHours: 6,
  kickoffToleranceHours: 12,
  requestTimeoutMs: 15000,
  market: 'over-1.5',

  /*
   * Market ID 3 er Total, altså Over/Under.
   * Over 1,5 identificeres efterfølgende via line.value = 1.5.
   */
  marketIds: [3],

  /*
   * Skal være false, da Over/Under 1,5 ikke nødvendigvis
   * er bookmakerens hovedlinje.
   */
  mainLineOnly: false
};

/*
 * ------------------------------------------------------------
 * INDLÆS KONFIGURATION
 * ------------------------------------------------------------
 */

async function readOptionalJsonFile(
  file,
  fallbackValue
) {
  try {
    const contents = await fs.readFile(
      file,
      'utf8'
    );

    const parsed = JSON.parse(contents);

    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        'Konfigurationsfilen skal indeholde et JSON-objekt.'
      );
    }

    return {
      ...fallbackValue,
      ...parsed
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        ...fallbackValue
      };
    }

    throw new Error(
      `${file} kunne ikke indlæses: ${error.message}`
    );
  }
}

const configuration =
  await readOptionalJsonFile(
    oddsConfigFile,
    defaultConfiguration
  );

const dashboard = JSON.parse(
  await fs.readFile(
    resultsFile,
    'utf8'
  )
);

await fs.mkdir(
  cacheDirectory,
  {
    recursive: true
  }
);

/*
 * ------------------------------------------------------------
 * STATUS OG KONSTANTER
 * ------------------------------------------------------------
 */

const executionTime =
  new Date().toISOString();

const previousWarnings = Array.isArray(
  dashboard.warnings
)
  ? dashboard.warnings
  : [];

const errors = Array.isArray(
  dashboard.errors
)
  ? dashboard.errors
  : [];

/*
 * Fjern advarsler fra tidligere oddsberigelser.
 * Dermed vokser advarselslisten ikke ved hver ny kørsel.
 */
const warnings = previousWarnings.filter(
  warning => {
    const text = String(warning || '');

    return (
      !text.includes('THERUNDOWN_API_KEY') &&
      !text.includes('Odds-integrationen er deaktiveret') &&
      !text.includes('TheRundown kunne ikke hente') &&
      !text.includes('TheRundown-cache kunne ikke') &&
      !text.includes('kunne ikke matches med et TheRundown-event') &&
      !text.includes('event-matching fejlede') &&
      !text.includes('oddsdata kunne ikke fortolkes')
    );
  }
);

const apiKey = String(
  process.env.THERUNDOWN_API_KEY || ''
).trim();

const provider = String(
  configuration.provider ||
  'TheRundown'
).trim();

const bookmaker = String(
  configuration.bookmaker ||
  'Unibet'
).trim();

const bookmakerId = Number(
  configuration.bookmakerId ?? 21
);

const threshold = Number(
  configuration.minimumScore ?? 80
);

const cacheHours = Math.max(
  0,
  Number(
    configuration.cacheHours ?? 6
  )
);

const kickoffToleranceHours = Math.max(
  0,
  Number(
    configuration.kickoffToleranceHours ?? 12
  )
);

const requestTimeoutMs = Math.max(
  1000,
  Number(
    configuration.requestTimeoutMs ?? 15000
  )
);

const configuredMarketIds = Array.isArray(
  configuration.marketIds
)
  ? configuration.marketIds
  : [3];

const marketIds = [
  ...new Set(
    configuredMarketIds
      .map(Number)
      .filter(
        marketId =>
          Number.isFinite(marketId) &&
          marketId > 0
      )
  )
];

if (marketIds.length === 0) {
  marketIds.push(3);
}

if (marketIds.length > 12) {
  throw new Error(
    'Der må højst konfigureres 12 TheRundown market IDs.'
  );
}

const mainLineOnly = Boolean(
  configuration.mainLineOnly
);

const statistics = {
  totalMatches: 0,
  candidates: 0,
  belowThreshold: 0,
  apiEligible: 0,
  fallbackOnly: 0,
  available: 0,
  cached: 0,
  notMatched: 0,
  noEvents: 0,
  noMarket: 0,
  apiErrors: 0,
  requests: 0,
  cacheHits: 0
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

function isValidHttpsUrl(value) {
  try {
    const url = new URL(
      String(value || '').trim()
    );

    return (
      url.protocol === 'https:' &&
      Boolean(url.hostname)
    );
  } catch {
    return false;
  }
}

function matchIdentity(match) {
  if (
    match?.fixtureId !== null &&
    match?.fixtureId !== undefined &&
    String(match.fixtureId).trim() !== ''
  ) {
    return `fixture:${String(match.fixtureId).trim()}`;
  }

  return [
    match?.date || '',
    normalizeText(match?.home),
    normalizeText(match?.away),
    normalizeText(
      match?.leagueSlug ||
      match?.leagueName
    )
  ].join('|');
}

function getRundownSportId(match) {
  const value =
    match?.oddsConfiguration
      ?.rundownSportId;

  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ''
  ) {
    return null;
  }

  const sportId = Number(value);

  return (
    Number.isFinite(sportId) &&
    sportId > 0
  )
    ? sportId
    : null;
}

function getFallbackUrl(match) {
  const candidates = [
    match?.fallbackOddsUrl,
    match?.oddsConfiguration?.fallbackUrl,
    match?.odds?.fallbackUrl,
    dashboard?.oddsConfiguration
      ?.defaultFallbackUrl
  ];

  for (const candidate of candidates) {
    const url = String(
      candidate || ''
    ).trim();

    if (isValidHttpsUrl(url)) {
      return url;
    }
  }

  return '';
}

function getFallbackLabel(match) {
  return String(
    match?.fallbackOddsLabel ||
    match?.oddsConfiguration
      ?.fallbackLabel ||
    match?.odds?.fallbackLabel ||
    'Find odds hos Unibet'
  ).trim();
}

function candidateDate(match) {
  const date = String(
    match?.date || ''
  ).trim();

  if (
    /^\d{4}-\d{2}-\d{2}$/.test(date)
  ) {
    return date;
  }

  const kickoff = String(
    match?.kickoff || ''
  ).trim();

  if (!kickoff) {
    return null;
  }

  const parsed = new Date(kickoff);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed
    .toISOString()
    .slice(0, 10);
}

function isCandidate(match) {
  return (
    Number.isFinite(
      Number(match?.score)
    ) &&
    Number(match.score) >= threshold
  );
}

function createUnavailableOdds(
  match,
  status,
  reason
) {
  return {
    available: false,
    status,
    reason,
    provider,
    bookmaker,
    bookmakerId,
    market: 'Over 1,5 mål',
    fallbackUrl:
      getFallbackUrl(match),
    fallbackLabel:
      getFallbackLabel(match),
    checkedAt:
      executionTime
  };
}

function setFallbackStatus(
  match,
  status,
  reason
) {
  const fallbackUrl =
    getFallbackUrl(match);

  const fallbackLabel =
    getFallbackLabel(match);

  match.odds = {
    ...createUnavailableOdds(
      match,
      status,
      reason
    ),
    fallbackUrl,
    fallbackLabel
  };

  match.oddsStatus =
    'external-link';

  match.oddsSource =
    null;

  match.bookmaker =
    bookmaker;

  match.fallbackOddsUrl =
    fallbackUrl;

  match.fallbackOddsLabel =
    fallbackLabel;
}

function setAvailableOdds(
  match,
  parsedOdds,
  eventId,
  detailStatus = 'available'
) {
  const fallbackUrl =
    getFallbackUrl(match);

  const fallbackLabel =
    getFallbackLabel(match);

  match.odds = {
    ...parsedOdds,
    available: true,
    status: detailStatus,
    provider,
    bookmaker,
    bookmakerId,
    market:
      parsedOdds.market ||
      'Over 1,5 mål',
    eventId:
      eventId ||
      parsedOdds.eventId ||
      null,
    fallbackUrl,
    fallbackLabel,
    checkedAt:
      parsedOdds.checkedAt ||
      executionTime
  };

  match.oddsStatus =
    'available';

  match.oddsSource =
    provider;

  match.bookmaker =
    bookmaker;

  match.fallbackOddsUrl =
    fallbackUrl;

  match.fallbackOddsLabel =
    fallbackLabel;
}

function requestGroupKey(
  sportId,
  date
) {
  return `${sportId}|${date}`;
}

function removeDuplicateMatches(
  matches
) {
  const matchMap = new Map();

  for (const match of matches) {
    if (!match) {
      continue;
    }

    const key =
      matchIdentity(match);

    if (!matchMap.has(key)) {
      matchMap.set(
        key,
        match
      );
    }
  }

  return Array.from(
    matchMap.values()
  );
}

function addWarning(message) {
  const normalized =
    String(message || '').trim();

  if (
    normalized &&
    !warnings.includes(normalized)
  ) {
    warnings.push(normalized);
  }
}

/*
 * ------------------------------------------------------------
 * SAML ALLE UNIKKE KAMPE
 * ------------------------------------------------------------
 */

const matches = removeDuplicateMatches([
  ...(
    Array.isArray(dashboard.results)
      ? dashboard.results
      : []
  ),
  ...(
    Array.isArray(dashboard.nearMisses)
      ? dashboard.nearMisses
      : []
  )
]);

statistics.totalMatches =
  matches.length;

const candidates = matches.filter(
  isCandidate
);

statistics.candidates =
  candidates.length;

/*
 * ------------------------------------------------------------
 * INDSAML API-GRUPPER
 * ------------------------------------------------------------
 *
 * Der foretages ét API-kald pr. TheRundown sport ID og dato.
 */

const requestGroups = new Map();

for (const match of matches) {
  if (!isCandidate(match)) {
    statistics.belowThreshold += 1;

    setFallbackStatus(
      match,
      'below-score-threshold',
      `Kampens score er under grænsen på ${threshold}.`
    );

    continue;
  }

  const sportId =
    getRundownSportId(match);

  const date =
    candidateDate(match);

  if (!sportId) {
    statistics.fallbackOnly += 1;

    setFallbackStatus(
      match,
      'league-not-supported',
      'Ligaen har ikke et verificeret TheRundown sport ID.'
    );

    continue;
  }

  if (!date) {
    statistics.fallbackOnly += 1;

    setFallbackStatus(
      match,
      'invalid-match-date',
      'Kampdatoen kunne ikke bestemmes.'
    );

    addWarning(
      `${match.home} - ${match.away}: ` +
      'kampdatoen kunne ikke bestemmes.'
    );

    continue;
  }

  statistics.apiEligible += 1;

  const key = requestGroupKey(
    sportId,
    date
  );

  if (!requestGroups.has(key)) {
    requestGroups.set(
      key,
      {
        key,
        sportId,
        date,
        matches: []
      }
    );
  }

  requestGroups
    .get(key)
    .matches
    .push(match);
}

/*
 * ------------------------------------------------------------
 * KONTROLLÉR KONFIGURATION
 * ------------------------------------------------------------
 */

if (!configuration.enabled) {
  addWarning(
    'Odds-integrationen er deaktiveret i config/odds.json.'
  );

  for (const match of candidates) {
    if (
      getRundownSportId(match) !== null
    ) {
      setFallbackStatus(
        match,
        'integration-disabled',
        'Odds-integrationen er deaktiveret.'
      );
    }
  }
} else if (!apiKey) {
  addWarning(
    'THERUNDOWN_API_KEY mangler. ' +
    'Analysen publiceres med links til Unibet i stedet.'
  );

  for (const match of candidates) {
    if (
      getRundownSportId(match) !== null
    ) {
      setFallbackStatus(
        match,
        'api-key-missing',
        'TheRundown API-nøglen er ikke konfigureret.'
      );
    }
  }
} else {
  /*
   * ----------------------------------------------------------
   * HENT OG MATCH EVENTS
   * ----------------------------------------------------------
   */

  for (
    const group of
      requestGroups.values()
  ) {
    let payload = null;
    let payloadSource = 'api';

    /*
     * Prøv først gyldig cache.
     */
    try {
      const cached =
        await readRundownCache(
          cacheDirectory,
          group.sportId,
          group.date,
          cacheHours
        );

      if (cached) {
        payload = cached;
        payloadSource = 'cache';
        statistics.cacheHits += 1;
      }
    } catch (error) {
      addWarning(
        `${group.sportId}/${group.date}: ` +
        'TheRundown-cache kunne ikke læses: ' +
        error.message
      );
    }

    /*
     * Hent API-data, hvis cache ikke kunne bruges.
     */
    if (!payload) {
      try {
        payload =
          await fetchRundownEvents({
            apiKey,
            sportId:
              group.sportId,
            date:
              group.date,
            affiliateIds: [
              bookmakerId
            ],
            marketIds,
            mainLineOnly,
            timeoutMs:
              requestTimeoutMs
          });

        statistics.requests += 1;

        try {
          await writeRundownCache(
            cacheDirectory,
            group.sportId,
            group.date,
            payload
          );
        } catch (error) {
          addWarning(
            `${group.sportId}/${group.date}: ` +
            'TheRundown-cache kunne ikke gemmes: ' +
            error.message
          );
        }
      } catch (error) {
        statistics.apiErrors += 1;

        addWarning(
          'TheRundown kunne ikke hente ' +
          `sport ${group.sportId} ` +
          `den ${group.date}: ` +
          error.message
        );

        for (
          const match of
            group.matches
        ) {
          setFallbackStatus(
            match,
            'api-error',
            'TheRundown-kaldet fejlede.'
          );
        }

        continue;
      }
    }

    const events = Array.isArray(
      payload?.events
    )
      ? payload.events
      : Array.isArray(payload)
        ? payload
        : [];

    if (events.length === 0) {
      statistics.noEvents +=
        group.matches.length;

      for (
        const match of
          group.matches
      ) {
        setFallbackStatus(
          match,
          'no-events-returned',
          'TheRundown returnerede ingen events for ligaen og datoen.'
        );
      }

      continue;
    }

    for (
      const match of
        group.matches
    ) {
      let event = null;

      try {
        event = matchRundownEvent(
          match,
          events,
          kickoffToleranceHours
        );
      } catch (error) {
        addWarning(
          `${match.home} - ${match.away}: ` +
          'event-matching fejlede: ' +
          error.message
        );
      }

      if (!event) {
        statistics.notMatched += 1;

        setFallbackStatus(
          match,
          'event-not-matched',
          'Kampen kunne ikke matches med et TheRundown-event.'
        );

        addWarning(
          `${match.home} - ${match.away}: ` +
          'kunne ikke matches med et TheRundown-event.'
        );

        continue;
      }

      const eventId =
        event.event_id ||
        event.eventId ||
        event.id ||
        event.event_uuid ||
        null;

      try {
        const parsedOdds =
          parseUnibetOver15(
            event,
            bookmakerId
          );

        if (!parsedOdds?.available) {
          statistics.noMarket += 1;

          setFallbackStatus(
            match,
            parsedOdds?.status ||
              'market-not-found',
            parsedOdds?.reason ||
              'Unibet Over 1,5 blev ikke fundet på eventet.'
          );

          if (eventId) {
            match.odds.eventId =
              eventId;
          }

          continue;
        }

        setAvailableOdds(
          match,
          parsedOdds,
          eventId,
          payloadSource === 'cache'
            ? 'cached'
            : 'available'
        );

        statistics.available += 1;

        if (
          payloadSource === 'cache'
        ) {
          statistics.cached += 1;
        }
      } catch (error) {
        statistics.apiErrors += 1;

        setFallbackStatus(
          match,
          'odds-parse-error',
          'Oddsdata kunne ikke fortolkes.'
        );

        if (eventId) {
          match.odds.eventId =
            eventId;
        }

        addWarning(
          `${match.home} - ${match.away}: ` +
          'oddsdata kunne ikke fortolkes: ' +
          error.message
        );
      }
    }
  }
}

/*
 * ------------------------------------------------------------
 * OPDATER RESULTATER OG NEAR MISSES
 * ------------------------------------------------------------
 */

dashboard.results =
  matches.filter(
    match =>
      Boolean(match.passed)
  );

dashboard.nearMisses =
  matches.filter(
    match =>
      !match.passed
  );

/*
 * ------------------------------------------------------------
 * SYNKRONISÉR MATCHESBYDATE
 * ------------------------------------------------------------
 *
 * matchesByDate bygges igen, så oddsstatus ikke bliver forskellig
 * mellem results, nearMisses og datovisningen.
 */

const dates = Array.from(
  new Set(
    matches
      .map(match => match.date)
      .filter(Boolean)
  )
).sort();

dashboard.matchesByDate =
  dates.map(date => {
    const dateMatches =
      matches.filter(
        match =>
          match.date === date
      );

    const approved =
      dateMatches
        .filter(
          match =>
            Boolean(match.passed)
        )
        .sort(
          (matchA, matchB) =>
            Number(
              matchB.score || 0
            ) -
            Number(
              matchA.score || 0
            )
        );

    const dateNearMisses =
      dateMatches
        .filter(
          match =>
            !match.passed
        )
        .sort(
          (matchA, matchB) =>
            Number(
              matchB.score || 0
            ) -
            Number(
              matchA.score || 0
            )
        );

    return {
      date,
      totalMatches:
        dateMatches.length,
      approved,
      nearMisses:
        dateNearMisses
    };
  });

/*
 * ------------------------------------------------------------
 * OPDATER LIGASTATUS
 * ------------------------------------------------------------
 */

if (
  Array.isArray(
    dashboard.foundLeagues
  )
) {
  for (
    const league of
      dashboard.foundLeagues
  ) {
    const leagueMatches =
      matches.filter(
        match =>
          String(
            match.leagueSlug || ''
          ) ===
          String(
            league.slug || ''
          )
      );

    const candidatesInLeague =
      leagueMatches.filter(
        isCandidate
      );

    const availableInLeague =
      candidatesInLeague.filter(
        match =>
          match.oddsStatus ===
          'available'
      );

    const fallbackInLeague =
      candidatesInLeague.filter(
        match =>
          match.oddsStatus ===
          'external-link'
      );

    if (
      !league.odds ||
      typeof league.odds !==
        'object'
    ) {
      league.odds = {};
    }

    league.odds.provider =
      provider;

    league.odds.bookmaker =
      bookmaker;

    league.odds.bookmakerId =
      bookmakerId;

    league.odds.candidates =
      candidatesInLeague.length;

    league.odds.available =
      availableInLeague.length;

    league.odds.fallback =
      fallbackInLeague.length;

    if (
      availableInLeague.length > 0
    ) {
      league.odds.status =
        availableInLeague.length ===
        candidatesInLeague.length
          ? 'available'
          : 'partial';
    } else if (
      candidatesInLeague.length > 0
    ) {
      league.odds.status =
        'external-link';
    } else {
      league.odds.status =
        'no-candidates';
    }
  }
}

/*
 * ------------------------------------------------------------
 * STATUS FOR DATAKILDER
 * ------------------------------------------------------------
 */

if (
  !dashboard.dataSources ||
  typeof dashboard.dataSources !==
    'object'
) {
  dashboard.dataSources = {};
}

dashboard.dataSources.odds = {
  provider,
  bookmaker,
  bookmakerId,
  enabled:
    Boolean(configuration.enabled),
  keyConfigured:
    Boolean(apiKey),
  available:
    statistics.available > 0,
  requestsUsed:
    statistics.requests,
  cacheHits:
    statistics.cacheHits,
  error:
    statistics.apiErrors > 0
      ? (
          `${statistics.apiErrors} fejl ` +
          'under oddsberigelsen.'
        )
      : null
};

/*
 * ------------------------------------------------------------
 * ODDS-SAMMENFATNING
 * ------------------------------------------------------------
 */

dashboard.oddsConfiguration = {
  ...(
    dashboard.oddsConfiguration ||
    {}
  ),
  provider,
  bookmaker,
  bookmakerId,
  market:
    'Over 1,5 mål',
  marketIds,
  mainLineOnly,
  enrichmentPending:
    false,
  enrichedAt:
    executionTime,
  keyConfigured:
    Boolean(apiKey),
  fallbackEnabled:
    true
};

dashboard.oddsSummary = {
  provider,
  bookmaker,
  bookmakerId,
  market:
    'Over 1,5 mål',
  threshold,
  totalMatches:
    statistics.totalMatches,
  candidates:
    statistics.candidates,
  belowThreshold:
    statistics.belowThreshold,
  apiEligible:
    statistics.apiEligible,
  fallbackOnly:
    statistics.fallbackOnly,
  available:
    statistics.available,
  cached:
    statistics.cached,
  notMatched:
    statistics.notMatched,
  noEvents:
    statistics.noEvents,
  noMarket:
    statistics.noMarket,
  apiErrors:
    statistics.apiErrors,
  requests:
    statistics.requests,
  cacheHits:
    statistics.cacheHits,
  updatedAt:
    executionTime
};

/*
 * updatedAt angiver tidspunktet for det færdige dashboardoutput.
 * Værdien gemmes som UTC via ISO 8601.
 */
dashboard.updatedAt =
  executionTime;

dashboard.warnings =
  warnings;

dashboard.errors =
  errors;

/*
 * ------------------------------------------------------------
 * GEM RESULTATER
 * ------------------------------------------------------------
 */

await fs.writeFile(
  resultsFile,
  JSON.stringify(
    dashboard,
    null,
    2
  ),
  'utf8'
);

console.log(
  JSON.stringify(
    {
      provider,
      bookmaker,
      market:
        'Over 1,5 mål',
      marketIds,
      threshold,
      keyConfigured:
        Boolean(apiKey),
      totalMatches:
        statistics.totalMatches,
      candidates:
        statistics.candidates,
      belowThreshold:
        statistics.belowThreshold,
      apiEligible:
        statistics.apiEligible,
      available:
        statistics.available,
      fallbackOnly:
        statistics.fallbackOnly,
      notMatched:
        statistics.notMatched,
      noEvents:
        statistics.noEvents,
      noMarket:
        statistics.noMarket,
      requests:
        statistics.requests,
      cacheHits:
        statistics.cacheHits,
      apiErrors:
        statistics.apiErrors,
      updatedAt:
        executionTime,
      warnings:
        warnings.length
    },
    null,
    2
  )
);
