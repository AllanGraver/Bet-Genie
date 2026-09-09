import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverCsvLeagues, normalizeFileName } from '../src/csv.js';

const config = JSON.parse(await fs.readFile(new URL('../config/leagues.json', import.meta.url), 'utf8'));
const sample = 'Wk,Day,Date,Time,Home,Score,Away\n1,Fri,2024-08-16,20:00,Home,2–1,Away\n';

test('normalisering ignorerer mellemrum, bindestreger og parenteser', () => {
  assert.equal(normalizeFileName('2024-2025 Premier League Scores & Fixtures (1).csv').includes(normalizeFileName('premier-league')), true);
});

test('genkender alle fire konkrete FBref-filnavne', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'betscope-leagues-'));
  const names = [
    '2024-2025 Premier League Scores & Fixtures (1).csv',
    '2024-2025 Danish Superliga Scores & Fixtures (1).csv',
    '2024-2025 Bundesliga Scores & Fixtures (1).csv',
    '2024-2025 Belgian Pro League Scores & Fixtures (1).csv'
  ];
  for (const name of names) await fs.writeFile(path.join(directory, name), sample, 'utf8');

  const result = await discoverCsvLeagues(directory, config);
  assert.equal(result.found.length, 4);
  assert.equal(result.unknown.length, 0);
  assert.deepEqual(
    result.found.map(item => item.league.displayName).sort(),
    ['3F Superliga', 'Belgian Pro League', 'Bundesliga', 'Premier League'].sort()
  );
});
