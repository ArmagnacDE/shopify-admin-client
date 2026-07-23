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
  "shopify-admin-client": "github:ArmagnacDE/shopify-admin-client#v1.1.0"
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

// b) aus Umgebungsvariablen mit Praefix
//    -> liest SHOPIFY_B2C_STORE / _CLIENT_ID / _CLIENT_SECRET
const b2c = clientFromEnv("SHOPIFY_B2C", { label: "B2C" });
```

Jeder Client hält seinen **eigenen** Token-Cache — mehrere Stores laufen unabhängig.
`client.graphql(query, variables)` gibt das `data`-Feld der Antwort zurück.

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

- `createShopifyClient({ store, clientId, clientSecret, version?, label?, timeoutMs? })` →
  `{ graphql, config }`
- `graphql(query, variables?, { retryNetwork? })` → `data`-Feld der Antwort.
- `clientFromEnv(prefix, { version?, label?, timeoutMs? })` → wie oben, liest
  `${prefix}_STORE` / `${prefix}_CLIENT_ID` / `${prefix}_CLIENT_SECRET`.
- `isMutation(query)` → `boolean` (Hilfsfunktion, exportiert).
- `SHOPIFY_API_VERSION` (env) setzt die Default-API-Version (sonst `2025-10`).

## Tests

```bash
npm test   # node --test, ohne externe Deps, ohne Netz (fetch gestubt)
```

## Versionierung

Konsumenten pinnen auf einen Git-Tag (`#v1.1.0`). Verbesserungen fließen **immer**
hierher: Änderung → neuer Tag → Konsumenten heben die Version an. Keine lokalen Kopien
editieren.
