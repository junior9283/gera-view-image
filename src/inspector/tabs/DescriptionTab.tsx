import { useTranslation } from "react-i18next";
import type { DocId } from "../../ipc/types";
import { setText, useTexts, type TextField } from "../textEdits";

/** Teto de caracteres por campo (o Rust corta no mesmo valor). */
const MAX_CHARS = 16_384;

const FIELDS: { field: TextField; multiline: boolean }[] = [
  { field: "title", multiline: false },
  { field: "description", multiline: true },
  { field: "author", multiline: false },
  { field: "altText", multiline: true },
];

/** Título, descrição, autor e Descrição da Imagem (texto alternativo): gravados ao salvar. */
export function DescriptionTab({ id }: { id: DocId }) {
  const { t } = useTranslation();
  const texts = useTexts(id);
  return (
    <form className="inspector-form" onSubmit={(e) => e.preventDefault()}>
      {FIELDS.map(({ field, multiline }) => {
        const common = {
          value: texts[field],
          maxLength: MAX_CHARS,
          onChange: (e: { target: { value: string } }) => setText(id, field, e.target.value),
        };
        return (
          <label key={field}>
            <span>{t(`inspector.text.${field}`)}</span>
            {multiline ? <textarea rows={3} {...common} /> : <input type="text" {...common} />}
          </label>
        );
      })}
      <p className="inspector-hint">{t("inspector.text.hint")}</p>
    </form>
  );
}
