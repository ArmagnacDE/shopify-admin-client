// Barrel (oeffentliche Wurzel-API des Pakets). Der Transport lebt in transport.js,
// die Anbindungs-Ebene (Identitaet, Store-Registry, Guard-Mechanik, Audit, Boundary) in
// eigenen Modulen — so bleibt jedes env-frei importierbar und der Import-Zyklus zwischen
// Guard und Identitaet vermieden (beide teilen sich nur errors.js).
//
// Additiv zu v1.1.0: createShopifyClient/clientFromEnv/isMutation unveraendert; NEU in
// v1.2.0: verifyShopIdentity, createStoreRegistry, createJsonlAudit, scanClientBoundary,
// MutationGuardError. Die Guard-Fabrik + Lexer liegen unter dem Subpath ./guard
// (shopify-admin-client/guard), die Registry zusaetzlich unter ./registry.

export { createShopifyClient, clientFromEnv, isMutation } from "./transport.js";
export { verifyShopIdentity } from "./identity.js";
export { createStoreRegistry } from "./store-registry.js";
export { createJsonlAudit } from "./jsonl-audit.js";
export { scanClientBoundary } from "./boundary.js";
export { MutationGuardError } from "./errors.js";
