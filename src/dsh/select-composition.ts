import type { DshCompositionSelection, DshMode } from "./composition.js";
import { PRODUCTION_DSH_COMPOSITION } from "./controlled-composition.js";
import { NATIVE_DSH_COMPOSITION } from "./native-composition.js";

export function selectDshComposition(mode: DshMode): DshCompositionSelection {
  return mode === "native" ? NATIVE_DSH_COMPOSITION : PRODUCTION_DSH_COMPOSITION;
}
