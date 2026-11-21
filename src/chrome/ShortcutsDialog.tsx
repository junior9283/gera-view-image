import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWindowEvent } from "../lib/events";
import { useModal } from "../lib/modal";
import { SHOW_SHORTCUTS_EVENT } from "../shortcuts/events";
import { KEYMAP, formatShortcut } from "../shortcuts/keymap";
import { MENUS, type MenuItem } from "./menus";
import "../prefs/prefs.css";

/** Comandos com atalho de cada menu (inclusive dos submenus). */
const withKeys = (items: MenuItem[]): { label: string; keys: string }[] =>
  items.flatMap((i) => {
    if ("separator" in i) return [];
    if (i.submenu) return withKeys(i.submenu);
    return KEYMAP[i.command] ? [{ label: i.label, keys: formatShortcut(KEYMAP[i.command]) }] : [];
  });

/** Ajuda › Atalhos de Teclado: a lista sai do próprio keymap. */
export function ShortcutsDialog() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useWindowEvent(SHOW_SHORTCUTS_EVENT, () => setOpen(true));

  useModal(dialog, { active: open, onClose: () => setOpen(false) });

  if (!open) return null;
  return (
    <div className="prefs-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div
        ref={dialog}
        className="prefs-dialog shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h3 id={titleId}>{t("shortcuts.title")}</h3>
        <div className="shortcuts-list">
          {MENUS.map((m) => {
            const rows = withKeys(m.items);
            if (!rows.length) return null;
            return (
              <table key={m.label}>
                <caption>{t(m.label)}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("shortcuts.command")}</th>
                    <th scope="col">{t("shortcuts.keys")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.label}>
                      <td>{t(r.label)}</td>
                      <td>
                        <kbd>{r.keys}</kbd>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })}
        </div>
        <div className="prefs-actions">
          <button onClick={() => setOpen(false)}>{t("shortcuts.close")}</button>
        </div>
      </div>
    </div>
  );
}
