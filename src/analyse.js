const norm = s => String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\b(fc|if|bk|fk|afc|cf)\b/g,'').replace(/[^a-z0-9]+/g,' ').trim();
const sameTeam = (a,b) => { const x=norm(a), y=norm(b); return x===y || (x.length>4 && y.includes(x)) || (y.length>4 && x.includes(y)); };
const finished = m => Number.isFinite(m.homeScore) && Number.isFinite(m.awayScore);
const goalsFor = (m,team) => sameTeam(m.home,team) ? m.homeScore : sameTeam(m.away,team) ? m.awayScore : null;
const rate = (xs,p) => xs.length ? xs.filter(p).length / xs.length : 0;
const clamp = x => Math.max(0,Math.min(1,x));
const sortPast = (xs,date) => xs.filter(m=>finished(m)&&m.date<date).sort((a,b)=>b.date.localeCompare(a.date));

export function preAnalyse(fixture, history, settings) {
  const h = sortPast(history.filter(m=>sameTeam(m.home,fixture.home)||sameTeam(m.away,fixture.home)),fixture.date).slice(0,settings.historyMatches);
  const a = sortPast(history.filter(m=>sameTeam(m.home,fixture.away)||sameTeam(m.away,fixture.away)),fixture.date).slice(0,settings.historyMatches);
  const h5=h.slice(0,5), a5=a.slice(0,5);
  const homeAvg=h.length?h.reduce((s,m)=>s+goalsFor(m,fixture.home),0)/h.length:0;
  const awayAvg=a.length?a.reduce((s,m)=>s+goalsFor(m,fixture.away),0)/a.length:0;
  const hScored=h5.filter(m=>goalsFor(m,fixture.home)>=1).length, aScored=a5.filter(m=>goalsFor(m,fixture.away)>=1).length;
  const homeOver15=rate(h5,m=>m.homeScore+m.awayScore>1.5), awayOver15=rate(a5,m=>m.homeScore+m.awayScore>1.5);
  const homeBtts=rate(h5,m=>m.homeScore>=1&&m.awayScore>=1), awayBtts=rate(a5,m=>m.homeScore>=1&&m.awayScore>=1);
  const c=settings.criteria,w=settings.preScoreWeights;
  const criteria=[homeAvg>c.minimumGoalsAverage&&awayAvg>c.minimumGoalsAverage,hScored>=c.minimumScoredInLastFive&&aScored>=c.minimumScoredInLastFive,homeOver15>=c.minimumTeamOver15Rate&&awayOver15>=c.minimumTeamOver15Rate,homeBtts>=c.minimumBttsRate&&awayBtts>=c.minimumBttsRate];
  const score=100*(w.goalsAverage*clamp(((homeAvg+awayAvg)/2-1)/1.5)+w.scoringForm*(hScored+aScored)/10+w.teamOver15*(homeOver15+awayOver15)/2+w.btts*(homeBtts+awayBtts)/2);
  return {...fixture,historyReady:h5.length===5&&a5.length===5,preCriteria:criteria,preScore:+score.toFixed(1),metrics:{homeAvg,awayAvg,hScored,aScored,homeOver15,awayOver15,homeBtts,awayBtts,recentBtts:(homeBtts+awayBtts)/2},homeForm:h5,awayForm:a5};
}

export function finalise(pre,h2h,settings,h2hSource) {
  const usable=h2h.filter(finished).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,10);
  const h2hOver15=rate(usable,m=>m.homeScore+m.awayScore>1.5);
  const c=settings.criteria,w=settings.finalScoreWeights,m=pre.metrics;
  const criteria=[m.homeAvg>c.minimumGoalsAverage&&m.awayAvg>c.minimumGoalsAverage,usable.length>=settings.h2hMinimumMatches&&h2hOver15>c.minimumH2HOver15Rate,m.hScored>=c.minimumScoredInLastFive&&m.aScored>=c.minimumScoredInLastFive,m.homeOver15>=c.minimumTeamOver15Rate&&m.awayOver15>=c.minimumTeamOver15Rate,m.homeBtts>=c.minimumBttsRate&&m.awayBtts>=c.minimumBttsRate];
  const score=100*(w.goalsAverage*clamp(((m.homeAvg+m.awayAvg)/2-1)/1.5)+w.h2hOver15*h2hOver15+w.scoringForm*(m.hScored+m.aScored)/10+w.teamOver15*(m.homeOver15+m.awayOver15)/2+w.btts*(m.homeBtts+m.awayBtts)/2);
  return {...pre,score:+score.toFixed(1),passed:pre.historyReady&&criteria.every(Boolean),passedCount:criteria.filter(Boolean).length,criteria,metrics:{...m,h2hOver15,h2hCount:usable.length},h2h:usable,dataQuality:pre.historyReady&&usable.length>=settings.h2hMinimumMatches?'complete':'limited',sources:{history:[...new Set([...pre.homeForm,...pre.awayForm].map(x=>x.source))],h2h:h2hSource}};
}

export function localH2H(history,fixture) {
  return history.filter(m=>finished(m)&&m.date<fixture.date&&((sameTeam(m.home,fixture.home)&&sameTeam(m.away,fixture.away))||(sameTeam(m.home,fixture.away)&&sameTeam(m.away,fixture.home))));
}
