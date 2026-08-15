# shopify-admin-client

Schlanker, **dependency-freier** Client für die **Shopify Admin GraphQL API** (Node 18+,
native `fetch`). Auth über **Client-Credentials-Grant** (Client ID + Secret → 24h-Token,
automatisch geholt & gecached), mit Timeout, Retry bei Netzfehlern und Rate-Limit-Handling
(HTTP 429 + GraphQL-Cost-Throttling).

Generisch und wiederverwendbar — kennt keine projektspezifischen Stores. Enthält
keinerlei Geschäftsdaten oder Credentials.

## Installation

Direkt aus GitHub, tag-gepinnt (kein Registry nötig):

```jsonc
// package.json
"dependencies": {
  "shopify-admin-client": "github:ArmagnacDE/shopify-admin-client#v1.2.0"
}
```

> **Integrität:** Git-Tags sind verschiebbar. Committe das `package-lock.json` (es pinnt
> den Commit-SHA) und installiere in CI/Deploy mit **`npm ci`**, nicht `npm install` —
> sonst könnte ein verschobener Tag fremden Code in deine Container mit den Store-Secrets
> ziehen.

## Nutzung

```js
import { createShopifyClient, clientFromEnv } from "shopify-admin-client";

// a) explizit
const shop = createShopifyClient({
  store: "shop.myshopify.com",
  clientId: process.env.SHOPIFY_CLIENT_ID,
  clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
  label: "shop",
});
const data = await shop.graphql(`query { shop { name currencyCode } }`);

// b) aus Umgebungsvariablen mit Praefix — ⚠️ UNGEGUARDET, s. u.
//    -> liest SHOPIFY_B2C_STORE / _CLIENT_ID / _CLIENT_SECRET
const b2c = clientFromEnv("SHOPIFY_B2C", { label: "B2C" });
```

Jeder Client hält seinen **eigenen** Token-Cache — mehrere Stores laufen unabhängig.
`client.graphql(query, variables)` gibt das `data`-Feld der Antwort zurück.

## Multi-Store: Registry (`shopify-admin-client/registry`)

Für Repos, die **mehrere Stores** anbinden (oder den Ziel-Store hart als Code-Konstante
festnageln wollen), bindet die **Store-Registry** Namen an Handles. Der Endpoint jedes
Stores ist eine **Code-Konstante** (`expectedDomain`), die zugleich API-Host **und**
Allowlist ist. Aus der Umgebung liest die Registry **nur** `<PREFIX>_CLIENT_ID` und
`<PREFIX>_CLIENT_SECRET` — **kein `<PREFIX>_STORE`**. Damit kann kein Env-Wert den
Ziel-Host verschieben: Der Write geht **immer** an die Code-Konstante. Sind je Shop
**eigene** Custom Apps installiert (der Normalfall), scheitert eine vertauschte `.env`
schon am Token-Tausch (401), bevor irgendein Request mit Seiteneffekt läuft. Ist
**dieselbe** App in mehreren Shops installiert, gelingt der Token-Tausch auch mit den
Credentials des anderen Shops — der Request landet trotzdem am richtigen Host, aber
mit den Rechten der anderen Installation. Getrennte Apps je Shop sind deshalb Teil des
Sicherheitsmodells, nicht nur Ordnung.

```js
import { createStoreRegistry } from "shopify-admin-client/registry";
import { createJsonlAudit } from "shopify-admin-client";

const registry = createStoreRegistry({
  stores: {
    b2c: { expectedDomain: "b2c.myshopify.com", envPrefix: "WAGEMUT_B2C", version: "2026-04", label: "B2C" },
    b2b: { expectedDomain: "b2b.myshopify.com", envPrefix: "WAGEMUT_B2B", version: "2026-04", label: "B2B" },
  },
  auditForStore: (name, cfg) => createJsonlAudit({ directory: `logs/${name}` }),
  // env: process.env (Default); fetch?: injizierbar (Tests) — bis in den Transport, zur Aufrufzeit aufgelöst
});

const b2c = registry.get("b2c");            // Handle, memoisiert je Name + Registry-Instanz
b2c.declareMutations({ felder: ["productUpdate"], budget: 20, grund: "Preis-Sync" });
const data = await b2c.graphql(`query { shop { name } }`);   // Read: direkt, ungeguardet
await b2c.graphql(mutation, vars);          // Write: Guard prüft Form → Identität → Bulk → Deny → Budget
```

**Store-Handle** (`registry.get(name)`): `{ graphql, declareMutations, isDeclared,
verifyIdentity, config, state }`. `graphql` ist der **geguardete** Aufruf (Reads direkt,
Writes vor dem ersten Send geprüft); `config = { store, version, endpoint, label }`.

- **Lazy:** Struktur (Namen, Domains, Präfixe, `version`) wird **beim Bau** geprüft
  (unbekannte Namen / doppelte Domains oder Präfixe / fehlende oder ungültige `version`
  werfen sofort); Credentials werden erst bei `get(name)` gelesen (fehlend → klarer
  `Error`, **kein Netz**); Token-Tausch erst beim ersten `graphql`. Die validierten Werte
  liegen in einem **eingefrorenen Snapshot** — spätere Änderungen am übergebenen
  `stores`-Objekt (Präfix umbiegen, Store nachschieben) haben keine Wirkung.
- **`version` ist Pflicht je Store** — eine Code-Konstante wie die Domain. Ohne Pin fiele
  die API-Version still auf den Client-Default zurück.
- **`get(name)` ist memoisiert** (ein Handle je Name und Registry-Instanz); ein
  gescheitertes `get` (fehlende Credentials) wird **nicht** gecacht. `auditForStore` wird
  genau **einmal je Name** aufgerufen.
- **Instanzbasiert:** Deklaration, Budget und Identitäts-Cache hängen je Store-Handle — ein
  Prozess kann B2C und B2B unabhängig berühren, ohne dass ihre Guards sich vermischen.

## Mutation-Guard & Audit (`shopify-admin-client/guard`)

Der Registry-Handle legt je Store einen **Default-Deny-Guard** vor den Transport. Kein
Write ohne vorherige Code-Deklaration; der Guard entscheidet nicht, was „gut" ist, er
erzwingt, dass die Absicht als exaktes Token im Code steht, BEVOR etwas wirkt.

- **Deklaration:** `declareMutations({ felder, budget, grund })` — einmal pro Instanz, vor
  dem ersten Write. Fehlt sie / ist das Feld nicht deklariert / ist das Budget erschöpft →
  `MutationGuardError` (`deny` / `budget`), **nichts gesendet**.
- **Prüfreihenfolge je Write:** Form (kanonisch: mutation-first, genau ein Root-Feld) →
  Identität (`verifyShopIdentity`, einmal je Instanz gecacht) → Bulk
  (`bulkOperationRunMutation` gesperrt) → Deny → Budget. Reads laufen unberührt durch.
- **Audit-Vertrag** (`createJsonlAudit` oder eigene Implementierung): `declared`, `attempt`,
  `result`, `rejected` — alle **synchron**; `location()` = aktuelle Monatsdatei. `attempt`
  läuft VOR dem Send und **wirft** bei Schreibfehler (fail-closed → `MutationGuardError('log')`,
  kein Budget verbraucht); `declared/result/rejected` warnen selbst und werfen nie (nach
  erfolgreichem Send darf kein Audit-Fehler als „Write gescheitert" beim Aufrufer landen —
  Dubletten-Schutz). Jeder Eintrag trägt `store: expectedDomain`. **Synchron ist
  Vertragspflicht, keine Empfehlung:** gibt `attempt` eine Promise zurück, lehnt der Guard
  den Write mit `MutationGuardError('log')` ab (fail-closed — ein async-`attempt` hätte
  beim Send noch nichts geschrieben); Promises aus `declared/result/rejected` werden
  entschärft, damit keine unhandledRejection den Prozess nach einem erfolgreichen Send
  mit Exit 1 beendet.
- **Datenschutz:** `createJsonlAudit({ directory, transformVariables? })` — der
  Datenschutz-Transform ist lokale Firmen-Entscheidung und sieht **nur** `variablen` — als
  **tiefe Kopie** (`structuredClone`), ein in-place redigierender Transform verändert also
  nie den echten Write; die Feldkürzung (800 Zeichen, Tiefenlimit) darüber ist Default und
  läuft NACH dem Transform. Das Log bleibt lokal und gitignored.

```js
import { createMutationGuard, extrahiereRootFeld, istSchreibDokument, validateDeclaration } from "shopify-admin-client/guard";
// createMutationGuard({ graphql, expectedDomain, audit, id? }) — die Registry ruft das für dich.
```

## Boundary-Scan (`scanClientBoundary`)

Der generische Teil des Firmen-Meta-Tests: hält ein Repo an der Anbindungs-Grenze.

```js
import { scanClientBoundary } from "shopify-admin-client";
const befunde = scanClientBoundary({
  rootDirs: ["lib", "scripts"],
  allowClientIn: ["lib/shopify.js"],   // nur hier darf der Client importiert werden
  ignore: ["scripts/spike"],            // Pfad-Segmente überspringen (nicht scripts/spike-x.js)
});                                      // [] = sauber; sonst { file, line, rule, detail }
```

Meldet: Import von `shopify-admin-client` (statisch **und** dynamisch, alle Subpaths)
außerhalb `allowClientIn`; Roh-`fetch` mit statisch sichtbarem `myshopify.com`-Ziel
(auch `fetch?.(…)`, `globalThis.fetch(…)`, `fetch(new URL("/…", "https://x.myshopify.com"))`);
Nutzung von `clientFromEnv`. Ein nicht lesbares `rootDir` (Tippfehler, Rechte) **wirft**,
statt still `[]` zu liefern — ein Meta-Test darf nicht aus Versehen grün sein. Der Scan ist
ein Stolperdraht gegen versehentliches Vorbeischreiben, keine Sicherheitsgrenze (die ist die
Credential-Trennung): aus Variablen zusammengesetzte Ziele erkennt er nicht.

## Identitätsprüfung (`verifyShopIdentity`)

```js
import { verifyShopIdentity } from "shopify-admin-client";
const domain = await verifyShopIdentity(shop.graphql, { expectedDomain: "shop.myshopify.com" });
```

Fragt live `shop.myshopifyDomain` ab und vergleicht **case-insensitiv** gegen
`expectedDomain`; die Rückgabe ist die API-Antwort **roh** (Groß/Klein erhalten). Wirft
`MutationGuardError` mit Code `identitaet` (Antwort fehlt/leer oder Reader wirft) bzw.
`store` (falscher Shop). Ohne eigenen Cache — der Aufrufer (Registry-Handle bzw. Guard)
hält die gecachte Single-Flight-Promise.

> ⚠️ **`clientFromEnv` ist UNGEGUARDET:** Es liest `<PREFIX>_STORE` aus der Umgebung — der
> Endpoint ist damit ein Env-Wert, keine Code-Konstante. **Nicht für Firmen-Repos**
> (armagnac, Wagemut) verwenden; dort ist die Registry mit `expectedDomain` der Weg.
> `clientFromEnv` bleibt nur für Standalone-/Ad-hoc-Nutzung im Paket.

## Sicherheit & Robustheit

- **Store-Validierung:** `store` muss `<shop>.myshopify.com` sein. Pfade, Ports, `@`
  oder andere Hosts werden abgelehnt — verhindert, dass Client-Secret/Access-Token an
  einen fremden Host gelangen (SSRF/Exfiltration). `version` muss `JJJJ-MM` oder
  `unstable` sein.
- **Request-Timeout:** je Request (Default 30 s, `timeoutMs` konfigurierbar) — kein
  unbegrenztes Hängen in unbeaufsichtigten Cron-Läufen.
- **Kein Secret-/Token-Leak:** Access-Token wird nie geloggt; Credentials stehen nur im
  POST-Body, nie in URLs. Fremde Fehler-Bodies werden gekürzt übernommen.
- **Retry-Semantik & Dubletten-Schutz:** Netz-Retry (bei _geworfenen_ Fehlern) ist für
  **Reads standardmäßig an, für Mutations aus** — sonst könnte ein nach dem Senden
  verlorener Response einen doppelten Schreibvorgang auslösen. 429/THROTTLED werden für
  beide wiederholt (der Request wurde serverseitig nicht ausgeführt). Override je Aufruf:

  ```js
  await shop.graphql(mutation, vars, { retryNetwork: true });  // erzwingt Retry
  await shop.graphql(query, vars, { retryNetwork: false });    // verbietet Retry
  ```

- **Rate-Limit-Backoff** ist gedeckelt (max 60 s); eine grundsätzlich zu teure Query
  (`requestedQueryCost > maximumAvailable`) wirft sofort statt sinnlos zu warten.
- **Single-Flight-Token:** parallele Calls bei kaltem Cache lösen nur _einen_
  Token-Tausch aus.

> ⚠️ **`userErrors` prüfen:** Shopify meldet _fachliche_ Mutation-Fehler in
> `data.<feld>.userErrors`, **nicht** in `errors`. Der Client gibt `data` unverändert
> zurück — der Aufrufer muss `userErrors` selbst prüfen, sonst läuft ein Skript
> „erfolgreich" durch, obwohl nichts angelegt wurde.

## API

**Wurzel (`shopify-admin-client`):**

- `createShopifyClient({ store, clientId, clientSecret, version?, label?, timeoutMs?, fetch? })` →
  `{ graphql, config }`. `fetch?` ist injizierbar und wird **zur Aufrufzeit** aufgelöst
  (ohne Wert je Request das aktuelle `globalThis.fetch`, kein beim Bau eingefrorener Verweis).
- `graphql(query, variables?, { retryNetwork? })` → `data`-Feld der Antwort.
- `clientFromEnv(prefix, { version?, label?, timeoutMs?, fetch? })` → wie oben, liest
  `${prefix}_STORE` / `${prefix}_CLIENT_ID` / `${prefix}_CLIENT_SECRET`. **UNGEGUARDET** (s. o.).
- `verifyShopIdentity(graphql, { expectedDomain })` → `Promise<domain>` (roh; wirft
  `MutationGuardError` `identitaet` | `store`).
- `createStoreRegistry({ stores, env?, auditForStore, fetch? })` → `{ get(name) }` (auch unter
  dem Subpath `shopify-admin-client/registry`). Handle: `{ graphql, declareMutations,
  isDeclared, verifyIdentity, config, state }`.
- `createJsonlAudit({ directory, transformVariables?, warn?, now?, pid?, append?, mkdir? })` →
  `{ declared, attempt, result, rejected, location }` (Audit-Vertrag; alle synchron).
- `scanClientBoundary({ rootDirs, allowClientIn?, ignore?, forbidRawFetch?, forbidClientFromEnv? })` →
  Befunde `[{ file, line, rule, detail }]` (leer = sauber).
- `isMutation(query)` → `boolean` (Hilfsfunktion, exportiert).
- `MutationGuardError` — Fehlerklasse (Codes `declare | form | bulk | deny | budget | log |
  identitaet | store | init`; Präfix `[mutation-guard:<code>]`).
- `SHOPIFY_API_VERSION` (env) setzt die Default-API-Version von `createShopifyClient`
  (sonst `2025-10`). **Registry-Handles ignorieren das** — dort ist `version` je Store Pflicht.

**`shopify-admin-client/guard`:** `createMutationGuard({ graphql, expectedDomain, audit, id? })`
→ `{ graphql, declareMutations, isDeclared, verifyIdentity, state }`; dazu die Lexer/Form-Helfer
`istSchreibDokument`, `extrahiereRootFeld`, `ohneStringsUndKommentare`, `validateDeclaration`
und `MutationGuardError`.

**Subpaths:** `.` (Wurzel oben), `./registry` (`createStoreRegistry`), `./guard`
(`createMutationGuard` + Lexer).

## Tests

```bash
npm test           # node --test, ohne externe Deps, ohne Netz (fetch gestubt)
npm run test:install   # npm pack -> Tarball in leerem Verzeichnis installieren -> Root + Subpaths importieren
```

`test:install` prüft das **gepackte** Paket (genau die `files`) vor dem Tag — so fällt ein
vergessener `files`/`exports`-Eintrag auf, bevor der Tag unveränderlich veröffentlicht ist.
Nach dem Tag-Push denselben Import gegen `github:…#vX.Y.Z` als Smoke-Test laufen lassen
(Release-Checkliste, **nicht** Teil von `npm test`).

## Versionierung

Konsumenten pinnen auf einen Git-Tag (`#v1.2.0`). Verbesserungen fließen **immer**
hierher: Änderung → neuer Tag → Konsumenten heben die Version an. Keine lokalen Kopien
editieren.
