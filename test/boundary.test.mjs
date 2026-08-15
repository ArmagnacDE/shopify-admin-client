// scanClientBoundary — Fehlerbild-Test 3 (Client-Teil): Client nur in erlaubten
// Dateien, ignore wirkt, kein Roh-fetch, kein clientFromEnv. Gegen ein Fixture-
// Verzeichnis (kein echtes Repo nötig).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanClientBoundary } from "../boundary.js";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "boundary-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

test("sauberes Repo: keine Befunde", (t) => {
  const root = fixture({
    "lib/shopify.js": 'import { createStoreRegistry } from "shopify-admin-client/registry";\nexport const x = 1;\n',
    "scripts/report.js": 'import { registry } from "../lib/shopify.js";\nawait registry.get("prod").graphql("query { shop { name } }");\n',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const befunde = scanClientBoundary({
    rootDirs: [join(root, "lib"), join(root, "scripts")],
    allowClientIn: [join(root, "lib/shopify.js").replace(/\\/g, "/")],
  });
  assert.deepEqual(befunde, []);
});

test("Client-Import außerhalb erlaubter Dateien wird gemeldet (statisch + dynamisch)", (t) => {
  const root = fixture({
    "lib/shopify.js": 'import { createStoreRegistry } from "shopify-admin-client/registry";\n',
    "scripts/boese.js": 'import { createShopifyClient } from "shopify-admin-client";\n',
    "scripts/boese-dyn.js": 'const m = await import("shopify-admin-client/guard");\n',
    "scripts/boese-req.js": 'const c = require("shopify-admin-client");\n',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const befunde = scanClientBoundary({
    rootDirs: [join(root, "lib"), join(root, "scripts")],
    allowClientIn: [join(root, "lib/shopify.js").replace(/\\/g, "/")],
  });
  const importBefunde = befunde.filter((b) => b.rule === "client-import").map((b) => b.file);
  assert.equal(importBefunde.length, 3);
  assert.ok(importBefunde.every((f) => /boese/.test(f)));
  assert.ok(!importBefunde.some((f) => /shopify\.js/.test(f)), "erlaubte Datei nicht gemeldet");
});

test("ignore-Präfix überspringt komplett (z. B. scripts/spike/)", (t) => {
  const root = fixture({
    "scripts/spike/dev-client.js": 'import { createShopifyClient } from "shopify-admin-client";\nfetch("https://x.myshopify.com/y");\nclientFromEnv("X");\n',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const spikePrefix = join(root, "scripts/spike/").replace(/\\/g, "/");
  const befunde = scanClientBoundary({
    rootDirs: [join(root, "scripts")],
    ignore: [spikePrefix],
  });
  assert.deepEqual(befunde, [], "ignore-Präfix muss alle drei Fundtypen unterdrücken");
});

test("Roh-fetch gegen myshopify.com und clientFromEnv werden gemeldet", (t) => {
  const root = fixture({
    "scripts/roh.js": 'const r = await fetch("https://armagnac-de.myshopify.com/admin/api/graphql.json");\n',
    "scripts/env.js": 'import { clientFromEnv } from "shopify-admin-client";\nconst c = clientFromEnv("SHOPIFY");\n',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const befunde = scanClientBoundary({
    rootDirs: [join(root, "scripts")],
    // env.js importiert den Client — erlauben, damit NUR der clientFromEnv-Fund übrig bleibt:
    allowClientIn: [join(root, "scripts/env.js").replace(/\\/g, "/")],
  });
  assert.ok(befunde.some((b) => b.rule === "raw-fetch" && /roh\.js/.test(b.file)));
  assert.ok(befunde.some((b) => b.rule === "client-from-env" && /env\.js/.test(b.file)));
  assert.ok(!befunde.some((b) => b.rule === "client-import"), "env.js ist erlaubt");
});

test("forbidRawFetch/forbidClientFromEnv abschaltbar", (t) => {
  const root = fixture({
    "scripts/roh.js": 'fetch("https://x.myshopify.com/y");\nconst c = clientFromEnv("X");\n',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const befunde = scanClientBoundary({
    rootDirs: [join(root, "scripts")],
    forbidRawFetch: false,
    forbidClientFromEnv: false,
  });
  assert.deepEqual(befunde, []);
});

test("harmloser fetch (nicht myshopify) und Produktsuche nach 'mutation' lösen nichts aus", (t) => {
  const root = fixture({
    "scripts/ok.js": 'await fetch("https://example.com/api");\nconst q = "query { products(query: \\"mutation\\") { edges { node { id } } } }";\n',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const befunde = scanClientBoundary({ rootDirs: [join(root, "scripts")] });
  assert.deepEqual(befunde, []);
});

test("längerer Paketname (shopify-admin-client-extra) ist KEIN Fund", (t) => {
  const root = fixture({
    "scripts/other.js": 'import x from "shopify-admin-client-extra";\n',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const befunde = scanClientBoundary({ rootDirs: [join(root, "scripts")] });
  assert.deepEqual(befunde.filter((b) => b.rule === "client-import"), []);
});

test("rootDirs Pflicht", () => {
  assert.throws(() => scanClientBoundary({ rootDirs: [] }), /rootDirs/);
  assert.throws(() => scanClientBoundary({}), /rootDirs/);
});
