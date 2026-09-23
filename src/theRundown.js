/*
 * TheRundown API client for BetScope
 *
 * Ansvar:
 * - hente events med odds fra TheRundown V2
 * - læse og skrive API-cache
 * - matche BetScope-kampe med TheRundown-events
 * - finde Unibet Over 1,5 mål
 * - konvertere amerikanske odds til decimalodds
 *
 * TheRundown V2-datamodel:
 *
 * event
 *   markets[]
 *     participants[]
 *       lines[]
 *         prices[affiliateId]
 *
 * For Total-markedet:
 * - market_id = 3
 * - participant name = Over eller Under
 * - line.value = mållinjen, eksempelvis 1.5
 * - prices["21"] = Unibet-prisen
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const API_BASE_URL =
  'https://therundown.io/api/v2';

const TOTAL_MARKET_IDS = new Set([
  3,
  43
]);

const DEFAULT_BOOKMAKER_ID = 21;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_KICKOFF_TOLERANCE_HOURS = 12;

/*
 * ------------------------------------------------------------
 * GENERELLE HJÆLPEFUNKTIONER
 * ------------------------------------------------------------
 */

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\bfc\b/g, ' ')
    .replace(/\bafc\b/g, ' ')
    .replace(/\bif\b/g, ' ')
    .replace(/\bfk\b/g, ' ')
    .replace(/\bac\b/g, ' ')
    .replace(/\bcf\b/g, ' ')
    .replace(/\bsc\b/g, ' ')
    .replace(/\bsv\b/g, ' ')
    .replace(/\bcalcio\b/g, ' ')
    .replace(/\bfootball club\b/g, ' ')
    .replace(/\bclub de futbol\b/g, ' ')
    .replace(/[^a-z0-9æøå]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeCommonTeamWords(value) {
  return normalizeText(value)
    .split(' ')
    .filter(word =>
      word &&
      ![
        'the',
        'club',
        'football',
        'fodbold',
        'soccer',
        'men',
        'women'
      ].includes(word)
    )
    .join(' ');
}

function createSafeFilenamePart(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseFiniteNumber(value) {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ''
  ) {
    return null;
  }

  const normalizedValue = String(value)
    .trim()
    .replace(',', '.');

  const number = Number(normalizedValue);

  return Number.isFinite(number)
    ? number
    : null;
}

function parseBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  return [
    'true',
    '1',
    'yes',
    'y'
  ].includes(normalized);
}

function roundNumber(value, decimals = 3) {
  if (!Number.isFinite(Number(value))) {
    return null;
  }

  const factor = 10 ** decimals;

  return Math.round(
    Number(value) * factor
  ) / factor;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(
    String(value || '')
  );
}

function parseDate(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime())
    ? null
    : parsed;
}

function absoluteHoursBetween(
  firstValue,
  secondValue
) {
  const firstDate = parseDate(firstValue);
  const secondDate = parseDate(secondValue);

  if (!firstDate || !secondDate) {
    return null;
  }

  return Math.abs(
    firstDate.getTime() -
    secondDate.getTime()
  ) / 3600000;
}

function normalizeLineValue(value) {
  const parsed = parseFiniteNumber(value);

  if (parsed === null) {
    return null;
  }

  return roundNumber(parsed, 3);
}

function isOver15Line(value) {
  const parsed = normalizeLineValue(value);

  return (
    parsed !== null &&
    Math.abs(parsed - 1.5) < 0.001
  );
}

function getObjectEntries(value) {
  return isPlainObject(value)
    ? Object.entries(value)
    : [];
}

/*
 * ------------------------------------------------------------
 * ODDSKONVERTERING
 * ------------------------------------------------------------
 */

export function americanToDecimal(
  americanOdds
) {
  const american = parseFiniteNumber(
    americanOdds
  );

  if (
    american === null ||
    american === 0
  ) {
    return null;
  }

  if (american > 0) {
    return roundNumber(
      1 + american / 100,
      3
    );
  }

  return roundNumber(
    1 + 100 / Math.abs(american),
    3
  );
}

function impliedProbabilityFromDecimal(
  decimalOdds
) {
  const decimal = parseFiniteNumber(
    decimalOdds
  );

  if (
    decimal === null ||
    decimal <= 1
  ) {
    return null;
  }

  return roundNumber(
    1 / decimal,
    4
  );
}

function normalizePriceValue(priceObject) {
  if (
    typeof priceObject === 'number' ||
    typeof priceObject === 'string'
  ) {
    const rawPrice = parseFiniteNumber(
      priceObject
    );

    if (rawPrice === null) {
      return null;
    }

    return {
      rawPrice,
      decimalOdds:
        rawPrice > 1 &&
        rawPrice < 20
          ? roundNumber(rawPrice, 3)
          : americanToDecimal(rawPrice)
    };
  }

  if (!isPlainObject(priceObject)) {
    return null;
  }

  const possibleDecimalPrice =
    parseFiniteNumber(
      priceObject.decimal_price ??
      priceObject.decimalPrice ??
      priceObject.decimal_odds ??
      priceObject.decimalOdds
    );

  const rawPrice = parseFiniteNumber(
    priceObject.price ??
    priceObject.american_price ??
    priceObject.americanPrice ??
    priceObject.odds ??
    priceObject.value
  );

  if (
    possibleDecimalPrice !== null &&
    possibleDecimalPrice > 1
  ) {
    return {
      rawPrice,
      decimalOdds:
        roundNumber(
          possibleDecimalPrice,
          3
        )
    };
  }

  if (rawPrice === null) {
    return null;
  }

  /*
   * TheRundown dokumenterer normalt price som amerikanske odds.
   * Denne kontrol gør klienten tolerant, hvis en pris allerede
   * leveres som decimalodds.
   */
  const decimalOdds =
    rawPrice > 1 &&
    rawPrice < 20
      ? roundNumber(rawPrice, 3)
      : americanToDecimal(rawPrice);

  return {
    rawPrice,
    decimalOdds
  };
}

/*
 * ------------------------------------------------------------
 * HTTP
 * ------------------------------------------------------------
 */

async function readResponseBody(response) {
  const text = await response.text();

  if (!text) {
    return {
      text: '',
      json: null
    };
  }

  try {
    return {
      text,
      json: JSON.parse(text)
    };
  } catch {
    return {
      text,
      json: null
    };
  }
}

function formatApiErrorBody(body) {
  if (body.json !== null) {
    try {
      return JSON.stringify(
        body.json
      ).slice(0, 1000);
    } catch {
      // Fortsæt til body.text.
    }
  }

  return String(body.text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

function buildApiError(
  response,
  body,
  url
) {
  const details =
    formatApiErrorBody(body);

  const error = new Error(
    `TheRundown HTTP ${response.status} ` +
    `${response.statusText || ''}` +
    (
      details
        ? `: ${details}`
        : ''
    )
  );

  error.name = 'TheRundownApiError';
  error.status = response.status;
  error.url = url;

  error.retryable = [
    408,
    425,
    429,
    500,
    502,
    503,
    504
  ].includes(response.status);

  const retryAfter =
    response.headers.get('retry-after');

  if (retryAfter) {
    error.retryAfter = retryAfter;
  }

  return error;
}

/*
 * ------------------------------------------------------------
 * HENT EVENTS
 * ------------------------------------------------------------
 */

export async function fetchRundownEvents({
  apiKey,
  sportId,
  date,
  affiliateIds = [
    DEFAULT_BOOKMAKER_ID
  ],
  marketIds = [3],
  mainLineOnly = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  hideNoMarkets = false,
  hideClosed = false,
  offset = 0
}) {
  const normalizedApiKey = String(
    apiKey || ''
  ).trim();

  if (!normalizedApiKey) {
    throw new Error(
      'TheRundown API-nøglen mangler.'
    );
  }

  const normalizedSportId = Number(
    sportId
  );

  if (
    !Number.isFinite(normalizedSportId) ||
    normalizedSportId <= 0
  ) {
    throw new Error(
      `Ugyldigt TheRundown sport ID: ${sportId}`
    );
  }

  if (!isIsoDate(date)) {
    throw new Error(
      `Ugyldig TheRundown-dato: ${date}. ` +
      'Forventet format er YYYY-MM-DD.'
    );
  }

  const normalizedAffiliateIds = [
    ...new Set(
      (
        Array.isArray(affiliateIds)
          ? affiliateIds
          : [affiliateIds]
      )
        .map(Number)
        .filter(value =>
          Number.isFinite(value) &&
          value > 0
        )
    )
  ];

  if (normalizedAffiliateIds.length === 0) {
    throw new Error(
      'Mindst ét gyldigt affiliate ID er påkrævet.'
    );
  }

  const normalizedMarketIds = [
    ...new Set(
      (
        Array.isArray(marketIds)
          ? marketIds
          : [marketIds]
      )
        .map(Number)
        .filter(value =>
          Number.isFinite(value) &&
          value > 0
        )
    )
  ];

  if (normalizedMarketIds.length === 0) {
    normalizedMarketIds.push(3);
  }

  if (normalizedMarketIds.length > 12) {
    throw new Error(
      'TheRundown accepterer højst 12 market IDs pr. kald.'
    );
  }

  const safeTimeoutMs = Math.max(
    1000,
    Number(timeoutMs) ||
      DEFAULT_TIMEOUT_MS
  );

  const query = new URLSearchParams({
    affiliate_ids:
      normalizedAffiliateIds.join(','),

    market_ids:
      normalizedMarketIds.join(','),

    main_line:
      String(Boolean(mainLineOnly)),

    hide_no_markets:
      String(Boolean(hideNoMarkets)),

    hide_closed:
      String(Boolean(hideClosed)),

    offset:
      String(
        Number.isFinite(Number(offset))
          ? Number(offset)
          : 0
      )
  });

  const url =
    `${API_BASE_URL}/sports/` +
    `${normalizedSportId}/events/` +
    `${date}?${query.toString()}`;

  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    safeTimeoutMs
  );

  let response;

  try {
    response = await fetch(
      url,
      {
        method: 'GET',

        headers: {
          Accept: 'application/json',
          'X-TheRundown-Key':
            normalizedApiKey,
          'User-Agent':
            'BetScope/1.0'
        },

        signal:
          controller.signal
      }
    );
  } catch (error) {
    if (
      error?.name === 'AbortError'
    ) {
      throw new Error(
        `TheRundown-kaldet overskred ` +
        `${safeTimeoutMs} ms.`
      );
    }

    throw new Error(
      'Netværksfejl ved kald til TheRundown: ' +
      error.message
    );
  } finally {
    clearTimeout(timeout);
  }

  const body =
    await readResponseBody(response);

  if (!response.ok) {
    throw buildApiError(
      response,
      body,
      url
    );
  }

  if (body.json === null) {
    throw new Error(
      'TheRundown returnerede ikke gyldig JSON.'
    );
  }

  const payload =
    Array.isArray(body.json)
      ? {
          events: body.json
        }
      : body.json;

  if (!isPlainObject(payload)) {
    throw new Error(
      'TheRundown returnerede et ukendt dataformat.'
    );
  }

  if (
    payload.events !== undefined &&
    !Array.isArray(payload.events)
  ) {
    throw new Error(
      'TheRundown-feltet events er ikke et array.'
    );
  }

  return {
    ...payload,

    events:
      Array.isArray(payload.events)
        ? payload.events
        : [],

    _betScopeMeta: {
      fetchedAt:
        new Date().toISOString(),

      sportId:
        normalizedSportId,

      date,

      affiliateIds:
        normalizedAffiliateIds,

      marketIds:
        normalizedMarketIds,

      mainLineOnly:
        Boolean(mainLineOnly),

      dataDelaySeconds:
        parseFiniteNumber(
          response.headers.get(
            'x-data-delay-seconds'
          )
        ),

      dataPoints:
        parseFiniteNumber(
          response.headers.get(
            'x-datapoints'
          )
        )
    }
  };
}

/*
 * ------------------------------------------------------------
 * CACHE
 * ------------------------------------------------------------
 */

function rundownCacheFile(
  cacheDirectory,
  sportId,
  date
) {
  const safeSportId =
    createSafeFilenamePart(sportId);

  const safeDate =
    createSafeFilenamePart(date);

  if (!safeSportId || !safeDate) {
    throw new Error(
      'Cachefilen kunne ikke oprettes på grund af ugyldige værdier.'
    );
  }

  return path.join(
    cacheDirectory,
    `${safeSportId}-${safeDate}.json`
  );
}

export async function readRundownCache(
  cacheDirectory,
  sportId,
  date,
  maximumAgeHours = 6
) {
  const file = rundownCacheFile(
    cacheDirectory,
    sportId,
    date
  );

  try {
    const contents = await fs.readFile(
      file,
      'utf8'
    );

    const cached = JSON.parse(
      contents
    );

    if (!isPlainObject(cached)) {
      return null;
    }

    const fetchedAt =
      cached.cachedAt ||
      cached.fetchedAt ||
      cached.payload?._betScopeMeta
        ?.fetchedAt ||
      cached._betScopeMeta
        ?.fetchedAt;

    if (!fetchedAt) {
      return null;
    }

    const fetchedAtTime =
      new Date(fetchedAt).getTime();

    if (
      !Number.isFinite(fetchedAtTime)
    ) {
      return null;
    }

    const ageHours = (
      Date.now() -
      fetchedAtTime
    ) / 3600000;

    const allowedAge = Math.max(
      0,
      Number(maximumAgeHours) || 0
    );

    if (ageHours > allowedAge) {
      return null;
    }

    const payload =
      isPlainObject(cached.payload)
        ? cached.payload
        : cached;

    if (
      payload.events !== undefined &&
      !Array.isArray(payload.events)
    ) {
      return null;
    }

    return payload;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    /*
     * En ugyldig eller korrupt cache skal ikke stoppe
     * BetScope. API-kaldet kan hente et nyt svar.
     */
    if (error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

export async function writeRundownCache(
  cacheDirectory,
  sportId,
  date,
  payload
) {
  if (!isPlainObject(payload)) {
    throw new Error(
      'TheRundown-cache kræver et gyldigt payload-objekt.'
    );
  }

  await fs.mkdir(
    cacheDirectory,
    {
      recursive: true
    }
  );

  const file = rundownCacheFile(
    cacheDirectory,
    sportId,
    date
  );

  const temporaryFile =
    `${file}.${process.pid}.tmp`;

  const cacheObject = {
    cachedAt:
      new Date().toISOString(),

    sportId:
      Number(sportId),

    date,

    payload
  };

  await fs.writeFile(
    temporaryFile,
    JSON.stringify(
      cacheObject,
      null,
      2
    ),
    'utf8'
  );

  await fs.rename(
    temporaryFile,
    file
  );

  return file;
}

/*
 * ------------------------------------------------------------
 * EVENT- OG HOLDNAVNE
 * ------------------------------------------------------------
 */

function getEventTeams(event) {
  const teams = Array.isArray(
    event?.teams
  )
    ? event.teams
    : [];

  let homeTeam = teams.find(team =>
    team?.is_home === true ||
    team?.isHome === true ||
    String(
      team?.designation ||
      team?.side ||
      ''
    ).toLowerCase() === 'home'
  );

  let awayTeam = teams.find(team =>
    team?.is_home === false ||
    team?.isHome === false ||
    String(
      team?.designation ||
      team?.side ||
      ''
    ).toLowerCase() === 'away'
  );

  /*
   * TheRundown V2 dokumenterer normalt teams som:
   * [away team, home team].
   */
  if (
    !awayTeam &&
    teams.length >= 1
  ) {
    awayTeam = teams[0];
  }

  if (
    !homeTeam &&
    teams.length >= 2
  ) {
    homeTeam = teams[1];
  }

  const homeName = String(
    homeTeam?.name ||
    homeTeam?.team_name ||
    homeTeam?.display_name ||
    ''
  ).trim();

  const awayName = String(
    awayTeam?.name ||
    awayTeam?.team_name ||
    awayTeam?.display_name ||
    ''
  ).trim();

  return {
    homeTeam,
    awayTeam,
    homeName,
    awayName
  };
}

function tokenSet(value) {
  return new Set(
    removeCommonTeamWords(value)
      .split(' ')
      .filter(Boolean)
  );
}

function tokenSimilarity(
  firstValue,
  secondValue
) {
  const first = tokenSet(firstValue);
  const second = tokenSet(secondValue);

  if (
    first.size === 0 ||
    second.size === 0
  ) {
    return 0;
  }

  const intersection = [
    ...first
  ].filter(value =>
    second.has(value)
  ).length;

  const union = new Set([
    ...first,
    ...second
  ]).size;

  return union > 0
    ? intersection / union
    : 0;
}

function bigrams(value) {
  const normalized =
    removeCommonTeamWords(value)
      .replace(/\s+/g, '');

  if (!normalized) {
    return [];
  }

  if (normalized.length === 1) {
    return [normalized];
  }

  const result = [];

  for (
    let index = 0;
    index < normalized.length - 1;
    index += 1
  ) {
    result.push(
      normalized.slice(
        index,
        index + 2
      )
    );
  }

  return result;
}

function diceSimilarity(
  firstValue,
  secondValue
) {
  const first = bigrams(firstValue);
  const second = bigrams(secondValue);

  if (
    first.length === 0 ||
    second.length === 0
  ) {
    return 0;
  }

  const secondCounts = new Map();

  for (const item of second) {
    secondCounts.set(
      item,
      (
        secondCounts.get(item) || 0
      ) + 1
    );
  }

  let intersection = 0;

  for (const item of first) {
    const count =
      secondCounts.get(item) || 0;

    if (count > 0) {
      intersection += 1;
      secondCounts.set(
        item,
        count - 1
      );
    }
  }

  return (
    2 * intersection
  ) / (
    first.length +
    second.length
  );
}

function teamNameSimilarity(
  firstValue,
  secondValue
) {
  const first =
    removeCommonTeamWords(firstValue);

  const second =
    removeCommonTeamWords(secondValue);

  if (!first || !second) {
    return 0;
  }

  if (first === second) {
    return 1;
  }

  if (
    first.includes(second) ||
    second.includes(first)
  ) {
    const shorter = Math.min(
      first.length,
      second.length
    );

    const longer = Math.max(
      first.length,
      second.length
    );

    const lengthRatio =
      longer > 0
        ? shorter / longer
        : 0;

    return Math.max(
      0.82,
      lengthRatio
    );
  }

  return Math.max(
    tokenSimilarity(
      first,
      second
    ),
    diceSimilarity(
      first,
      second
    )
  );
}

function eventKickoff(event) {
  return (
    event?.event_date ||
    event?.eventDate ||
    event?.start_time ||
    event?.startTime ||
    event?.scheduled ||
    event?.schedule?.event_date ||
    event?.schedule?.start_time ||
    null
  );
}

function matchKickoff(match) {
  if (match?.kickoff) {
    return match.kickoff;
  }

  if (
    match?.date &&
    match?.time
  ) {
    return (
      `${match.date}T` +
      `${match.time}`
    );
  }

  if (match?.date) {
    return `${match.date}T12:00:00`;
  }

  return null;
}

function eventIdentifier(event) {
  return (
    event?.event_id ||
    event?.eventId ||
    event?.id ||
    event?.event_uuid ||
    null
  );
}

/*
 * ------------------------------------------------------------
 * MATCH ET BETSCOPE-FIXTURE MED ET RUNDOWN-EVENT
 * ------------------------------------------------------------
 */

export function matchRundownEvent(
  match,
  events,
  kickoffToleranceHours =
    DEFAULT_KICKOFF_TOLERANCE_HOURS
) {
  if (
    !match ||
    !Array.isArray(events) ||
    events.length === 0
  ) {
    return null;
  }

  const matchHome = String(
    match.home || ''
  ).trim();

  const matchAway = String(
    match.away || ''
  ).trim();

  if (!matchHome || !matchAway) {
    return null;
  }

  const toleranceHours = Math.max(
    0,
    Number(kickoffToleranceHours) ||
      DEFAULT_KICKOFF_TOLERANCE_HOURS
  );

  const expectedKickoff =
    matchKickoff(match);

  const candidates = [];

  for (const event of events) {
    if (!event) {
      continue;
    }

    const {
      homeName,
      awayName
    } = getEventTeams(event);

    if (!homeName || !awayName) {
      continue;
    }

    const homeScore =
      teamNameSimilarity(
        matchHome,
        homeName
      );

    const awayScore =
      teamNameSimilarity(
        matchAway,
        awayName
      );

    const reversedHomeScore =
      teamNameSimilarity(
        matchHome,
        awayName
      );

    const reversedAwayScore =
      teamNameSimilarity(
        matchAway,
        homeName
      );

    const normalTeamScore =
      (
        homeScore +
        awayScore
      ) / 2;

    const reversedTeamScore =
      (
        reversedHomeScore +
        reversedAwayScore
      ) / 2;

    /*
     * Normalt skal hjemme- og udehold være placeret korrekt.
     * Reversed bruges primært som robusthed ved usædvanlige feeds.
     */
    const orientation =
      normalTeamScore >=
      reversedTeamScore
        ? 'normal'
        : 'reversed';

    const teamScore = Math.max(
      normalTeamScore,
      reversedTeamScore
    );

    const kickoffDifference =
      absoluteHoursBetween(
        expectedKickoff,
        eventKickoff(event)
      );

    if (
      kickoffDifference !== null &&
      kickoffDifference >
        toleranceHours
    ) {
      continue;
    }

    /*
     * Kræv relativt stærkt match på begge hold.
     * Et samlet gennemsnit alene er ikke tilstrækkeligt,
     * hvis ét af holdene matcher dårligt.
     */
    const selectedHomeScore =
      orientation === 'normal'
        ? homeScore
        : reversedHomeScore;

    const selectedAwayScore =
      orientation === 'normal'
        ? awayScore
        : reversedAwayScore;

    if (
      selectedHomeScore < 0.52 ||
      selectedAwayScore < 0.52 ||
      teamScore < 0.62
    ) {
      continue;
    }

    const kickoffScore =
      kickoffDifference === null
        ? 0.5
        : Math.max(
            0,
            1 -
            kickoffDifference /
              Math.max(
                toleranceHours,
                1
              )
          );

    const totalScore =
      teamScore * 0.88 +
      kickoffScore * 0.12;

    candidates.push({
      event,
      eventId:
        eventIdentifier(event),
      teamScore,
      kickoffDifference,
      totalScore,
      orientation,
      homeName,
      awayName
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort(
    (first, second) =>
      second.totalScore -
        first.totalScore ||
      (
        first.kickoffDifference ??
        Number.POSITIVE_INFINITY
      ) -
      (
        second.kickoffDifference ??
        Number.POSITIVE_INFINITY
      )
  );

  const best = candidates[0];
  const secondBest = candidates[1];

  /*
   * Undgå tvetydige matches, hvis de to bedste kandidater
   * næsten har samme score.
   */
  if (
    secondBest &&
    best.totalScore < 0.9 &&
    best.totalScore -
      secondBest.totalScore < 0.035
  ) {
    return null;
  }

  /*
   * Returnér eventet i original form, men tilføj
   * intern matchingmetadata til fejlsøgning.
   */
  return {
    ...best.event,

    _betScopeMatch: {
      eventId:
        best.eventId,

      score:
        roundNumber(
          best.totalScore,
          4
        ),

      teamScore:
        roundNumber(
          best.teamScore,
          4
        ),

      kickoffDifferenceHours:
        best.kickoffDifference === null
          ? null
          : roundNumber(
              best.kickoffDifference,
              3
            ),

      orientation:
        best.orientation,

      rundownHome:
        best.homeName,

      rundownAway:
        best.awayName
    }
  };
}

/*
 * ------------------------------------------------------------
 * MARKEDSUDTRÆK
 * ------------------------------------------------------------
 */

function marketId(market) {
  return parseFiniteNumber(
    market?.market_id ??
    market?.marketId ??
    market?.id
  );
}

function participantName(participant) {
  return String(
    participant?.name ||
    participant?.participant_name ||
    participant?.participantName ||
    participant?.label ||
    participant?.description ||
    ''
  ).trim();
}

function isOverParticipant(participant) {
  const name = normalizeText(
    participantName(participant)
  );

  if (
    name === 'over' ||
    name.startsWith('over ')
  ) {
    return true;
  }

  const side = normalizeText(
    participant?.side ||
    participant?.type_name ||
    participant?.result_type ||
    participant?.selection
  );

  return (
    side === 'over' ||
    side.startsWith('over ')
  );
}

function participantLines(participant) {
  if (
    Array.isArray(participant?.lines)
  ) {
    return participant.lines;
  }

  if (
    isPlainObject(participant?.lines)
  ) {
    return Object.values(
      participant.lines
    );
  }

  return [];
}

function lineValue(
  line,
  participant
) {
  const directValue =
    line?.value ??
    line?.line_value ??
    line?.lineValue ??
    line?.handicap ??
    line?.points ??
    line?.total;

  const parsedDirect =
    normalizeLineValue(directValue);

  if (parsedDirect !== null) {
    return parsedDirect;
  }

  const participantValue =
    participant?.value ??
    participant?.line_value ??
    participant?.lineValue ??
    participant?.handicap ??
    participant?.points ??
    participant?.total;

  const parsedParticipant =
    normalizeLineValue(
      participantValue
    );

  if (
    parsedParticipant !== null
  ) {
    return parsedParticipant;
  }

  /*
   * Robusthed hvis navnet eksempelvis er "Over 1.5".
   */
  const name = participantName(
    participant
  );

  const match = name.match(
    /(?:over|under)\s*([0-9]+(?:[.,][0-9]+)?)/i
  );

  return match
    ? normalizeLineValue(match[1])
    : null;
}

function linePrices(line) {
  const prices =
    line?.prices ??
    line?.price ??
    {};

  if (Array.isArray(prices)) {
    return prices;
  }

  if (isPlainObject(prices)) {
    return prices;
  }

  return {};
}

function getBookmakerPrice(
  line,
  bookmakerId
) {
  const prices = linePrices(line);
  const bookmakerKey =
    String(bookmakerId);

  if (Array.isArray(prices)) {
    return prices.find(price => {
      const affiliateId = Number(
        price?.affiliate_id ??
        price?.affiliateId ??
        price?.bookmaker_id ??
        price?.bookmakerId
      );

      return (
        Number.isFinite(affiliateId) &&
        affiliateId ===
          Number(bookmakerId)
      );
    }) || null;
  }

  if (
    Object.prototype.hasOwnProperty.call(
      prices,
      bookmakerKey
    )
  ) {
    return prices[bookmakerKey];
  }

  /*
   * Robusthed hvis objektets værdier selv indeholder affiliate_id.
   */
  for (
    const [, price] of
      getObjectEntries(prices)
  ) {
    const affiliateId = Number(
      price?.affiliate_id ??
      price?.affiliateId ??
      price?.bookmaker_id ??
      price?.bookmakerId
    );

    if (
      Number.isFinite(affiliateId) &&
      affiliateId ===
        Number(bookmakerId)
    ) {
      return price;
    }
  }

  return null;
}

function isClosedPrice(price) {
  if (!isPlainObject(price)) {
    return false;
  }

  return (
    parseBoolean(
      price.is_closed ??
      price.isClosed ??
      price.closed ??
      price.suspended
    )
  );
}

function priceUpdatedAt(price) {
  if (!isPlainObject(price)) {
    return null;
  }

  return (
    price.updated_at ||
    price.updatedAt ||
    price.timestamp ||
    null
  );
}

function priceIsMainLine(price) {
  if (!isPlainObject(price)) {
    return false;
  }

  return parseBoolean(
    price.is_main_line ??
    price.isMainLine ??
    price.main_line ??
    price.mainLine
  );
}

function priceIdentifier(price) {
  if (!isPlainObject(price)) {
    return null;
  }

  return (
    price.id ||
    price.price_id ||
    price.priceId ||
    null
  );
}

/*
 * ------------------------------------------------------------
 * FIND UNIBET OVER 1,5
 * ------------------------------------------------------------
 */

export function parseUnibetOver15(
  event,
  bookmakerId =
    DEFAULT_BOOKMAKER_ID
) {
  const numericBookmakerId = Number(
    bookmakerId
  );

  if (
    !Number.isFinite(numericBookmakerId) ||
    numericBookmakerId <= 0
  ) {
    throw new Error(
      `Ugyldigt bookmaker ID: ${bookmakerId}`
    );
  }

  const markets = Array.isArray(
    event?.markets
  )
    ? event.markets
    : [];

  if (markets.length === 0) {
    return {
      available: false,
      status: 'markets-missing',
      reason:
        'Eventet indeholder ingen markeder.',
      bookmaker: 'Unibet',
      bookmakerId:
        numericBookmakerId,
      market:
        'Over 1,5 mål'
    };
  }

  const totalMarkets =
    markets.filter(market =>
      TOTAL_MARKET_IDS.has(
        Number(marketId(market))
      )
    );

  if (totalMarkets.length === 0) {
    return {
      available: false,
      status: 'total-market-missing',
      reason:
        'Eventet indeholder ikke Total-markedet.',
      bookmaker: 'Unibet',
      bookmakerId:
        numericBookmakerId,
      market:
        'Over 1,5 mål'
    };
  }

  const candidates = [];

  for (const market of totalMarkets) {
    const participants = Array.isArray(
      market?.participants
    )
      ? market.participants
      : isPlainObject(
          market?.participants
        )
        ? Object.values(
            market.participants
          )
        : [];

    for (const participant of participants) {
      if (!isOverParticipant(participant)) {
        continue;
      }

      const lines =
        participantLines(participant);

      for (const line of lines) {
        const total =
          lineValue(
            line,
            participant
          );

        if (!isOver15Line(total)) {
          continue;
        }

        const price =
          getBookmakerPrice(
            line,
            numericBookmakerId
          );

        if (!price) {
          continue;
        }

        if (isClosedPrice(price)) {
          continue;
        }

        const normalizedPrice =
          normalizePriceValue(price);

        if (
          !normalizedPrice ||
          normalizedPrice.decimalOdds ===
            null ||
          normalizedPrice.decimalOdds <= 1
        ) {
          continue;
        }

        candidates.push({
          marketId:
            marketId(market),

          periodId:
            parseFiniteNumber(
              market?.period_id ??
              market?.periodId
            ),

          participantId:
            participant?.id ||
            participant?.participant_id ||
            null,

          participantName:
            participantName(
              participant
            ),

          lineId:
            line?.id ||
            line?.line_id ||
            line?.lineId ||
            null,

          total,

          priceId:
            priceIdentifier(price),

          americanOdds:
            normalizedPrice.rawPrice,

          decimalOdds:
            normalizedPrice.decimalOdds,

          impliedProbability:
            impliedProbabilityFromDecimal(
              normalizedPrice.decimalOdds
            ),

          isMainLine:
            priceIsMainLine(price),

          updatedAt:
            priceUpdatedAt(price)
        });
      }
    }
  }

  if (candidates.length === 0) {
    return {
      available: false,
      status:
        'unibet-over-15-not-found',
      reason:
        'Unibet Over 1,5 blev ikke fundet på eventet.',
      bookmaker:
        'Unibet',
      bookmakerId:
        numericBookmakerId,
      market:
        'Over 1,5 mål',
      eventId:
        eventIdentifier(event)
    };
  }

  /*
   * Prioritér:
   * 1. hovedlinje
   * 2. nyeste pris
   * 3. første gyldige kandidat
   */
  candidates.sort(
    (first, second) => {
      const mainLineDifference =
        Number(second.isMainLine) -
        Number(first.isMainLine);

      if (mainLineDifference !== 0) {
        return mainLineDifference;
      }

      const firstUpdated =
        parseDate(first.updatedAt)
          ?.getTime() || 0;

      const secondUpdated =
        parseDate(second.updatedAt)
          ?.getTime() || 0;

      return (
        secondUpdated -
        firstUpdated
      );
    }
  );

  const selected = candidates[0];

  return {
    available: true,
    status: 'available',

    provider:
      'TheRundown',

    bookmaker:
      'Unibet',

    bookmakerId:
      numericBookmakerId,

    market:
      'Over 1,5 mål',

    marketKey:
      'over-1.5',

    marketId:
      selected.marketId,

    periodId:
      selected.periodId,

    line:
      selected.total,

    decimal:
      selected.decimalOdds,

    decimalOdds:
      selected.decimalOdds,

    american:
      selected.americanOdds,

    americanOdds:
      selected.americanOdds,

    impliedProbability:
      selected.impliedProbability,

    isMainLine:
      selected.isMainLine,

    eventId:
      eventIdentifier(event),

    priceId:
      selected.priceId,

    participantId:
      selected.participantId,

    lineId:
      selected.lineId,

    updatedAt:
      selected.updatedAt,

    checkedAt:
      new Date().toISOString()
  };
}
