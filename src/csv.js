import fs from 'node:fs/promises';
import path from 'node:path';

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (c === '"' && quoted && next === '"') { field += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { row.push(field); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && next === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); if (row.some(v => v.trim())) rows.push(row); }
  return rows;
}

const norm = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9æøå]+/g, '');
const scoreParts = score => {
  const match = String(score || '').match(/(\d+)\s*[-–—:]\s*(\d+)/);
  return match ? [Number(match[1]), Number(match[2])] : [null, null];
};
const canonicalTeam = value => String(value || '').replace(/^[a-z]{2,3}(?=[A-ZÆØÅ])/,'').trim();

export function rowsToMatches(rows, league, sourceFile) {
  if (!rows.length) return [];
  let headerIndex = rows.findIndex(r => r.some(c => ['date','dato'].includes(norm(c))) && r.some(c => ['home','hjemme','hometeam'].includes(norm(c))) && r.some(c => ['away','ude','awayteam'].includes(norm(c))));
  if (headerIndex < 0) return [];
  const headers = rows[headerIndex].map(norm);
  const index = (...names) => headers.findIndex(h => names.includes(h));
  const dateI = index('date','dato'), timeI = index('time','tid'), homeI = index('home','hjemme','hometeam'), awayI = index('away','ude','awayteam'), scoreI = index('score','result','resultat'), homeScoreI = index('homescore','fthg'), awayScoreI = index('awayscore','ftag'), fixtureI = index('fixtureid','apifixtureid'), statusI = index('status');
  return rows.slice(headerIndex + 1).map(r => {
    const score = scoreI >= 0 ? scoreParts(r[scoreI]) : [Number(r[homeScoreI]), Number(r[awayScoreI])];
    const homeScore = Number.isFinite(score[0]) ? score[0] : null;
    const awayScore = Number.isFinite(score[1]) ? score[1] : null;
    const date = String(r[dateI] || '').slice(0,10);
    const home = canonicalTeam(r[homeI]), away = canonicalTeam(r[awayI]);
    if (!date || !home || !away) return null;
    return { fixtureId: fixtureI >= 0 ? Number(r[fixtureI]) || null : null, leagueSlug: league.slug, leagueName: league.displayName, apiLeagueId: league.apiLeagueId, season: league.season, date, time: timeI >= 0 ? String(r[timeI] || '') : '', home, away, homeScore, awayScore, status: statusI >= 0 ? String(r[statusI] || '') : (homeScore !== null && awayScore !== null ? 'finished' : 'scheduled'), source: `CSV:${sourceFile}` };
  }).filter(Boolean);
}

export async function discoverCsvLeagues(directory, leagueConfig) {
  const names = (await fs.readdir(directory).catch(() => [])).filter(n => n.toLowerCase().endsWith('.csv'));
  const found = [], unknown = [];
  for (const file of names) {
    const lower = file.toLowerCase();
    const league = leagueConfig.find(l => l.filePatterns.some(p => lower.includes(p.toLowerCase())));
    if (!league) { unknown.push(file); continue; }
    const text = await fs.readFile(path.join(directory, file), 'utf8');
    const matches = rowsToMatches(parseCsv(text.replace(/^\uFEFF/,'')), league, file);
    found.push({ league, file, rowCount: matches.length, matches });
  }
  return { found, unknown };
}

const quote = value => `"${String(value ?? '').replace(/"/g,'""')}"`;
export async function writeLeagueMemory(directory, league, matches) {
  const file = path.join(directory, `${league.slug}.csv`);
  const unique = new Map();
  for (const m of matches) {
    const key = m.fixtureId ? `id:${m.fixtureId}` : `${m.date}|${norm(m.home)}|${norm(m.away)}`;
    const old = unique.get(key);
    if (!old || (m.homeScore !== null && old.homeScore === null)) unique.set(key, m);
  }
  const sorted = [...unique.values()].sort((a,b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  const header = ['FixtureId','League','Season','Date','Time','Home','Away','HomeScore','AwayScore','Status','Source'];
  const lines = [header.map(quote).join(',')];
  for (const m of sorted) lines.push([m.fixtureId||'',league.displayName,m.season||league.season,m.date,m.time,m.home,m.away,m.homeScore??'',m.awayScore??'',m.status,m.source].map(quote).join(','));
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
  return file;
}
