import type { Lang } from "./types";

export type Tx = (en: string, ar: string) => string;

export const makeTx = (lang: Lang): Tx =>
  lang === "ar" ? (_en, ar) => ar : (en) => en;
