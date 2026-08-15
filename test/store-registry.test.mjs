// Store-Registry: Bauzeit-Validierung, Lazy-Verhalten, get-Memoisierung und
// Fehlerbild-Test 1 (Token-/Endpoint-Ebene, Assertion Host x client_id — S0-A14).
// Kein echtes Netz: der Token-Tausch wird per injiziertem fetch simuliert.

import test from "node:test";
import assert from "node:assert/strict";
import { createStoreRegistry } from "../store-registry.js";

// Gültige (No-op) Audit-Instanz — der Guard prüft beim Bau, dass attempt eine Funktion ist.
const auditNoop = () => {
  const noop = () => {};
  return { declared: noop, attempt: noop, result: noop, rejected: noop, location: () => "logs/x.jsonl" };
};

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
// Fehlerbild-Test 2 — Instanz-Leck (Guard je Store instanzbasiert)
// ---------------------------------------------------------------------------------

const STORES2 = {
  b2c: { expectedDomain: "b2c.myshopify.com", envPrefix: "WM_B2C", version: "2026-04" },
  b2b: { expectedDomain: "b2b.myshopify.com", envPrefix: "WM_B2B", version: "2026-04" },
};
const ENV2 = {
  WM_B2C_CLIENT_ID: "idc", WM_B2C_CLIENT_SECRET: "sc",
  WM_B2B_CLIENT_ID: "idb", WM_B2B_CLIENT_SECRET: "sb",
};
const M_UPDATE = "mutation U($i: ProductInput!) { productUpdate(input: $i) { product { id } } }";

// Token immer ok; identity antwortet als der Host des Endpoints; sonst { ok: 1 }.
function guardFetch(record) {
  return async (url, options) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/access_token")) return resp({ access_token: "tok", expires_in: 86399 });
    const body = JSON.parse(options.body);
    record.push({ host: u.host, query: body.query });
    if (/myshopifyDomain/.test(body.query)) return resp({ data: { shop: { myshopifyDomain: u.host } } });
    return resp({ data: { ok: 1 } });
  };
}

function spyAudit() {
  const calls = [];
  const entries = {};
  const auditForStore = (name) => {
    calls.push(name);
    const list = [];
    entries[name] = list;
    const mk = (typ) => (e) => list.push({ typ, ...e });
    return { declared: mk("declared"), attempt: mk("attempt"), result: mk("result"), rejected: mk("rejected"), location: () => `logs/${name}.jsonl` };
  };
  return { auditForStore, calls, entries };
}

test("Fehlerbild 2: getrennte Deklaration/Budget je Store; auditForStore 1x je Name; store je Eintrag", async () => {
  const record = [];
  const spy = spyAudit();
  const reg = createStoreRegistry({ stores: STORES2, env: ENV2, auditForStore: spy.auditForStore, fetch: guardFetch(record) });

  const b2c = reg.get("b2c");
  const b2b = reg.get("b2b");
  b2c.declareMutations({ felder: ["productUpdate"], budget: 5, grund: "Test" });
  // b2b bewusst NICHT deklariert

  await b2c.graphql(M_UPDATE, { i: {} });                       // erlaubt
  await assert.rejects(() => b2b.graphql(M_UPDATE, { i: {} }),  // derselbe Write, andere Instanz
    (e) => e.code === "deny");

  assert.equal(b2c.state().zaehler, 1, "getrenntes Budget: b2c hat gezählt");
  assert.equal(b2b.state().zaehler, 0, "getrenntes Budget: b2b hat nicht gezählt");
  assert.equal(b2c.isDeclared(), true);
  assert.equal(b2b.isDeclared(), false);

  // Memoisierung + auditForStore genau einmal je Name.
  assert.equal(reg.get("b2c"), b2c);
  assert.equal(reg.get("b2b"), b2b);
  assert.deepEqual([...spy.calls].sort(), ["b2b", "b2c"]);

  // Jeder Audit-Eintrag trägt den richtigen store.
  assert.ok(spy.entries.b2c.length > 0 && spy.entries.b2c.every((e) => e.store === "b2c.myshopify.com"));
  assert.ok(spy.entries.b2b.length > 0 && spy.entries.b2b.every((e) => e.store === "b2b.myshopify.com"));
});

test("Fehlerbild 2: genau EINE Identitätsabfrage je Handle (auch parallele erste Writes); Reads lösen keine aus", async () => {
  const record = [];
  const spy = spyAudit();
  const reg = createStoreRegistry({ stores: STORES2, env: ENV2, auditForStore: spy.auditForStore, fetch: guardFetch(record) });
  const b2c = reg.get("b2c");
  b2c.declareMutations({ felder: ["productUpdate"], budget: 5, grund: "Test" });

  await b2c.graphql("query { shop { name } }"); // Read: keine Identität
  const identityBisher = record.filter((r) => /myshopifyDomain/.test(r.query)).length;
  assert.equal(identityBisher, 0, "Read hat eine Identitätsabfrage ausgelöst");

  await Promise.all([b2c.graphql(M_UPDATE, { i: {} }), b2c.graphql(M_UPDATE, { i: {} })]);
  const identityQueries = record.filter((r) => r.host === "b2c.myshopify.com" && /myshopifyDomain/.test(r.query)).length;
  assert.equal(identityQueries, 1, "Single-Flight: genau eine Identitätsabfrage trotz paralleler erster Writes");
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
