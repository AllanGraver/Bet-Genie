import fs from 'node:fs/promises';
import path from 'node:path';

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (character === '"' && quoted && nextCharacter === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && nextCharacter === '\n') index += 1;
      row.push(field);
      field = '';
      if (row.some(value => value.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += character;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    if (row.some(value => value.trim() !== '')) rows.push(row);
  }

  return rows;
}

const normalizeColumnName = value => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9æøå]+/g, '');

export function normalizeFileName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\.csv$/i, '')
    .replace(/[^a-z0-9æøå]+/g, '');
}

function parseScore(score) {
  const match = String(score || '').match(/(\d+)\s*[-–—:]\s*(\d+)/);
  return match ? [Number(match[1]), Number(match[2])] : [null, null];
}

function canonicalTeam(value) {
  return String(value || '')
    .replace(/^[a-z]{2,3}(?=[A-ZÆØÅ])/u, '')
    .trim();
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const european = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (european) {
    const [, day, month, year] = european;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  return text.slice(0, 10);
}

export function rowsToMatches(rows, league, sourceFile) {
  if (!rows.length) return [];

  const headerIndex = rows.findIndex(row => {
    const normalized = row.map(normalizeColumnName);
    return normalized.some(value => ['date', 'dato'].includes(value)) &&
      normalized.some(value => ['home', 'hjemme', 'hometeam'].includes(value)) &&
      normalized.some(value => ['away', 'ude', 'awayteam'].includes(value));
  });

  if (headerIndex < 0) return [];

  const headers = rows[headerIndex].map(normalizeColumnName);
  const indexOf = (...names) => headers.findIndex(header => names.includes(header));

  const dateIndex = indexOf('date', 'dato');
  const timeIndex = indexOf('time', 'tid');
  const homeIndex = indexOf('home', 'hjemme', 'hometeam');
  const awayIndex = indexOf('away', 'ude', 'awayteam');
  const scoreIndex = indexOf('score', 'result', 'resultat');
  const homeScoreIndex = indexOf('homescore', 'fthg');
  const awayScoreIndex = indexOf('awayscore', 'ftag');
  const fixtureIndex = indexOf('fixtureid', 'apifixtureid');
  const statusIndex = indexOf('status');

  return rows.slice(headerIndex + 1).map(row => {
    let homeScore = null;
    let awayScore = null;

    if (scoreIndex >= 0) {
      [homeScore, awayScore] = parseScore(row[scoreIndex]);
    } else if (homeScoreIndex >= 0 && awayScoreIndex >= 0) {
      const parsedHome = Number(row[homeScoreIndex]);
      const parsedAway = Number(row[awayScoreIndex]);
      homeScore = row[homeScoreIndex] !== '' && Number.isFinite(parsedHome) ? parsedHome : null;
      awayScore = row[awayScoreIndex] !== '' && Number.isFinite(parsedAway) ? parsedAway : null;
    }

    const date = normalizeDate(row[dateIndex]);
    const home = canonicalTeam(row[homeIndex]);
    const away = canonicalTeam(row[awayIndex]);

    if (!date || !home || !away) return null;

    return {
      fixtureId: fixtureIndex >= 0 ? Number(row[fixtureIndex]) || null : null,
      leagueSlug: league.slug,
      leagueName: league.displayName,
      apiLeagueId: league.apiLeagueId,
      season: league.season,
      date,
      time: timeIndex >= 0 ? String(row[timeIndex] || '') : '',
      home,
      away,
      homeScore,
      awayScore,
      status: statusIndex >= 0
        ? String(row[statusIndex] || '')
        : (homeScore !== null && awayScore !== null ? 'finished' : 'scheduled'),
      source: `CSV:${sourceFile}`
    };
  }).filter(Boolean);
}

export async function discoverCsvLeagues(directory, leagueConfig) {
  const fileNames = (await fs.readdir(directory).catch(() => []))
    .filter(fileName => fileName.toLowerCase().endsWith('.csv'));

  const found = [];
  const unknown = [];

  for (const file of fileNames) {
    const normalizedFileName = normalizeFileName(file);

    const league = leagueConfig.find(leagueItem => {
      const patterns = Array.isArray(leagueItem.filePatterns)
        ? leagueItem.filePatterns
        : [];

      return patterns.some(pattern =>
        normalizedFileName.includes(normalizeFileName(pattern))
      );
    });

    if (!league) {
      unknown.push(file);
      continue;
    }

    const text = await fs.readFile(path.join(directory, file), 'utf8');
    const matches = rowsToMatches(
      parseCsv(text.replace(/^\uFEFF/, '')),
      league,
      file
    );

    found.push({
      league,
      file,
      rowCount: matches.length,
      matches
    });
  }

  return { found, unknown };
}

const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;

export async function writeLeagueMemory(directory, league, matches) {
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${league.slug}.csv`);
  const unique = new Map();

  for (const match of matches) {
    const key = match.fixtureId
      ? `id:${match.fixtureId}`
      : `${match.date}|${normalizeFileName(match.home)}|${normalizeFileName(match.away)}`;

    const existing = unique.get(key);
    const incomingFinished = match.homeScore !== null && match.awayScore !== null;
    const existingFinished = existing?.homeScore !== null && existing?.awayScore !== null;

    if (!existing || (incomingFinished && !existingFinished)) unique.set(key, match);
  }

  const sorted = [...unique.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || String(a.time || '').localeCompare(String(b.time || ''))
  );

  const header = [
    'FixtureId', 'League', 'Season', 'Date', 'Time', 'Home', 'Away',
    'HomeScore', 'AwayScore', 'Status', 'Source'
  ];
  const lines = [header.map(quote).join(',')];

  for (const match of sorted) {
    lines.push([
      match.fixtureId || '',
      league.displayName,
      match.season || league.season,
      match.date,
      match.time,
      match.home,
      match.away,
      match.homeScore ?? '',
      match.awayScore ?? '',
      match.status,
      match.source
    ].map(quote).join(','));
  }

  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}
