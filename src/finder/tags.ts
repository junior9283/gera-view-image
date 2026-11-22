// Etiquetas digitadas (`user.xdg.tags`).

/**
 * Divide o texto digitado em etiquetas: a vírgula separa (é o separador do `user.xdg.tags`,
 * então nunca entra numa etiqueta).
 */
export const splitTags = (raw: string): string[] => raw.split(",").map((s) => s.trim()).filter(Boolean);

/** Acrescenta etiquetas sem repetir, na ordem. */
export const addTags = (tags: string[], raw: string): string[] => [...new Set([...tags, ...splitTags(raw)])];
