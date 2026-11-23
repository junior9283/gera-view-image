import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useForcedNative } from "../chrome/nativeDecorations";
import { useModal } from "../lib/modal";
import { onTabKeys } from "../lib/tablist";
import { loadSignatures, removeSignature, signatureSrc, useSignatures } from "../markup/signatures";
import { runCommand } from "../shortcuts/commands";
import { useEnabled } from "../shortcuts/useEnabled";
import { MAX_VERSIONS_MB, setPrefs, usePrefs, type Prefs } from "../store/prefs";
import { commitEditing } from "../tabs/transfer";
import "./prefs.css";

const TABS = ["general", "images", "signatures"] as const;
type Tab = (typeof TABS)[number];

/** Preferências de um tipo. */
type KeysOf<T> = { [K in keyof Prefs]: Prefs[K] extends T ? K : never }[keyof Prefs];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="prefs-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Check({ label, pref }: { label: string; pref: KeysOf<boolean> }) {
  const on = usePrefs((p) => p[pref]);
  return (
    <Row label={label}>
      <input type="checkbox" checked={on} onChange={(e) => setPrefs({ [pref]: e.target.checked })} />
    </Row>
  );
}

interface SelectProps<K extends keyof Prefs> {
  label: string;
  pref: K;
  values: (Prefs[K] & string)[];
  /** Prefixo das chaves de i18n das opções. */
  options: string;
}

function Select<K extends keyof Prefs>({ label, pref, values, options }: SelectProps<K>) {
  const { t } = useTranslation();
  const value = usePrefs((p) => p[pref]);
  return (
    <Row label={label}>
      <select value={String(value)} onChange={(e) => setPrefs({ [pref]: e.target.value })}>
        {values.map((v) => (
          <option key={v} value={v}>{t(`${options}.${v as string}`)}</option>
        ))}
      </select>
    </Row>
  );
}

interface NumberProps {
  label: string;
  pref: KeysOf<number>;
  min: number;
  max: number;
}

/** Edição local: deixa o campo ficar vazio/parcial; só ao confirmar vira inteiro entre `min` e `max`. */
function NumberField({ label, pref, min, max }: NumberProps) {
  const value = usePrefs((p) => p[pref]);
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    const n = Math.round(Number(text));
    if (text?.trim() && Number.isFinite(n)) setPrefs({ [pref]: Math.min(max, Math.max(min, n)) });
    setText(null);
  };
  return (
    <Row label={label}>
      <input
        type="number"
        min={min}
        max={max}
        value={text ?? value}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </Row>
  );
}

function General() {
  const { t } = useTranslation();
  const native = usePrefs((p) => p.nativeDecorations);
  const forcedNative = useForcedNative();
  return (
    <>
      <Select label={t("prefs.language")} pref="language" values={["system", "pt-BR", "en"]} options="prefs.lang" />
      <Select label={t("prefs.openFilesIn")} pref="openFilesIn" values={["tabs", "window", "windows"]} options="prefs.openIn" />
      <Check label={t("prefs.tabBar")} pref="tabBar" />
      <Check label={t("prefs.browseFolder")} pref="browseFolder" />
      <Check label={t("prefs.dragPans")} pref="dragPans" />
      <NumberField label={t("prefs.slideshowSeconds")} pref="slideshowSeconds" min={1} max={60} />
      <NumberField label={t("prefs.versionsMaxMb")} pref="versionsMaxMb" min={0} max={MAX_VERSIONS_MB} />
      <Check label={t("prefs.autoUpdate")} pref="autoUpdate" />
      <Row label={t("prefs.nativeDecorations")}>
        <input
          type="checkbox"
          checked={native || forcedNative}
          disabled={forcedNative}
          title={forcedNative ? t("prefs.nativeUnavailable") : undefined}
          onChange={(e) => setPrefs({ nativeDecorations: e.target.checked })}
        />
      </Row>
    </>
  );
}

function Images() {
  const { t } = useTranslation();
  const background = usePrefs((p) => p.background);
  const customBg = usePrefs((p) => p.customBg);
  return (
    <>
      <Select label={t("prefs.openBehavior")} pref="openBehavior" values={["fit", "actual"]} options="prefs.open" />
      <Select label={t("prefs.actualSize")} pref="actualSize" values={["pixel", "print"]} options="prefs.actual" />
      <Select label={t("prefs.background")} pref="background" values={["window", "black", "white", "gray", "custom"]} options="prefs.bg" />
      {background === "custom" && (
        <Row label={t("prefs.customBg")}>
          <input type="color" value={customBg} onChange={(e) => setPrefs({ customBg: e.target.value })} />
        </Row>
      )}
      <Check label={t("prefs.showImageBackground")} pref="showImageBackground" />
      <Check label={t("prefs.colorManagement")} pref="colorManagement" />
      <Check label={t("prefs.liveText")} pref="liveText" />
      <Select label={t("prefs.sortBy")} pref="sortBy" values={["manual", "name", "date", "kind", "size"]} options="prefs.sort" />
    </>
  );
}

interface SignaturesProps {
  onCreate: () => void;
  /** Sem mais assinaturas, o foco vai para a aba. */
  focusTab: () => void;
}

function Signatures({ onCreate, focusTab }: SignaturesProps) {
  const { t } = useTranslation();
  const list = useSignatures();
  const canCreate = useEnabled("tools.annotate.signature");
  useEffect(() => void loadSignatures(), []);

  const remove = (id: string, li: HTMLElement) => {
    // O botão some com a linha: o foco passa para a vizinha.
    const next = (li.nextElementSibling ?? li.previousElementSibling)?.querySelector("button");
    if (next) next.focus();
    else focusTab();
    void removeSignature(id);
  };

  return (
    <>
      {list.length ? (
        <ul className="prefs-signatures">
          {list.map((s, i) => (
            <li key={s.id}>
              <img src={signatureSrc(s)} alt={t("prefs.sig.name", { n: i + 1 })} />
              <button type="button" aria-label={t("prefs.sig.removeNamed", { n: i + 1 })} onClick={(e) => remove(s.id, e.currentTarget.parentElement!)}>
                {t("prefs.sig.remove")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="prefs-empty">{t("prefs.sig.empty")}</p>
      )}
      <button type="button" disabled={!canCreate} title={canCreate ? undefined : t("prefs.sig.needsImage")} onClick={onCreate}>
        {t("prefs.sig.create")}
      </button>
    </>
  );
}

export function PreferencesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [tab, setTab] = useState<Tab>("general");
  const dialog = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const close = () => {
    commitEditing();
    onClose();
  };
  useModal(dialog, { onClose: close });

  const createSignature = () => {
    onClose();
    runCommand("tools.annotate.signature");
  };

  return (
    <div className="prefs-backdrop" role="presentation">
      <div ref={dialog} className="prefs-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
        <h3 id={`${id}-title`}>{t("prefs.title")}</h3>
        <div ref={tabs} className="prefs-tabs" role="tablist" aria-label={t("prefs.title")} onKeyDown={onTabKeys}>
          {TABS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              id={`${id}-${k}`}
              aria-selected={tab === k}
              aria-controls={tab === k ? `${id}-panel` : undefined}
              tabIndex={tab === k ? 0 : -1}
              onClick={() => setTab(k)}
            >
              {t(`prefs.tab.${k}`)}
            </button>
          ))}
        </div>
        <div id={`${id}-panel`} className="prefs-panel" role="tabpanel" aria-labelledby={`${id}-${tab}`}>
          {tab === "general" && <General />}
          {tab === "images" && <Images />}
          {tab === "signatures" && (
            <Signatures
              onCreate={createSignature}
              focusTab={() => tabs.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()}
            />
          )}
        </div>
        <div className="prefs-actions">
          <button onClick={close}>{t("prefs.close")}</button>
        </div>
      </div>
    </div>
  );
}
