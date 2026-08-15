// createMutationGuard — Default-Deny-Schranke, instanzbasiert, gegen den Audit-Vertrag.
// Verhalten unverändert zur armagnac-Fassung; Testaufbau auf Fake-Audit umgestellt
// (append/mkdir/warn-Injektion + Kürzung liegen in test/jsonl-audit.test.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import {
  createMutationGuard, extrahiereRootFeld, istSchreibDokument, MutationGuardError,
} from "../mutation-guard.js";

const DOMAIN = "armagnac-de.myshopify.com";
const IDENTITAET = "query { shop { myshopifyDomain } }";
const LOC = "logs-test/shopify-mutations-2026-08.jsonl";
const M_PRODUCT_UPDATE = "mutation U($i: ProductInput!) { productUpdate(input: $i) { product { id } } }";
const M_PRODUCT_SET = "mutation S($i: ProductSetInput!) { productSet(input: $i) { product { id } } }";
const M_PUBLISH = "mutation P($id: ID!) { publishablePublish(id: $id, input: []) { userErrors { message } } }";

// Fake-Audit: sammelt Einträge; `ctrl[typ]` (mutierbar) lässt die Methode werfen.
function makeAudit({ ctrl = {}, noLocation = false } = {}) {
  const entries = [];
  const mk = (typ) => (e) => {
    if (ctrl[typ]) throw new Error(typeof ctrl[typ] === "string" ? ctrl[typ] : `${typ} kaputt`);
    entries.push({ typ, ...e });
  };
  const audit = { declared: mk("declared"), attempt: mk("attempt"), result: mk("result"), rejected: mk("rejected") };
  if (!noLocation) audit.location = () => LOC;
  return { audit, entries, ctrl };
}

function bauGuard({ expected = DOMAIN, live = expected, graphqlImpl, ctrl, noLocation, id } = {}) {
  const calls = [];
  const base = async (q) => (q === IDENTITAET ? { shop: { myshopifyDomain: live } } : { ok: true });
  const impl = graphqlImpl ?? base;
  const graphql = async (q, v, o) => { calls.push({ q, v, o }); return impl(q, v, o); };
  const { audit, entries, ctrl: ctrlOut } = makeAudit({ ctrl, noLocation });
  const guard = createMutationGuard({ graphql, expectedDomain: expected, audit, id });
  return { guard, calls, entries, ctrl: ctrlOut };
}
const writeCalls = (calls) => calls.filter((c) => c.q !== IDENTITAET);

// --- init -----------------------------------------------------------------------------
test("init: graphql/expectedDomain/audit sind Pflicht (Code 'init')", () => {
  const { audit } = makeAudit();
  assert.throws(() => createMutationGuard({ expectedDomain: DOMAIN, audit }), (e) => e.code === "init");
  assert.throws(() => createMutationGuard({ graphql: async () => ({}), audit }), (e) => e.code === "init" && /expectedDomain/.test(e.message));
  assert.throws(() => createMutationGuard({ graphql: async () => ({}), expectedDomain: DOMAIN }), (e) => e.code === "init" && /audit/.test(e.message));
});

// --- Default-Deny ---------------------------------------------------------------------
test("undeklariertes productUpdate wird bei Mutation 1 abgelehnt und nie gesendet", async () => {
  const { guard, calls, entries } = bauGuard();
  await assert.rejects(() => guard.graphql(M_PRODUCT_UPDATE, { i: {} }),
    (e) => e instanceof MutationGuardError && e.code === "deny"
      && e.message.includes("productUpdate") && e.message.includes("declareMutations"));
  assert.equal(writeCalls(calls).length, 0, "die Mutation ging trotzdem raus");
  assert.equal(entries.at(-1).typ, "rejected");
  assert.equal(entries.at(-1).grund, "deny");
});

test("nicht deklariertes Feld wird abgelehnt, deklarierte Liste steht in der Meldung", async () => {
  const { guard } = bauGuard();
  guard.declareMutations({ felder: ["productSet"], budget: 5, grund: "Test" });
  await assert.rejects(() => guard.graphql(M_PUBLISH, {}),
    (e) => e.code === "deny" && e.message.includes("publishablePublish") && e.message.includes("productSet"));
});

// --- Budget ---------------------------------------------------------------------------
test("Budget: Nr. budget+1 bricht mit Zähler, letzter Operation und audit.location() ab", async () => {
  const { guard } = bauGuard();
  guard.declareMutations({ felder: ["productSet"], budget: 2, grund: "Test" });
  await guard.graphql(M_PRODUCT_SET, {});
  await guard.graphql(M_PRODUCT_SET, {});
  await assert.rejects(() => guard.graphql(M_PRODUCT_SET, {}),
    (e) => e.code === "budget" && e.message.includes("2 von 2")
      && e.message.includes("productSet") && e.message.includes(LOC));
  assert.equal(guard.state().zaehler, 2);
});

test("Budget-Meldung ohne audit.location(): Satz entfällt", async () => {
  const { guard } = bauGuard({ noLocation: true });
  guard.declareMutations({ felder: ["productSet"], budget: 1, grund: "Test" });
  await guard.graphql(M_PRODUCT_SET, {});
  await assert.rejects(() => guard.graphql(M_PRODUCT_SET, {}),
    (e) => e.code === "budget" && !e.message.includes("steht im Log"));
});

// --- Live-Identität -------------------------------------------------------------------
test("falsche Live-Domain: Abbruch vor der ersten Mutation, Reads bleiben frei", async () => {
  const { guard, calls } = bauGuard({ live: "wagemut-b2c.myshopify.com" });
  guard.declareMutations({ felder: ["productSet"], budget: 5, grund: "Test" });
  await guard.graphql("query Q { shop { name } }"); // Read: frei
  await assert.rejects(() => guard.graphql(M_PRODUCT_SET, {}),
    (e) => e.code === "store" && e.message.includes("wagemut-b2c") && e.message.includes(DOMAIN));
  assert.equal(calls.filter((c) => c.q === M_PRODUCT_SET).length, 0);
});

test("Identitätsabfrage scheitert: fail-closed mit eigenem Fehlertext", async () => {
  const { guard } = bauGuard({ graphqlImpl: async (q) => { if (q === IDENTITAET) throw new Error("ECONNRESET"); return { ok: true }; } });
  guard.declareMutations({ felder: ["productSet"], budget: 5, grund: "Test" });
  await assert.rejects(() => guard.graphql(M_PRODUCT_SET, {}),
    (e) => e.code === "identitaet" && e.message.includes("ECONNRESET"));
});

test("Identität wird pro Instanz genau einmal abgefragt; Reads lösen keine aus", async () => {
  const { guard, calls } = bauGuard();
  guard.declareMutations({ felder: ["productSet"], budget: 5, grund: "Test" });
  await guard.graphql("query A { shop { name } }");
  await guard.graphql("query B { shop { name } }");
  assert.equal(calls.filter((c) => c.q === IDENTITAET).length, 0, "Read hat Identity-Query ausgelöst");
  await guard.graphql(M_PRODUCT_SET, {});
  await guard.graphql(M_PRODUCT_SET, {});
  assert.equal(calls.filter((c) => c.q === IDENTITAET).length, 1, "Identity-Query nicht gecacht");
});

test("Identitäts-Ablehnung bleibt gecacht — zweiter Write löst KEINE zweite Abfrage aus", async () => {
  const { guard, calls } = bauGuard({ live: "wagemut-b2c.myshopify.com" });
  guard.declareMutations({ felder: ["productSet"], budget: 5, grund: "x" });
  await assert.rejects(() => guard.graphql(M_PRODUCT_SET, {}), (e) => e.code === "store");
  await assert.rejects(() => guard.graphql(M_PRODUCT_SET, {}), (e) => e.code === "store");
  assert.equal(calls.filter((c) => c.q === IDENTITAET).length, 1,
    "Ablehnung nicht gecacht — zweite Identitätsabfrage (kein In-Prozess-Retry erlaubt)");
});

test("Single-Flight: parallele erste Writes lösen genau EINE Identitätsabfrage aus", async () => {
  const { guard, calls } = bauGuard();
  guard.declareMutations({ felder: ["productSet"], budget: 5, grund: "Test" });
  await Promise.all([guard.graphql(M_PRODUCT_SET, {}), guard.graphql(M_PRODUCT_SET, {})]);
  assert.equal(calls.filter((c) => c.q === IDENTITAET).length, 1);
});

test("Identity-/Store-Ablehnung hinterlässt eine rejected-Zeile mit store", async () => {
  const { guard, entries } = bauGuard({ live: "wagemut-b2c.myshopify.com" });
  guard.declareMutations({ felder: ["productSet"], budget: 5, grund: "x" });
  await assert.rejects(() => guard.graphql(M_PRODUCT_SET, {}), (e) => e.code === "store");
  const rejected = entries.find((z) => z.typ === "rejected");
  assert.equal(rejected?.grund, "store");
  assert.equal(rejected?.store, DOMAIN);
});

// --- Bulk -----------------------------------------------------------------------------
test("bulkOperationRunMutation ist gesperrt — auch deklariert", async () => {
  const { guard, entries } = bauGuard();
  guard.declareMutations({ felder: ["bulkOperationRunMutation"], budget: 5, grund: "Test" });
  await assert.rejects(() => guard.graphql('mutation B { bulkOperationRunMutation(mutation: "m", stagedUploadPath: "p") { bulkOperation { id } } }'),
    (e) => e.code === "bulk");
  assert.equal(entries.at(-1).grund, "bulk");
});

test("bulkOperationRunQuery läuft als Read — ohne Deklaration, mit unveränderten Opts", async () => {
  const { guard, calls } = bauGuard();
  const doc = 'mutation Q { bulkOperationRunQuery(query: "query { orders { edges { node { id } } } }") { bulkOperation { id } } }';
  await guard.graphql(doc, {}, { retryNetwork: true });
  const call = calls.find((c) => c.q === doc);
  assert.ok(call, "nicht durchgereicht");
  assert.equal(call.o?.retryNetwork, true, "Read-Opts wurden verändert");
  assert.equal(calls.filter((c) => c.q === IDENTITAET).length, 0, "Read-Ausnahme hat Identity ausgelöst");
});

// --- Deklarations-Regeln --------------------------------------------------------------
test("declareMutations: doppelt, verspätet und ungültig schlagen fehl; declared wird geloggt", async () => {
  const { guard, entries } = bauGuard();
  assert.throws(() => guard.declareMutations({ felder: [], budget: 5, grund: "x" }), /felder/);
  assert.throws(() => guard.declareMutations({ felder: ["a"], budget: 0, grund: "x" }), /budget/);
  assert.throws(() => guard.declareMutations({ felder: ["a"], budget: 3 }), /grund/);
  guard.declareMutations({ felder: ["productSet"], budget: 3, grund: "Januar-Block anlegen" });
  assert.throws(() => guard.declareMutations({ felder: ["productSet"], budget: 3, grund: "nochmal" }), /bereits/);
  const declared = entries.find((z) => z.typ === "declared");
  assert.equal(declared.grund, "Januar-Block anlegen");
  assert.deepEqual(declared.felder, ["productSet"]);
});

test("declareMutations NACH der ersten Mutation ist verspätet", async () => {
  const { guard } = bauGuard();
  await guard.graphql("query R { shop { name } }"); // Reads zählen nicht
  guard.declareMutations({ felder: ["productSet"], budget: 1, grund: "nach Reads ist ok" });
  await guard.graphql(M_PRODUCT_SET, {});
  assert.equal(guard.state().zaehler, 1);
});

test("isDeclared spiegelt den Zustand — Basis für Sammelkommandos", () => {
  const { guard } = bauGuard();
  assert.equal(guard.isDeclared(), false);
  guard.declareMutations({ felder: ["productSet"], budget: 1, grund: "x" });
  assert.equal(guard.isDeclared(), true);
});

// --- Write-Erkennung + kanonische Form ------------------------------------------------
test("fragment-first-Mutation gilt als Write und wird abgelehnt statt als Read wiederholt", async () => {
  const { guard, calls, entries } = bauGuard();
  guard.declareMutations({ felder: ["productSet"], budget: 5, grund: "x" });
  const doc = "fragment F on Product { id } mutation S($i: ProductSetInput!) { productSet(input: $i) { product { ...F } } }";
  assert.equal(istSchreibDokument(doc), true);
  await assert.rejects(() => guard.graphql(doc, {}), (e) => e.code === "form");
  assert.equal(calls.length, 0, "nicht-kanonisches Dokument wurde gesendet");
  assert.equal(entries.at(-1).grund, "form");
});

test("kanonische Form: Aliasse, mehrere Root-Felder, Block-Strings, Direktiven", () => {
  assert.equal(extrahiereRootFeld(M_PRODUCT_SET), "productSet");
  assert.equal(extrahiereRootFeld("mutation($item:ID!,$key:String!){ inventoryActivate(inventoryItemId:$item) @idempotent(key:$key) { inventoryLevel { id } } }"),
    "inventoryActivate", "Direktive @idempotent darf kein zweites Root-Feld erzeugen");
  assert.throws(() => extrahiereRootFeld("mutation M { a: productSet(input: {}) { id } }"), /Alias/);
  assert.throws(() => extrahiereRootFeld("mutation M { productSet(input: {}) { id } tagsAdd(id: \"x\") { id } }"), /Root-Felder/);
  assert.throws(() => extrahiereRootFeld('mutation M { productSet(input: { descriptionHtml: """x""" }) { id } }'), /Block-String/);
  assert.throws(() => extrahiereRootFeld("query Q { shop { name } }"), /beginnt nicht mit mutation/);
  assert.throws(() => extrahiereRootFeld("mutation M { productSet(input: {}) @ skip(if: false) { id } }"), /Root-Felder/);
  assert.throws(() => extrahiereRootFeld("mutation M { productSet(input: {}) { id } } fragment F on X { a }"), /Root-Felder/);
});

test('Reads mit "mutation" in String oder Kommentar bleiben Reads', async () => {
  const { guard, calls } = bauGuard();
  const suchQuery = 'query Q { products(query: "mutation") { edges { node { id } } } }';
  const kommentarQuery = "# hier stand mal eine mutation\nquery Q { shop { name } }";
  await guard.graphql(suchQuery);
  await guard.graphql(kommentarQuery);
  assert.equal(calls.filter((c) => c.q === suchQuery || c.q === kommentarQuery).length, 2);
  assert.equal(calls.filter((c) => c.q === IDENTITAET).length, 0, "Read hat Identity ausgelöst");
});

// --- Log-Semantik / Fehlerbesitz ------------------------------------------------------
test("attempt+result teilen die Korrelations-ID; store je Eintrag; variablen roh an attempt", async () => {
  const { guard, entries } = bauGuard({ id: () => "fix-id" });
  guard.declareMutations({ felder: ["productSet"], budget: 5, grund: "x" });
  await guard.graphql(M_PRODUCT_SET, { i: { html: "x".repeat(5000) } });
  const attempt = entries.find((z) => z.typ === "attempt");
  const result = entries.find((z) => z.typ === "result");
  assert.equal(attempt.id, "fix-id");
  assert.equal(result.id, "fix-id");
  assert.equal(result.status, "ok");
  assert.equal(attempt.store, DOMAIN);
  assert.equal(attempt.variablen.i.html.length, 5000, "der Guard reicht Variablen ROH weiter — Kürzung macht das Audit");
});

test("Client-Fehler erzeugt result-Zeile mit status error und wird weitergeworfen", async () => {
  const { guard, entries } = bauGuard({ graphqlImpl: async (q) => {
    if (q === IDENTITAET) return { shop: { myshopifyDomain: DOMAIN } };
    throw new Error("HTTP 502 Bad Gateway");
  } });
  guard.declareMutations({ felder: ["productSet"], budget: 5, grund: "x" });
  await assert.rejects(() => guard.graphql(M_PRODUCT_SET, {}), /502/);
  const result = entries.find((z) => z.typ === "result");
  assert.equal(result.status, "error");
  assert.match(result.fehler, /502/);
});

test("attempt() wirft (beliebige Ausnahme) → 'log', KEIN Budget verbraucht, nicht gesendet", async () => {
  // Mutierbares ctrl: erst wirft attempt, nach dem Fix schreibt es normal.
  const { guard, calls, ctrl } = bauGuard({ ctrl: { attempt: "EACCES" } });
  guard.declareMutations({ felder: ["productSet"], budget: 1, grund: "x" });
  await assert.rejects(() => guard.graphql(M_PRODUCT_SET, {}),
    (e) => e.code === "log" && e.message.includes("NICHT gesendet"));
  assert.equal(guard.state().zaehler, 0, "fehlgeschlagenes Attempt-Log hat Budget verbraucht");
  assert.equal(calls.filter((c) => c.q === M_PRODUCT_SET).length, 0, "Mutation trotz Log-Fehler gesendet");
  ctrl.attempt = false; // Log repariert → Wiederholung möglich (Budget nicht verbraucht)
  await guard.graphql(M_PRODUCT_SET, {});
  assert.equal(guard.state().zaehler, 1);
});

test("werfendes result() erreicht den Aufrufer NICHT (Tiefenverteidigung, Dublettenschutz)", async () => {
  const { guard } = bauGuard({ ctrl: { result: true } });
  guard.declareMutations({ felder: ["productSet"], budget: 5, grund: "x" });
  const ergebnis = await guard.graphql(M_PRODUCT_SET, {});
  assert.deepEqual(ergebnis, { ok: true }, "werfendes result() hat den Erfolg verfälscht");
});

test("werfendes declared()/rejected() erreicht den Aufrufer NICHT (echter Fehler bleibt)", async () => {
  const { guard } = bauGuard({ ctrl: { declared: true, rejected: true } });
  assert.doesNotThrow(() => guard.declareMutations({ felder: ["productSet"], budget: 1, grund: "x" }));
  // Undeklariertes Feld: rejected() wirft intern, der Guard schluckt es → der DENY-Fehler bleibt.
  await assert.rejects(() => guard.graphql(M_PUBLISH, {}), (e) => e.code === "deny");
});

// --- Retry-Semantik -------------------------------------------------------------------
test("Writes ohne Netz-Retry; explizites retryNetwork:true bleibt als Opt-in wirksam", async () => {
  const { guard, calls } = bauGuard();
  guard.declareMutations({ felder: ["productSet", "inventorySetQuantities"], budget: 5, grund: "x" });
  await guard.graphql(M_PRODUCT_SET, {});
  assert.equal(calls.find((c) => c.q === M_PRODUCT_SET).o.retryNetwork, false, "Default muss false erzwingen");
  const M_INV = "mutation I($i: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $i) { userErrors { message } } }";
  await guard.graphql(M_INV, {}, { retryNetwork: true });
  assert.equal(calls.find((c) => c.q === M_INV).o.retryNetwork, true, "bewusstes Opt-in wurde geschluckt");
});

// --- Kadenz v1.2.0 (Codex P1-1): Block-Strings dürfen den Lexer nicht im String-Zustand
// zurücklassen — sonst fiele ein späteres `mutation` weg und ein fragment-first-Dokument
// liefe als Read ungeguardet zum Transport.
test("Block-String mit einzelnem Anführungszeichen: fragment-first bleibt Write und wird abgelehnt", async () => {
  const { guard, calls } = bauGuard();
  guard.declareMutations({ felder: ["tagsAdd"], budget: 5, grund: "x" });
  const doc = 'fragment F on Mutation {\n  tagsAdd(id: $id, tags: ["""a"b"""]) { node { id } }\n}\nmutation M($id: ID!) { ...F }';
  assert.equal(istSchreibDokument(doc), true, "Block-String hat das spätere `mutation` verschluckt");
  await assert.rejects(() => guard.graphql(doc, { id: "gid://x" }), (e) => e.code === "form");
  assert.equal(calls.length, 0, "Bypass: nicht-kanonisches Write-Dokument erreichte den Transport");
});

test("Block-String-Varianten im Lexer: Escape, verschachtelte Quotes, danach zählt `mutation` wieder", () => {
  // \""" ist das einzige Escape im Block-String; danach ist das Dokument wieder „draußen".
  assert.equal(istSchreibDokument('query { a(b: """x\\"""y""") { c } } mutation'), true);
  assert.equal(istSchreibDokument('query { a(b: """ "mutation" """) { c } }'), false, "mutation IM Block-String ist Text");
  assert.equal(istSchreibDokument('query { a(b: """"") { c } }'), false, "unabgeschlossener Block-String (ungültiges GraphQL, Server lehnt ab): Rest ist String-Inhalt");
  // Eine echte Mutation mit Block-String-Argument bleibt Write (und scheitert dann an der Form-Regel).
  assert.equal(istSchreibDokument('mutation { productUpdate(input: {descriptionHtml: """x"y"""}) { product { id } } }'), true);
});
