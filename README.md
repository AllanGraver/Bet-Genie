# BetScope CSV + API-Football

En gratis og vedligeholdelsesvenlig løsning, hvor manuelle FBref CSV-filer er historisk hukommelse, mens API-Football kun bruges strategisk til dagens fixtures, catch-up af afsluttede kampe og H2H for de bedste kandidater.

## 1. Upload CSV-filer
Læg CSV-filer i `data/leagues/`. Filnavnet skal indeholde et mønster fra `config/leagues.json`, fx:
- `allsvenskan.csv`
- `superliga_2025-2026.csv`
- `premier-league-current.csv`

Brug FBrefs **Scores & Fixtures**-tabel, ikke spillerstatistik. Følgende kolonner genkendes: `Date`, `Time`, `Home`, `Away`, `Score`. Det interne memory-format genkendes også.

## 2. Liga-godkendelse
CSV-filen matches mod `config/leagues.json`. Ukendte filer vises som advarsel i dashboardet. Kontroller altid API league ID og season i konfigurationen mod API-Football-dashboardet, især ved sæsonskifte.

## 3. API-nøgle
Opret en repository secret under Settings > Secrets and variables > Actions:
`API_FOOTBALL_KEY`

## 4. GitHub Pages
Vælg Settings > Pages > Source > GitHub Actions. Kør derefter Actions > Opdater BetScope CSV-dashboard > Run workflow.

## Requeststrategi
- 1 request: dagens fixtures for alle ligaer.
- 1 catch-up request pr. liga, der har en CSV-fil, for perioden fra i går til i dag. Afsluttede kampe upsertes i ligaens canonical CSV.
- H2H requests kun for top 15 efter lokal pre-score, og kun hvis CSV-hukommelsen har færre end 5 H2H-kampe.
- H2H caches i 30 dage.
- Internt hard limit: 85 requests.
- Ingen oddsrequests.

Ved 9 aktive ligaer og 15 helt nye H2H-opslag er normalrammen 25 requests: 1 + 9 + 15. Cache reducerer typisk antallet. Dette er et designbudget, ikke et løfte om API-forbrug.

## Vigtigt om automatisk CSV-hukommelse
Workflowet har `contents: write` og committer:
- opdaterede `data/leagues/*.csv`
- H2H-cache
- det genererede `docs/data/results.json`

Manuelle CSV-filer bliver dermed kombineret med API-Football-resultater. Samme kamp deduplikeres via fixture-ID eller dato + hold.

## Lokal test uden API
`npm test`

Sample-build:
`npm run build:sample`

## Centrale filer
- `config/settings.json`: kriterier, vægte, requestgrænser.
- `config/leagues.json`: filnavne, API league IDs og sæsoner.
- `src/csv.js`: CSV-genkendelse og memory-upsert.
- `src/apiFootball.js`: requestmanager.
- `src/analyse.js`: pre-score og fem kriterier.
- `src/run.js`: samlet pipeline.
- `docs/`: GitHub Pages-dashboard.
