/* BetScope uge-dashboard med scoregraduering */

const $ = selector =>
  documen*.querySelector(selector);

const n*mber = value =>
  Number.isFinite(*umber(value))
    ? Number(value)
*   : 0;

const fixed = (value, dig*ts = 2) =>
  number(value).toFixed*digits);

const pct = value =>
  `*{Math.round(number(value) * 100)}%*;

const esc = value =>
  String(v*lue ?? '').replace(
    /[&<>"']/g*
    character => ({
      '&': '&*mp;',
      '<': '&lt;',
      '>'* '&gt;',
      '"': '&quot;',
    * "'": '&#039;'
    })[character]
 *);

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

function getScoreGrade(scoreVal*e) {
  const score = number(scoreV*lue);

  if (score >= 90) {
    re*urn {
      key: 'elite',
      la*el: 'Elite',
      range: '90+',
 *    description:
        'Meget st*rk statistisk profil'
    };
  }

* if (score >= 80) {
    return {
 *    key: 'strong',
      label: 'S*ærk',
      range: '80-89',
      description:
        'Stærk statistisk profil'
    };
  }

  if (score >= 70) {
    return {
      key: 'interesting',
      label: 'Interessant',
      range: '70-79',
      description:
        'Interessant statistisk profil'
    };
  }

  return {
    key: 'low',
    label: 'Under 70',
    range: '0-69',
    description:
      'Lavere samlet statistisk vurdering'
  };
}

/*
 * ------------------------------------------------------------
 * KAMPDATA
 * ------------------------------------------------------------
 */

const leagueName = match =>*  match.leagueName ||
  match.leag*e ||
  'Liga ukendt';

function ki*koff(match) {
  if (match.time) {
*   return match.time;
  }

  const*date = match.kickoff
    ? new Dat*(match.kickoff)
    : null;

  if *
    date &&
    !Number.isNaN(dat*.getTime())
  ) {
    return date.*oLocaleTimeString(
      'da-DK',
*     {
        hour: '2-digit',
  *     minute: '2-digit'
      }
   *);
  }

  return (
    match.kicko*f ||
    'Tid ukendt'
  );
}

func*ion passedCriterion(match, index) *
  const criterion =
    Array.isA*ray(match.criteria)
      ? match.*riteria[index]
      : false;

  r*turn (
    criterion &&
    typeof*criterion === 'object'
  )
    ? B*olean(criterion.passed)
    : Bool*an(criterion);
}

function require*ent(match, index) {
  const criter*on =
    Array.isArray(match.crite*ia)
      ? match.criteria[index]
*     : null;

  if (
    criterion*&&
    typeof criterion === 'objec*' &&
    criterion.required
  ) {
*   return criterion.required;
  }
*  return [
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

function historyRows(matche* = []) {
  if (
    !Array.isArray*matches) ||
    !matches.length
  * {
    return `
      <li class="h*story-empty">
        Ingen histor*ske kampe tilgængelige
      </li>*    `;
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
            ${esc(match.homeScore ?? '-')}-${esc(match.awayScore ?? '-')}
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
  return `
    <span class="score-grade score-grade-${esc(grade.key)}">
      <i aria-hidden="true">●</i>
      ${esc(grade.label)}${
        includeRange
          ? ` ${esc(grade.range)}`
          : ''
      }
    </span>
  `;
}

/*
 * ------------------------------------------------------------
 * ODDS OG FALLBACK-LINK
 * ------------------------------------------------------------
 */

function safeHttpsUrl(value) {
* try {
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
   * Odds fundet gennem TheRundown.
   */
  if (
    oddsStatus === '*vailable' &&
    odds.available ==* true &&
    Number.isFinite(decim*lOdds) &&
    decimalOdds > 1
  ) *
    const formattedOdds = decimal*dds
      .toFixed(2)
      .repla*e('.', ',');

    const checkedAt * odds.checkedAt
      ? new Date(o*ds.checkedAt)
      : null;

    c*nst checkedAtText = (
      checke*At &&
      !Number.isNaN(checkedA*.getTime())
    )
      ? checkedA*.toLocaleString(
          'da-DK'*
          {
            dateStyle* 'short',
            timeStyle: '*hort'
          }
        )
      * null;

    return `
      <sectio*
        class="odds-panel odds-av*ilable"
        aria-label="Unibet*odds"
      >
        <div class="*dds-panel-copy">
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
   * Odds mangler, men et fallback-link findes.
   */
  const fallbackUrl = safeHttpsUrl(
    match?.fallbackOddsUrl ||
    match?.oddsConfiguration?.fallbackUrl ||
    odds.fallbackUrl
  );

  if (fallbackUrl) {
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
            ${esc(fallbackUrl)}${esc(fallbackUrl)}</a>)
          </p>
        </div>
      </section>
    `;
  }

  /*
   * Ingen odds og intet gyldigt fallback-link.
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
                const ok =
                  passedCriterion(
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

    league.csvRows += number(
      item.csvRows
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

  if (
    odds.rundownSupported === true
  ) {
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
}

function populateGradeFilter() {
  const filter = $('#grade-filter');

  if (!filter) {
    return;
  }

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
        `${match.home} ` +
        `${match.away} ` +
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

    const totalElement = $('#total');
    const approvedElement = $('#approved');
    const rejectedElement = $('#rejected');
    const requestsElement = $('#requests');

    if (totalElement) {
      totalElement.textContent =
        number(payload.totalMatches);
    }

    if (approvedElement) {
      approvedElement.textContent =
        data.results.length;
    }

    if (rejectedElement) {
      rejectedElement.textContent =
        data.nearMisses.length;
    }

    if (requestsElement) {
      requestsElement.textContent =
        number(
          payload.requestUsage?.used
        );
    }

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

if ($('#refresh')) {
  $('#refresh').onclick = load;
}

if ($('#search')) {
  $('#search').oninput =
    renderMatches;
}

if ($('#filter')) {
  $('#filter').onchange =
    renderMatches;
}

if ($('#date-filter')) {
  $('#date-filter').onchange =
    renderMatches;
}

if ($('#grade-filter')) {
  $('#grade-filter').onchange =
    renderMatches;
}

load();
