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
Ziel-Host verschieben; eine vertauschte `.env` scheitert am Token-Tausch (401), bevor
irgendein Request mit Seiteneffekt läuft.

```js
import { createStoreRegistry } from "shopify-admin-client/registry";
import { createJsonlAudit } from "shopify-admin-client"; // ab S2

const registry = createStoreRegistry({
  stores: {
    b2c: { expectedDomain: "b2c.myshopify.com", envPrefix: "WAGEMUT_B2C", version: "2026-04", label: "B2C" },
    b2b: { expectedDomain: "b2b.myshopify.com", envPrefix: "WAGEMUT_B2B", version: "2026-04", label: "B2B" },
  },
  auditForStore: (name, cfg) => createJsonlAudit({ directory: `logs/${name}` }),
  // env: process.env (Default); fetch?: injizierbar (Tests) — bis in den Transport, zur Aufrufzeit aufgelöst
});

const b2c = registry.get("b2c");           // Handle, memoisiert je Name + Registry-Instanz
const data = await b2c.graphql(`query { shop { name } }`);
await b2c.verifyIdentity();                 // Live-Prüfung shop.myshopifyDomain gegen expectedDomain
```

- **Lazy:** Struktur (Namen, Domains, Präfixe, `version`) wird **beim Bau** geprüft
  (unbekannte Namen / doppelte Domains oder Präfixe / fehlende `version` werfen sofort);
  Credentials werden erst bei `get(name)` gelesen (fehlend → klarer `Error`, **kein Netz**);
  Token-Tausch erst beim ersten `graphql`.
- **`version` ist Pflicht je Store** — eine Code-Konstante wie die Domain. Ohne Pin fiele
  die API-Version still auf den Client-Default zurück.
- **`get(name)` ist memoisiert** (ein Handle je Name und Registry-Instanz); ein
  gescheitertes `get` (fehlende Credentials) wird **nicht** gecacht.

> **Hinweis (S1):** In dieser Version ist `handle.graphql` noch der rohe Transport. Der
> Mutation-Guard (Writes vor dem ersten Send geguardet, `declareMutations`, Audit über
> `auditForStore`) kommt in S2 unter demselben Tag **v1.2.0** — es wird kein
> ungeguardeter Zwischenstand getaggt/veröffentlicht.

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
  dem Subpath `shopify-admin-client/registry`).
- `isMutation(query)` → `boolean` (Hilfsfunktion, exportiert).
- `MutationGuardError` — Fehlerklasse (Codes u. a. `identitaet`, `store`; Präfix
  `[mutation-guard:<code>]`).
- `SHOPIFY_API_VERSION` (env) setzt die Default-API-Version von `createShopifyClient`
  (sonst `2025-10`). **Registry-Handles ignorieren das** — dort ist `version` je Store Pflicht.

**Subpaths:** `.` (Wurzel oben), `./registry` (`createStoreRegistry`).

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
