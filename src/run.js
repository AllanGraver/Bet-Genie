import fs from 'node:fs/promises';
import path from 'node:path';
import { discoverCsvLeagues, writeLeagueMemory } from './csv.js';
import { ApiFootball, apiFixtureToMatch } from './apiFootball.js';
import { preAnalyse, finalise, localH2H } from './analyse.js';

const root=process.cwd();
const settings=JSON.parse(await fs.readFile('config/settings.json','utf8'));
const leagues=JSON.parse(await fs.readFile('config/leagues.json','utf8'));
const dataDir=path.join(root,'data/leagues');
const date=process.env.ANALYSIS_DATE||new Intl.DateTimeFormat('en-CA',{timeZone:settings.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const sample=process.env.SAMPLE_MODE==='true';
const discovery=await discoverCsvLeagues(dataDir,leagues);
const activeById=new Map(discovery.found.map(x=>[x.league.apiLeagueId,x.league]));
let allHistory=discovery.found.flatMap(x=>x.matches);
let today=[];
let api=null;
const errors=[];

if(sample){
  const payload=JSON.parse(await fs.readFile('test/fixtures/api-today.json','utf8'));
  today=payload.response.map(item=>apiFixtureToMatch(item,activeById.get(item.league.id))).filter(Boolean);
}else if(activeById.size){
  api=new ApiFootball(process.env.API_FOOTBALL_KEY,settings.apiBaseUrl,settings.dailyHardLimit);
  try{
    const response=await api.get('/fixtures',{date,timezone:settings.timezone});
    today=response.filter(item=>activeById.has(item.league.id)).map(item=>apiFixtureToMatch(item,activeById.get(item.league.id)));
  }catch(e){errors.push(e.message)}
}

// One catch-up call per active league. It upserts finished matches from yesterday into the canonical league CSV.
if(api){
  const yesterday=new Date(`${date}T12:00:00Z`);yesterday.setUTCDate(yesterday.getUTCDate()-1);const y=yesterday.toISOString().slice(0,10);
  for(const {league} of discovery.found){
    try{
      const finished=await api.get('/fixtures',{league:league.apiLeagueId,season:league.season,from:y,to:date,status:'FT-AET-PEN'});
      const apiMatches=finished.map(item=>apiFixtureToMatch(item,league));
      const leagueExisting=allHistory.filter(m=>m.leagueSlug===league.slug);
      await writeLeagueMemory(dataDir,league,[...leagueExisting,...apiMatches,...today.filter(m=>m.leagueSlug===league.slug)]);
      allHistory=[...allHistory.filter(m=>m.leagueSlug!==league.slug),...leagueExisting,...apiMatches];
    }catch(e){errors.push(`${league.displayName}: ${e.message}`)}
  }
}

let pre=today.map(f=>preAnalyse(f,allHistory.filter(m=>m.leagueSlug===f.leagueSlug),settings)).sort((a,b)=>b.preScore-a.preScore);
const finalResults=[];
for(const candidate of pre){
  let h2h=localH2H(allHistory,candidate),source='CSV';
  const shouldRequest=api&&pre.indexOf(candidate)<settings.h2hCandidateLimit&&h2h.length<settings.h2hMinimumMatches&&candidate.homeId&&candidate.awayId;
  if(shouldRequest){
    const cacheFile=path.join('data/cache',`h2h-${Math.min(candidate.homeId,candidate.awayId)}-${Math.max(candidate.homeId,candidate.awayId)}.json`);
    let cached=null;
    try{cached=JSON.parse(await fs.readFile(cacheFile,'utf8'));const age=(Date.now()-new Date(cached.fetchedAt))/86400000;if(age>settings.h2hCacheDays)cached=null}catch{}
    if(cached){h2h=cached.matches;source='API-Football cache'}
    else try{
      const response=await api.get('/fixtures/headtohead',{h2h:`${candidate.homeId}-${candidate.awayId}`,last:10});
      h2h=response.map(item=>apiFixtureToMatch(item,activeById.get(item.league.id)||{slug:candidate.leagueSlug,displayName:item.league.name,apiLeagueId:item.league.id,season:item.league.season}));
      await fs.writeFile(cacheFile,JSON.stringify({fetchedAt:new Date().toISOString(),matches:h2h},null,2));source='API-Football';
    }catch(e){errors.push(`${candidate.home}-${candidate.away} H2H: ${e.message}`)}
  }
  finalResults.push(finalise(candidate,h2h,settings,source));
}
finalResults.sort((a,b)=>Number(b.passed)-Number(a.passed)||b.score-a.score);
const results=finalResults.filter(x=>x.passed),nearMisses=finalResults.filter(x=>!x.passed);
const leagueSummary=discovery.found.map(x=>({slug:x.league.slug,name:x.league.displayName,file:x.file,csvRows:x.rowCount,today:today.filter(m=>m.leagueSlug===x.league.slug).length}));
const output={date,updatedAt:new Date().toISOString(),totalMatches:today.length,foundLeagues:leagueSummary,unknownCsvFiles:discovery.unknown,results,nearMisses,requestUsage:{used:api?.used||0,remaining:api?.remaining??null,hardLimit:settings.dailyHardLimit},errors};
await fs.mkdir('docs/data',{recursive:true});
await fs.writeFile('docs/data/results.json',JSON.stringify(output,null,2));
if(api)await api.saveLog('data/cache/request-log.json');
console.log(JSON.stringify({date,leagues:leagueSummary.length,today:today.length,approved:results.length,notApproved:nearMisses.length,requests:output.requestUsage,errors},null,2));
