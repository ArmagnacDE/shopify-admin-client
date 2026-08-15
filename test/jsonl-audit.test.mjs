// createJsonlAudit: Audit-Vertrag, Feldkürzung (Default über den ganzen Eintrag),
// transformVariables (nur variablen), Lazy-mkdir, location(), Fehlerbesitz je Methode.
// Kein echtes fs: append/mkdir/warn injiziert.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createJsonlAudit, kuerzeFuerLog } from "../jsonl-audit.js";

const FIX = () => new Date("2026-08-15T22:00:00Z");
// Plattformneutral (Windows liefert Backslashes): dieselbe join-Regel wie der Code.
const MONATSDATEI = join("logs-test", "shopify-mutations-2026-08.jsonl");

function bauAudit(extra = {}) {
  const log = [];
  const warnungen = [];
  const mkdirs = [];
  const audit = createJsonlAudit({
    directory: "logs-test",
    now: FIX,
    pid: 4711,
    append: (pfad, zeile) => log.push({ pfad, zeile: JSON.parse(zeile) }),
    mkdir: (dir, o) => mkdirs.push({ dir, o }),
    warn: (m) => warnungen.push(m),
    ...extra,
  });
  return { audit, log, warnungen, mkdirs };
}

test("location() = Monatsdatei im Verzeichnis", () => {
  const { audit } = bauAudit();
  assert.equal(audit.location(), MONATSDATEI);
});

test("declared/attempt/result/rejected schreiben ts, pid, typ + Guard-Felder", () => {
  const { audit, log } = bauAudit();
  audit.declared({ store: "a.myshopify.com", felder: ["productSet"], budget: 5, grund: "Test" });
  audit.attempt({ store: "a.myshopify.com", id: "id1", feld: "productSet", nr: 1, variablen: { i: {} } });
  audit.result({ store: "a.myshopify.com", id: "id1", feld: "productSet", status: "ok" });
  audit.rejected({ store: "a.myshopify.com", grund: "deny", feld: "publishablePublish" });

  assert.deepEqual(log.map((l) => l.zeile.typ), ["declared", "attempt", "result", "rejected"]);
  for (const l of log) {
    assert.equal(l.zeile.ts, "2026-08-15T22:00:00.000Z");
    assert.equal(l.zeile.pid, 4711);
    assert.equal(l.zeile.store, "a.myshopify.com");
    assert.equal(l.pfad, MONATSDATEI);
  }
});

test("lazy: mkdir erst beim ERSTEN Eintrag, dann nicht mehr", () => {
  const { audit, mkdirs } = bauAudit();
  assert.equal(mkdirs.length, 0, "Bau darf kein mkdir auslösen");
  audit.declared({ store: "a.myshopify.com", felder: ["x"], budget: 1, grund: "g" });
  audit.attempt({ store: "a.myshopify.com", id: "i", feld: "x", nr: 1, variablen: {} });
  assert.equal(mkdirs.length, 1, "mkdir genau einmal (lazy, dann gecacht)");
});

test("Feldkürzung ist DEFAULT über den GESAMTEN Eintrag (auch fehler in result)", () => {
  const { audit, log } = bauAudit();
  audit.attempt({ store: "a.myshopify.com", id: "i", feld: "productSet", nr: 1, variablen: { i: { html: "x".repeat(5000) } } });
  audit.result({ store: "a.myshopify.com", id: "i", feld: "productSet", status: "error", fehler: "y".repeat(3000) });
  const attempt = log.find((l) => l.zeile.typ === "attempt");
  const result = log.find((l) => l.zeile.typ === "result");
  assert.match(attempt.zeile.variablen.i.html, /\[gekürzt 5000 Zeichen\]$/);
  assert.match(result.zeile.fehler, /\[gekürzt 3000 Zeichen\]$/);
});

test("transformVariables sieht NUR variablen und läuft VOR der Kürzung", () => {
  const gesehen = [];
  const { audit, log } = bauAudit({
    transformVariables: (v) => {
      gesehen.push(v);
      return { redigiert: true };
    },
  });
  audit.attempt({ store: "a.myshopify.com", id: "i", feld: "productSet", nr: 1, variablen: { email: "kunde@example.com" } });
  assert.deepEqual(gesehen, [{ email: "kunde@example.com" }]);
  assert.deepEqual(log[0].zeile.variablen, { redigiert: true });
});

test("transformVariables wird NICHT auf declared/rejected angewandt (kein variablen-Feld)", () => {
  let aufrufe = 0;
  const { audit, log } = bauAudit({ transformVariables: (v) => { aufrufe++; return v; } });
  audit.declared({ store: "a.myshopify.com", felder: ["x"], budget: 1, grund: "g" });
  audit.rejected({ store: "a.myshopify.com", grund: "deny", feld: "x" });
  assert.equal(aufrufe, 0);
  assert.equal(log.length, 2);
});

test("attempt WIRFT bei Schreibfehler (fail-closed), warnt NICHT", () => {
  const warnungen = [];
  const audit = createJsonlAudit({
    directory: "logs-test", now: FIX, pid: 1, mkdir: () => {}, warn: (m) => warnungen.push(m),
    append: () => { throw new Error("EACCES"); },
  });
  assert.throws(() => audit.attempt({ store: "a.myshopify.com", id: "i", feld: "x", nr: 1, variablen: {} }), /EACCES/);
  assert.equal(warnungen.length, 0, "attempt darf nicht warnen — es wirft");
});

test("declared/result/rejected WARNEN bei Schreibfehler, werfen NIE", () => {
  const warnungen = [];
  const audit = createJsonlAudit({
    directory: "logs-test", now: FIX, pid: 1, mkdir: () => {}, warn: (m) => warnungen.push(m),
    append: () => { throw new Error("Platte voll"); },
  });
  assert.doesNotThrow(() => audit.declared({ store: "a.myshopify.com", felder: ["x"], budget: 1, grund: "g" }));
  assert.doesNotThrow(() => audit.result({ store: "a.myshopify.com", id: "i", feld: "x", status: "ok" }));
  assert.doesNotThrow(() => audit.rejected({ store: "a.myshopify.com", grund: "deny", feld: "x" }));
  assert.equal(warnungen.length, 3);
  assert.ok(warnungen.every((w) => /nicht schreibbar/.test(w)));
});

test("werfendes warn() erreicht den Aufrufer nicht (Tiefenverteidigung)", () => {
  const audit = createJsonlAudit({
    directory: "logs-test", now: FIX, pid: 1, mkdir: () => {},
    append: () => { throw new Error("Platte voll"); },
    warn: () => { throw new Error("Logger kaputt"); },
  });
  assert.doesNotThrow(() => audit.result({ store: "a.myshopify.com", id: "i", feld: "x", status: "ok" }));
});

test("directory Pflicht; transformVariables muss Funktion sein", () => {
  assert.throws(() => createJsonlAudit({}), /directory fehlt/);
  assert.throws(() => createJsonlAudit({ directory: "x", transformVariables: 1 }), /transformVariables muss eine Funktion/);
});

test("kuerzeFuerLog: kurze Werte und Nicht-Strings unangetastet", () => {
  assert.deepEqual(kuerzeFuerLog({ a: "kurz", b: 7, c: [true, null] }), { a: "kurz", b: 7, c: [true, null] });
});

// --- Kadenz v1.2.0 -------------------------------------------------------------------
test("transformVariables arbeitet auf einer KOPIE — der echte Write bleibt unverändert (Codex P2-1)", () => {
  // In-place redigierender Transform, wie er in einem Firmen-Repo naheliegt.
  const { audit, log } = bauAudit({
    transformVariables: (v) => { delete v.input.customer.email; v.input.customer.name = "[redigiert]"; return v; },
  });
  const variablen = { input: { customer: { email: "k@example.com", name: "Kunde" }, note: "x" } };
  audit.attempt({ store: "a.myshopify.com", id: "1", feld: "draftOrderCreate", nr: 1, variablen });
  // Log ist redigiert …
  assert.deepEqual(log[0].zeile.variablen, { input: { customer: { name: "[redigiert]" }, note: "x" } });
  // … die Referenz, die der Guard danach an den Transport gibt, NICHT.
  assert.deepEqual(variablen, { input: { customer: { email: "k@example.com", name: "Kunde" }, note: "x" } },
    "Transform hat die echten Mutations-Variablen verändert");
});

test("nicht kopierbare variablen: Transform wird übersprungen, Eintrag markiert, kein Wurf", () => {
  const { audit, log } = bauAudit({ transformVariables: () => { throw new Error("darf nicht laufen"); } });
  const variablen = { fn: () => 1 }; // structuredClone kann keine Funktionen
  assert.doesNotThrow(() => audit.attempt({ store: "a.myshopify.com", id: "1", feld: "x", nr: 1, variablen }));
  assert.match(log[0].zeile.variablen, /nicht kopierbar/);
});

test("ts und Monatsdatei stammen aus DEMSELBEN Zeitpunkt (Codex P3-2, Monatswechsel)", () => {
  // now() springt bei jedem Aufruf einen Monat weiter: zwei now()-Aufrufe je Eintrag
  // würden August-ts in die September-Datei schreiben.
  let n = 0;
  const now = () => new Date(Date.UTC(2026, 7 + n++, 15, 12));
  const { audit, log } = bauAudit({ now });
  audit.attempt({ store: "a.myshopify.com", id: "1", feld: "x", nr: 1, variablen: {} });
  assert.equal(log[0].zeile.ts, "2026-08-15T12:00:00.000Z");
  assert.equal(log[0].pfad, join("logs-test", "shopify-mutations-2026-08.jsonl"));
});

test("werfender transformVariables: attempt wirft mit klarer Ursache (nicht „Log nicht schreibbar“)", () => {
  const { audit } = bauAudit({ transformVariables: (v) => { delete v.input.customer.email; return v; } });
  // Anderer Variablen-Shape als vom Transform angenommen → TypeError im Transform.
  assert.throws(
    () => audit.attempt({ store: "a.myshopify.com", id: "1", feld: "productSet", nr: 1, variablen: { input: {} } }),
    /transformVariables hat geworfen/
  );
});

test("kuerzeFuerLog: Date/Buffer werden wie im Transport (toJSON) geloggt, nicht als {}", () => {
  const d = new Date("2026-08-15T22:00:00Z");
  assert.equal(kuerzeFuerLog(d), "2026-08-15T22:00:00.000Z");
  assert.deepEqual(kuerzeFuerLog({ when: d }), { when: "2026-08-15T22:00:00.000Z" });
  assert.equal(kuerzeFuerLog(Buffer.from("ab")).type, "Buffer");
});
