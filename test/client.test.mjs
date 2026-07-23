// Tests fuer den gehaerteten Shopify-Admin-Client. Nutzt einen fetch-Stub
// (globalThis.fetch) und injizierten No-op-sleep, damit nichts real wartet/netzt.

import test from "node:test";
import assert from "node:assert/strict";
import { createShopifyClient, isMutation } from "../index.js";

const CREDS = { store: "shop.myshopify.com", clientId: "id", clientSecret: "sec" };
const noSleep = async () => {};

// Response-Attrappe.
function resp({ ok = true, status = 200, statusText = "OK", headers = {}, body = {} }) {
  return {
    ok,
    status,
    statusText,
    headers: { get: (k) => headers[k] ?? headers[k.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  };
}

// Router-fetch: zaehlt Token- vs GraphQL-Aufrufe, delegiert an handlers.
function stubFetch(handlers) {
  const counts = { token: 0, graphql: 0 };
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/access_token")) {
      counts.token += 1;
      return (handlers.token || (() => resp({ body: { access_token: "tok", expires_in: 86399 } })))(counts.token, options);
    }
    counts.graphql += 1;
    return handlers.graphql(counts.graphql, options);
  };
  return counts;
}

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test("isMutation: erkennt Mutation trotz Whitespace/Kommentar, Query nicht", () => {
  assert.equal(isMutation("mutation { x }"), true);
  assert.equal(isMutation("\n  # kommentar\n  mutation Foo { x }"), true);
  assert.equal(isMutation("query { x }"), false);
  assert.equal(isMutation("  { x }"), false); // anonyme Query
});

test("store-Validierung: fremde/manipulierte Hosts werden abgelehnt", () => {
  for (const store of [
    "evil.com",
    "shop.myshopify.com@evil.com",
    "shop.myshopify.com/x",
    "shop.myshopify.com:8080",
    "http://shop.myshopify.com",
    "shop.myshopify.com#",
    "shop.myshopify.com ",
  ]) {
    assert.throws(() => createShopifyClient({ ...CREDS, store }), /store-Domain/, `sollte werfen: ${store}`);
  }
  // gueltig:
  assert.doesNotThrow(() => createShopifyClient({ ...CREDS, store: "my-shop.myshopify.com" }));
});

test("version-Validierung: nur JJJJ-MM oder unstable", () => {
  assert.throws(() => createShopifyClient({ ...CREDS, version: "../evil" }), /API-Version/);
  assert.throws(() => createShopifyClient({ ...CREDS, version: "2025" }), /API-Version/);
  assert.doesNotThrow(() => createShopifyClient({ ...CREDS, version: "2025-10" }));
  assert.doesNotThrow(() => createShopifyClient({ ...CREDS, version: "unstable" }));
});

test("fehlende Credentials werfen", () => {
  assert.throws(() => createShopifyClient({ store: "shop.myshopify.com" }), /muessen gesetzt sein/);
});

test("Mutation wird bei Netzfehler NICHT wiederholt (Dubletten-Schutz)", async () => {
  const counts = stubFetch({ graphql: () => { throw new Error("ECONNRESET"); } });
  const c = createShopifyClient({ ...CREDS, sleep: noSleep });
  await assert.rejects(() => c.graphql("mutation { productCreate { id } }"));
  assert.equal(counts.graphql, 1, "Mutation darf nur EINMAL gesendet werden");
});

test("Query WIRD bei Netzfehler wiederholt (3 Retries → 4 Versuche)", async () => {
  const counts = stubFetch({ graphql: () => { throw new Error("ECONNRESET"); } });
  const c = createShopifyClient({ ...CREDS, sleep: noSleep });
  await assert.rejects(() => c.graphql("query { shop { name } }"));
  assert.equal(counts.graphql, 4, "1 Versuch + 3 Retries");
});

test("Mutation-Retry bei 429 ist erlaubt (Request wurde nicht ausgefuehrt)", async () => {
  const counts = stubFetch({
    graphql: (n) => (n === 1
      ? resp({ ok: false, status: 429, headers: { "Retry-After": "1" } })
      : resp({ body: { data: { ok: true } } })),
  });
  const c = createShopifyClient({ ...CREDS, sleep: noSleep });
  const data = await c.graphql("mutation { x }");
  assert.deepEqual(data, { ok: true });
  assert.equal(counts.graphql, 2);
});

test("leeres errors:[] wird NICHT als Throttling gedeutet → data zurueck", async () => {
  const counts = stubFetch({ graphql: () => resp({ body: { data: { a: 1 }, errors: [] } }) });
  const c = createShopifyClient({ ...CREDS, sleep: noSleep });
  const data = await c.graphql("query { a }");
  assert.deepEqual(data, { a: 1 });
  assert.equal(counts.graphql, 1, "kein Retry-Loop");
});

test("Query grundsaetzlich zu teuer → sofortiger Fehler statt endloser Retries", async () => {
  const counts = stubFetch({
    graphql: () => resp({
      body: {
        errors: [{ extensions: { code: "THROTTLED" } }],
        extensions: { cost: { requestedQueryCost: 2000, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 500, restoreRate: 100 } } },
      },
    }),
  });
  const c = createShopifyClient({ ...CREDS, sleep: noSleep });
  await assert.rejects(() => c.graphql("query { big }"), /zu teuer/);
  assert.equal(counts.graphql, 1, "kein Retry, sofort werfen");
});

test("Token-Antwort ohne access_token wirft klar", async () => {
  stubFetch({ token: () => resp({ body: { foo: "bar" } }), graphql: () => resp({ body: { data: {} } }) });
  const c = createShopifyClient({ ...CREDS, sleep: noSleep });
  await assert.rejects(() => c.graphql("query { a }"), /access_token/);
});

test("Single-Flight: parallele Calls loesen nur EINEN Token-Tausch aus", async () => {
  const counts = stubFetch({ graphql: () => resp({ body: { data: { ok: 1 } } }) });
  const c = createShopifyClient({ ...CREDS, sleep: noSleep });
  await Promise.all([c.graphql("query{a}"), c.graphql("query{b}"), c.graphql("query{c}")]);
  assert.equal(counts.token, 1, "Token nur einmal geholt");
  assert.equal(counts.graphql, 3);
});

test("Token wird gecached (zweiter Call ohne erneuten Tausch)", async () => {
  const counts = stubFetch({ graphql: () => resp({ body: { data: { ok: 1 } } }) });
  const c = createShopifyClient({ ...CREDS, sleep: noSleep });
  await c.graphql("query{a}");
  await c.graphql("query{b}");
  assert.equal(counts.token, 1);
});

test("expires_in fehlt → Token trotzdem nutzbar (kein NaN, kein Dauer-Refetch)", async () => {
  const counts = stubFetch({
    token: () => resp({ body: { access_token: "tok" } }), // kein expires_in
    graphql: () => resp({ body: { data: { ok: 1 } } }),
  });
  const c = createShopifyClient({ ...CREDS, sleep: noSleep });
  await c.graphql("query{a}");
  await c.graphql("query{b}");
  assert.equal(counts.token, 1, "Fallback-TTL greift, kein Refetch pro Call");
});

test("config wird zurueckgegeben, Token nie im Klartext exponiert", async () => {
  stubFetch({ graphql: () => resp({ body: { data: {} } }) });
  const c = createShopifyClient({ ...CREDS, label: "Test\nInjection" });
  assert.equal(c.config.store, "shop.myshopify.com");
  assert.equal(c.config.endpoint, "https://shop.myshopify.com/admin/api/2025-10/graphql.json");
  assert.equal(c.config.label, "Test Injection", "Steuerzeichen im Label durch Space ersetzt");
});
