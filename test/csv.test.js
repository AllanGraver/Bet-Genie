import test from 'node:test';import assert from 'node:assert/strict';import {parseCsv,rowsToMatches} from '../src/csv.js';
const league={slug:'test',displayName:'Test',apiLeagueId:1,season:2026};
test('læser FBref Scores & Fixtures-format',()=>{const csv='Date,Time,Home,Score,Away\n2026-09-01,18:00,Hold A,2–1,Hold B\n';const m=rowsToMatches(parseCsv(csv),league,'test.csv');assert.equal(m.length,1);assert.equal(m[0].homeScore,2);assert.equal(m[0].away,'Hold B')});
test('læser intern memory-format',()=>{const csv='FixtureId,Date,Home,Away,HomeScore,AwayScore,Status\n5,2026-09-01,A,B,3,0,finished\n';const m=rowsToMatches(parseCsv(csv),league,'test.csv');assert.equal(m[0].fixtureId,5);assert.equal(m[0].homeScore,3)});
