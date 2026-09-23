/*
 * BetScope result validation
 *
 * Validerer:
 * - at docs/data/results.json findes og er gyldig JSON
 * - at den overordnede datastruktur er korrekt
 * - at results og nearMisses er konsistente
 * - at matchesByDate er synkroniseret med kampene
 * - at alle kampe har gyldig oddsstatus
 * - at available-odds har gyldige decimalodds
 * - at fallback-kampe har et sikkert HTTPS-link
 * - at ligaoversigten er konsistent
 * - at API-nøgler eller andre secrets ikke er lækket
 * - at dubletter ikke forekommer
 *
 * Scriptet returnerer:
 * - exit code 0 ved succes, også hvis der kun er advarsler
 * - exit code 1 ved kritiske valideringsfejl
 *
 * Kør:
 *   node src/validate-results.js
 *
 * Eller:
 *   npm run validate:data
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/*
 * ------------------------------------------------------------
 * KONFIGURATION
 * ------------------------------------------------------------
 */

const root = process.cwd();

const resultsFile = path.join(
  root,
  'docs',
  'data',
  'results.json'
);

const VALID_ODDS_STATUSES = new Set([
  'available',
  'external-link',
  'pending'
]);

const VALID_ODDS_DETAIL_STATUSES = new Set([
  'available',
  'cached',
  'below-score-threshold',
  'below_score_threshold',
  'league-not-supported',
  'league_not_supported',
  'invalid-match-date',
  'integration-disabled',
  'api-key-missing',
  'odds-source-unavailable',
  'odds_source_unavailable',
  'api-error',
  'api_error',
  'no-events-returned',
  'event-not-matched',
  'event_not_matched',
  'market-not-found',
  'markets-missing',
  'total-market-missing',
  'unibet-over-15-not-found',
  'odds-parse-error',
  'not-found',
  'not_found',
  'external-link',
  'pending'
]);

const SECRET_FIELD_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /authorization/i,
  /access[_-]?token/i,
  /bearer/i,
  /password/i,
  /private[_-]?key/i,
  /client[_-]?secret/i
];

const SECRET_VALUE_PATTERNS = [
  /\btrk_[a-z0-9_-]{12,}\b/i,
  /\b(?:bearer)\s+[a-z0-9._~+/-]{12,}=*\b/i,
  /\bsk[-_][a-z0-9_-]{12,}\b/i,
  /\bx-therundown-key\b/i,
  /\bx-rapidapi-key\b/i,
  /\btherundown_api_key\b/i,
  /\bapi_football_key\b/i,
  /\bodds_api_key\b/i
];

const errors = [];
const warnings = [];
const information = [];

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

function isNonEmptyString(value) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0
  );
}

function isFiniteNumber(value) {
  return (
    value !== null &&
    value !== undefined &&
    String(value).trim() !== '' &&
    Number.isFinite(Number(value))
  );
}

function isPositiveNumber(value) {
  return (
    isFiniteNumber(value) &&
    Number(value) > 0
  );
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(
    String(value || '')
  );
}

function isIsoDateTime(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }

  const parsed = new Date(value);

  return !Number.isNaN(
    parsed.getTime()
  );
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9æøå]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function uniqueValues(values) {
  return [
    ...new Set(values)
  ];
}

function addError(message) {
  errors.push(String(message));
}

function addWarning(message) {
  warnings.push(String(message));
}

function addInformation(message) {
  information.push(String(message));
}

function matchLabel(match) {
  const home = String(
    match?.home || 'Ukendt hjemmehold'
  );

  const away = String(
    match?.away || 'Ukendt udehold'
  );

  const date = String(
    match?.date || 'ukendt dato'
  );

  return `${home} - ${away} (${date})`;
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
    String(match?.date || ''),
    normalizeText(match?.home),
    normalizeText(match?.away),
    normalizeText(
      match?.leagueSlug ||
      match?.leagueName
    )
  ].join('|');
}

function safeArray(value) {
  return Array.isArray(value)
    ? value
    : [];
}

function isSafeHttpsUrl(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }

  try {
    const url = new URL(value);

    return (
      url.protocol === 'https:' &&
      Boolean(url.hostname)
    );
  } catch {
    return false;
  }
}

function valuesEqual(
  firstValue,
  secondValue
) {
  return JSON.stringify(firstValue) ===
    JSON.stringify(secondValue);
}

/*
 * ------------------------------------------------------------
 * INDLÆS RESULTSFIL
 * ------------------------------------------------------------
 */

let rawContents;

try {
  rawContents = await fs.readFile(
    resultsFile,
    'utf8'
  );
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error(
      `Valideringsfejl: ${resultsFile} findes ikke.`
    );

    console.error(
      'Kør først npm run build:data.'
    );

    process.exit(1);
  }

  console.error(
    `Valideringsfejl: results.json kunne ikke læses: ${error.message}`
  );

  process.exit(1);
}

if (!rawContents.trim()) {
  console.error(
    'Valideringsfejl: results.json er tom.'
  );

  process.exit(1);
}

let dashboard;

try {
  dashboard = JSON.parse(
    rawContents
  );
} catch (error) {
  console.error(
    `Valideringsfejl: results.json indeholder ugyldig JSON: ${error.message}`
  );

  process.exit(1);
}

if (!isPlainObject(dashboard)) {
  console.error(
    'Valideringsfejl: results.json skal indeholde et JSON-objekt.'
  );

  process.exit(1);
}

/*
 * ------------------------------------------------------------
 * KONTROLLÉR OVERORDNET STRUKTUR
 * ------------------------------------------------------------
 */

if (!isIsoDate(dashboard.date)) {
  addError(
    'Feltet date mangler eller er ikke i formatet YYYY-MM-DD.'
  );
}

if (!isPlainObject(dashboard.period)) {
  addError(
    'Feltet period mangler eller er ikke et objekt.'
  );
} else {
  if (!isIsoDate(dashboard.period.from)) {
    addError(
      'period.from mangler eller er ikke en gyldig ISO-dato.'
    );
  }

  if (!isIsoDate(dashboard.period.to)) {
    addError(
      'period.to mangler eller er ikke en gyldig ISO-dato.'
    );
  }

  if (
    isIsoDate(dashboard.period.from) &&
    isIsoDate(dashboard.period.to) &&
    dashboard.period.from >
      dashboard.period.to
  ) {
    addError(
      'period.from ligger efter period.to.'
    );
  }

  if (
    !isPositiveNumber(
      dashboard.period.days
    )
  ) {
    addError(
      'period.days skal være et positivt tal.'
    );
  }
}

if (
  dashboard.updatedAt !== undefined &&
  !isIsoDateTime(dashboard.updatedAt)
) {
  addError(
    'updatedAt er ikke et gyldigt dato- og tidsstempel.'
  );
}

if (!Array.isArray(dashboard.results)) {
  addError(
    'Feltet results mangler eller er ikke et array.'
  );
}

if (!Array.isArray(dashboard.nearMisses)) {
  addError(
    'Feltet nearMisses mangler eller er ikke et array.'
  );
}

if (!Array.isArray(dashboard.matchesByDate)) {
  addError(
    'Feltet matchesByDate mangler eller er ikke et array.'
  );
}

if (!Array.isArray(dashboard.foundLeagues)) {
  addError(
    'Feltet foundLeagues mangler eller er ikke et array.'
  );
}

if (
  dashboard.warnings !== undefined &&
  !Array.isArray(dashboard.warnings)
) {
  addError(
    'Feltet warnings skal være et array.'
  );
}

if (
  dashboard.errors !== undefined &&
  !Array.isArray(dashboard.errors)
) {
  addError(
    'Feltet errors skal være et array.'
  );
}

/*
 * ------------------------------------------------------------
 * SAML KAMPE
 * ------------------------------------------------------------
 */

const approvedResults = safeArray(
  dashboard.results
);

const nearMisses = safeArray(
  dashboard.nearMisses
);

const allMatches = [
  ...approvedResults,
  ...nearMisses
];

if (
  dashboard.totalMatches !== undefined &&
  !isFiniteNumber(
    dashboard.totalMatches
  )
) {
  addError(
    'totalMatches skal være et tal.'
  );
}

if (
  isFiniteNumber(dashboard.totalMatches) &&
  Number(dashboard.totalMatches) <
    allMatches.length
) {
  addWarning(
    `totalMatches er ${dashboard.totalMatches}, men results og nearMisses indeholder tilsammen ${allMatches.length} kampe.`
  );
}

/*
 * ------------------------------------------------------------
 * VALIDER DEN ENKELTE KAMP
 * ------------------------------------------------------------
 */

function validateOddsObject(
  match,
  indexLabel
) {
  const label = matchLabel(match);
  const oddsStatus = String(
    match.oddsStatus || ''
  ).trim();

  if (!oddsStatus) {
    addError(
      `${indexLabel} ${label}: oddsStatus mangler.`
    );

    return;
  }

  if (
    !VALID_ODDS_STATUSES.has(
      oddsStatus
    )
  ) {
    addError(
      `${indexLabel} ${label}: ukendt oddsStatus "${oddsStatus}".`
    );
  }

  const odds = match.odds;

  if (oddsStatus === 'available') {
    if (!isPlainObject(odds)) {
      addError(
        `${indexLabel} ${label}: oddsStatus er available, men odds-objektet mangler.`
      );

      return;
    }

    if (odds.available !== true) {
      addError(
        `${indexLabel} ${label}: available-status kræver odds.available = true.`
      );
    }

    const decimalOdds =
      odds.decimalOdds ??
      odds.decimal;

    if (
      !isFiniteNumber(decimalOdds) ||
      Number(decimalOdds) <= 1
    ) {
      addError(
        `${indexLabel} ${label}: available-status kræver decimalodds over 1,00.`
      );
    }

    if (
      odds.line !== undefined &&
      (
        !isFiniteNumber(odds.line) ||
        Math.abs(
          Number(odds.line) - 1.5
        ) > 0.001
      )
    ) {
      addWarning(
        `${indexLabel} ${label}: markedet er Over 1,5, men odds.line er ${odds.line}.`
      );
    }

    if (
      odds.bookmaker &&
      String(
        odds.bookmaker
      ).toLowerCase() !== 'unibet'
    ) {
      addWarning(
        `${indexLabel} ${label}: bookmakeren er "${odds.bookmaker}" og ikke Unibet.`
      );
    }

    if (
      odds.bookmakerId !== undefined &&
      Number(odds.bookmakerId) !== 21
    ) {
      addWarning(
        `${indexLabel} ${label}: bookmakerId er ${odds.bookmakerId}, forventet 21.`
      );
    }

    if (
      !isNonEmptyString(
        odds.eventId
      )
    ) {
      addWarning(
        `${indexLabel} ${label}: available-odds mangler eventId.`
      );
    }

    if (
      match.oddsSource &&
      String(
        match.oddsSource
      ).toLowerCase() !==
        'therundown'
    ) {
      addWarning(
        `${indexLabel} ${label}: oddsSource er "${match.oddsSource}", forventet TheRundown.`
      );
    }
  }

  if (oddsStatus === 'external-link') {
    const fallbackUrl = String(
      match.fallbackOddsUrl ||
      match.oddsConfiguration
        ?.fallbackUrl ||
      odds?.fallbackUrl ||
      ''
    ).trim();

    if (!fallbackUrl) {
      addError(
        `${indexLabel} ${label}: external-link mangler fallbackOddsUrl.`
      );
    } else if (
      !isSafeHttpsUrl(fallbackUrl)
    ) {
      addError(
        `${indexLabel} ${label}: fallbackOddsUrl er ikke en gyldig HTTPS-URL.`
      );
    }

    if (
      isPlainObject(odds) &&
      odds.available === true
    ) {
      addError(
        `${indexLabel} ${label}: external-link må ikke have odds.available = true.`
      );
    }
  }

  if (oddsStatus === 'pending') {
    addWarning(
      `${indexLabel} ${label}: oddsStatus er stadig pending efter datapipelinen.`
    );
  }

  if (isPlainObject(odds)) {
    const detailStatus = String(
      odds.status || ''
    ).trim();

    if (
      detailStatus &&
      !VALID_ODDS_DETAIL_STATUSES.has(
        detailStatus
      )
    ) {
      addWarning(
        `${indexLabel} ${label}: ukendt odds.status "${detailStatus}".`
      );
    }

    if (
      odds.checkedAt !== undefined &&
      !isIsoDateTime(
        odds.checkedAt
      )
    ) {
      addWarning(
        `${indexLabel} ${label}: odds.checkedAt er ikke et gyldigt tidsstempel.`
      );
    }
  }
}

function validateMatch(
  match,
  expectedPassed,
  indexLabel
) {
  if (!isPlainObject(match)) {
    addError(
      `${indexLabel}: kampdata er ikke et objekt.`
    );

    return;
  }

  const label = matchLabel(match);

  if (!isNonEmptyString(match.home)) {
    addError(
      `${indexLabel} ${label}: home mangler.`
    );
  }

  if (!isNonEmptyString(match.away)) {
    addError(
      `${indexLabel} ${label}: away mangler.`
    );
  }

  if (
    isNonEmptyString(match.home) &&
    isNonEmptyString(match.away) &&
    normalizeText(match.home) ===
      normalizeText(match.away)
  ) {
    addError(
      `${indexLabel} ${label}: hjemmehold og udehold er identiske.`
    );
  }

  if (!isIsoDate(match.date)) {
    addError(
      `${indexLabel} ${label}: date mangler eller er ugyldig.`
    );
  }

  if (
    isIsoDate(match.date) &&
    isPlainObject(dashboard.period) &&
    isIsoDate(dashboard.period.from) &&
    isIsoDate(dashboard.period.to) &&
    (
      match.date <
        dashboard.period.from ||
      match.date >
        dashboard.period.to
    )
  ) {
    addWarning(
      `${indexLabel} ${label}: kampdatoen ligger uden for analyseperioden.`
    );
  }

  if (
    !isNonEmptyString(
      match.leagueSlug
    ) &&
    !isNonEmptyString(
      match.leagueName
    )
  ) {
    addError(
      `${indexLabel} ${label}: leagueSlug og leagueName mangler.`
    );
  }

  if (!isFiniteNumber(match.score)) {
    addError(
      `${indexLabel} ${label}: score mangler eller er ikke et tal.`
    );
  }

  if (
    expectedPassed === true &&
    match.passed !== true
  ) {
    addError(
      `${indexLabel} ${label}: kampen ligger i results, men passed er ikke true.`
    );
  }

  if (
    expectedPassed === false &&
    match.passed === true
  ) {
    addError(
      `${indexLabel} ${label}: kampen ligger i nearMisses, men passed er true.`
    );
  }

  validateOddsObject(
    match,
    indexLabel
  );
}

approvedResults.forEach(
  (match, index) => {
    validateMatch(
      match,
      true,
      `results[${index}]`
    );
  }
);

nearMisses.forEach(
  (match, index) => {
    validateMatch(
      match,
      false,
      `nearMisses[${index}]`
    );
  }
);

/*
 * ------------------------------------------------------------
 * DUBLETKONTROL
 * ------------------------------------------------------------
 */

const identities = allMatches.map(
  matchIdentity
);

const duplicateIdentities =
  uniqueValues(
    identities.filter(
      (identity, index) =>
        identities.indexOf(identity) !==
        index
    )
  );

for (
  const duplicateIdentity of
    duplicateIdentities
) {
  addError(
    `Kampen "${duplicateIdentity}" forekommer flere gange i results/nearMisses.`
  );
}

const approvedIdentitySet = new Set(
  approvedResults.map(
    matchIdentity
  )
);

const nearMissIdentitySet = new Set(
  nearMisses.map(
    matchIdentity
  )
);

for (
  const identity of
    approvedIdentitySet
) {
  if (
    nearMissIdentitySet.has(identity)
  ) {
    addError(
      `Kampen "${identity}" findes både i results og nearMisses.`
    );
  }
}

/*
 * ------------------------------------------------------------
 * VALIDER MATCHESBYDATE
 * ------------------------------------------------------------
 */

const matchesByDate = safeArray(
  dashboard.matchesByDate
);

const dateGroupDates =
  matchesByDate.map(group =>
    String(group?.date || '')
  );

const duplicateDates =
  uniqueValues(
    dateGroupDates.filter(
      (date, index) =>
        dateGroupDates.indexOf(date) !==
        index
    )
  );

for (const date of duplicateDates) {
  addError(
    `matchesByDate indeholder datoen ${date} flere gange.`
  );
}

const dateViewMatchMap = new Map();

for (
  let groupIndex = 0;
  groupIndex < matchesByDate.length;
  groupIndex += 1
) {
  const group =
    matchesByDate[groupIndex];

  const groupLabel =
    `matchesByDate[${groupIndex}]`;

  if (!isPlainObject(group)) {
    addError(
      `${groupLabel} er ikke et objekt.`
    );

    continue;
  }

  if (!isIsoDate(group.date)) {
    addError(
      `${groupLabel}.date er ugyldig.`
    );
  }

  if (!Array.isArray(group.approved)) {
    addError(
      `${groupLabel}.approved er ikke et array.`
    );
  }

  if (!Array.isArray(group.nearMisses)) {
    addError(
      `${groupLabel}.nearMisses er ikke et array.`
    );
  }

  const approved =
    safeArray(group.approved);

  const groupNearMisses =
    safeArray(group.nearMisses);

  const groupMatches = [
    ...approved,
    ...groupNearMisses
  ];

  if (
    isFiniteNumber(group.totalMatches) &&
    Number(group.totalMatches) !==
      groupMatches.length
  ) {
    addError(
      `${groupLabel}: totalMatches er ${group.totalMatches}, men gruppen 
