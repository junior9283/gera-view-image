import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { DocInfo } from "../ipc/types";
import { useUi } from "../store/ui";
import { activate } from "../viewer/actions";
import { BatchStatus } from "./BatchStatus";
import { Thumb } from "./Thumb";
import { ThumbMenu } from "./ThumbMenu";
import { useThumbs } from "./useThumbs";
import "./sidebar.css";

const SIZE = 128;
const PAGE_SIZE = 64;
/** Páginas listadas por documento (GIF longo não vira uma lista de centenas de itens). */
const MAX_PAGES = 100;

const pages = (d: DocInfo) => (d.frames > 1 && !d.error ? Array.from({ length: Math.min(d.frames, MAX_PAGES) }, (_, i) => i) : []);

export function Sidebar() {
  const { t } = useTranslation();
  const page = useUi((s) => s.page);
  const area = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const { docs, activeId, selected, drop, menu, closeMenu, itemProps, onKeyDown } = useThumbs({ list, area, layout: "list" });
  const many = selected.size > 1;

  return (
    <aside ref={area} className="sidebar" aria-label={t("sidebar.label")} data-testid="sidebar">
      <div ref={list} className="sidebar-list" onKeyDown={onKeyDown}>
        {docs.map((d, i) => (
          <div key={d.id} className="sidebar-doc">
            {drop === i && <div className="drop-line" />}
            <button
              type="button"
              {...itemProps(d, i)}
              className={`sidebar-item${d.id === activeId && page === null ? " active" : ""}${many && selected.has(d.id) ? " selected" : ""}`}
              aria-current={d.id === activeId}
              aria-pressed={many ? selected.has(d.id) : undefined}
            >
              <Thumb doc={d} size={SIZE} />
              <span className="sidebar-name">{d.name}</span>
            </button>
            {pages(d).map((f) => (
              <button
                type="button"
                key={f}
                className={`sidebar-item sidebar-page${d.id === activeId && page === f ? " active" : ""}`}
                onClick={() => activate(d.id, f)}
              >
                <Thumb doc={d} frame={f} size={PAGE_SIZE} />
                <span className="sidebar-name">{t("sidebar.page", { n: f + 1 })}</span>
              </button>
            ))}
          </div>
        ))}
        {drop === docs.length && <div className="drop-line" />}
      </div>
      <BatchStatus selected={selected.size} />
      {menu && <ThumbMenu target={menu} onClose={closeMenu} />}
    </aside>
  );
}
