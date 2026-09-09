/* BetScope uge-dashboard med scoregraduering */
const $ = selector => document.querySelector(selector);
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const fixed = (value, digits = 2) => number(value).toFixed(digits);
const pct = value => `${Math.round(number(value) * 100)}%`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

let data = {
  results: [],
  nearMisses: [],
  foundLeagues: [],
  unknownCsvFiles: [],
  warnings: [],
  errors: []
};

const criteriaTitles = [
  'Begge holds målsnit over 1,00',
  'H2H over 1,5 mål',
  'Scoret i mindst 4 af seneste 5',
  'Holdkampe over 1,5 mål',
  'BTTS-rate mindst 60%'
];

function getScoreGrade(scoreValue) {
  const score = number(scoreValue);

  if (score >= 90) {
    return {
      key: 'elite',
      label: 'Elite',
      range: '90+',
      description: 'Meget stærk statistisk profil'
    };
  }

  if (score >= 80) {
    return {
      key: 'strong',
      label: 'Stærk',
      range: '80-89',
      description: 'Stærk statistisk profil'
    };
  }

  if (score >= 70) {
    return {
      key: 'interesting',
      label: 'Interessant',
      range: '70-79',
      description: 'Interessant statistisk profil'
    };
  }

  return {
    key: 'low',
    label: 'Under 70',
    range: '0-69',
    description: 'Lavere samlet statistisk vurdering'
  };
}

const leagueName = match => match.leagueName || match.league || 'Liga ukendt';

function kickoff(match) {
  if (match.time) return match.time;
  const date = match.kickoff ? new Date(match.kickoff) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })
    : (match.kickoff || 'Tid ukendt');
}

function passedCriterion(match, index) {
  const criterion = Array.isArray(match.criteria) ? match.criteria[index] : false;
  return criterion && typeof criterion === 'object'
    ? Boolean(criterion.passed)
    : Boolean(criterion);
}

function requirement(match, index) {
  const criterion = Array.isArray(match.criteria) ? match.criteria[index] : null;
  if (criterion && typeof criterion === 'object' && criterion.required) {
    return criterion.required;
  }

  return [
    'Begge > 1,00',
    'Mere end 80%',
    'Begge mindst 4/5',
    'Begge mindst 80%',
    'Begge mindst 60%'
  ][index];
}

function actual(match, index) {
  const metrics = match.metrics || {};
  return [
    `${fixed(metrics.homeAvg)} / ${fixed(metrics.awayAvg)}`,
    `${pct(metrics.h2hOver15)} · ${number(metrics.h2hCount)} H2H-kampe`,
    `${number(metrics.hScored)}/5 · ${number(metrics.aScored)}/5`,
    `${pct(metrics.homeOver15)} · ${pct(metrics.awayOver15)}`,
    `${pct(metrics.homeBtts)} · ${pct(metrics.awayBtts)}`
  ][index];
}

function historyRows(matches = []) {
  if (!Array.isArray(matches) || !matches.length) {
    return '<li class="history-empty">Ingen historiske kampe tilgængelige</li>';
  }

  return matches.map(match => `
    <li class="history-row">
      <span>${esc(match.date || '')}</span>
      <span>${esc(match.home || '')} <b>${match.homeScore ?? '-'}-${match.awayScore ?? '-'}</b> ${esc(match.away || '')}</span>
      ${match.source ? `<small>${esc(match.source)}</small>` : ''}
    </li>
  `).join('');
}

function gradeBadge(grade, includeRange = false) {
  return `
    <span class="score-grade score-grade-${grade.key}">
      <i aria-hidden="true">●</i>
      ${esc(grade.label)}${includeRange ? ` ${esc(grade.range)}` : ''}
    </span>
  `;
}

function matchCard(match, index) {
  const passed = Boolean(match.passed);
  const grade = getScoreGrade(match.score);

  return `
    <details class="match grade-border-${grade.key} ${passed ? 'approved' : 'rejected'}">
      <summary>
        <span class="rank">#${index + 1}</span>
        <div class="match-summary">
          <small>${esc(leagueName(match))} · ${esc(match.date || '')} · ${esc(kickoff(match))}</small>
          <h3>${esc(match.home)} <em>mod</em> ${esc(match.away)}</h3>
          <div class="match-status-row">
            <p class="${passed ? 'ok' : 'no'}">
              ${passed ? '✓ BESTÅR ALLE 5' : '× BESTÅR IKKE ALLE 5'} · ${number(match.passedCount)}/5
            </p>
            ${gradeBadge(grade)}
          </div>
        </div>
        <div class="score-block score-block-${grade.key}">
          <strong class="score">${fixed(match.score, 1)}<small>/100</small></strong>
          <span>${esc(grade.label)}</span>
        </div>
        <b class="chev" aria-hidden="true">⌄</b>
      </summary>

      <div class="content">
        <section class="grade-detail grade-detail-${grade.key}">
          <div>
            <small>SAMLET GRADUERING</small>
            <h4><span aria-hidden="true">●</span> ${esc(grade.label)} ${esc(grade.range)}</h4>
            <p>${esc(grade.description)}</p>
          </div>
          <strong>${fixed(match.score, 1)}<small>/100</small></strong>
        </section>

        <section class="criteria">
          ${criteriaTitles.map((title, index) => {
            const ok = passedCriterion(match, index);
            return `
              <article class="criterion-card ${ok ? 'ok' : 'no'}">
                <h4>${ok ? '✓' : '×'} K${index + 1}</h4>
                <b>${esc(title)}</b>
                <dl>
                  <dt>Faktisk</dt><dd>${esc(actual(match, index))}</dd>
                  <dt>Krav</dt><dd>${esc(requirement(match, index))}</dd>
                </dl>
              </article>
            `;
          }).join('')}
        </section>

        <section class="details-grid">
          <div class="detail-panel">
            <h4>${esc(match.home)} · seneste 5</h4>
            <ul>${historyRows(match.homeForm)}</ul>
          </div>
          <div class="detail-panel">
            <h4>${esc(match.away)} · seneste 5</h4>
            <ul>${historyRows(match.awayForm)}</ul>
          </div>
          <div class="detail-panel">
            <h4>Indbyrdes kampe</h4>
            <ul>${historyRows(match.h2h)}</ul>
          </div>
          <div class="detail-panel">
            <h4>Datakvalitet</h4>
            <p><b>${match.dataQuality === 'complete' ? 'Komplet' : 'Begrænset'}</b></p>
            <p>Historik: ${esc((match.sources?.history || []).join(', ') || 'Ukendt')}</p>
            <p>H2H: ${esc(match.sources?.h2h || 'Ukendt')}</p>
            <p>Gradueringen er baseret på succesindekset. Godkendelse kræver fortsat 5/5 kriterier.</p>
          </div>
        </section>
      </div>
    </details>
  `;
}

function uniqueLeagues() {
  const map = new Map();

  for (const item of data.foundLeagues || []) {
    const key = String(item.slug || item.name || item.displayName || '')
      .trim()
      .toLowerCase();

    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, {
        slug: key,
        name: item.name || item.displayName || item.slug || 'Ukendt liga',
        periodMatches: 0,
        csvRows: 0
      });
    }

    const league = map.get(key);
    league.periodMatches = Math.max(
      league.periodMatches,
      number(item.periodMatches ?? item.today)
    );
    league.csvRows += number(item.csvRows);
  }

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'da'));
}

function renderLeagues() {
  const leagues = uniqueLeagues();

  $('#leagues').innerHTML = leagues.length
    ? `
      <div class="league-summary">
        <div class="league-total">
          <b>${leagues.length}</b>
          <span>${leagues.length === 1 ? 'liga fundet' : 'ligaer fundet'}</span>
        </div>
        <div class="league-list">
          ${leagues.map(league => `
            <div class="league-item">
              <span class="league-name">${esc(league.name)}</span>
              <span class="league-today">${league.periodMatches} ${league.periodMatches === 1 ? 'kamp' : 'kampe'} i perioden</span>
              <small>${league.csvRows} historiske kamprækker</small>
            </div>
          `).join('')}
        </div>
      </div>
    `
    : '<div class="empty">Ingen genkendte CSV-ligaer.</div>';

  const unknown = Array.isArray(data.unknownCsvFiles) ? data.unknownCsvFiles.length : 0;
  $('#unknown').textContent = unknown
    ? `${unknown} CSV-${unknown === 1 ? 'fil kunne' : 'filer kunne'} ikke forbindes med en kendt liga.`
    : '';
}

function populateDateFilter() {
  const filter = $('#date-filter');
  if (!filter) return;

  const dates = [...new Set(
    [...data.results, ...data.nearMisses]
      .map(match => match.date)
      .filter(Boolean)
  )].sort();

  filter.innerHTML = '<option value="all">Hele ugen</option>' + dates.map(date => `
    <option value="${esc(date)}">
      ${new Date(`${date}T12:00:00`).toLocaleDateString('da-DK', {
        weekday: 'long', day: 'numeric', month: 'long'
      })}
    </option>
  `).join('');
}

function populateGradeFilter() {
  const filter = $('#grade-filter');
  if (!filter) return;

  filter.innerHTML = `
    <option value="all">Alle gradueringer</option>
    <option value="elite">Elite 90+</option>
    <option value="strong">Stærk 80-89</option>
    <option value="interesting">Interessant 70-79</option>
    <option value="low">Under 70</option>
  `;
}

function renderMatches() {
  const query = ($('#search')?.value || '').trim().toLowerCase();
  const status = $('#filter')?.value || 'approved';
  const selectedDate = $('#date-filter')?.value || 'all';
  const selectedGrade = $('#grade-filter')?.value || 'all';

  let matches = status === 'approved'
    ? data.results
    : status === 'rejected'
      ? data.nearMisses
      : [...data.results, ...data.nearMisses];

  matches = [...matches]
    .filter(match => `${match.home} ${match.away} ${leagueName(match)}`.toLowerCase().includes(query))
    .filter(match => selectedDate === 'all' || match.date === selectedDate)
    .filter(match => selectedGrade === 'all' || getScoreGrade(match.score).key === selectedGrade)
    .sort((a, b) => number(b.score) - number(a.score));

  $('#list').innerHTML = matches.length
    ? matches.map(matchCard).join('')
    : '<div class="empty">Ingen kampe i denne visning.</div>';
}

function renderMessages() {
  const messages = [...(data.warnings || []), ...(data.errors || [])];
  $('#errors').innerHTML = messages.length
    ? `<h3>Dataadvarsler</h3>${messages.map(message => `<p>${esc(message)}</p>`).join('')}`
    : '';
}

async function load() {
  const button = $('#refresh');
  if (button) {
    button.disabled = true;
    button.textContent = '↻ Henter data...';
  }

  try {
    const response = await fetch(`data/results.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = await response.json();
    data = {
      results: Array.isArray(payload.results) ? payload.results : [],
      nearMisses: Array.isArray(payload.nearMisses) ? payload.nearMisses : [],
      foundLeagues: Array.isArray(payload.foundLeagues) ? payload.foundLeagues : [],
      unknownCsvFiles: Array.isArray(payload.unknownCsvFiles) ? payload.unknownCsvFiles : [],
      warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
      errors: Array.isArray(payload.errors) ? payload.errors : []
    };

    $('#total').textContent = number(payload.totalMatches);
    $('#approved').textContent = data.results.length;
    $('#rejected').textContent = data.nearMisses.length;
    $('#requests').textContent = number(payload.requestUsage?.used);

    const from = payload.period?.from || payload.date || '-';
    const to = payload.period?.to || payload.date || '-';
    $('#meta').textContent = `Kampe fra ${from} til ${to} · Opdateret ${
      payload.updatedAt ? new Date(payload.updatedAt).toLocaleString('da-DK') : 'ikke endnu'
    }`;

    renderLeagues();
    populateDateFilter();
    populateGradeFilter();
    renderMatches();
    renderMessages();
  } catch (error) {
    $('#meta').textContent = `Data kunne ikke hentes: ${error.message}`;
    $('#list').innerHTML = '<div class="empty">Kontrollér docs/data/results.json.</div>';
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = '↻ Genindlæs dashboard';
    }
  }
}

if ($('#refresh')) $('#refresh').onclick = load;
if ($('#search')) $('#search').oninput = renderMatches;
if ($('#filter')) $('#filter').onchange = renderMatches;
if ($('#date-filter')) $('#date-filter').onchange = renderMatches;
if ($('#grade-filter')) $('#grade-filter').onchange = renderMatches;
load();
