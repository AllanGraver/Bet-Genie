/* BetScope uge-dashboard med scoregraduering */

const $ = selector =>
  document.querySelector(selector);

const number = value =>
  Number.isFinite(Number(value))
    ? Number(value)
    : 0;

const fixed = (value, digits = 2) =>
  number(value).toFixed(digits);

const pct = value =>
  `${Math.round(number(value) * 100)}%`;

const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    })[character]
  );

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

/*
 * ------------------------------------------------------------
 * SCOREGRADUERING
 * ------------------------------------------------------------
 */

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

/*
 * ------------------------------------------------------------
 * KAMPDATA
 * ------------------------------------------------------------
 */

const leagueName = match =>
  match.leagueName ||
  match.league ||
  'Liga ukendt';

function kickoff(match) {
  if (match.time) {
    return match.time;
  }

  const kickoffDate = match.kickoff
    ? new Date(match.kickoff)
    : null;

  if (
    kickoffDate &&
    !Number.isNaN(kickoffDate.getTime())
  ) {
    return kickoffDate.toLocaleTimeString(
      'da-DK',
      {
        hour: '2-digit',
        minute: '2-digit'
      }
    );
  }

  return match.kickoff || 'Tid ukendt';
}

function passedCriterion(match, index) {
  const criterion = Array.isArray(match.criteria)
    ? match.criteria[index]
    : false;

  if (
    criterion &&
    typeof criterion === 'object'
  ) {
    return Boolean(criterion.passed);
  }

  return Boolean(criterion);
}

function requirement(match, index) {
  const criterion = Array.isArray(match.criteria)
    ? match.criteria[index]
    : null;

  if (
    criterion &&
    typeof criterion === 'object' &&
    criterion.required
  ) {
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

    `${pct(metrics.h2hOver15)} · ` +
      `${number(metrics.h2hCount)} H2H-kampe`,

    `${number(metrics.hScored)}/5 · ` +
      `${number(metrics.aScored)}/5`,

    `${pct(metrics.homeOver15)} · ` +
      `${pct(metrics.awayOver15)}`,

    `${pct(metrics.homeBtts)} · ` +
      `${pct(metrics.awayBtts)}`
  ][index];
}

/*
 * ------------------------------------------------------------
 * HISTORIK
 * ------------------------------------------------------------
 */

function historyRows(matches = []) {
  if (
    !Array.isArray(matches) ||
    matches.length === 0
  ) {
    return `
      <li class="history-empty">
        Ingen historiske kampe tilgængelige
      </li>
    `;
  }

  return matches
    .map(match => `
      <li class="history-row">
        <span>
          ${esc(match.date || '')}
        </span>

        <span>
          ${esc(match.home || '')}

          <b>
            ${esc(match.homeScore ?? '-')}
            -
            ${esc(match.awayScore ?? '-')}
          </b>

          ${esc(match.away || '')}
        </span>

        ${
          match.source
            ? `<small>${esc(match.source)}</small>`
            : ''
        }
      </li>
    `)
    .join('');
}

/*
 * ------------------------------------------------------------
 * GRADUERINGSBADGE
 * ------------------------------------------------------------
 */

function gradeBadge(
  grade,
  includeRange = false
) {
  const range = includeRange
    ? ` ${esc(grade.range)}`
    : '';

  return `
    <span class="score-grade score-grade-${esc(grade.key)}">
      <i aria-hidden="true">●</i>
      ${esc(grade.label)}${range}
    </span>
  `;
}

/*
 * ------------------------------------------------------------
 * ODDS OG FALLBACK-LINK
 * ------------------------------------------------------------
 */

function safeHttpsUrl(value) {
  try {
    const url = new URL(
      String(value || '').trim()
    );

    if (url.protocol !== 'https:') {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

function renderOddsPanel(match) {
  const odds = (
    match?.odds &&
    typeof match.odds === 'object'
  )
    ? match.odds
    : {};

  const oddsStatus = String(
    match?.oddsStatus ||
    odds.status ||
    ''
  ).trim();

  const decimalOdds = Number(
    odds.decimalOdds ??
    odds.decimal
  );

  /*
   * Et odds er fundet gennem TheRundown.
   */
  if (
    oddsStatus === 'available' &&
    odds.available === true &&
    Number.isFinite(decimalOdds) &&
    decimalOdds > 1
  ) {
    const formattedOdds = decimalOdds
      .toFixed(2)
      .replace('.', ',');

    const checkedAt = odds.checkedAt
      ? new Date(odds.checkedAt)
      : null;

    const checkedAtText = (
      checkedAt &&
      !Number.isNaN(checkedAt.getTime())
    )
      ? checkedAt.toLocaleString(
          'da-DK',
          {
            dateStyle: 'short',
            timeStyle: 'short'
          }
        )
      : null;

    return `
      <section
        class="odds-panel odds-available"
        aria-label="Unibet odds"
      >
        <div class="odds-panel-copy">
          <small class="odds-eyebrow">
            UNIBET ODDS
          </small>

          <h4>
            Over 1,5 mål
          </h4>

          <p>
            Kilde: TheRundown${
              checkedAtText
                ? ` · Opdateret ${esc(checkedAtText)}`
                : ''
            }
          </p>
        </div>

        <div class="odds-value-wrap">
          <strong class="odds-value">
            ${esc(formattedOdds)}
          </strong>

          <small>
            DECIMALODDS
          </small>
        </div>
      </section>
    `;
  }

  /*
   * Et API-odds blev ikke fundet.
   * Find et rent HTTPS-fallback-link fra kampdataene.
   */
  const fallbackUrl = safeHttpsUrl(
    match?.fallbackOddsUrl ||
    match?.oddsConfiguration?.fallbackUrl ||
    odds.fallbackUrl
  );

  if (fallbackUrl) {
    const safeUrl = esc(fallbackUrl);

    return `
      <section
        class="odds-panel odds-fallback"
        aria-label="Unibet odds"
      >
        <div class="odds-panel-copy">
          <small class="odds-eyebrow">
            UNIBET ODDS
          </small>

          <h4>
            Odds ikke tilgængelige via API
          </h4>

          <p class="odds-fallback-text">
            (find odds på:
            ${safeUrl}${safeUrl}</a>)
          </p>
        </div>
      </section>
    `;
  }

  /*
   * Hverken API-odds eller et gyldigt fallback-link findes.
   */
  return `
    <section
      class="odds-panel odds-error"
      aria-label="Oddsstatus"
    >
      <div class="odds-panel-copy">
        <small class="odds-eyebrow">
          UNIBET ODDS
        </small>

        <h4>
          Oddslink mangler
        </h4>

        <p>
          Der er ikke konfigureret et gyldigt HTTPS-link.
        </p>
      </div>
    </section>
  `;
}

/*
 * ------------------------------------------------------------
 * KAMPKORT
 * ------------------------------------------------------------
 */

function matchCard(match, index) {
  const passed = Boolean(match.passed);

  const grade = getScoreGrade(
    match.score
  );

  return `
    <details
      class="
        match
        grade-border-${esc(grade.key)}
        ${passed ? 'approved' : 'rejected'}
      "
    >
      <summary>
        <span class="rank">
          #${index + 1}
        </span>

        <div class="match-summary">
          <small>
            ${esc(leagueName(match))}
            ·
            ${esc(match.date || '')}
            ·
            ${esc(kickoff(match))}
          </small>

          <h3>
            ${esc(match.home)}
            <em>mod</em>
            ${esc(match.away)}
          </h3>

          <div class="match-status-row">
            <p class="${passed ? 'ok' : 'no'}">
              ${
                passed
                  ? '✓ BESTÅR ALLE 5'
                  : '× BESTÅR IKKE ALLE 5'
              }
              ·
              ${number(match.passedCount)}/5
            </p>

            ${gradeBadge(grade)}
          </div>
        </div>

        <div
          class="score-block score-block-${esc(grade.key)}"
        >
          <strong class="score">
            ${fixed(match.score, 1)}
            <small>/100</small>
          </strong>

          <span>
            ${esc(grade.label)}
          </span>
        </div>

        <b
          class="chev"
          aria-hidden="true"
        >
          ⌄
        </b>
      </summary>

      <div class="content">
        <section
          class="grade-detail grade-detail-${esc(grade.key)}"
        >
          <div>
            <small>
              SAMLET GRADUERING
            </small>

            <h4>
              <span aria-hidden="true">
                ●
              </span>

              ${esc(grade.label)}
              ${esc(grade.range)}
            </h4>

            <p>
              ${esc(grade.description)}
            </p>
          </div>

          <strong>
            ${fixed(match.score, 1)}
            <small>/100</small>
          </strong>
        </section>

        ${renderOddsPanel(match)}

        <section class="criteria">
          ${criteriaTitles
            .map(
              (
                title,
                criterionIndex
              ) => {
                const ok = passedCriterion(
                  match,
                  criterionIndex
                );

                return `
                  <article
                    class="
                      criterion-card
                      ${ok ? 'ok' : 'no'}
                    "
                  >
                    <h4>
                      ${ok ? '✓' : '×'}
                      K${criterionIndex + 1}
                    </h4>

                    <b>
                      ${esc(title)}
                    </b>

                    <dl>
                      <dt>
                        Faktisk
                      </dt>

                      <dd>
                        ${esc(
                          actual(
                            match,
                            criterionIndex
                          )
                        )}
                      </dd>

                      <dt>
                        Krav
                      </dt>

                      <dd>
                        ${esc(
                          requirement(
                            match,
                            criterionIndex
                          )
                        )}
                      </dd>
                    </dl>
                  </article>
                `;
              }
            )
            .join('')}
        </section>

        <section class="details-grid">
          <div class="detail-panel">
            <h4>
              ${esc(match.home)}
              · seneste 5
            </h4>

            <ul>
              ${historyRows(match.homeForm)}
            </ul>
          </div>

          <div class="detail-panel">
            <h4>
              ${esc(match.away)}
              · seneste 5
            </h4>

            <ul>
              ${historyRows(match.awayForm)}
            </ul>
          </div>

          <div class="detail-panel">
            <h4>
              Indbyrdes kampe
            </h4>

            <ul>
              ${historyRows(match.h2h)}
            </ul>
          </div>

          <div class="detail-panel">
            <h4>
              Datakvalitet
            </h4>

            <p>
              <b>
                ${
                  match.dataQuality === 'complete'
                    ? 'Komplet'
                    : 'Begrænset'
                }
              </b>
            </p>

            <p>
              Historik:
              ${esc(
                (
                  match.sources?.history ||
                  []
                ).join(', ') ||
                'Ukendt'
              )}
            </p>

            <p>
              H2H:
              ${esc(
                match.sources?.h2h ||
                'Ukendt'
              )}
            </p>

            <p>
              Gradueringen er baseret på succesindekset.
              Godkendelse kræver fortsat 5/5 kriterier.
            </p>
          </div>
        </section>
      </div>
    </details>
  `;
}

/*
 * ------------------------------------------------------------
 * LIGAOVERSIGT
 * ------------------------------------------------------------
 */

function uniqueLeagues() {
  const map = new Map();

  for (
    const item of
      data.foundLeagues || []
  ) {
    const key = String(
      item.slug ||
      item.name ||
      item.displayName ||
      ''
    )
      .trim()
      .toLowerCase();

    if (!key) {
      continue;
    }

    if (!map.has(key)) {
      map.set(
        key,
        {
          slug: key,

          name:
            item.name ||
            item.displayName ||
            item.slug ||
            'Ukendt liga',

          periodMatches: 0,

          csvRows: 0,

          csvFiles: 0,

          odds:
            item.odds || null
        }
      );
    }

    const league = map.get(key);

    league.periodMatches = Math.max(
      league.periodMatches,
      number(
        item.periodMatches ??
        item.today
      )
    );

    league.csvRows = Math.max(
      league.csvRows,
      number(item.csvRows)
    );

    league.csvFiles = Math.max(
      league.csvFiles,
      number(item.csvFiles)
    );

    if (item.odds) {
      league.odds = item.odds;
    }
  }

  return [
    ...map.values()
  ].sort(
    (leagueA, leagueB) =>
      leagueA.name.localeCompare(
        leagueB.name,
        'da'
      )
  );
}

function leagueOddsStatus(league) {
  const odds = league.odds;

  if (!odds) {
    return '';
  }

  if (
    number(odds.available) > 0 ||
    odds.status === 'available'
  ) {
    return `
      <span
        class="
          league-odds-status
          league-odds-available
        "
      >
        Unibet-odds tilgængelige
      </span>
    `;
  }

  if (odds.rundownSupported === true) {
    return `
      <span
        class="
          league-odds-status
          league-odds-api
        "
      >
        TheRundown aktiveret
      </span>
    `;
  }

  return `
    <span
      class="
        league-odds-status
        league-odds-fallback
      "
    >
      Unibet-link
    </span>
  `;
}

function renderLeagues() {
  const leagues = uniqueLeagues();

  const leaguesElement = $('#leagues');
  const unknownElement = $('#unknown');

  if (leaguesElement) {
    leaguesElement.innerHTML = leagues.length
      ? `
        <div class="league-summary">
          <div class="league-total">
            <b>
              ${leagues.length}
            </b>

            <span>
              ${
                leagues.length === 1
                  ? 'liga fundet'
                  : 'ligaer fundet'
              }
            </span>
          </div>

          <div class="league-list">
            ${leagues
              .map(league => `
                <div class="league-item">
                  <span class="league-name">
                    ${esc(league.name)}
                  </span>

                  <span class="league-today">
                    ${league.periodMatches}
                    ${
                      league.periodMatches === 1
                        ? 'kamp'
                        : 'kampe'
                    }
                    i perioden
                  </span>

                  <small>
                    ${league.csvRows}
                    historiske kamprækker
                  </small>

                  ${leagueOddsStatus(league)}
                </div>
              `)
              .join('')}
          </div>
        </div>
      `
      : `
        <div class="empty">
          Ingen genkendte CSV-ligaer.
        </div>
      `;
  }

  const unknown = Array.isArray(
    data.unknownCsvFiles
  )
    ? data.unknownCsvFiles.length
    : 0;

  if (unknownElement) {
    unknownElement.textContent = unknown
      ? (
          `${unknown} CSV-` +
          `${
            unknown === 1
              ? 'fil kunne'
              : 'filer kunne'
          } ikke forbindes med en kendt liga.`
        )
      : '';
  }
}

/*
 * ------------------------------------------------------------
 * FILTRE
 * ------------------------------------------------------------
 */

function populateDateFilter() {
  const filter = $('#date-filter');

  if (!filter) {
    return;
  }

  const previousValue =
    filter.value || 'all';

  const dates = [
    ...new Set(
      [
        ...data.results,
        ...data.nearMisses
      ]
        .map(match => match.date)
        .filter(Boolean)
    )
  ].sort();

  filter.innerHTML = `
    <option value="all">
      Hele ugen
    </option>
  ` + dates
    .map(date => `
      <option value="${esc(date)}">
        ${
          new Date(
            `${date}T12:00:00`
          ).toLocaleDateString(
            'da-DK',
            {
              weekday: 'long',
              day: 'numeric',
              month: 'long'
            }
          )
        }
      </option>
    `)
    .join('');

  if (
    previousValue === 'all' ||
    dates.includes(previousValue)
  ) {
    filter.value = previousValue;
  }
}

function populateGradeFilter() {
  const filter = $('#grade-filter');

  if (!filter) {
    return;
  }

  const previousValue =
    filter.value || 'all';

  filter.innerHTML = `
    <option value="all">
      Alle gradueringer
    </option>

    <option value="elite">
      Elite 90+
    </option>

    <option value="strong">
      Stærk 80-89
    </option>

    <option value="interesting">
      Interessant 70-79
    </option>

    <option value="low">
      Under 70
    </option>
  `;

  if (
    [
      'all',
      'elite',
      'strong',
      'interesting',
      'low'
    ].includes(previousValue)
  ) {
    filter.value = previousValue;
  }
}

/*
 * ------------------------------------------------------------
 * RENDER KAMPE
 * ------------------------------------------------------------
 */

function renderMatches() {
  const listElement = $('#list');

  if (!listElement) {
    return;
  }

  const query = (
    $('#search')?.value ||
    ''
  )
    .trim()
    .toLowerCase();

  const status =
    $('#filter')?.value ||
    'approved';

  const selectedDate =
    $('#date-filter')?.value ||
    'all';

  const selectedGrade =
    $('#grade-filter')?.value ||
    'all';

  let matches;

  if (status === 'approved') {
    matches = data.results;
  } else if (status === 'rejected') {
    matches = data.nearMisses;
  } else {
    matches = [
      ...data.results,
      ...data.nearMisses
    ];
  }

  matches = [
    ...matches
  ]
    .filter(match =>
      (
        `${match.home || ''} ` +
        `${match.away || ''} ` +
        `${leagueName(match)}`
      )
        .toLowerCase()
        .includes(query)
    )
    .filter(match =>
      selectedDate === 'all' ||
      match.date === selectedDate
    )
    .filter(match =>
      selectedGrade === 'all' ||
      getScoreGrade(match.score).key ===
        selectedGrade
    )
    .sort(
      (matchA, matchB) =>
        number(matchB.score) -
        number(matchA.score)
    );

  listElement.innerHTML = matches.length
    ? matches
        .map(matchCard)
        .join('')
    : `
      <div class="empty">
        Ingen kampe i denne visning.
      </div>
    `;
}

/*
 * ------------------------------------------------------------
 * ADVARSLER
 * ------------------------------------------------------------
 */

function renderMessages() {
  const errorsElement = $('#errors');

  if (!errorsElement) {
    return;
  }

  const messages = [
    ...(data.warnings || []),
    ...(data.errors || [])
  ];

  errorsElement.innerHTML = messages.length
    ? `
      <h3>
        Dataadvarsler
      </h3>

      ${messages
        .map(message => `
          <p>
            ${esc(message)}
          </p>
        `)
        .join('')}
    `
    : '';
}

/*
 * ------------------------------------------------------------
 * OPDATER KPI-FELTER
 * ------------------------------------------------------------
 */

function setText(selector, value) {
  const element = $(selector);

  if (element) {
    element.textContent =
      String(value ?? '');
  }
}

function updateKpis(payload) {
  setText(
    '#total',
    number(payload.totalMatches)
  );

  setText(
    '#approved',
    data.results.length
  );

  setText(
    '#rejected',
    data.nearMisses.length
  );

  /*
   * Brug samlet requestforbrug, hvis det findes.
   * Ellers bruges API-Football-forbruget.
   */
  const totalRequests =
    number(payload.requestUsage?.used) +
    number(
      payload.dataSources?.odds?.requestsUsed
    );

  setText(
    '#requests',
    totalRequests
  );
}

/*
 * ------------------------------------------------------------
 * INDLÆS DATA
 * ------------------------------------------------------------
 */

async function load() {
  const button = $('#refresh');
  const metaElement = $('#meta');
  const listElement = $('#list');

  if (button) {
    button.disabled = true;
    button.textContent =
      '↻ Henter data...';
  }

  try {
    const response = await fetch(
      `data/results.json?v=${Date.now()}`,
      {
        cache: 'no-store'
      }
    );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const payload =
      await response.json();

    data = {
      results:
        Array.isArray(payload.results)
          ? payload.results
          : [],

      nearMisses:
        Array.isArray(payload.nearMisses)
          ? payload.nearMisses
          : [],

      foundLeagues:
        Array.isArray(payload.foundLeagues)
          ? payload.foundLeagues
          : [],

      unknownCsvFiles:
        Array.isArray(payload.unknownCsvFiles)
          ? payload.unknownCsvFiles
          : [],

      warnings:
        Array.isArray(payload.warnings)
          ? payload.warnings
          : [],

      errors:
        Array.isArray(payload.errors)
          ? payload.errors
          : []
    };

    updateKpis(payload);

    const from =
      payload.period?.from ||
      payload.date ||
      '-';

    const to =
      payload.period?.to ||
      payload.date ||
      '-';

    const updatedAt =
      payload.updatedAt
        ? new Date(payload.updatedAt)
        : null;

    const updatedAtText = (
      updatedAt &&
      !Number.isNaN(
        updatedAt.getTime()
      )
    )
      ? updatedAt.toLocaleString(
          'da-DK'
        )
      : 'ikke endnu';

    if (metaElement) {
      metaElement.textContent =
        `Kampe fra ${from} til ${to}` +
        ` · Opdateret ${updatedAtText}`;
    }

    renderLeagues();
    populateDateFilter();
    populateGradeFilter();
    renderMatches();
    renderMessages();
  } catch (error) {
    console.error(
      'BetScope kunne ikke indlæse dashboarddata:',
      error
    );

    if (metaElement) {
      metaElement.textContent =
        `Data kunne ikke hentes: ${error.message}`;
    }

    if (listElement) {
      listElement.innerHTML = `
        <div class="empty">
          Kontrollér docs/data/results.json.
        </div>
      `;
    }

    const leaguesElement = $('#leagues');

    if (leaguesElement) {
      leaguesElement.innerHTML = `
        <div class="empty">
          Ligaoversigten kunne ikke indlæses.
        </div>
      `;
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent =
        '↻ Genindlæs dashboard';
    }
  }
}

/*
 * ------------------------------------------------------------
 * EVENTS
 * ------------------------------------------------------------
 */

const refreshButton = $('#refresh');
const searchInput = $('#search');
const statusFilter = $('#filter');
const dateFilter = $('#date-filter');
const gradeFilter = $('#grade-filter');

if (refreshButton) {
  refreshButton.addEventListener(
    'click',
    load
  );
}

if (searchInput) {
  searchInput.addEventListener(
    'input',
    renderMatches
  );
}

if (statusFilter) {
  statusFilter.addEventListener(
    'change',
    renderMatches
  );
}

if (dateFilter) {
  dateFilter.addEventListener(
    'change',
    renderMatches
  );
}

if (gradeFilter) {
  gradeFilter.addEventListener(
    'change',
    renderMatches
  );
}

load();
