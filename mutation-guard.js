// Mutation-Guard — Default-Deny-Schranke vor jeder Shopify-Mutation. Instanzbasiert:
// ein Guard je Store (Deklaration, Budget, Identitäts-Cache je Instanz), damit ein
// Prozess B2C und B2B unabhängig berühren kann. Kein Shopify-Write ohne vorherige
// Code-Deklaration `declareMutations({felder, budget, grund})` — der Guard entscheidet
// nicht, was „gut" ist, er erzwingt, dass die Absicht als exaktes Token im Code steht,
// BEVOR etwas wirkt.
//
// Prüfreihenfolge je Write (Reads laufen unberührt durch) — BEIBEHALTEN (D-S0-2):
//   Form → Identität → Bulk → Deny → Budget.
//   1. Kanonische Form: mutation-first, genau EIN Root-Feld. Unparsebares wird
//      ABGELEHNT, nie geraten (kein GraphQL-Parser, Spec Prämisse 11).
//   2. Live-Shop-Identität: `verifyShopIdentity` gegen die Code-Konstante expectedDomain,
//      genau EINMAL pro Instanz (gecachte Single-Flight-Promise; auch eine Ablehnung
//      bleibt gecacht). Innerhalb der Registry ist der Endpoint bereits die Konstante —
//      der eigentliche Schutz gegen „falscher Shop" ist Endpoint = Konstante + Token-
//      Bindung; die Prüfung bleibt aus Kompatibilität + Standalone-Nutzbarkeit.
//   3. bulkOperationRunMutation: immer Abbruch, nicht deklarierbar — 1 Zähler-Tick mit
//      unbegrenzten Writes wäre die triviale Umgehung des Budgets.
//   4. Default-Deny: Root-Feld muss in den deklarierten Feldern stehen.
//   5. Budget: Zähler gegen die deklarierte Obergrenze.
//
// Audit: der Guard ist audit-agnostisch (Vertrag declared/attempt/result/rejected/
// location, alle synchron). `attempt` läuft VOR dem Send; wirft es, übersetzt der Guard
// die Ausnahme in MutationGuardError('log') — fail-closed, kein Budget verbraucht.
// declared/result/rejected dürfen laut Vertrag nie werfen; der Guard fängt Ausnahmen
// daraus TROTZDEM ab (Tiefenverteidigung — nach erfolgreichem Send darf kein Audit-
// Fehler als „Write gescheitert" beim Aufrufer landen, Dubletten-Schutz). Jeder Eintrag
// trägt zusätzlich `store: expectedDomain` (zwei Handles in EINEM Log unterscheidbar).

import { randomUUID } from "node:crypto";
import { MutationGuardError } from "./errors.js";
import { verifyShopIdentity } from "./identity.js";

export { MutationGuardError } from "./errors.js";

const READ_AUSNAHMEN = new Set(["bulkOperationRunQuery"]);

// Deklaration validieren (aus dem Client, damit die armagnac-Fassade den gepufferten
// Puffer SOFORT prüfen kann — S0-A8).
export function validateDeclaration({ felder, budget, grund } = {}) {
  if (!Array.isArray(felder) || felder.length === 0 || felder.some((f) => typeof f !== "string" || !f.trim())) {
    throw new MutationGuardError("declare", "felder muss eine nicht-leere Liste von Root-Feld-Namen sein.");
  }
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new MutationGuardError("declare", `budget muss eine positive Ganzzahl sein (ist: ${budget}).`);
  }
  if (typeof grund !== "string" || !grund.trim()) {
    throw new MutationGuardError("declare", "grund fehlt — der fachliche Anlass gehört in die Deklaration.");
  }
}

// Strings ("..."), Block-Strings ("""...""") und #-Kommentare aus einem GraphQL-Dokument
// entfernen — der leichte Lexer, den die Write-Erkennung braucht: `query { p(q: "mutation") }`
// ist ein Read und darf NICHT blockieren, während das Schlüsselwort außerhalb von Strings
// überall zählt. Block-Strings sind ein EIGENER Zustand (Kadenz v1.2.0, Codex P1): als Folge
// einfacher Anführungszeichen gelesen ließe `"""a"b"""` den Lexer im String-Zustand zurück,
// der Rest des Dokuments (inkl. eines späteren `mutation`) fiele weg — Guard-Bypass per
// fragment-first. Innerhalb eines Block-Strings zählt nur `\"""` als Escape.
export function ohneStringsUndKommentare(doc) {
  let out = "";
  let inString = false;
  let inBlock = false;
  let inKommentar = false;
  for (let i = 0; i < doc.length; i++) {
    const c = doc[i];
    if (inKommentar) { if (c === "\n") { inKommentar = false; out += c; } continue; }
    if (inBlock) {
      if (c === "\\" && doc.startsWith('"""', i + 1)) { i += 3; continue; }
      if (doc.startsWith('"""', i)) { inBlock = false; i += 2; }
      continue;
    }
    if (inString) {
      if (c === "\\") { i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === "#") { inKommentar = true; continue; }
    if (doc.startsWith('"""', i)) { inBlock = true; i += 2; continue; }
    if (c === '"') { inString = true; continue; }
    out += c;
  }
  return out;
}

/** Write-Erkennung: `mutation` irgendwo AUSSERHALB von Strings/Kommentaren (fragment-first
 *  zählt, Suchbegriffe nicht).
 *
 *  BEWUSST NICHT UMGESETZT (Kadenz v1.2.0, Codex P1-2 → als P3 eingestuft): Eine Query, deren
 *  Operationsname, Alias oder Enum-Wert wörtlich `mutation` lautet (`query mutation { … }`),
 *  wird als Write eingestuft und scheitert dann laut mit `form` — nie still. Ein Tokenizer, der
 *  nur den Operationstyp je Definition liest, wäre die Lösung, ist aber ein Parser durch die
 *  Hintertür (Prämisse 11) und ändert die Klassifikation der migrierten armagnac-Fassung.
 *  Wortlaut `mutation` als Bezeichner kommt in Shopify-Dokumenten praktisch nicht vor; die
 *  Kosten sind ein klarer Fehlertext, das Umbenennen des Bezeichners behebt ihn. */
export function istSchreibDokument(query) {
  return /\bmutation\b/.test(ohneStringsUndKommentare(String(query)));
}

/**
 * Kanonische Form prüfen und das EINE Root-Feld extrahieren. Wirft MutationGuardError
 * ('form') bei fragment-first, Block-Strings, Aliassen, mehreren Root-Feldern,
 * unbalancierten Klammern. Kein Parser — ein enger Zeichen-Scan mit fail-closed-Default.
 */
export function extrahiereRootFeld(query) {
  const doc = String(query);
  const form = (was) => new MutationGuardError("form",
    `Dokument nicht in kanonischer Form (${was}). Konvention: mutation-first, genau `
    + "ein Root-Feld, keine Aliasse/Block-Strings — siehe shopify-admin-client/guard.");

  if (doc.includes('"""')) throw form("Block-String");
  const gestrippt = doc.replace(/^\s*(?:#[^\n]*\n\s*)*/, "");
  if (!/^mutation\b/.test(gestrippt)) throw form("beginnt nicht mit mutation");

  let tiefe = 0;
  let klammern = 0;
  let inString = false;
  let inKommentar = false;
  const rootFelder = [];
  let i = 0;
  while (i < gestrippt.length) {
    const c = gestrippt[i];
    if (inKommentar) { if (c === "\n") inKommentar = false; i++; continue; }
    if (inString) {
      if (c === "\\") { i += 2; continue; }
      if (c === '"') inString = false;
      i++; continue;
    }
    if (c === "#") { inKommentar = true; i++; continue; }
    if (c === '"') { inString = true; i++; continue; }
    if (c === "{") { tiefe++; i++; continue; }
    if (c === "}") { tiefe--; if (tiefe < 0) throw form("unbalancierte Klammern"); i++; continue; }
    if (c === "(") { klammern++; i++; continue; }
    if (c === ")") { klammern--; if (klammern < 0) throw form("unbalancierte Klammern"); i++; continue; }
    if (tiefe === 1 && klammern === 0) {
      if (c === ":") throw form("Alias auf Root-Ebene");
      const rest = gestrippt.slice(i);
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
      if (m) {
        // Direktiven (@idempotent) und Variablen ($x) sind keine Felder — den GANZEN
        // Bezeichner überspringen, sonst wird sein Rest als zweites Root-Feld gelesen.
        i += m[0].length;
        if (gestrippt[i - m[0].length - 1] !== "$" && gestrippt[i - m[0].length - 1] !== "@") {
          rootFelder.push(m[0]);
        }
        continue;
      }
    }
    i++;
  }
  if (tiefe !== 0 || klammern !== 0 || inString) throw form("unbalancierte Klammern");
  if (rootFelder.length !== 1) throw form(`${rootFelder.length} Root-Felder`);
  return rootFelder[0];
}

/**
 * Eine Guard-Instanz. Die Registry erzeugt je Store genau eine; Tests bauen eigene mit
 * Mock-graphql und Fake-Audit.
 *
 * @param {object} opts
 * @param {(q:string,v?:object,o?:object)=>Promise<object>} opts.graphql  roher Client-Aufruf (Reads frei)
 * @param {string}   opts.expectedDomain  erwartete myshopify-Domain (Code-Konstante) — Pflicht
 * @param {object}   opts.audit           Audit-Vertrag (declared/attempt/result/rejected/location?) — Pflicht
 * @param {()=>string} [opts.id]          Korrelations-ID je Sendeversuch (Default randomUUID)
 * @returns {{ graphql:Function, declareMutations:Function, isDeclared:()=>boolean, verifyIdentity:()=>Promise<string>, state:()=>object }}
 */
export function createMutationGuard({ graphql, expectedDomain, audit, id = randomUUID } = {}) {
  if (typeof graphql !== "function") {
    throw new MutationGuardError("init", "graphql-Funktion fehlt beim Guard-Aufbau.");
  }
  if (!expectedDomain) {
    throw new MutationGuardError("init", "expectedDomain fehlt beim Guard-Aufbau.");
  }
  if (!audit || typeof audit.attempt !== "function") {
    throw new MutationGuardError("init", "audit fehlt beim Guard-Aufbau — ohne Audit keine freigegebenen Writes.");
  }

  let deklaration = null;          // { felder:Set, budget, grund }
  let zaehler = 0;
  let letzteOperation = null;
  let ersteMutationLief = false;   // ab dann ist declareMutations verspätet
  let identityPromise = null;      // der EINZIGE Identitäts-Cache je Instanz

  const ort = () => (typeof audit.location === "function" ? audit.location() : null);

  // Guard trägt `store` je Eintrag bei und schluckt Ausnahmen der nicht-fail-closed-
  // Methoden (Tiefenverteidigung). `attempt` NICHT hier — dessen Fehler ist fail-closed.
  const auditDeclared = (e) => { try { audit.declared({ store: expectedDomain, ...e }); } catch { /* geschluckt */ } };
  const auditResult = (e) => { try { audit.result({ store: expectedDomain, ...e }); } catch { /* geschluckt */ } };
  const auditRejected = (grund, feld) => { try { audit.rejected({ store: expectedDomain, grund, feld: feld ?? null }); } catch { /* geschluckt */ } };

  const verifyIdentity = () => {
    if (!identityPromise) identityPromise = verifyShopIdentity(graphql, { expectedDomain });
    return identityPromise;
  };

  function declareMutations({ felder, budget, grund } = {}) {
    if (deklaration) {
      throw new MutationGuardError("declare", "declareMutations wurde bereits aufgerufen — einmal pro Prozess.");
    }
    if (ersteMutationLief) {
      throw new MutationGuardError("declare", "declareMutations kam NACH der ersten Mutation — Deklaration gehört vor den ersten Write.");
    }
    validateDeclaration({ felder, budget, grund });
    deklaration = { felder: new Set(felder), budget, grund };
    auditDeclared({ felder: [...felder], budget, grund });
  }

  async function guardedGraphql(query, variables = {}, opts = {}) {
    if (!istSchreibDokument(query)) return graphql(query, variables, opts);

    // 1. Kanonische Form zuerst — auch die Read-Ausnahme hängt am Root-Feld.
    let feld;
    try {
      feld = extrahiereRootFeld(query);
    } catch (e) {
      auditRejected("form", null);
      throw e;
    }
    if (READ_AUSNAHMEN.has(feld)) return graphql(query, variables, opts);

    // 2. Identität (einmal pro Instanz, fail-closed). Auch diese Ablehnung ins Log —
    //    der Wrong-Store-Versuch ist forensisch der interessanteste.
    try {
      await verifyIdentity();
    } catch (e) {
      auditRejected(e?.code === "store" ? "store" : "identitaet", null);
      throw e;
    }

    // 3. Bulk-Mutationen sind nicht deklarierbar.
    if (feld === "bulkOperationRunMutation") {
      auditRejected("bulk", feld);
      throw new MutationGuardError("bulk",
        "bulkOperationRunMutation ist gesperrt: ein Zähler-Tick mit unbegrenzten Writes würde das Budget aushebeln.");
    }

    // 4. Default-Deny gegen die Deklaration.
    if (!deklaration) {
      auditRejected("deny", feld);
      throw new MutationGuardError("deny",
        `Mutation "${feld}" ohne Deklaration. Vor dem ersten Write gehört in das Skript: `
        + `declareMutations({ felder: ['${feld}'], budget: <Zahl>, grund: '<Anlass>' }) — `
        + "beim Bauen eintragen; der Live-Lauf verlangt die Freigabe des Shop-Verantwortlichen.");
    }
    if (!deklaration.felder.has(feld)) {
      auditRejected("deny", feld);
      throw new MutationGuardError("deny",
        `Mutation "${feld}" ist nicht deklariert (deklariert: ${[...deklaration.felder].join(", ")}). `
        + "Deklaration erweitern; die Erweiterung braucht die Freigabe des Shop-Verantwortlichen.");
    }

    // 5. Budget.
    if (zaehler + 1 > deklaration.budget) {
      auditRejected("budget", feld);
      const logOrt = ort();
      throw new MutationGuardError("budget",
        `Budget erschöpft: ${zaehler} von ${deklaration.budget} Mutationen gesendet, `
        + `"${feld}" wäre Nr. ${zaehler + 1}. Letzte Operation: ${letzteOperation ?? "—"}. `
        + (logOrt ? `Was bereits lief, steht im Log: ${logOrt}. ` : "")
        + "Wiederaufnahme nach Prüfung; Budget nur mit Freigabe des Shop-Verantwortlichen erhöhen.");
    }

    // 6. attempt VOR dem Send (fail-closed) — und VOR dem Zählen: scheitert das Attempt-
    //    Log, wurde nichts gesendet, also kein Budget verbraucht, keine „letzte Operation".
    const korrId = id();
    try {
      audit.attempt({ store: expectedDomain, id: korrId, feld, nr: zaehler + 1, variablen: variables });
    } catch (e) {
      const logOrt = ort();
      throw new MutationGuardError("log",
        `Mutations-Log nicht schreibbar (${e?.message ?? e}) — Mutation NICHT gesendet.`
        + (logOrt ? ` Log: ${logOrt}. Im Container muss das Log-Verzeichnis ein beschreibbares Volume sein.` : ""));
    }
    zaehler++;
    letzteOperation = feld;
    ersteMutationLief = true;
    try {
      // Kein Netz-Retry für Writes — außer ein Aufrufer verlangt es EXPLIZIT
      // (retryNetwork:true, bewusstes Opt-in einer @idempotent-Mutation).
      const retryNetwork = opts.retryNetwork === true;
      const ergebnis = await graphql(query, variables, { ...opts, retryNetwork });
      auditResult({ id: korrId, feld, status: "ok" });
      return ergebnis;
    } catch (e) {
      auditResult({ id: korrId, feld, status: "error", fehler: String(e?.message ?? e) });
      throw e;
    }
  }

  return {
    graphql: guardedGraphql,
    declareMutations,
    isDeclared: () => deklaration !== null,
    verifyIdentity,
    /** Nur für Tests/Diagnose: aktueller Zählerstand und Deklaration. */
    state: () => ({
      zaehler,
      letzteOperation,
      deklariert: deklaration ? { felder: [...deklaration.felder], budget: deklaration.budget } : null,
    }),
  };
}
