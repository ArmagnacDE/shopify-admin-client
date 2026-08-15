// Live-Identitaetspruefung des Shops — genau EINE Implementierung im Client, von der
// der Guard (mutation-guard.js, S2) vor dem ersten Write und von der armagnac-
// write-guard-Fassade (S3) genutzt wird. Ohne eigenen Cache: der Aufrufer (Guard,
// je Instanz) haelt die gecachte Single-Flight-Promise, damit es EINEN Identitaets-
// Cache je Handle gibt, nicht zwei konkurrierende.
//
// Warum die Live-Abfrage: dem Config-/Konstantenwert wird nicht blind vertraut — das
// Client-Credentials-Token traegt keinen auslesbaren Shop-Kontext, geprueft wird die
// tatsaechliche API-Antwort `shop.myshopifyDomain`. Innerhalb der Registry ist der
// Endpoint bereits die Code-Konstante `expectedDomain` (der eigentliche Schutz gegen
// "falscher Shop"); die Pruefung hat zusaetzlichen Wert nur dort, wo Konstante !=
// Endpoint sein kann (Direktnutzer mit Env-Store) — siehe Design-Doc, Reviewer Concern.

import { MutationGuardError } from "./errors.js";

const IDENTITY_QUERY = "query { shop { myshopifyDomain } }";

const norm = (s) => String(s ?? "").trim().toLowerCase();

/**
 * Prueft die Live-Shop-Identitaet gegen die erwartete Domain.
 *
 * @param {(query: string) => Promise<object>} graphql  Ausfuehrender GraphQL-Reader
 *        (Reads sind ungeguardet — der Guard laesst genau diese eine Read zu).
 * @param {{ expectedDomain: string }} opts
 * @returns {Promise<string>} die von der API gemeldete Domain, ROH (Gross/Klein
 *        erhalten — der write-guard-Adapter gibt sie unveraendert zurueck); der
 *        Vergleich intern ist case-insensitiv.
 * @throws {MutationGuardError} Code 'identitaet' (Antwort fehlt/leer oder Reader wirft)
 *         | 'store' (Antwort != erwartete Domain, oder expectedDomain fehlt).
 */
export async function verifyShopIdentity(graphql, { expectedDomain } = {}) {
  if (!expectedDomain) {
    throw new MutationGuardError(
      "store",
      "expectedDomain fehlt — ohne erwartete Domain ist keine Identitaetspruefung moeglich."
    );
  }

  let antwort;
  try {
    antwort = await graphql(IDENTITY_QUERY);
  } catch (e) {
    // Reader (Netz/HTTP) geworfen: nicht pruefbar -> fail-closed als 'identitaet'.
    throw new MutationGuardError(
      "identitaet",
      `Shop-Identitaet nicht pruefbar (${e?.message ?? e}) — kein Write ohne bewiesene Identitaet.`
    );
  }

  const ist = antwort?.shop?.myshopifyDomain;
  if (!ist) {
    throw new MutationGuardError(
      "identitaet",
      "Shop-Identitaet nicht lesbar (shop.myshopifyDomain leer) — kein Write."
    );
  }
  if (norm(ist) !== norm(expectedDomain)) {
    throw new MutationGuardError(
      "store",
      `Shop-Identitaet falsch: API antwortet als "${ist}", erwartet "${expectedDomain}". ` +
        "Vermutlich eine vertauschte .env — kein Write gesendet."
    );
  }
  return ist;
}
