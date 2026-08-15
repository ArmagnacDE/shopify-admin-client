// Store-Registry — bindet Store-Namen an geguardete Handles. Der Endpoint jedes Stores
// ist eine Code-Konstante (`expectedDomain`), die zugleich Allowlist UND API-Host ist;
// aus der Umgebung liest die Registry NUR `<PREFIX>_CLIENT_ID` und `<PREFIX>_CLIENT_SECRET`
// — KEIN `<PREFIX>_STORE`. Damit kann kein Env-Wert den Ziel-Host verschieben
// (Credential-Trennung ist strukturell, Design-Doc Praemisse 6).
//
// Lazy: Struktur (Namen, Domains, Praefixe, version) wird beim Bau geprueft; Credentials
// werden erst bei get(name) gelesen (fehlend -> Error, KEIN Netz); Token-Tausch und alles
// Weitere erst beim ersten graphql-Aufruf des Handles.
//
// Snapshot (Kadenz v1.2.0, Codex P1-3): die beim Bau validierten Werte werden in eine
// interne Map KOPIERT; get(name) liest ausschliesslich diesen Snapshot. Eine spaetere
// Mutation des uebergebenen `stores`-Objekts (Praefix umbiegen, Store nachschieben) hat
// keine Wirkung — sonst koennte Store A nach dem Bau die Credentials von B erhalten und
// ein nachgeschobener Eintrag die Dubletten-Pruefung umgehen.
//
// get(name) legt je Store den Mutation-Guard vor den Transport: `handle.graphql` ist
// `guard.graphql` (Writes geguardet, Reads direkt, kein Read-Preflight); die Audit-Instanz
// kommt aus `auditForStore(name, storeCfg)` (genau einmal je Name). Deklaration, Budget und
// Identitaets-Cache haengen je Guard-Instanz — ein Prozess kann B2C und B2B unabhaengig
// beruehren.

import { createShopifyClient, STORE_RE, VERSION_RE } from "./transport.js";
import { createMutationGuard } from "./mutation-guard.js";

// Praefix wie eine Env-Variable: Grossbuchstabe zuerst, dann Grossbuchstaben/Ziffern/_.
const PREFIX_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * @param {object} opts
 * @param {{ [name: string]: { expectedDomain: string, envPrefix: string, version: string, label?: string } }} opts.stores
 *        Store-Konstanten. `version` ist PFLICHT je Store (Code-Konstante wie die Domain
 *        — sonst faellt der Transport-Default auf einen Env-/Client-Wert zurueck, S0-A18).
 * @param {NodeJS.ProcessEnv} [opts.env]  Umgebung (Default process.env). Gelesen werden
 *        nur `<envPrefix>_CLIENT_ID` und `<envPrefix>_CLIENT_SECRET`.
 * @param {(name: string, storeCfg: object) => object} opts.auditForStore  Audit-Fabrik je
 *        Store (Pflicht). get(name) ruft sie genau einmal je Name (Handle memoisiert) und
 *        übergibt das Audit an den Guard.
 * @param {typeof fetch} [opts.fetch]  Transport injizierbar (bis in den Transport, zur
 *        Aufrufzeit aufgeloest) — fuer Tests/Fehlerbild-Test 1.
 * @returns {{ get: (name: string) => object }}  get(name) → Store-Handle
 *        { graphql, declareMutations, isDeclared, verifyIdentity, config, state }.
 */
export function createStoreRegistry({ stores, env = process.env, auditForStore, fetch } = {}) {
  // --- Bauzeit-Pruefungen (kein Netz, keine Credentials) ------------------------------
  if (!stores || typeof stores !== "object") {
    throw new Error("createStoreRegistry: stores muss ein Objekt { name: config } sein.");
  }
  if (typeof auditForStore !== "function") {
    throw new Error("createStoreRegistry: auditForStore muss eine Funktion sein (Audit je Store).");
  }
  if (fetch !== undefined && typeof fetch !== "function") {
    throw new Error("createStoreRegistry: fetch muss eine Funktion sein, wenn gesetzt.");
  }
  if (!env || typeof env !== "object") {
    throw new Error("createStoreRegistry: env muss ein Objekt sein.");
  }

  const names = Object.keys(stores).filter((n) => Object.hasOwn(stores, n));
  if (names.length === 0) {
    throw new Error("createStoreRegistry: stores ist leer — mindestens ein Store noetig.");
  }

  const seenDomains = new Map(); // normalisierte Domain -> Store-Name
  const seenPrefixes = new Map(); // normalisiertes Praefix -> Store-Name
  const snapshot = new Map(); // name -> eingefrorene, validierte Kopie (einzige Quelle fuer get)

  for (const name of names) {
    const cfg = stores[name];
    if (!cfg || typeof cfg !== "object") {
      throw new Error(`createStoreRegistry: Store "${name}" hat keine Konfiguration.`);
    }
    const { expectedDomain, envPrefix, version } = cfg;

    if (!expectedDomain || !STORE_RE.test(expectedDomain)) {
      throw new Error(
        `createStoreRegistry: Store "${name}" hat ungueltige expectedDomain "${expectedDomain}". ` +
          "Erwartet <shop>.myshopify.com."
      );
    }
    if (!envPrefix) {
      throw new Error(`createStoreRegistry: Store "${name}" hat keinen envPrefix.`);
    }
    const prefix = String(envPrefix).toUpperCase();
    if (!PREFIX_RE.test(prefix)) {
      throw new Error(
        `createStoreRegistry: Store "${name}" hat ungueltigen envPrefix "${envPrefix}". ` +
          "Erwartet ^[A-Z][A-Z0-9_]*$ (z. B. WAGEMUT_B2C)."
      );
    }
    // version PFLICHT (S0-A18): ohne Pin faellt der Transport auf seinen Default zurueck.
    if (!version || typeof version !== "string") {
      throw new Error(
        `createStoreRegistry: Store "${name}" hat keine version. version ist Pflicht je Store ` +
          "(Code-Konstante, z. B. \"2026-04\") — kein Rueckfall auf den Client-Default."
      );
    }
    // Dieselbe Regel wie im Transport, aber schon beim BAU (sonst faellt "2026-99" erst
    // beim ersten get() auf — Codex P3-1).
    if (!VERSION_RE.test(version)) {
      throw new Error(
        `createStoreRegistry: Store "${name}" hat ungueltige version "${version}". ` +
          "Erwartet JJJJ-MM (z. B. \"2026-04\") oder \"unstable\"."
      );
    }

    const normDomain = expectedDomain.toLowerCase();
    if (seenDomains.has(normDomain)) {
      throw new Error(
        `createStoreRegistry: expectedDomain "${expectedDomain}" doppelt (Stores ` +
          `"${seenDomains.get(normDomain)}" und "${name}").`
      );
    }
    seenDomains.set(normDomain, name);

    if (seenPrefixes.has(prefix)) {
      throw new Error(
        `createStoreRegistry: envPrefix "${prefix}" doppelt (Stores ` +
          `"${seenPrefixes.get(prefix)}" und "${name}").`
      );
    }
    seenPrefixes.set(prefix, name);

    // Validierte Werte kopieren und einfrieren — get() liest NUR den Snapshot. Flache Kopie
    // inkl. etwaiger Zusatzfelder (die gehen unveraendert an auditForStore), aber die vier
    // sicherheitsrelevanten Felder sind die hier geprueften Strings.
    snapshot.set(name, Object.freeze({
      ...cfg,
      expectedDomain,
      envPrefix: prefix,
      version,
      label: cfg.label ? String(cfg.label) : name,
    }));
  }

  // --- Lazy get(name), memoisiert je Registry-Instanz --------------------------------
  const handles = new Map(); // name -> Handle (nur bei Erfolg gecacht)

  function get(name) {
    if (!snapshot.has(name)) {
      throw new Error(
        `Store "${name}" ist unbekannt. Bekannte Stores: ${names.map((n) => `"${n}"`).join(", ")}.`
      );
    }
    if (handles.has(name)) return handles.get(name);

    const cfg = snapshot.get(name); // NICHT stores[name] — das Eingabeobjekt ist veraenderlich
    const prefix = cfg.envPrefix;
    const clientId = env[`${prefix}_CLIENT_ID`];
    const clientSecret = env[`${prefix}_CLIENT_SECRET`];
    if (!clientId || !clientSecret) {
      // Fehlende Credentials: klare Meldung, KEIN Netz — und NICHT memoisieren, damit
      // ein Retry nach gesetzter Env funktioniert (Fehl-get nicht cachen).
      throw new Error(
        `Store "${name}": ${prefix}_CLIENT_ID und ${prefix}_CLIENT_SECRET fehlen in der Umgebung. ` +
          "Nur diese beiden Werte liest die Registry (kein _STORE)."
      );
    }

    const client = createShopifyClient({
      store: cfg.expectedDomain, // Endpoint = Code-Konstante, nie aus der Env
      clientId,
      clientSecret,
      version: cfg.version, // Pflicht: kein Env-/Client-Default erreicht den Endpoint-Pfad
      label: cfg.label || name,
      fetch, // bis in den Transport durchgereicht (zur Aufrufzeit aufgeloest)
    });

    // Audit-Instanz je Store (genau einmal je Name — get memoisiert das Handle).
    const audit = auditForStore(name, cfg);
    // Guard vor den Transport: Writes geguardet, Reads direkt. Identitaets-Cache,
    // Deklaration und Budget haengen an dieser Guard-Instanz.
    const guard = createMutationGuard({
      graphql: client.graphql,
      expectedDomain: cfg.expectedDomain,
      audit,
    });

    const handle = {
      graphql: guard.graphql, // geguardet (Reads direkt, Writes vor dem ersten Send geprueft)
      declareMutations: guard.declareMutations,
      isDeclared: guard.isDeclared,
      verifyIdentity: guard.verifyIdentity, // der EINE Identitaets-Cache je Handle
      config: client.config, // { store, version, endpoint, label }
      state: guard.state,
    };

    handles.set(name, handle); // nur bei Erfolg
    return handle;
  }

  return { get };
}
