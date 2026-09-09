import fs from 'node:fs/promises';
import path from 'node:path';

export class ApiFootball {
  constructor(key, baseUrl, hardLimit = 85) {
    if (!key) {
      throw new Error('Mangler API_FOOTBALL_KEY');
    }

    this.key = key;
    this.baseUrl = baseUrl;
    this.hardLimit = hardLimit;

    this.used = 0;
    this.remaining = null;
    this.log = [];
  }

  async get(endpoint, params = {}) {
    if (this.used >= this.hardLimit) {
      throw new Error(
        `Internt requestloft på ${this.hardLimit} er nået`
      );
    }

    const url = new URL(endpoint, this.baseUrl);

    for (const [key, value] of Object.entries(params)) {
      if (
        value !== undefined &&
        value !== null &&
        value !== ''
      ) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      headers: {
        'x-apisports-key': this.key
      }
    });

    this.used++;

    const remainingHeader = response.headers.get(
      'x-ratelimit-requests-remaining'
    );

    this.remaining =
      remainingHeader !== null
        ? Number(remainingHeader)
        : null;

    this.log.push({
      timestamp: new Date().toISOString(),
      endpoint,
      params,
      status: response.status,
      remaining: this.remaining
    });

    if (!response.ok) {
      const responseText = await response.text();

      throw new Error(
        `API-Football ${response.status}: ${responseText}`
      );
    }

    const body = await response.json();

    if (
      body.errors &&
      Object.keys(body.errors).length > 0
    ) {
      throw new Error(
        `API-Football: ${JSON.stringify(body.errors)}`
      );
    }

    return Array.isArray(body.response)
      ? body.response
      : [];
  }

  async saveLog(file) {
    const directory = path.dirname(file);

    await fs.mkdir(directory, {
      recursive: true
    });

    const logData = {
      generatedAt: new Date().toISOString(),
      used: this.used,
      remaining: this.remaining,
      hardLimit: this.hardLimit,
      calls: this.log
    };

    await fs.writeFile(
      file,
      JSON.stringify(logData, null, 2),
      'utf8'
    );
  }
}

export function apiFixtureToMatch(item, league) {
  const fixtureDate = new Date(item.fixture.date);

  const status =
    item.fixture.status?.short || '';

  const finishedStatuses = [
    'FT',
    'AET',
    'PEN'
  ];

  const finished =
    finishedStatuses.includes(status);

  return {
    fixtureId: item.fixture.id,

    leagueSlug: league.slug,
    leagueName: league.displayName,
    apiLeagueId: league.apiLeagueId,

    season:
      item.league.season ||
      league.season,

    date:
      item.fixture.date.slice(0, 10),

    time:
      fixtureDate
        .toISOString()
        .slice(11, 16),

    kickoff:
      item.fixture.date,

    home:
      item.teams.home.name,

    away:
      item.teams.away.name,

    homeId:
      item.teams.home.id,

    awayId:
      item.teams.away.id,

    homeScore:
      finished
        ? Number(item.goals.home)
        : null,

    awayScore:
      finished
        ? Number(item.goals.away)
        : null,

    status:
      finished
        ? 'finished'
        : 'scheduled',

    source:
      'API-Football'
  };
}
