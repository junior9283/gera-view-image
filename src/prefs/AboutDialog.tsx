import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import logo from "../../assets/logo/preview/logo-128.png";
import "./prefs.css";

const REPOSITORY_URL = "https://github.com/junior9283/gera-view-image/";

function ExternalLink({ url, children }: { url: string; children: string }) {
  return (
    <a
      href={url}
      onClick={(e) => {
        e.preventDefault();
        void openUrl(url);
      }}
    >
      {children}
    </a>
  );
}

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");
  const titleId = useId();

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  return (
    <div className="prefs-backdrop" role="presentation">
      <div className="prefs-dialog about-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <img src={logo} alt={t("about.logoAlt")} width={96} height={96} draggable={false} />
        <h3 id={titleId}>{t("about.title")}</h3>
        {version && <p>{t("about.version", { version })}</p>}
        <p>{t("about.license")}</p>
        <p>
          <ExternalLink url={REPOSITORY_URL}>{t("about.repository")}</ExternalLink>
        </p>
        <p>
          {/* O mesmo arquivo vai nos pacotes (bundle.resources); o link abre o da versão instalada. */}
          <ExternalLink url={`${REPOSITORY_URL}blob/${version ? `v${version}` : "main"}/THIRD_PARTY_LICENSES`}>
            {t("about.thirdParty")}
          </ExternalLink>
        </p>
        <div className="prefs-actions">
          <button onClick={onClose}>{t("about.close")}</button>
        </div>
      </div>
    </div>
  );
}
