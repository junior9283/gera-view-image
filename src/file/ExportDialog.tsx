import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { notify, notifyError } from "../chrome/notify";
import * as ipc from "../ipc/commands";
import type { DocInfo, ExportFormat, ExportOptions } from "../ipc/types";
import { useDocs } from "../store/docs";
import { addRecent } from "../store/prefs";
import { viewable } from "../viewer/actions";
import {
  EXTENSIONS, defaultOptions, exportFormatOf, exportFormats, formatBytes, useEstimate, useHeicEncoder,
} from "./estimate";
import { dirname, exportDoc, stem } from "./fileActions";
import "./file.css";

const LOSSY: ExportFormat[] = ["jpeg", "heic", "webp", "avif", "jp2"];
/** Com perdas ou sem perdas (`quality: null`). */
const LOSSLESS_OPTION: ExportFormat[] = ["webp", "jp2"];
const DEEP: ExportFormat[] = ["png", "tiff"];
const ALPHA: ExportFormat[] = ["png", "tiff", "heic", "webp", "avif", "jp2", "exr"];
const DEFAULT_QUALITY: Partial<Record<ExportFormat, number>> = { jpeg: 90, heic: 80, webp: 90, avif: 80, jp2: 90 };

/** Pasta da última exportação (padrão para documentos sem caminho). */
let lastFolder = "";

const optionsFor = (format: ExportFormat): ExportOptions => ({
  ...defaultOptions(format), quality: DEFAULT_QUALITY[format] ?? null,
});

/**
 * Formatos com codificador. Enquanto a consulta não volta, HEIC aparece; se faltar a libkvazaar,
 * sai da lista e uma escolha HEIC vira PNG.
 */
function useFormats(opts: ExportOptions, onChange: (o: ExportOptions) => void): ExportFormat[] {
  const heic = useHeicEncoder();
  const missing = heic === false && opts.format === "heic";
  useEffect(() => {
    if (missing) onChange(optionsFor("png"));
  }, [missing, onChange]);
  return exportFormats(heic !== false);
}

/** Campos de formato/qualidade/profundidade/alfa/metadados, comuns aos dois diálogos. */
function OptionsFields({ opts, onChange }: { opts: ExportOptions; onChange: (o: ExportOptions) => void }) {
  const { t } = useTranslation();
  const formats = useFormats(opts, onChange);
  const f = opts.format;
  const set = (patch: Partial<ExportOptions>) => onChange({ ...opts, ...patch });
  const lossless = LOSSLESS_OPTION.includes(f) && opts.quality === null;
  return (
    <>
      <label className="file-row">
        <span>{t("file.export.format")}</span>
        <select
          value={f}
          onChange={(e) => {
            const format = e.target.value as ExportFormat;
            set({ format, quality: DEFAULT_QUALITY[format] ?? null, depth16: opts.depth16 && DEEP.includes(format) });
          }}
        >
          {formats.map((x) => (
            <option key={x} value={x}>{t(`file.export.formats.${x}`)}</option>
          ))}
        </select>
      </label>
      {LOSSLESS_OPTION.includes(f) && (
        <label className="file-check">
          <input
            type="checkbox" checked={lossless}
            onChange={(e) => set({ quality: e.target.checked ? null : DEFAULT_QUALITY[f]! })}
          />
          {t("file.export.lossless")}
        </label>
      )}
      {LOSSY.includes(f) && !lossless && (
        <label className="file-row">
          <span>{t("file.export.quality")}</span>
          <input
            type="range" min={1} max={100} value={opts.quality ?? DEFAULT_QUALITY[f]}
            onChange={(e) => set({ quality: Number(e.target.value) })}
          />
          <span>{opts.quality ?? DEFAULT_QUALITY[f]}</span>
        </label>
      )}
      {DEEP.includes(f) && (
        <label className="file-check">
          <input type="checkbox" checked={opts.depth16} onChange={(e) => set({ depth16: e.target.checked })} />
          {t("file.export.depth16")}
        </label>
      )}
      {ALPHA.includes(f) && (
        <label className="file-check">
          <input type="checkbox" checked={opts.alpha} onChange={(e) => set({ alpha: e.target.checked })} />
          {t("file.export.alpha")}
        </label>
      )}
      <label className="file-check">
        <input type="checkbox" checked={opts.stripMetadata} onChange={(e) => set({ stripMetadata: e.target.checked })} />
        {t("file.export.strip")}
      </label>
    </>
  );
}

const initialOptions = (doc: DocInfo): ExportOptions => optionsFor(exportFormatOf(doc.format));

const withExt = (name: string, f: ExportFormat) => `${stem(name)}.${EXTENSIONS[f]}`;
const join = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;

function Frame({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const titleId = useId();
  return (
    <div className="file-backdrop" role="presentation">
      <div
        className="file-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <h3 id={titleId}>{title}</h3>
        {children}
      </div>
    </div>
  );
}

function FolderField({ folder, setFolder }: { folder: string; setFolder: (f: string) => void }) {
  const { t } = useTranslation();
  const choose = async () => {
    const dir = await openDialog({ directory: true, multiple: false, defaultPath: folder || undefined });
    if (typeof dir === "string") setFolder(dir);
  };
  return (
    <label className="file-row">
      <span>{t("file.export.folder")}</span>
      <input type="text" value={folder} onChange={(e) => setFolder(e.target.value)} data-testid="export-folder" />
      <button type="button" onClick={() => void choose().catch(notifyError)}>{t("file.export.choose")}</button>
    </label>
  );
}

/** Exportar… (e "Salvar Como" para o que não dá para regravar no lugar). */
export function ExportDialog({ doc, mode, onClose }: { doc: DocInfo; mode: "export" | "save"; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [opts, setOpts] = useState(() => initialOptions(doc));
  const [name, setName] = useState(() => withExt(doc.name, opts.format));
  const [folder, setFolder] = useState(() => (doc.path ? dirname(doc.path) : lastFolder));
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bytes = useEstimate(doc.id, opts);
  const heic = useHeicEncoder();

  const changeOpts = (o: ExportOptions) => {
    if (o.format !== opts.format) setName((n) => withExt(n, o.format));
    setOpts(o);
  };

  const pick = async () => {
    const path = await saveDialog({ defaultPath: join(folder || ".", name) });
    if (!path) return;
    setFolder(dirname(path));
    setName(path.slice(path.lastIndexOf("/") + 1));
    setConfirmed(path); // o diálogo do sistema já perguntou sobre substituir
  };

  const run = async (force = false) => {
    setError(null);
    if (!folder.trim()) return setError(t("file.export.noFolder"));
    if (!name.trim()) return setError(t("file.export.noName"));
    const dest = join(folder.trim(), name.trim());
    if (!force && confirmed !== dest && (await ipc.pathExists(dest))) return setOverwrite(dest);
    setBusy(true);
    try {
      const info = await exportDoc(doc.id, dest, opts);
      lastFolder = folder.trim();
      if (info.path === dest) addRecent(dest);
      notify(t("file.exported", { name: name.trim() }));
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };

  return (
    <Frame title={t(mode === "save" ? "file.export.titleSave" : "file.export.title")} onClose={onClose}>
      <label className="file-row">
        <span>{t("file.export.name")}</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} data-testid="export-name" autoFocus />
        <button type="button" onClick={() => void pick().catch(notifyError)}>{t("file.export.choose")}</button>
      </label>
      <FolderField folder={folder} setFolder={setFolder} />
      <OptionsFields opts={opts} onChange={changeOpts} />
      {doc.format === "heic" && heic === false && <p className="file-hint">{t("file.export.heicEncoderMissing")}</p>}
      <p className="file-hint" data-testid="export-estimate">
        {bytes === null ? t("file.export.estimating") : t("file.export.estimate", { size: formatBytes(bytes, i18n.language) })}
      </p>
      {error && <p role="alert" className="file-error">{error}</p>}
      {overwrite && (
        <p role="alert" className="file-error">
          {t("file.export.overwrite", { name: overwrite.slice(overwrite.lastIndexOf("/") + 1) })}{" "}
          <button type="button" onClick={() => void run(true)}>{t("file.export.replace")}</button>
        </p>
      )}
      <div className="file-actions">
        <span className="file-spacer" />
        <button type="button" onClick={onClose}>{t("file.export.cancel")}</button>
        <button type="button" className="file-primary" disabled={busy} onClick={() => void run()} data-testid="export-ok">
          {t(mode === "save" ? "file.export.save" : "file.export.export")}
        </button>
      </div>
    </Frame>
  );
}

/** Lado maior limitado a `max` (sem ampliar). */
export function fitLongest(w: number, h: number, max: number): [number, number] | null {
  if (!max || Math.max(w, h) <= max) return null;
  const k = max / Math.max(w, h);
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

/** Nome livre na pasta: `nome.ext`, `nome (1).ext`... */
async function freeName(dir: string, base: string, ext: string): Promise<string> {
  for (let i = 0; ; i++) {
    const dest = join(dir, i ? `${base} (${i}).${ext}` : `${base}.${ext}`);
    if (!(await ipc.pathExists(dest))) return dest;
  }
}

/** Exportar Selecionadas: as mesmas opções para as imagens marcadas, numa pasta, com progresso. */
export function ExportSelectedDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const docs = useDocs((s) => s.docs).filter(viewable);
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(docs.map((d) => d.id)));
  const [opts, setOpts] = useState<ExportOptions>(() => optionsFor("jpeg"));
  const [folder, setFolder] = useState(lastFolder || (docs[0]?.path ? dirname(docs[0].path) : ""));
  const [longest, setLongest] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: number) =>
    setChosen((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });

  const run = async () => {
    setError(null);
    if (!folder.trim()) return setError(t("file.export.noFolder"));
    const list = docs.filter((d) => chosen.has(d.id));
    setProgress({ done: 0, total: list.length });
    let ok = 0;
    for (const [i, d] of list.entries()) {
      try {
        const dest = await freeName(folder.trim(), stem(d.name), EXTENSIONS[opts.format]);
        await exportDoc(d.id, dest, { ...opts, resize: fitLongest(d.width, d.height, Number(longest)) });
        ok++;
      } catch (e) {
        console.error(e);
        notify(t("file.export.failed", { name: d.name }));
      }
      setProgress({ done: i + 1, total: list.length });
    }
    lastFolder = folder.trim();
    notify(t("file.exportedMany", { count: ok }));
    onClose();
  };

  return (
    // Durante a exportação o Esc não fecha (o laço continuaria sem diálogo nem progresso).
    <Frame title={t("file.export.titleSelected")} onClose={progress ? () => {} : onClose}>
      <fieldset className="file-names" aria-label={t("file.export.images")}>
        {docs.map((d) => (
          <label key={d.id} className="file-check">
            <input type="checkbox" checked={chosen.has(d.id)} onChange={() => toggle(d.id)} />
            {d.name}
          </label>
        ))}
      </fieldset>
      <FolderField folder={folder} setFolder={setFolder} />
      <OptionsFields opts={opts} onChange={setOpts} />
      <label className="file-row">
        <span>{t("file.export.resize")}</span>
        <input type="number" min={1} value={longest} onChange={(e) => setLongest(e.target.value)} />
        <span>{t("file.export.pixels")}</span>
      </label>
      {progress && (
        <>
          <progress className="file-progress" value={progress.done} max={progress.total} />
          <p className="file-hint">{t("file.export.progress", progress)}</p>
        </>
      )}
      {error && <p role="alert" className="file-error">{error}</p>}
      <div className="file-actions">
        <span className="file-spacer" />
        <button type="button" onClick={onClose} disabled={!!progress}>{t("file.export.cancel")}</button>
        <button type="button" className="file-primary" disabled={!!progress || !chosen.size} onClick={() => void run()}>
          {t("file.export.export")}
        </button>
      </div>
    </Frame>
  );
}
