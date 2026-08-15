// Store-Registry: Bauzeit-Validierung, Lazy-Verhalten, get-Memoisierung und
// Fehlerbild-Test 1 (Token-/Endpoint-Ebene, Assertion Host x client_id — S0-A14).
// Kein echtes Netz: der Token-Tausch wird per injiziertem fetch simuliert.

import test from "node:test";
import assert from "node:assert/strict";
import { createStoreRegistry } from "../store-registry.js";

const auditNoop = () => ({}); // S1: Pflicht-Funktion, vom Guard erst in S2 aufgerufen.

function resp(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Unauthorized",
    headers: { get: () => null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  };
}

// Fetch-Mock: protokolliert je Token-Request Host UND client_id; ein Paar (Host,
// client_id), das nicht in `validPairs` steht, wird mit 401 abgelehnt (so wie Shopify
// fremde Credentials am Endpoint zurueckweist). GraphQL-Requests werden separat gezaehlt.
function makeFetch(record, validPairs) {
  return async (url, options) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/access_token")) {
      const clientId = new URLSearchParams(options.body).get("client_id");
      record.tokens.push({ host: u.host, clientId, url: String(url) });
      if (validPairs.get(u.host) !== clientId) {
        return resp({ error: "invalid_client" }, { ok: false, status: 401 });
      }
      return resp({ access_token: "tok", expires_in: 86399 });
    }
    record.graphql.push({ host: u.host, url: String(url) });
    return resp({ data: { ok: 1 } });
  };
}

const STORES = {
  a: { expectedDomain: "shop-a.myshopify.com", envPrefix: "STORE_A", version: "2026-04", label: "A" },
  b: { expectedDomain: "shop-b.myshopify.com", envPrefix: "STORE_B", version: "2026-04", label: "B" },
};

// ---------------------------------------------------------------------------------
// Fehlerbild-Test 1
// ---------------------------------------------------------------------------------

test("Fehlerbild 1: Token-Request paart Praefix-client_id mit Host der expectedDomain", async () => {
  const record = { tokens: [], graphql: [] };
  const validPairs = new Map([
    ["shop-a.myshopify.com", "id-a"],
    ["shop-b.myshopify.com", "id-b"],
  ]);
  const env = {
    STORE_A_CLIENT_ID: "id-a", STORE_A_CLIENT_SECRET: "sec-a",
    STORE_B_CLIENT_ID: "id-b", STORE_B_CLIENT_SECRET: "sec-b",
    // Diese Werte MUESSEN ignoriert werden:
    STORE_A_STORE: "evil-a.myshopify.com",
    STORE_B_STORE: "evil-b.myshopify.com",
    SHOPIFY_API_VERSION: "1999-01",
  };
  const reg = createStoreRegistry({ stores: STORES, env, auditForStore: auditNoop, fetch: makeFetch(record, validPairs) });

  await reg.get("a").graphql("query { x }");
  await reg.get("b").graphql("query { x }");

  // Jeder Token-Request: Host = expectedDomain der Konstante, client_id = Praefix-Wert.
  assert.deepEqual(
    record.tokens.map((t) => [t.host, t.clientId]).sort(),
    [["shop-a.myshopify.com", "id-a"], ["shop-b.myshopify.com", "id-b"]]
  );
  // Kein Env-Wert konnte den Host verschieben (kein evil-*), keine fremde Version.
  for (const g of record.graphql) {
    assert.ok(/^shop-[ab]\.myshopify\.com$/.test(g.host), `Host verschoben: ${g.host}`);
    assert.match(g.url, /\/admin\/api\/2026-04\/graphql\.json$/); // stores[].version, nicht 1999-01
    assert.doesNotMatch(g.url, /evil/);
  }
});

test("Fehlerbild 1: vertauschte .env (fremde Credentials) -> 401, KEIN graphql-Request", async () => {
  const record = { tokens: [], graphql: [] };
  const validPairs = new Map([
    ["shop-a.myshopify.com", "id-a"],
    ["shop-b.myshopify.com", "id-b"],
  ]);
  // .env von b traegt versehentlich die Credentials von a.
  const env = {
    STORE_A_CLIENT_ID: "id-a", STORE_A_CLIENT_SECRET: "sec-a",
    STORE_B_CLIENT_ID: "id-a", STORE_B_CLIENT_SECRET: "sec-a",
  };
  const reg = createStoreRegistry({ stores: STORES, env, auditForStore: auditNoop, fetch: makeFetch(record, validPairs) });

  await assert.rejects(() => reg.get("b").graphql("query { x }"), /Token-Tausch fehlgeschlagen \(HTTP 401\)/);

  // Der Host blieb die Code-Konstante (shop-b), das Paar (shop-b, id-a) wurde abgelehnt,
  // und danach folgte KEIN Request mit Seiteneffekt.
  assert.deepEqual(record.tokens.map((t) => [t.host, t.clientId]), [["shop-b.myshopify.com", "id-a"]]);
  assert.equal(record.graphql.length, 0, "nach gescheitertem Token-Tausch kein graphql.json-Request");
});

// ---------------------------------------------------------------------------------
// Lazy + Memoisierung
// ---------------------------------------------------------------------------------

test("lazy: Bau ohne Credentials und ohne Netz (kein fetch noetig)", () => {
  // Weder Credentials noch fetch gesetzt -> der reine Bau darf nicht scheitern/netzen.
  assert.doesNotThrow(() =>
    createStoreRegistry({ stores: STORES, env: {}, auditForStore: auditNoop })
  );
});

test("get memoisiert je Name und Registry-Instanz (get('a') === get('a'))", () => {
  const env = { STORE_A_CLIENT_ID: "id-a", STORE_A_CLIENT_SECRET: "sec-a", STORE_B_CLIENT_ID: "id-b", STORE_B_CLIENT_SECRET: "sec-b" };
  const reg = createStoreRegistry({ stores: STORES, env, auditForStore: auditNoop });
  assert.equal(reg.get("a"), reg.get("a"));
  assert.notEqual(reg.get("a"), reg.get("b"));
});

test("Fehl-get (fehlende Credentials) wirft klar, ohne Netz, und wird NICHT memoisiert", () => {
  const env = {}; // noch keine Credentials
  const reg = createStoreRegistry({ stores: STORES, env, auditForStore: auditNoop });
  assert.throws(() => reg.get("a"), /STORE_A_CLIENT_ID und STORE_A_CLIENT_SECRET fehlen/);
  // Credentials nachtraeglich setzen -> get muss jetzt erfolgreich sein (kein Cache des Fehlers).
  env.STORE_A_CLIENT_ID = "id-a";
  env.STORE_A_CLIENT_SECRET = "sec-a";
  const handle = reg.get("a");
  assert.equal(typeof handle.graphql, "function");
  assert.equal(handle.config.store, "shop-a.myshopify.com");
});

test("unbekannter Name wirft und nennt die bekannten Namen", () => {
  const reg = createStoreRegistry({ stores: STORES, env: {}, auditForStore: auditNoop });
  assert.throws(() => reg.get("c"), (e) => /unbekannt/.test(e.message) && /"a"/.test(e.message) && /"b"/.test(e.message));
});

test("Handle-config traegt store/version/endpoint/label", () => {
  const env = { STORE_A_CLIENT_ID: "id-a", STORE_A_CLIENT_SECRET: "sec-a" };
  const reg = createStoreRegistry({ stores: { a: STORES.a }, env, auditForStore: auditNoop });
  const { config } = reg.get("a");
  assert.equal(config.store, "shop-a.myshopify.com");
  assert.equal(config.version, "2026-04");
  assert.equal(config.endpoint, "https://shop-a.myshopify.com/admin/api/2026-04/graphql.json");
  assert.equal(config.label, "A");
});

// ---------------------------------------------------------------------------------
// Bauzeit-Validierung
// ---------------------------------------------------------------------------------

test("version je Store PFLICHT (S0-A18)", () => {
  assert.throws(
    () => createStoreRegistry({ stores: { a: { expectedDomain: "shop-a.myshopify.com", envPrefix: "STORE_A" } }, env: {}, auditForStore: auditNoop }),
    /version ist Pflicht/
  );
});

test("doppelte Domain wirft beim Bau (case-insensitiv)", () => {
  assert.throws(
    () => createStoreRegistry({
      stores: {
        a: { expectedDomain: "shop.myshopify.com", envPrefix: "A", version: "2026-04" },
        b: { expectedDomain: "SHOP.myshopify.com", envPrefix: "B", version: "2026-04" },
      },
      env: {}, auditForStore: auditNoop,
    }),
    /expectedDomain "SHOP.myshopify.com" doppelt/
  );
});

test("doppeltes Praefix wirft beim Bau (Grossschreibung normalisiert)", () => {
  assert.throws(
    () => createStoreRegistry({
      stores: {
        a: { expectedDomain: "shop-a.myshopify.com", envPrefix: "shopify", version: "2026-04" },
        b: { expectedDomain: "shop-b.myshopify.com", envPrefix: "SHOPIFY", version: "2026-04" },
      },
      env: {}, auditForStore: auditNoop,
    }),
    /envPrefix "SHOPIFY" doppelt/
  );
});

test("ungueltige expectedDomain wirft beim Bau", () => {
  assert.throws(
    () => createStoreRegistry({ stores: { a: { expectedDomain: "evil.com", envPrefix: "A", version: "2026-04" } }, env: {}, auditForStore: auditNoop }),
    /ungueltige expectedDomain/
  );
});

test("ungueltiger envPrefix wirft beim Bau", () => {
  assert.throws(
    () => createStoreRegistry({ stores: { a: { expectedDomain: "shop-a.myshopify.com", envPrefix: "1bad", version: "2026-04" } }, env: {}, auditForStore: auditNoop }),
    /ungueltigen envPrefix/
  );
});

test("auditForStore muss eine Funktion sein", () => {
  assert.throws(
    () => createStoreRegistry({ stores: STORES, env: {}, auditForStore: undefined }),
    /auditForStore muss eine Funktion sein/
  );
});

test("leere stores werfen", () => {
  assert.throws(() => createStoreRegistry({ stores: {}, env: {}, auditForStore: auditNoop }), /stores ist leer/);
  assert.throws(() => createStoreRegistry({ auditForStore: auditNoop }), /stores muss ein Objekt/);
});

test("nur eigene Schluessel (Object.hasOwn) — geerbte Keys zaehlen nicht als Store", () => {
  const proto = { ererbt: { expectedDomain: "x.myshopify.com", envPrefix: "X", version: "2026-04" } };
  const stores = Object.create(proto);
  stores.a = { expectedDomain: "shop-a.myshopify.com", envPrefix: "STORE_A", version: "2026-04" };
  const reg = createStoreRegistry({ stores, env: {}, auditForStore: auditNoop });
  assert.throws(() => reg.get("ererbt"), /unbekannt/);
});
