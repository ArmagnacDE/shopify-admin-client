// Regression S0-A2: der `fetch` der Transport-Option darf NICHT beim Bau eingefroren
// werden. Zwei Faelle:
//   (a) ohne Option -> jeder Request nimmt den AKTUELLEN globalThis.fetch, auch wenn er
//       NACH dem Bau des Clients getauscht wurde;
//   (b) mit Option  -> der injizierte fetch wird benutzt, globalThis.fetch bleibt unberuehrt.

import test from "node:test";
import assert from "node:assert/strict";
import { createShopifyClient } from "../transport.js";

const CREDS = { store: "shop.myshopify.com", clientId: "id", clientSecret: "sec" };
const noSleep = async () => {};

function resp(body) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function router(counts) {
  return async (url) => {
    if (String(url).endsWith("/access_token")) {
      counts.token++;
      return resp({ access_token: "tok", expires_in: 86399 });
    }
    counts.graphql++;
    return resp({ data: { ok: 1 } });
  };
}

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test("(a) globalThis.fetch NACH dem Bau getauscht wird trotzdem benutzt (nicht eingefroren)", async () => {
  // Bauen, WAEHREND globalThis.fetch noch etwas ist, das sofort werfen wuerde.
  globalThis.fetch = () => { throw new Error("alter globalThis.fetch darf nicht benutzt werden"); };
  const c = createShopifyClient({ ...CREDS, sleep: noSleep });

  // Erst JETZT den echten Stub setzen — ein eingefrorener Default wuerde ihn ignorieren.
  const counts = { token: 0, graphql: 0 };
  globalThis.fetch = router(counts);

  const data = await c.graphql("query { a }");
  assert.deepEqual(data, { ok: 1 });
  assert.equal(counts.token, 1);
  assert.equal(counts.graphql, 1);
});

test("(b) injizierter fetch wird benutzt, globalThis.fetch bleibt unangetastet", async () => {
  const counts = { token: 0, graphql: 0 };
  globalThis.fetch = () => { throw new Error("globalThis.fetch darf bei injiziertem fetch nicht benutzt werden"); };

  const c = createShopifyClient({ ...CREDS, sleep: noSleep, fetch: router(counts) });
  const data = await c.graphql("query { a }");
  assert.deepEqual(data, { ok: 1 });
  assert.equal(counts.token, 1);
  assert.equal(counts.graphql, 1);
});

test("nicht-funktionaler fetch wird beim Bau abgelehnt", () => {
  assert.throws(() => createShopifyClient({ ...CREDS, fetch: 123 }), /fetch muss eine Funktion sein/);
});
