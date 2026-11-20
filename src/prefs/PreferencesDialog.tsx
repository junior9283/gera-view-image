import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { setPrefs, usePrefs, type Prefs } from "../store/prefs";
import "./prefs.css";

const BACKGROUNDS: Prefs["background"][] = ["window", "black", "white", "gray", "custom"];
const OPEN_BEHAVIORS: Prefs["openBehavior"][] = ["fit", "actual"];
const LANGUAGES: Prefs["language"][] = ["system", "pt-BR", "en"];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="prefs-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function PreferencesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const prefs = usePrefs();
  const titleId = useId();

  return (
    <div className="prefs-backdrop" role="presentation">
      <div className="prefs-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h3 id={titleId}>{t("prefs.title")}</h3>

        <Row label={t("prefs.background")}>
          <select value={prefs.background} onChange={(e) => setPrefs({ background: e.target.value as Prefs["background"] })}>
            {BACKGROUNDS.map((b) => (
              <option key={b} value={b}>{t(`prefs.bg.${b}`)}</option>
            ))}
          </select>
        </Row>
        {prefs.background === "custom" && (
          <Row label={t("prefs.customBg")}>
            <input type="color" value={prefs.customBg} onChange={(e) => setPrefs({ customBg: e.target.value })} />
          </Row>
        )}

        <Row label={t("prefs.openBehavior")}>
          <select value={prefs.openBehavior} onChange={(e) => setPrefs({ openBehavior: e.target.value as Prefs["openBehavior"] })}>
            {OPEN_BEHAVIORS.map((o) => (
              <option key={o} value={o}>{t(`prefs.open.${o}`)}</option>
            ))}
          </select>
        </Row>

        <Row label={t("prefs.slideshowSeconds")}>
          <input
            type="number"
            min={1}
            max={60}
            value={prefs.slideshowSeconds}
            onChange={(e) => setPrefs({ slideshowSeconds: e.target.valueAsNumber })}
          />
        </Row>

        <Row label={t("prefs.browseFolder")}>
          <input type="checkbox" checked={prefs.browseFolder} onChange={(e) => setPrefs({ browseFolder: e.target.checked })} />
        </Row>
        <Row label={t("prefs.autoUpdate")}>
          <input type="checkbox" checked={prefs.autoUpdate} onChange={(e) => setPrefs({ autoUpdate: e.target.checked })} />
        </Row>
        <Row label={t("prefs.nativeDecorations")}>
          <input
            type="checkbox"
            checked={prefs.nativeDecorations}
            onChange={(e) => setPrefs({ nativeDecorations: e.target.checked })}
          />
        </Row>

        <Row label={t("prefs.language")}>
          <select value={prefs.language} onChange={(e) => setPrefs({ language: e.target.value as Prefs["language"] })}>
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>{t(`prefs.lang.${l}`)}</option>
            ))}
          </select>
        </Row>

        <div className="prefs-actions">
          <button onClick={onClose}>{t("prefs.close")}</button>
        </div>
      </div>
    </div>
  );
}
