# shopify-admin-client

Schlanker, **dependency-freier** Client für die **Shopify Admin GraphQL API** (Node 18+,
native `fetch`). Auth über **Client-Credentials-Grant** (Client ID + Secret → 24h-Token,
automatisch geholt & gecached), mit Retry bei Netzfehlern und Rate-Limit-Handling
(HTTP 429 + GraphQL-Cost-Throttling).

Generisch und wiederverwendbar — kennt keine projektspezifischen Stores. Enthält
keinerlei Geschäftsdaten oder Credentials.

## Installation

Direkt aus GitHub, tag-gepinnt (kein Registry nötig):

```jsonc
// package.json
"dependencies": {
  "shopify-admin-client": "github:ArmagnacDE/shopify-admin-client#v1.0.0"
}
```

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

## API

- `createShopifyClient({ store, clientId, clientSecret, version?, label? })` →
  `{ graphql, config }`
- `clientFromEnv(prefix, { version?, label? })` → wie oben, liest
  `${prefix}_STORE` / `${prefix}_CLIENT_ID` / `${prefix}_CLIENT_SECRET`.
- `SHOPIFY_API_VERSION` (env) setzt die Default-API-Version (sonst `2025-10`).

## Versionierung

Konsumenten pinnen auf einen Git-Tag (`#v1.0.0`). Verbesserungen fließen **immer**
hierher: Änderung → neuer Tag → Konsumenten heben die Version an. Keine lokalen Kopien
editieren.
