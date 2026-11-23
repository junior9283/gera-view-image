import { NEUTRAL_ADJUST, type ColorAdjust } from "../ipc/types";

export type SliderKey = Exclude<keyof ColorAdjust, "levels">;

const NEUTRAL_KEYS = Object.keys(NEUTRAL_ADJUST).filter((k) => k !== "levels") as SliderKey[];

/** Nenhum controle fora do lugar. */
export const isNeutral = (a: ColorAdjust) =>
  NEUTRAL_KEYS.every((k) => a[k] === NEUTRAL_ADJUST[k]) &&
  a.levels.black === NEUTRAL_ADJUST.levels.black &&
  a.levels.gamma === NEUTRAL_ADJUST.levels.gamma &&
  a.levels.white === NEUTRAL_ADJUST.levels.white;
