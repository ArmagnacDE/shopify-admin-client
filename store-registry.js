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
// STAND S1: get(name) liefert ein Handle auf Basis des Transports plus verifyIdentity.
// Der Mutation-Guard (declareMutations/isDeclared/state, Writes vor dem ersten Send
// geguardet) und der Audit-Verbrauch von `auditForStore` kommen in S2 — bis dahin ist
// `graphql` der ROHE Transport (ungeguardet). Der Tag v1.2.0 entsteht erst NACH S2, es
// wird also nie ein ungeguardeter Zwischenstand veroeffentlicht.

import { createShopifyClient, STORE_RE } from "./transport.js";
import { verifyShopIdentity } from "./identity.js";

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
 *        Store (Pflicht). Der Guard (S2) ruft sie je Handle genau einmal; in S1 wird sie
 *        beim Bau als Funktion geprueft, aber noch nicht aufgerufen.
 * @param {typeof fetch} [opts.fetch]  Transport injizierbar (bis in den Transport, zur
 *        Aufrufzeit aufgeloest) — fuer Tests/Fehlerbild-Test 1.
 * @returns {{ get: (name: string) => object }}
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
  }

  // --- Lazy get(name), memoisiert je Registry-Instanz --------------------------------
  const handles = new Map(); // name -> Handle (nur bei Erfolg gecacht)

  function get(name) {
    if (!Object.hasOwn(stores, name)) {
      throw new Error(
        `Store "${name}" ist unbekannt. Bekannte Stores: ${names.map((n) => `"${n}"`).join(", ")}.`
      );
    }
    if (handles.has(name)) return handles.get(name);

    const cfg = stores[name];
    const prefix = String(cfg.envPrefix).toUpperCase();
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

    // Ein Identitaets-Cache je Handle: Single-Flight, auch eine Ablehnung bleibt gecacht.
    // (In S2 uebernimmt der Guard diesen Cache; bis dahin haelt das Handle ihn direkt.)
    let identityPromise = null;
    const verifyIdentity = () => {
      if (!identityPromise) {
        identityPromise = verifyShopIdentity(client.graphql, {
          expectedDomain: cfg.expectedDomain,
        });
      }
      return identityPromise;
    };

    const handle = {
      graphql: client.graphql, // S1: roher Transport; S2 legt den Guard davor
      verifyIdentity,
      config: client.config, // { store, version, endpoint, label }
    };

    handles.set(name, handle); // nur bei Erfolg
    return handle;
  }

  return { get };
}
