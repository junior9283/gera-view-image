import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import logo from "../../assets/logo/preview/logo-128.png";
import { useModal } from "../lib/modal";
import "./prefs.css";

const REPOSITORY_URL = "https://github.com/junior9283/gera-view-image/";

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useModal(dialog, { onClose });

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  return (
    <div className="prefs-backdrop" role="presentation">
      <div ref={dialog} className="prefs-dialog about-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <img src={logo} alt={t("about.logoAlt")} width={96} height={96} draggable={false} />
        <h3 id={titleId}>{t("about.title")}</h3>
        {version && <p>{t("about.version", { version })}</p>}
        <p>{t("about.license")}</p>
        <p>
          <a
            href={REPOSITORY_URL}
            onClick={(e) => {
              e.preventDefault();
              void openUrl(REPOSITORY_URL);
            }}
          >
            {t("about.repository")}
          </a>
        </p>
        <div className="prefs-actions">
          <button onClick={onClose}>{t("about.close")}</button>
        </div>
      </div>
    </div>
  );
}
