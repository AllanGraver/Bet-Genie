import fs from 'node:fs/promises';

export class ApiFootball {
  constructor(key, baseUrl, hardLimit = 85) {
    if (!key) throw new Error('Mangler API_FOOTBALL_KEY');
    this.key = key; this.baseUrl = baseUrl; this.hardLimit = hardLimit; this.used = 0; this.remaining = null; this.log = [];
  }
  async get(endpoint, params = {}) {
    if (this.used >= this.hardLimit) throw new Error(`Internt requestloft på ${this.hardLimit} er nået`);
    const url = new URL(endpoint, this.baseUrl);
    for (const [k,v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k,String(v));
    const response = await fetch(url, { headers: { 'x-apisports-key': this.key } });
    this.used++;
    this.remaining = Number(response.headers.get('x-ratelimit-requests-remaining'));
    this.log.push({ endpoint, params, status: response.status, remaining: this.remaining });
    if (!response.ok) throw new Error(`API-Football ${response.status}: ${await response.text()}`);
    const body = await response.json();
    if (body.errors && Object.keys(body.errors).length) throw new Error(`API-Football: ${JSON.stringify(body.errors)}`);
    return body.response || [];
  }
  async saveLog(file) { await fs.writeFile(file, JSON.stringify({ used: this.used, remaining: this.remaining, calls: this.log }, null, 2)); }
}

export function apiFixtureToMatch(item, league) {
  const date = new Date(item.fixture.date);
  const status = item.fixture.status?.short || '';
  const finished = ['FT','AET','PEN'].includes(status);
  return { fixtureId:item.fixture.id, leagueSlug:league.slug, leagueName:league.displayName, apiLeagueId:league.apiLeagueId, season:item.league.season || league.season, date:item.fixture.date.slice(0,10), time:date.toISOString().slice(11,16), kickoff:item.fixture.date, home:item.teams.home.name, away:item.teams.away.name, homeId:item.teams.home.id, awayId:item.teams.away.id, homeScore:finished ? Number(item.goals.home) : null, awayScore:finished ? Number(item.goals.away) : null, status:finished?'finished':'scheduled', source:'API-Football' };
}
