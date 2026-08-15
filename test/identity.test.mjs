// Unit-Test verifyShopIdentity (Direktnutzer-Szenario: Code-Konstante != Endpoint).
// Reiner Fake-Reader, kein Netz.

import test from "node:test";
import assert from "node:assert/strict";
import { verifyShopIdentity } from "../identity.js";
import { MutationGuardError } from "../errors.js";

const reader = (domain) => async () => ({ shop: { myshopifyDomain: domain } });

test("richtige Domain -> Rueckgabe ROH (Gross/Klein erhalten), Vergleich case-insensitiv", async () => {
  const d = await verifyShopIdentity(reader("Armagnac-DE.myshopify.com"), {
    expectedDomain: "armagnac-de.myshopify.com",
  });
  assert.equal(d, "Armagnac-DE.myshopify.com");
});

test("falscher Shop -> MutationGuardError('store'), nennt die Ist-Domain", async () => {
  await assert.rejects(
    () => verifyShopIdentity(reader("fremder-shop.myshopify.com"), { expectedDomain: "armagnac-de.myshopify.com" }),
    (e) => {
      assert.ok(e instanceof MutationGuardError);
      assert.equal(e.code, "store");
      assert.match(e.message, /\[mutation-guard:store\]/);
      assert.match(e.message, /fremder-shop/);
      return true;
    }
  );
});

test("leere/fehlende Antwort -> MutationGuardError('identitaet'), 'nicht lesbar'", async () => {
  await assert.rejects(
    () => verifyShopIdentity(async () => ({}), { expectedDomain: "x.myshopify.com" }),
    (e) => e instanceof MutationGuardError && e.code === "identitaet" && /nicht lesbar/.test(e.message)
  );
});

test("Reader wirft (Netzfehler) -> MutationGuardError('identitaet'), 'nicht pruefbar'", async () => {
  await assert.rejects(
    () => verifyShopIdentity(async () => { throw new Error("ECONNRESET"); }, { expectedDomain: "x.myshopify.com" }),
    (e) => e instanceof MutationGuardError && e.code === "identitaet" && /nicht pruefbar/.test(e.message)
  );
});

test("fehlende expectedDomain -> MutationGuardError('store')", async () => {
  await assert.rejects(
    () => verifyShopIdentity(reader("a.myshopify.com"), {}),
    (e) => e instanceof MutationGuardError && e.code === "store" && /expectedDomain fehlt/.test(e.message)
  );
});

test("kein eigener Cache: zwei Aufrufe fragen den Reader zweimal", async () => {
  let calls = 0;
  const counting = async () => {
    calls++;
    return { shop: { myshopifyDomain: "a.myshopify.com" } };
  };
  await verifyShopIdentity(counting, { expectedDomain: "a.myshopify.com" });
  await verifyShopIdentity(counting, { expectedDomain: "a.myshopify.com" });
  assert.equal(calls, 2, "verifyShopIdentity cacht nicht selbst — der Aufrufer haelt den Cache");
});
