// Schlanker Shopify Admin GraphQL-Client (Factory) — ohne externe Abhaengigkeiten.
// Generisch & wiederverwendbar; kennt keine projektspezifischen Stores.
// Auth via Client-Credentials-Grant (Stand 2026): Client ID + Secret werden je Store
// gegen einen 24h-Access-Token getauscht.

const DEFAULT_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";

// fetch mit Wiederholung bei Netzwerkfehlern (Timeouts, DNS, Verbindungsabbrueche).
// Fuer unbeaufsichtigte Cron-Laeufe: kurze Netz-Wackler duerfen keinen Lauf killen.
async function fetchRetry(url, options, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt)); // 2s, 4s, 8s
    }
  }
}

/**
 * Erzeugt einen Shopify-Client fuer genau einen Store. Jeder Client haelt seinen
 * eigenen Token-Cache (Closure), sodass mehrere Stores unabhaengig voneinander laufen.
 *
 * @param {object} opts
 * @param {string} opts.store         myshopify-Domain, z. B. "shop.myshopify.com"
 * @param {string} opts.clientId      Client ID der Custom App
 * @param {string} opts.clientSecret  Client Secret der Custom App
 * @param {string} [opts.version]     API-Version (Default: SHOPIFY_API_VERSION | "2025-10")
 * @param {string} [opts.label]       Anzeigename fuer Fehlermeldungen
 * @returns {{ graphql: (query: string, variables?: object) => Promise<object>, config: object }}
 */
export function createShopifyClient({ store, clientId, clientSecret, version = DEFAULT_VERSION, label }) {
  const name = label || store || "Shopify";
  if (!store || !clientId || !clientSecret) {
    throw new Error(
      `Shopify-Client "${name}": store, clientId und clientSecret muessen gesetzt sein.`
    );
  }

  const GRAPHQL_ENDPOINT = `https://${store}/admin/api/${version}/graphql.json`;
  const TOKEN_ENDPOINT = `https://${store}/admin/oauth/access_token`;

  // In-Memory-Cache fuer den Access-Token (gilt 24h; wir erneuern mit Puffer).
  let cachedToken = null;
  let tokenExpiresAt = 0;

  async function getAccessToken() {
    const now = Date.now();
    if (cachedToken && now < tokenExpiresAt) return cachedToken;

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    });

    const res = await fetchRetry(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `[${name}] Token-Tausch fehlgeschlagen (HTTP ${res.status}): ${text}\n` +
          "Pruefe Client ID/Secret und ob die App im Store installiert ist."
      );
    }

    const json = await res.json();
    cachedToken = json.access_token;
    // expires_in ist ~86399s; 5 Min. Puffer abziehen.
    tokenExpiresAt = now + (json.expires_in - 300) * 1000;
    return cachedToken;
  }

  /**
   * Fuehrt eine GraphQL-Abfrage gegen die Shopify Admin API dieses Stores aus.
   * @returns {Promise<object>} data-Feld der Antwort
   */
  async function graphql(query, variables = {}) {
    const token = await getAccessToken();
    const MAX_RETRIES = 5;

    for (let attempt = 0; ; attempt++) {
      const res = await fetchRetry(GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables }),
      });

      // Rate-Limit auf HTTP-Ebene: warten und erneut versuchen.
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const wait = (parseFloat(res.headers.get("Retry-After")) || 2) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`[${name}] HTTP ${res.status} ${res.statusText}: ${text}`);
      }

      const json = await res.json();
      if (json.errors) {
        // GraphQL-Cost-Throttling: aus den Cost-Infos die Wartezeit ableiten.
        const throttled = json.errors.every((e) => e.extensions?.code === "THROTTLED");
        if (throttled && attempt < MAX_RETRIES) {
          const cost = json.extensions?.cost;
          const waitMs = cost
            ? Math.ceil(
                ((cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable) /
                  cost.throttleStatus.restoreRate) * 1000
              ) + 250
            : 2000;
          await new Promise((r) => setTimeout(r, Math.max(waitMs, 500)));
          continue;
        }
        throw new Error(`[${name}] GraphQL-Fehler: ` + JSON.stringify(json.errors, null, 2));
      }
      return json.data;
    }
  }

  return { graphql, config: { store, version, endpoint: GRAPHQL_ENDPOINT, label: name } };
}

/**
 * Bequemer Helfer: liest store/clientId/clientSecret aus Umgebungsvariablen mit
 * gegebenem Praefix — `${prefix}_STORE`, `${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`.
 * Beispiel: clientFromEnv("SHOPIFY_B2C") nutzt SHOPIFY_B2C_STORE usw.
 *
 * @param {string} prefix
 * @param {{ version?: string, label?: string }} [opts]
 */
export function clientFromEnv(prefix, { version, label } = {}) {
  return createShopifyClient({
    store: process.env[`${prefix}_STORE`],
    clientId: process.env[`${prefix}_CLIENT_ID`],
    clientSecret: process.env[`${prefix}_CLIENT_SECRET`],
    version,
    label: label || prefix,
  });
}
