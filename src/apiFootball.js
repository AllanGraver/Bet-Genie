import fs from 'node:fs/promises';
import path from 'node:path';

export class ApiFootball {
  constructor(key, baseUrl, hardLimit = 85) {
    if (!key) throw new Error('Mangler API_FOOTBALL_KEY');
    this.key = key;
    this.baseUrl = baseUrl;
    this.hardLimit = hardLimit;
    this.used = 0;
    this.remaining = null;
    this.log = [];
  }

  async get(endpoint, params = {}) {
    if (this.used >= this.hardLimit) {
      throw new Error(`Internt requestloft på ${this.hardLimit} er nået`);
    }

    const url = new URL(endpoint, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      headers: { 'x-apisports-key': this.key }
    });

    this.used += 1;
    const remainingHeader = response.headers.get('x-ratelimit-requests-remaining');
    this.remaining = remainingHeader === null ? null : Number(remainingHeader);
    this.log.push({
      timestamp: new Date().toISOString(),
      endpoint,
      params,
      status: response.status,
      remaining: this.remaining
    });

    if (!response.ok) {
      throw new Error(`API-Football ${response.status}: ${await response.text()}`);
    }

    const body = await response.json();
    if (body.errors && Object.keys(body.errors).length > 0) {
      throw new Error(`API-Football: ${JSON.stringify(body.errors)}`);
    }

    return Array.isArray(body.response) ? body.response : [];
  }

  async saveLog(file) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      generatedAt: new Date().toISOString(),
      used: this.used,
      remaining: this.remaining,
      hardLimit: this.hardLimit,
      calls: this.log
    }, null, 2), 'utf8');
  }
}

export function apiFixtureToMatch(item, league) {
  const status = item.fixture?.status?.short || '';
  const finished = ['FT', 'AET', 'PEN'].includes(status);
  const fixtureDate = item.fixture?.date || '';
  const parsedDate = fixtureDate ? new Date(fixtureDate) : null;

  return {
    fixtureId: item.fixture?.id || null,
    leagueSlug: league.slug,
    leagueName: league.displayName,
    apiLeagueId: league.apiLeagueId,
    season: item.league?.season || league.season,
    date: fixtureDate.slice(0, 10),
    time: parsedDate && !Number.isNaN(parsedDate.getTime())
      ? parsedDate.toISOString().slice(11, 16)
      : '',
    kickoff: fixtureDate,
    home: item.teams?.home?.name || 'Ukendt hjemmehold',
    away: item.teams?.away?.name || 'Ukendt udehold',
    homeId: item.teams?.home?.id || null,
    awayId: item.teams?.away?.id || null,
    homeScore: finished ? Number(item.goals?.home) : null,
    awayScore: finished ? Number(item.goals?.away) : null,
    status: finished ? 'finished' : 'scheduled',
    source: 'API-Football'
  };
}
