// test:install — prueft das GEPACKTE Paket, nicht nur die Dateien im Arbeitsbaum.
//
// Ablauf (Codex S0 #9): `npm pack` erzeugt den Tarball GENAU aus `files`; wir installieren
// ihn in ein leeres Verzeichnis und importieren Wurzel + jeden veroeffentlichten Subpath.
// So faellt ein vergessener `files`-/`exports`-Eintrag VOR dem Tag auf — die Installation
// aus dem Tag selbst wuerde sonst ein bereits unveraenderlich veroeffentlichtes Paket
// pruefen. Nach dem Tag-Push denselben Import gegen `github:...#vX.Y.Z` als Smoke-Test
// laufen lassen (Release-Checkliste, NICHT Teil von `npm test`).
//
// Dependency-frei, nicht interaktiv: nur node:child_process/fs/os/path.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" });
}

// 1. Tarball bauen und dessen Namen aus der npm-Ausgabe fischen.
const packOut = run("npm", ["pack"], repoRoot);
const tarball = packOut
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .reverse()
  .find((l) => l.endsWith(".tgz"));
if (!tarball) {
  throw new Error("npm pack lieferte keinen .tgz-Namen:\n" + packOut);
}
const tarballPath = join(repoRoot, tarball);

const tmp = mkdtempSync(join(tmpdir(), "sac-install-"));
try {
  // 2. Tarball als file:-Dependency in ein leeres Verzeichnis installieren.
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify(
      {
        name: "install-smoke",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: { "shopify-admin-client": `file:${tarballPath}` },
      },
      null,
      2
    )
  );
  run("npm", ["install", "--no-audit", "--no-fund", "--silent"], tmp);

  // 3. Wurzel + alle veroeffentlichten Subpaths importieren und die Exporte pruefen.
  const probe = [
    'import assert from "node:assert/strict";',
    'import * as root from "shopify-admin-client";',
    'import * as registry from "shopify-admin-client/registry";',
    'import * as guard from "shopify-admin-client/guard";',
    "const expected = [",
    '  "createShopifyClient", "clientFromEnv", "isMutation",',
    '  "verifyShopIdentity", "createStoreRegistry", "createJsonlAudit",',
    '  "scanClientBoundary", "MutationGuardError",',
    "];",
    "for (const n of expected)",
    '  assert.equal(typeof root[n], "function", "Barrel-Export fehlt: " + n);',
    'assert.equal(typeof registry.createStoreRegistry, "function", "Subpath ./registry fehlt createStoreRegistry");',
    "for (const n of [\"createMutationGuard\", \"extrahiereRootFeld\", \"istSchreibDokument\", \"validateDeclaration\", \"MutationGuardError\"])",
    '  assert.equal(typeof guard[n], "function", "Subpath ./guard fehlt: " + n);',
    'console.log("  Root + ./registry + ./guard importierbar, Exporte vollstaendig");',
  ].join("\n");
  writeFileSync(join(tmp, "probe.mjs"), probe);
  run("node", ["probe.mjs"], tmp);

  console.log(`OK test:install — ${tarball} liefert Root + ./registry + ./guard aus.`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(tarballPath, { force: true });
}
