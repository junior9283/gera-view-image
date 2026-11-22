// Campo de etiquetas: as fichas e a entrada (popover do título e diálogo Exportar).
import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { addTags } from "./tags";
import "./finder.css";

interface Props {
  /** `null` enquanto carrega (entrada desabilitada). */
  tags: string[] | null;
  onChange: (tags: string[]) => void;
  autoFocus?: boolean;
}

export function TagsInput({ tags, onChange, autoFocus }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const add = () => {
    if (!tags || !draft.trim()) return;
    const next = addTags(tags, draft);
    setDraft("");
    if (next.length !== tags.length) onChange(next);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    } else if (e.key === "Backspace" && !draft && tags?.length) {
      onChange(tags.slice(0, -1));
    }
  };
  return (
    <div className="finder-tags" role="group" aria-label={t("finder.popover.tags")}>
      {tags?.map((tag) => (
        <span key={tag} className="finder-tag">
          {tag}
          <button
            type="button" aria-label={t("finder.popover.removeTag", { tag })}
            onClick={() => onChange(tags.filter((x) => x !== tag))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text" value={draft} disabled={!tags} autoFocus={autoFocus}
        placeholder={t("finder.popover.tagsPlaceholder")} aria-label={t("finder.popover.tagsPlaceholder")}
        onChange={(e) => setDraft(e.target.value.replace(/,/g, ""))} onKeyDown={onKey} onBlur={add}
      />
    </div>
  );
}
