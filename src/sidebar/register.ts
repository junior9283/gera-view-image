// Lote 7 (Barra lateral avançada): ponto de registro, importado uma vez no `main.tsx`.
// Ordenar Por (Visualizar ›) grava `prefs.sortBy`; a ordem da barra segue a preferência (`sortSync`).
import { registerCommand, type CommandId } from "../shortcuts/commands";
import { setPrefs } from "../store/prefs";
import type { SortBy } from "./sort";
import { startSortSync } from "./sortSync";

const SORT_COMMANDS: [CommandId, SortBy][] = [
  ["view.sortByName", "name"],
  ["view.sortByDate", "date"],
  ["view.sortByKind", "kind"],
  ["view.sortBySize", "size"],
];

for (const [id, by] of SORT_COMMANDS) registerCommand(id, () => setPrefs({ sortBy: by }));
startSortSync();
