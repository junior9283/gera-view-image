import { useTranslation } from "react-i18next";
import { useDocs } from "../store/docs";
import { CONTACT_MAX, CONTACT_MIN, useUi } from "../store/ui";
import { activate } from "../viewer/actions";
import { Thumb } from "./Thumb";
import "./sidebar.css";

/** Pede as miniaturas em degraus de 64 px para o controle de tamanho não refazer tudo a cada pixel. */
export const bucket = (px: number) => Math.ceil(px / 64) * 64;

/** Folha de contato: grade de miniaturas no lugar do visualizador. Duplo clique abre a imagem. */
export function ContactSheet() {
  const { t } = useTranslation();
  const docs = useDocs((s) => s.docs);
  const activeId = useDocs((s) => s.activeId);
  const size = useUi((s) => s.contactSize);
  const setSize = useUi((s) => s.setContactSize);

  return (
    <section className="contact-sheet" aria-label={t("sidebar.contactSheet")} data-testid="contact-sheet">
      <div className="contact-toolbar">
        <input
          type="range"
          min={CONTACT_MIN}
          max={CONTACT_MAX}
          value={size}
          aria-label={t("sidebar.thumbSize")}
          onChange={(e) => setSize(Number(e.target.value))}
        />
      </div>
      <div className="contact-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size}px, 1fr))` }}>
        {docs.map((d) => (
          <figure
            key={d.id}
            className={`contact-item${d.id === activeId ? " active" : ""}`}
            onClick={() => activate(d.id)}
            onDoubleClick={() => {
              activate(d.id);
              useUi.getState().setSidebar("thumbs");
            }}
          >
            <Thumb doc={d} size={size} fetchSize={bucket(size)} />
            <figcaption>{d.name}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
