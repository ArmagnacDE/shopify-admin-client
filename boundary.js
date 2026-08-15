// Boundary-Scan — der generische Teil des Firmen-Meta-Tests. Hält ein Firmen-Repo an
// der Anbindungs-Grenze: der zentrale Client darf nur in den erlaubten Adapter-Dateien
// importiert werden, kein Skript schreibt per Roh-`fetch` an Shopify vorbei, und die
// ungeguardete `clientFromEnv`-Abkürzung ist verboten. Kein Parser — ein Zeilen-Scan
// mit fail-closed-Default (unklare Fälle werden gemeldet, nicht durchgewunken).
//
// Vorsätzliche Umgehung ist außer Scope (echte Grenze = Credential-Trennung); der Scan
// ist die billige Zusatzschranke gegen versehentliches Vorbeischreiben.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CODE_RE = /\.(js|mjs|cjs)$/;

// Import/Require des Pakets — statisch UND dynamisch, alle Subpaths:
//   import … from "shopify-admin-client"        import "shopify-admin-client/guard"
//   import("shopify-admin-client/registry")     require("shopify-admin-client")
// Der Paketname steht in Anführungszeichen; ein Subpath (…/x) zählt mit, ein längerer
// Paketname (…-client-extra) NICHT (Grenze \b… über das schließende Quote bzw. /).
const CLIENT_IMPORT_RE =
  /(?:from|import|require)\s*\(?\s*["'`]shopify-admin-client(?:\/[^"'`]*)?["'`]/;

// Roh-fetch mit myshopify.com-Ziel (Literal-Form) — z. B. fetch("https://x.myshopify.com/…").
const RAW_FETCH_RE = /\bfetch\s*\(\s*[`'"][^`'"]*myshopify\.com/;

// clientFromEnv als Bezeichner (Import oder Aufruf).
const CLIENT_FROM_ENV_RE = /\bclientFromEnv\b/;

function dateienUnter(dir) {
  const out = [];
  let eintraege;
  try {
    eintraege = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // fehlendes rootDir ist kein Fund, nur nichts zu scannen
  }
  for (const e of eintraege) {
    const pfad = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...dateienUnter(pfad));
    } else if (e.isFile() && CODE_RE.test(e.name)) {
      out.push(pfad);
    }
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string[]} opts.rootDirs           zu scannende Verzeichnisse (z. B. ['lib','scripts'])
 * @param {string[]} [opts.allowClientIn]    Dateien, die den Client importieren DÜRFEN
 *        (repo-relative Pfade, z. B. 'lib/shopify.js')
 * @param {string[]} [opts.ignore]           Pfadpräfixe, die komplett übersprungen werden
 *        (armagnac: ['scripts/spike/'])
 * @param {boolean} [opts.forbidRawFetch=true]     Roh-fetch gegen myshopify.com melden
 * @param {boolean} [opts.forbidClientFromEnv=true] clientFromEnv-Nutzung melden
 * @returns {Array<{ file:string, line:number, rule:string, detail:string }>} Befunde (leer = sauber)
 */
export function scanClientBoundary({
  rootDirs,
  allowClientIn = [],
  ignore = [],
  forbidRawFetch = true,
  forbidClientFromEnv = true,
} = {}) {
  if (!Array.isArray(rootDirs) || rootDirs.length === 0) {
    throw new Error("scanClientBoundary: rootDirs muss ein nicht-leeres Array sein.");
  }
  // Pfade normalisieren (Windows-Backslashes → /), damit Vergleiche stabil sind.
  const norm = (p) => p.replace(/\\/g, "/");
  const erlaubt = new Set(allowClientIn.map(norm));
  const ignorePraefixe = ignore.map(norm);
  const istIgnoriert = (p) => ignorePraefixe.some((pre) => p === pre || p.startsWith(pre));

  const befunde = [];
  for (const root of rootDirs) {
    for (const pfad of dateienUnter(root)) {
      const rel = norm(pfad);
      if (istIgnoriert(rel)) continue;
      const zeilen = readFileSync(pfad, "utf8").split("\n");
      zeilen.forEach((zeile, idx) => {
        const nr = idx + 1;
        if (CLIENT_IMPORT_RE.test(zeile) && !erlaubt.has(rel)) {
          befunde.push({ file: rel, line: nr, rule: "client-import",
            detail: "Import von shopify-admin-client außerhalb der erlaubten Adapter-Dateien." });
        }
        if (forbidRawFetch && RAW_FETCH_RE.test(zeile)) {
          befunde.push({ file: rel, line: nr, rule: "raw-fetch",
            detail: "Roh-fetch gegen myshopify.com — Writes gehören über den zentralen Client/Guard." });
        }
        if (forbidClientFromEnv && CLIENT_FROM_ENV_RE.test(zeile)) {
          befunde.push({ file: rel, line: nr, rule: "client-from-env",
            detail: "clientFromEnv ist ungeguardet (liest _STORE aus der Env) — Registry mit expectedDomain nutzen." });
        }
      });
    }
  }
  return befunde;
}
