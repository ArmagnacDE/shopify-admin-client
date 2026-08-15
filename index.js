// Barrel (oeffentliche Wurzel-API des Pakets). Der Transport lebt in transport.js,
// die Anbindungs-Ebene (Identitaet, Store-Registry, Fehlerklasse) in eigenen Modulen —
// so bleibt jedes env-frei importierbar und der Import-Zyklus zwischen Guard und
// Identitaet vermieden (beide teilen sich nur errors.js).
//
// Additiv zu v1.1.0: createShopifyClient/clientFromEnv/isMutation unveraendert; NEU in
// v1.2.0 (S1): verifyShopIdentity, createStoreRegistry, MutationGuardError.
// createMutationGuard/createJsonlAudit/scanClientBoundary folgen in S2 (Subpath ./guard).

export { createShopifyClient, clientFromEnv, isMutation } from "./transport.js";
export { verifyShopIdentity } from "./identity.js";
export { createStoreRegistry } from "./store-registry.js";
export { MutationGuardError } from "./errors.js";
