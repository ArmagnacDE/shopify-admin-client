// JSONL-Audit — der benannte Audit-Vertrag, den der Mutation-Guard bedient. Jede Firma
// bringt ihre eigene Instanz mit (eigenes Verzeichnis, eigener Datenschutz-Transform),
// die Guard-Mechanik bleibt audit-agnostisch. Das ist die Andockstelle, an der später
// die Diff-Karte (Write-Approval-Redesign) einhängt.
//
// Vertrag (alle Methoden SYNCHRON — der Guard awaitet kein Audit; `attempt` muss VOR dem
// Send synchron werfen können):
//   declared(e) | attempt(e) | result(e) | rejected(e) | location()
//   - attempt WIRFT bei Schreibfehler (fail-closed; der Guard übersetzt in 'log').
//   - declared/result/rejected werfen NIE (sie warnen selbst) — nach erfolgreichem Send
//     darf kein Audit-Fehler als „Write gescheitert" beim Aufrufer landen (Dubletten).
//   - location() = Pfad der aktuellen Monatsdatei (für Budget-/log-Meldung des Guards).
//
// DATENSCHUTZ: Variablen können Kundendaten tragen (Draft-Orders: Namen, Adressen). Der
// Datenschutz-Transform ist lokale Firmen-Entscheidung (`transformVariables`), er sieht
// NUR `variablen`. Die Feldkürzung darüber ist DEFAULT-Mechanik und läuft NACH dem
// Transform über den GESAMTEN Eintrag (kleine Zeilen, kein korruptes Parallel-Append).
// Das Log bleibt lokal und gitignored, nie nach Git oder Drive.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Variablen/Felder fürs Log gekürzt (markiert), damit Zeilen klein bleiben und
// paralleles Append nicht korrumpiert.
const FELD_MAX = 800;
const TIEFE_MAX = 20; // gegen zyklische/absurd tiefe Werte
export function kuerzeFuerLog(wert, max = FELD_MAX, tiefe = 0) {
  if (tiefe > TIEFE_MAX) return "[zu tief oder zyklisch — nicht serialisiert]";
  if (typeof wert === "string") {
    return wert.length > max ? `${wert.slice(0, max)}…[gekürzt ${wert.length} Zeichen]` : wert;
  }
  if (Array.isArray(wert)) return wert.map((v) => kuerzeFuerLog(v, max, tiefe + 1));
  if (wert && typeof wert === "object") {
    return Object.fromEntries(Object.entries(wert).map(([k, v]) => [k, kuerzeFuerLog(v, max, tiefe + 1)]));
  }
  return wert;
}

/**
 * @param {object} opts
 * @param {string}   opts.directory           Log-Verzeichnis (Pflicht).
 * @param {(v:any)=>any} [opts.transformVariables]  Datenschutz-Transform, sieht NUR `variablen`.
 * @param {(msg:string)=>void} [opts.warn]    Warn-Kanal (Default console.warn).
 * @param {()=>Date} [opts.now]               Zeitquelle (Tests).
 * @param {number}  [opts.pid]                Prozess-ID im Eintrag (Tests).
 * @param {(path:string, line:string)=>void} [opts.append]  fs.appendFileSync (Tests).
 * @param {(dir:string, opts:object)=>void}  [opts.mkdir]   fs.mkdirSync (Tests).
 * @returns {{ declared:Function, attempt:Function, result:Function, rejected:Function, location:()=>string }}
 */
export function createJsonlAudit({
  directory,
  transformVariables,
  warn = (msg) => console.warn(msg),
  now = () => new Date(),
  pid = process.pid,
  append = appendFileSync,
  mkdir = mkdirSync,
} = {}) {
  if (!directory) throw new Error("createJsonlAudit: directory fehlt.");
  if (transformVariables !== undefined && typeof transformVariables !== "function") {
    throw new Error("createJsonlAudit: transformVariables muss eine Funktion sein, wenn gesetzt.");
  }

  let verzeichnisBereit = false; // lazy: mkdir erst beim ersten Eintrag (kein fs beim Import)

  // Monatsdatei zu einem Zeitpunkt — ts und Dateiname eines Eintrags stammen aus DEMSELBEN
  // Date (Codex P3-2: zwei now()-Aufrufe konnten am Monatswechsel auseinanderfallen).
  const dateiFuer = (d) => {
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return join(directory, `shopify-mutations-${d.getFullYear()}-${mm}.jsonl`);
  };
  const location = () => dateiFuer(now());

  // Baut den Eintrag (Transform auf variablen, dann Kürzung über den GESAMTEN Eintrag)
  // und schreibt ihn. Wirft bei Schreibfehler — der Aufrufer (safe/attempt) entscheidet.
  const schreibe = (typ, eintrag) => {
    const e = { ...eintrag };
    if (transformVariables && Object.hasOwn(e, "variablen")) {
      // Der Transform bekommt eine TIEFE KOPIE (Codex P2-1): `variablen` ist dieselbe
      // Referenz, die der Guard danach an den Transport sendet — ein in-place redigierender
      // Transform (`delete v.customer.email`) würde sonst den echten Write verändern.
      // GraphQL-Variablen sind JSON; klappt structuredClone nicht (exotischer Wert), wird
      // NICHT transformiert und der Eintrag traegt den Hinweis (fail-safe fuers Log,
      // nie fuer den Write).
      let kopie;
      let kopierbar = true;
      try {
        kopie = structuredClone(e.variablen);
      } catch (err) {
        kopierbar = false;
        e.variablen = `[variablen nicht kopierbar — Transform uebersprungen: ${err?.message ?? err}]`;
      }
      if (kopierbar) e.variablen = transformVariables(kopie);
    }
    // Kürzung über den GESAMTEN Eintrag (Default-Mechanik, NACH transformVariables).
    // Nebeneffekt: der Wrapper {ts,pid,typ,…} kostet die verschachtelten Werte eine
    // Tiefen-Ebene (effektiv TIEFE_MAX-1 für `variablen`) — bewusst in Kauf genommen;
    // echte GraphQL-Inputs liegen bei ~4–6 Ebenen, das Limit greift dort nie.
    const jetzt = now();
    const voll = kuerzeFuerLog({ ts: jetzt.toISOString(), pid, typ, ...e });
    if (!verzeichnisBereit) {
      mkdir(directory, { recursive: true });
      verzeichnisBereit = true;
    }
    append(dateiFuer(jetzt), `${JSON.stringify(voll)}\n`);
  };

  // Nicht-fail-closed: Schreibfehler warnen, NIE werfen (declared/result/rejected).
  const sicher = (typ, eintrag) => {
    try {
      schreibe(typ, eintrag);
    } catch (e) {
      try {
        warn(`[jsonl-audit] Zeile (${typ}) nicht schreibbar: ${e?.message ?? e}`);
      } catch {
        /* selbst der Warn-Kanal darf den Aufrufer nicht erreichen */
      }
    }
  };

  return {
    declared: (e) => sicher("declared", e),
    // attempt läuft VOR dem Send: Schreibfehler MUSS propagieren (fail-closed),
    // der Guard übersetzt ihn in MutationGuardError('log').
    attempt: (e) => schreibe("attempt", e),
    result: (e) => sicher("result", e),
    rejected: (e) => sicher("rejected", e),
    location,
  };
}
