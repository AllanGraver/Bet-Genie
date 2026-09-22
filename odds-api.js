import fs from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = 'https://api.odds-api.io/v3';
const asNumber = value => Number.isFinite(Number(value)) ? Number(value) : null;
const normalize = value => String(value || '')
  .toLowerCase()
  .replace(/æ/g, 'ae')
  .replace(/ø/g, 'o')
  .replace(/å/g, 'a')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\b(fc|if|bk|fk|afc|cf|sc)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const tokenSet = value => new Set(normalize(value).split(' ').filter(Boolean));

function similarity(left, right) {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size || !b.size) return 0;
  const shared = [...a].filter(token => b.has(token)).length;
  return shared / Math.max(a.size, b.size);
}

async function getJson(endpoint, params, apiKey) {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set('apiKey', apiKey);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: { accept: 'application/json' }
  });

  if (!response.ok) {
    throw new Error(`Odds-API.io HTTP ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

export async function fetchFootballEvents(apiKey) {
  const payload = await getJson('events', {
    sport: 'football',
    status: 'pending',
    limit: 1000
  }, apiKey);

  return Array.isArray(payload)
    ? payload
    : payload.events || payload.data || [];
}

function getEventDate(event) {
  return new Date(
    event.date ||
    event.startTime ||
    event.start_time ||
    event.commence_time ||
    0
  );
}

function getMatchDate(match) {
  const raw = match.kickoff || (
    match.date
      ? `${match.date}T${match.time || '12:00'}:00`
      : ''
  );
  return new Date(raw);
}

export function matchOddsEvent(match, events, toleranceHours = 12) {
  const matchDate = getMatchDate(match);

  const candidates = events.map(event => {
    const eventHome = event.home || event.homeTeam || event.home_team || '';
    const eventAway = event.away || event.awayTeam || event.away_team || '';
    const directScore = (
      similarity(match.home, eventHome) +
      similarity(match.away, eventAway)
    ) / 2;
    const reverseScore = (
      similarity(match.home, eventAway) +
      similarity(match.away, eventHome)
    ) / 2;
    const hoursApart = Number.isNaN(matchDate.getTime())
      ? 0
      : Math.abs(getEventDate(event) - matchDate) / 3600000;

    return {
      event,
      similarity: Math.max(directScore, reverseScore),
      hoursApart
    };
  })
    .filter(candidate => (
      candidate.similarity >= 0.55 &&
      candidate.hoursApart <= toleranceHours
    ))
    .sort((a, b) => (
      b.similarity - a.similarity ||
      a.hoursApart - b.hoursApart
    ));

  return candidates[0]?.event || null;
}

export async function fetchUnibetOdds(apiKey, eventId) {
  return getJson('odds', {
    eventId,
    bookmakers: 'Unibet'
  }, apiKey);
}

function isOver15(name, handicap) {
  const label = String(name || '').toLowerCase().replace(',', '.');
  const line = asNumber(handicap);

  return (
    (label.includes('over') && label.includes('1.5')) ||
    (label === 'over' && line === 1.5) ||
    (label === 'o' && line === 1.5)
  );
}

export function parseUnibetOver15(payload) {
  const root = Array.isArray(payload) ? payload[0] || {} : payload || {};
  const bookmakers = root.bookmakers || payload.bookmakers || {};
  const offers = [];

  function inspectMarket(bookmaker, market) {
    const marketName = market.name || market.key || market.market || '';
    const rows = market.odds || market.outcomes || market.values || [];

    for (const row of rows) {
      const outcome = row.name || row.label || row.value || row.outcome;
      const line = row.hdp ?? row.handicap ?? row.point;
      if (!isOver15(outcome, line)) continue;

      const price = asNumber(
        row.price ?? row.odd ?? row.odds ?? row.decimal ?? row.over
      );

      if (price && price > 1) {
        offers.push({
          bookmaker,
          price,
          market: marketName || 'Totals',
          lastUpdated: market.updatedAt || root.updatedAt || null
        });
      }
    }
  }

  if (Array.isArray(bookmakers)) {
    for (const bookmaker of bookmakers) {
      const name = bookmaker.title || bookmaker.name || bookmaker.key || '';
      if (normalize(name) !== 'unibet') continue;
      for (const market of bookmaker.markets || bookmaker.bets || []) {
        inspectMarket('Unibet', market);
      }
    }
  } else {
    for (const [bookmaker, markets] of Object.entries(bookmakers)) {
      if (normalize(bookmaker) !== 'unibet') continue;
      const list = Array.isArray(markets)
        ? markets
        : Object.values(markets?.markets || markets || {});
      for (const market of list) inspectMarket('Unibet', market);
    }
  }

  offers.sort((a, b) => b.price - a.price);
  const best = offers[0];

  if (!best) {
    return {
      available: false,
      status: 'not_available',
      market: 'Over 1,5 mål',
      bookmaker: 'Unibet'
    };
  }

  return {
    available: true,
    status: 'available',
    market: 'Over 1,5 mål',
    bookmaker: 'Unibet',
    bestBookmaker: 'Unibet',
    bestPrice: best.price,
    lastUpdated: best.lastUpdated,
    source: 'Odds-API.io'
  };
}

function cachePath(cacheDirectory, match) {
  const raw = match.id || match.fixtureId || `${match.date}-${match.home}-${match.away}`;
  const safe = String(raw).replace(/[^a-z0-9_-]+/gi, '_');
  return path.join(cacheDirectory, `${safe}.json`);
}

export async function readOddsCache(cacheDirectory, match, maxAgeHours) {
  try {
    const cached = JSON.parse(
      await fs.readFile(cachePath(cacheDirectory, match), 'utf8')
    );
    const ageHours = (
      Date.now() - new Date(cached.fetchedAt).getTime()
    ) / 3600000;

    return ageHours <= maxAgeHours ? cached.odds : null;
  } catch {
    return null;
  }
}

export async function writeOddsCache(cacheDirectory, match, odds) {
  await fs.mkdir(cacheDirectory, { recursive: true });
  await fs.writeFile(
    cachePath(cacheDirectory, match),
    JSON.stringify({ fetchedAt: new Date().toISOString(), odds }, null, 2),
    'utf8'
  );
}
