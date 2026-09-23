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
  marketIds: [1, 3, 563],
  mainLineOnly: false
};

async function readOptionalJsonFile(
  file,
  fallbackValue
) {
  try {
    const contents = await fs.readFile(
      file,
      'utf8'
    );

    return {
      ...fallbackValue,
      ...JSON.parse(contents)
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ...fallbackValue };
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
 * STATUS
 * ------------------------------------------------------------
 */

const warnings = Array.isArray(
  dashboard.warnings
)
  ? dashboard.warnings
  : [];

const errors = Array.isArray(
  dashboard.errors
)
  ? dashboard.errors
  : [];

const apiKey = String(
  process.env.THERUNDOWN_API_KEY || ''
).trim();

const provider = String(
  configuration.provider ||
  'TheRundown'
);

const bookmaker = String(
  configuration.bookmaker ||
  'Unibet'
);

const bookmakerId = Number(
  configuration.bookmakerId ?? 21
);

const threshold = Number(
  configuration.minimumScore ?? 80
);

const cacheHours = Math.max(
  0,
  Number(configuration.cacheHours ?? 6)
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

const marketIds = Array.isArray(
  configuration.marketIds
)
  ? configuration.marketIds
      .map(Number)
      .filter(Number.isFinite)
  : [1, 3, 563];

const mainLineOnly = Boolean(
  configuration.mainLineOnly
);

const statistics = {
  totalMatches: 0,
  candidates: 0,
  apiEligible: 0,
  fallbackOnly: 0,
  available: 0,
  cached: 0,
  notMatched: 0,
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

function matchIdentity(match) {
  if (match.fixtureId) {
    return `fixture:${match.fixtureId}`;
  }

  return [
    match.date || '',
    normalizeText(match.home),
    normalizeText(match.away),
    normalizeText(match.leagueSlug)
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
  return String(
    match.fallbackOddsUrl ||
    match.oddsConfiguration?.fallbackUrl ||
    dashboard.oddsConfiguration
      ?.defaultFallbackUrl ||
    ''
  ).trim();
}

function getFallbackLabel(match) {
  return String(
    match.fallbackOddsLabel ||
    match.oddsConfiguration
      ?.fallbackLabel ||
    'Find odds hos Unibet'
  ).trim();
}

function candidateDate(match) {
  const date = String(
    match.date || ''
  ).trim();

  if (
    /^\d{4}-\d{2}-\d{2}$/.test(date)
  ) {
    return date;
  }

  const kickoff = String(
    match.kickoff || ''
  ).trim();

  if (kickoff) {
    const parsed = new Date(kickoff);

    if (!Number.isNaN(parsed.getTime())) {
      return parsed
        .toISOString()
        .slice(0, 10);
    }
  }

  return null;
}

function isCandidate(match) {
  return (
    Number.isFinite(Number(match.score)) &&
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
    fallbackUrl: getFallbackUrl(match),
    fallbackLabel: getFallbackLabel(match),
    checkedAt: new Date().toISOString()
  };
}

function setFallbackStatus(
  match,
  status,
  reason
) {
  match.odds = createUnavailableOdds(
    match,
    status,
    reason
  );

  match.oddsStatus = 'external-link';
  match.oddsSource = null;

  match.fallbackOddsUrl =
    getFallbackUrl(match);

  match.fallbackOddsLabel =
    getFallbackLabel(match);
}

function setAvailableOdds(
  match,
  parsedOdds,
  eventId,
  status = 'available'
) {
  match.odds = {
    ...parsedOdds,
    available: true,
    status,
    provider,
    bookmaker,
    bookmakerId,
    market:
      parsedOdds.market ||
      'Over 1,5 mål',
    eventId,
    fallbackUrl:
      getFallbackUrl(match),
    fallbackLabel:
      getFallbackLabel(match),
    checkedAt:
      parsedOdds.checkedAt ||
      new Date().toISOString()
  };

  match.oddsStatus = 'available';
  match.oddsSource = provider;

  match.fallbackOddsUrl =
    getFallbackUrl(match);

  match.fallbackOddsLabel =
    getFallbackLabel(match);
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
    const key = matchIdentity(match);

    if (!matchMap.has(key)) {
      matchMap.set(key, match);
    }
  }

  return Array.from(
    matchMap.values()
  );
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

    warnings.push(
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
  warnings.push(
    'Odds-integrationen er deaktiveret i config/odds.json.'
  );

  for (const match of candidates) {
    if (
      match.oddsStatus !==
      'external-link'
    ) {
      setFallbackStatus(
        match,
        'integration-disabled',
        'Odds-integrationen er deaktiveret.'
      );
    }
  }
} else if (!apiKey) {
  warnings.push(
    'THERUNDOWN_API_KEY mangler. ' +
    'Analysen publiceres med links til Unibet i stedet.'
  );

  for (const match of candidates) {
    if (
      match.oddsStatus !==
      'external-link'
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

  for (const group of requestGroups.values()) {
    let payload = null;
    let payloadSource = 'api';

    try {
      const cached = await readRundownCache(
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
      warnings.push(
        `${group.sportId}/${group.date}: ` +
        `TheRundown-cache kunne ikke læses: ${error.message}`
      );
    }

    if (!payload) {
      try {
        payload = await fetchRundownEvents({
          apiKey,
          sportId: group.sportId,
          date: group.date,
          affiliateIds: [bookmakerId],
          marketIds,
          mainLineOnly,
          timeoutMs: requestTimeoutMs
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
          warnings.push(
            `${group.sportId}/${group.date}: ` +
            `TheRundown-cache kunne ikke gemmes: ${error.message}`
          );
        }
      } catch (error) {
        statistics.apiErrors += 1;

        warnings.push(
          `TheRundown kunne ikke hente ` +
          `sport ${group.sportId} den ${group.date}: ` +
          error.message
        );

        for (const match of group.matches) {
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
      for (const match of group.matches) {
        setFallbackStatus(
          match,
          'no-events-returned',
          'TheRundown returnerede ingen events for ligaen og datoen.'
        );
      }

      continue;
    }

    for (const match of group.matches) {
      let event = null;

      try {
        event = matchRundownEvent(
          match,
          events,
          kickoffToleranceHours
        );
      } catch (error) {
        warnings.push(
          `${match.home} - ${match.away}: ` +
          `event-matching fejlede: ${error.message}`
        );
      }

      if (!event) {
        statistics.notMatched += 1;

        setFallbackStatus(
          match,
          'event-not-matched',
          'Kampen kunne ikke matches med et TheRundown-event.'
        );

        warnings.push(
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

        if (payloadSource === 'cache') {
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

        warnings.push(
          `${match.home} - ${match.away}: ` +
          `oddsdata kunne ikke fortolkes: ${error.message}`
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

dashboard.results = matches.filter(
  match => Boolean(match.passed)
);

dashboard.nearMisses = matches.filter(
  match => !match.passed
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

dashboard.matchesByDate = dates.map(
  date => {
    const dateMatches = matches.filter(
      match => match.date === date
    );

    const approved = dateMatches
      .filter(match =>
        Boolean(match.passed)
      )
      .sort(
        (matchA, matchB) =>
          Number(matchB.score || 0) -
          Number(matchA.score || 0)
      );

    const nearMisses = dateMatches
      .filter(match =>
        !match.passed
      )
      .sort(
        (matchA, matchB) =>
          Number(matchB.score || 0) -
          Number(matchA.score || 0)
      );

    return {
      date,
      totalMatches:
        dateMatches.length,
      approved,
      nearMisses
    };
  }
);

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
    const leagueMatches = matches.filter(
      match =>
        String(match.leagueSlug || '') ===
        String(league.slug || '')
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

    if (!league.odds) {
      league.odds = {};
    }

    league.odds.candidates =
      candidatesInLeague.length;

    league.odds.available =
      availableInLeague.length;

    league.odds.fallback =
      fallbackInLeague.length;

    if (availableInLeague.length > 0) {
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

if (!dashboard.dataSources) {
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
      ? `${statistics.apiErrors} fejl under oddsberigelsen.`
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
  market: 'Over 1,5 mål',
  enrichmentPending: false,
  enrichedAt:
    new Date().toISOString(),
  keyConfigured:
    Boolean(apiKey),
  fallbackEnabled: true
};

dashboard.oddsSummary = {
  provider,
  bookmaker,
  bookmakerId,
  market: 'Over 1,5 mål',
  threshold,
  totalMatches:
    statistics.totalMatches,
  candidates:
    statistics.candidates,
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
  noMarket:
    statistics.noMarket,
  apiErrors:
    statistics.apiErrors,
  requests:
    statistics.requests,
  cacheHits:
    statistics.cacheHits,
  updatedAt:
    new Date().toISOString()
};

dashboard.updatedAt =
  new Date().toISOString();

dashboard.warnings = warnings;
dashboard.errors = errors;

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
      market: 'Over 1,5 mål',
      threshold,
      candidates:
        statistics.candidates,
      apiEligible:
        statistics.apiEligible,
      available:
        statistics.available,
      fallbackOnly:
        statistics.fallbackOnly,
      notMatched:
        statistics.notMatched,
      noMarket:
        statistics.noMarket,
      requests:
        statistics.requests,
      cacheHits:
        statistics.cacheHits,
      apiErrors:
        statistics.apiErrors,
      warnings:
        warnings.length
    },
    null,
    2
  )
);
