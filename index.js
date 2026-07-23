// Schlanker Shopify Admin GraphQL-Client (Factory) — ohne externe Abhaengigkeiten.
// Generisch & wiederverwendbar; kennt keine projektspezifischen Stores.
// Auth via Client-Credentials-Grant (Stand 2026): Client ID + Secret werden je Store
// gegen einen 24h-Access-Token getauscht.

const DEFAULT_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";
const DEFAULT_TIMEOUT_MS = 30_000; // je Request; verhindert unbegrenzt haengende Laeufe
const MAX_BACKOFF_MS = 60_000;     // Obergrenze fuer server-gesteuerte Wartezeiten

// Erlaubte Store-Domain: <handle>.myshopify.com. Ohne diese Pruefung koennte ein
// manipulierter store-Wert (z. B. "evil.com", "shop.myshopify.com@evil.com",
// "shop.myshopify.com/x#") Client-Secret UND Access-Token an einen fremden Host lenken.
const STORE_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
// Erlaubte API-Version: JJJJ-MM oder "unstable" (kein beliebiges Pfadsegment).
const VERSION_RE = /^(\d{4}-\d{2}|unstable)$/;

// Steuerzeichen/Zeilenumbrueche aus frei gesetzten Bezeichnern entfernen (Log-Injection)
// und Laenge begrenzen — diese Werte landen in Fehlermeldungen/Logs.
function sanitizeLabel(s, max = 80) {
  return String(s).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

// Fremde Response-Bodies gekuerzt in Fehlermeldungen aufnehmen (Log-Bloat begrenzen;
// bei einem per Fehlkonfiguration erreichten Fremd-Host nicht unbegrenzt uebernehmen).
function truncate(text, max = 2000) {
  const s = String(text);
  return s.length > max
    ? s.slice(0, max) + `… [${s.length - max} weitere Zeichen abgeschnitten]`
    : s;
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Ist die GraphQL-Operation eine Mutation? Fuehrende Whitespaces + #-Kommentare
// ueberspringen, dann auf das Schluesselwort pruefen. Mutations duerfen bei einem nach
// dem Senden verlorenen Response NICHT blind wiederholt werden (Dubletten-Gefahr).
export function isMutation(query) {
  const stripped = String(query).replace(/^\s*(?:#[^\n]*\n\s*)*/, "");
  return /^mutation\b/.test(stripped);
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
 * @param {number} [opts.timeoutMs]   Timeout je Request in ms (Default 30000)
 * @param {(ms:number)=>Promise<void>} [opts.sleep]  Intern/Tests: Backoff-Sleep injizierbar
 * @returns {{ graphql: (query: string, variables?: object, opts?: {retryNetwork?: boolean}) => Promise<object>, config: object }}
 */
export function createShopifyClient({
  store,
  clientId,
  clientSecret,
  version = DEFAULT_VERSION,
  label,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sleep = defaultSleep,
}) {
  const name = sanitizeLabel(label || store || "Shopify");
  if (!store || !clientId || !clientSecret) {
    throw new Error(
      `Shopify-Client "${name}": store, clientId und clientSecret muessen gesetzt sein.`
    );
  }
  if (!STORE_RE.test(store)) {
    throw new Error(
      `Shopify-Client "${name}": ungueltige store-Domain "${sanitizeLabel(store)}". ` +
        "Erwartet <shop>.myshopify.com (kein Pfad, Port, @ oder anderer Host)."
    );
  }
  if (!VERSION_RE.test(version)) {
    throw new Error(
      `Shopify-Client "${name}": ungueltige API-Version "${sanitizeLabel(version)}". ` +
        'Erwartet JJJJ-MM oder "unstable".'
    );
  }

  const GRAPHQL_ENDPOINT = `https://${store}/admin/api/${version}/graphql.json`;
  const TOKEN_ENDPOINT = `https://${store}/admin/oauth/access_token`;

  // fetch mit Timeout je Versuch + Retry NUR bei *geworfenen* Netzfehlern.
  // `retries` = 0 schaltet den Netz-Retry ab (Mutations), damit ein nach dem Senden
  // verlorener Response nicht zu einem doppelten Schreibvorgang fuehrt.
  async function fetchWithTimeoutRetry(url, options, retries) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        if (attempt >= retries) throw err;
        await sleep(Math.min(2000 * 2 ** attempt, MAX_BACKOFF_MS)); // 2s, 4s, 8s (gecappt)
      }
    }
  }

  // In-Memory-Cache fuer den Access-Token (gilt 24h; wir erneuern mit Puffer).
  let cachedToken = null;
  let tokenExpiresAt = 0;
  let inFlightToken = null; // Single-Flight: parallele Calls teilen einen Token-Tausch.

  async function requestToken() {
    const now = Date.now();
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    });

    // Token-Tausch ist idempotent -> Netz-Retry erlaubt.
    const res = await fetchWithTimeoutRetry(
      TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
      3
    );

    if (!res.ok) {
      const text = truncate(await res.text());
      throw new Error(
        `[${name}] Token-Tausch fehlgeschlagen (HTTP ${res.status}): ${text}\n` +
          "Pruefe Client ID/Secret und ob die App im Store installiert ist."
      );
    }

    const json = await res.json();
    if (!json || typeof json.access_token !== "string" || !json.access_token) {
      throw new Error(`[${name}] Token-Antwort ohne gueltiges access_token.`);
    }
    const expiresIn = Number(json.expires_in);
    const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
    cachedToken = json.access_token;
    tokenExpiresAt = now + (ttl - 300) * 1000; // 5 Min. Puffer
    return cachedToken;
  }

  async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
    // Laufenden Token-Tausch teilen, statt bei Parallellast mehrere anzustossen.
    if (inFlightToken) return inFlightToken;
    inFlightToken = requestToken().finally(() => {
      inFlightToken = null;
    });
    return inFlightToken;
  }

  /**
   * Fuehrt eine GraphQL-Abfrage gegen die Shopify Admin API dieses Stores aus.
   * @param {string} query
   * @param {object} [variables]
   * @param {{retryNetwork?: boolean}} [opts]  retryNetwork erzwingt/verbietet den
   *        Netz-Retry. Default: Reads = an, Mutations = aus (Dubletten-Schutz).
   * @returns {Promise<object>} data-Feld der Antwort
   */
  async function graphql(query, variables = {}, { retryNetwork } = {}) {
    const token = await getAccessToken();
    const MAX_RETRIES = 5;
    // Netz-Retry: fuer Reads erlaubt, fuer Mutations nur bei explizitem Opt-in.
    const networkRetries = (retryNetwork ?? !isMutation(query)) ? 3 : 0;

    for (let attempt = 0; ; attempt++) {
      // 429/THROTTLED bedeuten: der Request wurde serverseitig NICHT ausgefuehrt
      // (nur abgelehnt) -> ein erneutes Senden ist auch fuer Mutations sicher.
      const res = await fetchWithTimeoutRetry(
        GRAPHQL_ENDPOINT,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": token,
          },
          body: JSON.stringify({ query, variables }),
        },
        networkRetries
      );

      // Rate-Limit auf HTTP-Ebene: warten und erneut versuchen.
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = parseFloat(res.headers.get("Retry-After"));
        const wait = Math.min((Number.isFinite(retryAfter) ? retryAfter : 2) * 1000, MAX_BACKOFF_MS);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const text = truncate(await res.text());
        throw new Error(`[${name}] HTTP ${res.status} ${res.statusText}: ${text}`);
      }

      const json = await res.json();
      if (json.errors && json.errors.length > 0) {
        // GraphQL-Cost-Throttling: aus den Cost-Infos die Wartezeit ableiten.
        const throttled = json.errors.every((e) => e.extensions?.code === "THROTTLED");
        if (throttled && attempt < MAX_RETRIES) {
          const cost = json.extensions?.cost;
          const ts = cost?.throttleStatus;
          // Query grundsaetzlich zu teuer -> Retry hilft nie, sofort werfen.
          if (ts && cost.requestedQueryCost > ts.maximumAvailable) {
            throw new Error(
              `[${name}] GraphQL-Query zu teuer: Kosten ${cost.requestedQueryCost} ` +
                `> Maximum ${ts.maximumAvailable}. Query aufteilen.`
            );
          }
          const waitMs = ts
            ? Math.ceil(
                ((cost.requestedQueryCost - ts.currentlyAvailable) / ts.restoreRate) * 1000
              ) + 250
            : 2000;
          await sleep(Math.min(Math.max(waitMs, 500), MAX_BACKOFF_MS));
          continue;
        }
        throw new Error(
          `[${name}] GraphQL-Fehler: ` + truncate(JSON.stringify(json.errors, null, 2))
        );
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
 * @param {{ version?: string, label?: string, timeoutMs?: number }} [opts]
 */
export function clientFromEnv(prefix, { version, label, timeoutMs } = {}) {
  return createShopifyClient({
    store: process.env[`${prefix}_STORE`],
    clientId: process.env[`${prefix}_CLIENT_ID`],
    clientSecret: process.env[`${prefix}_CLIENT_SECRET`],
    version,
    label: label || prefix,
    timeoutMs,
  });
}
