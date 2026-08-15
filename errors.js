// Fehlerklasse des Mutation-Guards — als eigenes Modul, damit identity.js und
// mutation-guard.js sie importieren koennen, OHNE einander zu importieren
// (kein Import-Zyklus). Der Kompatibilitaetsvertrag (Codes + Praefix) ist
// wortgleich zur bisherigen armagnac-Fassung (lib/mutation-guard.js): der
// Ernstfall-Test greift auf genau das Praefix [mutation-guard:<code>].

// Erlaubte Fehlercodes (Vertrag). `identitaet` | `store` wirft identity.js;
// die uebrigen der Guard (S2). Ein unbekannter Code ist ein Programmierfehler.
export const MUTATION_GUARD_CODES = Object.freeze([
  "declare",
  "form",
  "bulk",
  "deny",
  "budget",
  "log",
  "identitaet",
  "store",
  "init",
]);

const CODE_SET = new Set(MUTATION_GUARD_CODES);

// Greppbare Fehlertexte: jeder Abbruch traegt [mutation-guard:<code>].
export class MutationGuardError extends Error {
  constructor(code, message) {
    if (!CODE_SET.has(code)) {
      // Fail-loud beim Bauen — ein Tippfehler im Code darf nicht als
      // scheinbar gueltiger Guard-Fehler durchgehen.
      throw new Error(
        `MutationGuardError: unbekannter Code "${code}". Erlaubt: ${MUTATION_GUARD_CODES.join(", ")}.`
      );
    }
    super(`[mutation-guard:${code}] ${message}`);
    this.name = "MutationGuardError";
    this.code = code;
  }
}
