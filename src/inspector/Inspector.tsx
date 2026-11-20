import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { metadata } from "../ipc/commands";
import type { DocId, Metadata } from "../ipc/types";
import { useDocs } from "../store/docs";
import { useAnnotations, getAnnotationSource } from "./annotations";
import { formatBytes, formatCoord, formatDate, mapUrl } from "./format";
import { addKeyword, removeKeyword, seedKeywords, useKeywords } from "./keywords";
import { TOGGLE_INSPECTOR_EVENT } from "./toggle";
import "./inspector.css";

const TABS = ["general", "exif", "iptc", "gps", "keywords", "annotations"] as const;
type Tab = (typeof TABS)[number];

type Load = { state: "loading" } | { state: "error" } | { state: "ok"; meta: Metadata };

/** Painel flutuante de informações; abre e fecha com `toggleInspector()`. */
export function InspectorHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const toggle = () => setOpen((o) => !o);
    window.addEventListener(TOGGLE_INSPECTOR_EVENT, toggle);
    return () => window.removeEventListener(TOGGLE_INSPECTOR_EVENT, toggle);
  }, []);
  return open ? <Inspector onClose={() => setOpen(false)} /> : null;
}

function Inspector({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const doc = useDocs((s) => s.docs.find((d) => d.id === s.activeId));
  const [tab, setTab] = useState<Tab>("general");
  const [loaded, setLoaded] = useState<{ key: string; result: Load } | null>(null);
  const id = doc?.id;
  const rev = doc?.rev;
  const failed = doc?.error != null;
  const key = `${id}:${rev}`;
  // Resultado de outra revisão/documento conta como "carregando".
  const load: Load = loaded?.key === key ? loaded.result : { state: "loading" };

  useEffect(() => {
    if (id === undefined || failed) return;
    let stale = false;
    const done = (result: Load) => !stale && setLoaded({ key, result });
    metadata(id)
      .then((meta) => {
        if (stale) return;
        seedKeywords(id, meta.keywords);
        done({ state: "ok", meta });
      })
      .catch(() => done({ state: "error" }));
    return () => {
      stale = true;
    };
  }, [id, key, failed]);

  return (
    <aside className="inspector" role="complementary" aria-label={t("inspector.title")}>
      <header className="inspector-head">
        <strong>{t("inspector.title")}</strong>
        <button className="inspector-close" onClick={onClose} aria-label={t("inspector.close")}>
          ×
        </button>
      </header>
      <div className="inspector-tabs" role="tablist">
        {TABS.map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {t(`inspector.tab.${k}`)}
          </button>
        ))}
      </div>
      <div className="inspector-body" role="tabpanel">
        {id === undefined || failed ? (
          <p className="inspector-empty">{t("inspector.empty")}</p>
        ) : tab === "annotations" ? (
          <AnnotationsTab id={id} />
        ) : load.state === "loading" ? (
          <p className="inspector-empty">{t("inspector.loading")}</p>
        ) : load.state === "error" ? (
          <p role="alert" className="inspector-empty">
            {t("inspector.error")}
          </p>
        ) : (
          <TabContent tab={tab} id={id} meta={load.meta} />
        )}
      </div>
    </aside>
  );
}

function TabContent({ tab, id, meta }: { tab: Tab; id: DocId; meta: Metadata }) {
  switch (tab) {
    case "general":
      return <GeneralTab meta={meta} />;
    case "exif":
      return <Fields rows={meta.exif} />;
    case "iptc":
      return <Fields rows={meta.iptc} />;
    case "gps":
      return <GpsTab meta={meta} />;
    case "keywords":
      return <KeywordsTab id={id} />;
    default:
      return null;
  }
}

function Fields({ rows }: { rows: [string, string][] }) {
  const { t } = useTranslation();
  if (rows.length === 0) return <p className="inspector-empty">{t("inspector.empty")}</p>;
  return (
    <dl className="inspector-fields">
      {rows.map(([k, v], i) => (
        <div key={`${k}-${i}`}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function GeneralTab({ meta }: { meta: Metadata }) {
  const { t, i18n } = useTranslation();
  const g = meta.general;
  const yesNo = (b: boolean) => t(b ? "inspector.general.yes" : "inspector.general.no");
  const rows: [string, string][] = [
    [t("inspector.general.dimensions"), `${g.width} × ${g.height} px`],
    [t("inspector.general.dpi"), g.dpi ? `${Math.round(g.dpi[0])} × ${Math.round(g.dpi[1])} dpi` : "—"],
    [t("inspector.general.colorModel"), g.colorModel],
    [t("inspector.general.profile"), g.profile ?? t("inspector.general.none")],
    [t("inspector.general.depth"), t("inspector.general.depthBits", { bits: g.depth })],
    [t("inspector.general.alpha"), yesNo(g.hasAlpha)],
    [t("inspector.general.size"), formatBytes(g.fileSize)],
    [t("inspector.general.created"), g.created ? formatDate(g.created, i18n.language) : "—"],
    [t("inspector.general.modified"), formatDate(g.modified, i18n.language)],
  ];
  return <Fields rows={rows} />;
}

function GpsTab({ meta }: { meta: Metadata }) {
  const { t } = useTranslation();
  const gps = meta.gps;
  if (!gps) return <p className="inspector-empty">{t("inspector.noGps")}</p>;
  const rows: [string, string][] = [
    [t("inspector.latitude"), formatCoord(gps.lat, "lat")],
    [t("inspector.longitude"), formatCoord(gps.lon, "lon")],
  ];
  if (gps.alt !== null) rows.push([t("inspector.altitude"), `${gps.alt.toFixed(1)} m`]);
  return (
    <>
      <Fields rows={rows} />
      <button className="inspector-action" onClick={() => void openUrl(mapUrl(gps))}>
        {t("inspector.openMap")}
      </button>
    </>
  );
}

function KeywordsTab({ id }: { id: DocId }) {
  const { t } = useTranslation();
  const words = useKeywords(id);
  const [draft, setDraft] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    addKeyword(id, draft);
    setDraft("");
  };
  return (
    <>
      {words.length === 0 ? (
        <p className="inspector-empty">{t("inspector.noKeywords")}</p>
      ) : (
        <ul className="inspector-chips">
          {words.map((w) => (
            <li key={w}>
              <span>{w}</span>
              <button aria-label={t("inspector.removeKeyword", { word: w })} onClick={() => removeKeyword(id, w)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="inspector-add" onSubmit={submit}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={t("inspector.newKeyword")} />
        <button type="submit">{t("inspector.addKeyword")}</button>
      </form>
      <p className="inspector-hint">{t("inspector.keywordsHint")}</p>
    </>
  );
}

function AnnotationsTab({ id }: { id: DocId }) {
  const { t } = useTranslation();
  const items = useAnnotations(id);
  if (items.length === 0) return <p className="inspector-empty">{t("inspector.noAnnotations")}</p>;
  return (
    <ul className="inspector-list">
      {items.map((a) => (
        <li key={a.id}>
          <button onClick={() => getAnnotationSource()?.select(id, a.id)}>
            <small>{a.kind}</small> {a.label}
          </button>
        </li>
      ))}
    </ul>
  );
}
