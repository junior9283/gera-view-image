import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { open as openDialog, save as saveDialog } from "../lib/dialogs";
import { notify, notifyError } from "../chrome/notify";
import { TagsInput } from "../finder/TagsInput";
import * as ipc from "../ipc/commands";
import type { DocInfo, ExportFormat, ExportOptions, TiffCompression } from "../ipc/types";
import { useModal } from "../lib/modal";
import { hasPages, shownPage } from "../markup/pages";
import { useDocs } from "../store/docs";
import { reportBatch, type BatchFailure } from "../sidebar/batch";
import { batchTargets } from "../sidebar/selection";
import { addRecent } from "../store/prefs";
import { viewable } from "../viewer/actions";
import {
  ALT_FORMATS, EXTENSIONS, defaultOptions, exportFormatOf, exportFormats, formatBytes, useEstimate, useHeicEncoder,
} from "./estimate";
import { dirname, exportDoc, stem } from "./fileActions";
import "./file.css";

const LOSSY: ExportFormat[] = ["jpeg", "heic", "webp", "avif", "jp2", "pdf"];
/** Com perdas ou sem perdas (`quality: null`). */
const LOSSLESS_OPTION: ExportFormat[] = ["webp", "jp2", "pdf"];
const DEEP: ExportFormat[] = ["png", "tiff"];
const ALPHA: ExportFormat[] = ["png", "tiff", "heic", "webp", "avif", "jp2", "exr", "pdf", "gif", "ico", "tga", "psd"];
/** Formatos que guardam a resolução (ppp); no PDF, ela define o tamanho da página. */
const RESOLUTION: ExportFormat[] = ["jpeg", "png", "tiff", "heic", "webp", "avif", "exr", "bmp", "pdf", "psd"];
const TIFF_COMPRESSIONS: TiffCompression[] = ["none", "lzw", "packbits", "deflate"];
const MAX_DPI = 10000;
const DEFAULT_QUALITY: Partial<Record<ExportFormat, number>> = { jpeg: 90, heic: 80, webp: 90, avif: 80, jp2: 90, pdf: 90 };
/** Qualidade ao escolher o formato (o PDF começa sem perdas). */
const initialQuality = (f: ExportFormat) => (f === "pdf" ? null : (DEFAULT_QUALITY[f] ?? null));
/** Perfil de saída (Lote 1): "keep" mantém o da imagem; os outros são ids de `ColorProfile`. */
const OUTPUT_PROFILES = ["keep", "srgb", "display-p3", "adobe-rgb"] as const;
/** Formatos que não levam perfil: só manter (o Rust grava em sRGB) ou sRGB. */
const NO_PROFILE: ExportFormat[] = ["avif", "exr", "pdf", "gif", "ico", "tga"];
const outputProfiles = (f: ExportFormat) => (NO_PROFILE.includes(f) ? OUTPUT_PROFILES.slice(0, 2) : OUTPUT_PROFILES);
const profileFor = (f: ExportFormat, p: string | null | undefined) =>
  outputProfiles(f).some((x) => x === p) ? p : null;

/** Pasta da última exportação (padrão para documentos sem caminho). */
let lastFolder = "";

const optionsFor = (format: ExportFormat): ExportOptions => ({
  ...defaultOptions(format), quality: initialQuality(format),
});

/**
 * Formatos com codificador. Enquanto a consulta não volta, HEIC aparece; se faltar a libkvazaar,
 * sai da lista e uma escolha HEIC vira PNG.
 */
function useFormats(opts: ExportOptions, onChange: (o: ExportOptions) => void, alt: boolean): ExportFormat[] {
  const heic = useHeicEncoder();
  const missing = heic === false && opts.format === "heic";
  useEffect(() => {
    if (missing) onChange(optionsFor("png"));
  }, [missing, onChange]);
  return exportFormats(heic !== false, alt || ALT_FORMATS.includes(opts.format));
}

/** A tecla Alt mostra os formatos extras enquanto o diálogo estiver aberto. */
function useAltFormats(): [boolean, () => void] {
  const [alt, setAlt] = useState(false);
  useEffect(() => {
    // Na captura e sem propagar: o Alt sozinho abriria a barra de menus atrás do diálogo.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      e.stopPropagation();
      setAlt(true);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  return [alt, () => setAlt(true)];
}

/** Resolução (ppp). Vazio mantém a do documento, mostrada como sugestão. */
function ResolutionField({ dpi, current, onChange }: { dpi: number | null; current: number | null; onChange: (d: number | null) => void }) {
  const { t } = useTranslation();
  return (
    <label className="file-row">
      <span>{t("file.export.resolution")}</span>
      <input
        type="number" min={1} max={MAX_DPI} value={dpi ?? ""} data-testid="export-dpi"
        placeholder={current === null ? t("file.export.keepResolution") : String(Math.round(current * 100) / 100)}
        onChange={(e) => {
          const v = Number(e.target.value);
          onChange(v > 0 ? Math.min(v, MAX_DPI) : null);
        }}
      />
      <span>{t("file.export.ppi")}</span>
    </label>
  );
}

/** Campos de formato/qualidade/profundidade/alfa/metadados, comuns aos dois diálogos. */
function OptionsFields({ opts, onChange, currentDpi = null }: {
  opts: ExportOptions;
  onChange: (o: ExportOptions) => void;
  /** Resolução do documento (nenhuma se são vários). */
  currentDpi?: number | null;
}) {
  const { t } = useTranslation();
  const [alt, showAlt] = useAltFormats();
  const formats = useFormats(opts, onChange, alt);
  const f = opts.format;
  const set = (patch: Partial<ExportOptions>) => onChange({ ...opts, ...patch });
  const lossless = LOSSLESS_OPTION.includes(f) && opts.quality === null;
  return (
    <>
      <label className="file-row">
        <span>{t("file.export.format")}</span>
        <select
          value={f} title={t("file.export.altFormats")}
          // Alt+clique: a lista precisa estar completa antes de o menu abrir.
          onPointerDown={(e) => e.altKey && flushSync(showAlt)}
          onChange={(e) => {
            const format = e.target.value as ExportFormat;
            set({ format, quality: initialQuality(format), depth16: opts.depth16 && DEEP.includes(format),
              colorProfile: profileFor(format, opts.colorProfile), dpi: RESOLUTION.includes(format) ? opts.dpi : null });
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
      {f === "tiff" && (
        <label className="file-row">
          <span>{t("file.export.compression")}</span>
          <select
            value={opts.tiffCompression ?? "none"}
            onChange={(e) => set({ tiffCompression: e.target.value as TiffCompression })}
          >
            {TIFF_COMPRESSIONS.map((c) => (
              <option key={c} value={c}>{t(`file.export.compressions.${c}`)}</option>
            ))}
          </select>
        </label>
      )}
      {f === "exr" && (
        <label className="file-row">
          <span>{t("file.export.depth")}</span>
          <select value={opts.exrHalf ? "half" : "float"} onChange={(e) => set({ exrHalf: e.target.value === "half" })}>
            <option value="half">{t("file.export.depths.half")}</option>
            <option value="float">{t("file.export.depths.float")}</option>
          </select>
        </label>
      )}
      {RESOLUTION.includes(f) && (
        <ResolutionField dpi={opts.dpi ?? null} current={currentDpi} onChange={(dpi) => set({ dpi })} />
      )}
      {ALPHA.includes(f) && (
        <label className="file-check">
          <input type="checkbox" checked={opts.alpha} onChange={(e) => set({ alpha: e.target.checked })} />
          {t("file.export.alpha")}
        </label>
      )}
      <label className="file-row">
        <span>{t("file.export.profile")}</span>
        <select
          value={opts.colorProfile ?? "keep"}
          onChange={(e) => set({ colorProfile: e.target.value === "keep" ? null : e.target.value })}
          data-testid="export-profile"
        >
          {outputProfiles(f).map((p) => (
            <option key={p} value={p}>{t(`file.export.profiles.${p}`)}</option>
          ))}
        </select>
      </label>
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
  const dialog = useRef<HTMLDivElement>(null);
  useModal(dialog, { onClose });
  return (
    <div className="file-backdrop" role="presentation">
      <div
        ref={dialog} className="file-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
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
  const [tags, setTags] = useState<string[]>([]);
  const [dpi, setDpi] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    ipc.documentDpi(doc.id).then((d) => live && setDpi(d), () => {});
    return () => {
      live = false;
    };
  }, [doc.id]);
  // Como no app da Apple: exporta o que está na tela.
  const [frame] = useState(() => shownPage(doc.id));
  const bytes = useEstimate(doc.id, { ...opts, frame });
  const heic = useHeicEncoder();

  // Outro destino: o aviso de substituir era sobre o anterior.
  const rename = (n: string) => {
    setName(n);
    setOverwrite(null);
  };
  const moveTo = (dir: string) => {
    setFolder(dir);
    setOverwrite(null);
  };
  const changeOpts = (o: ExportOptions) => {
    if (o.format !== opts.format) rename(withExt(name, o.format));
    setOpts(o);
  };

  const pick = async () => {
    const path = await saveDialog({ defaultPath: join(folder || ".", name) });
    if (!path) return;
    moveTo(dirname(path));
    rename(path.slice(path.lastIndexOf("/") + 1));
    setConfirmed(path); // o diálogo do sistema já perguntou sobre substituir
  };

  const run = async (force = false) => {
    setError(null);
    if (!folder.trim()) return setError(t("file.export.noFolder"));
    if (!name.trim()) return setError(t("file.export.noName"));
    const dest = join(folder.trim(), name.trim());
    const agreed = confirmed === dest || (force && overwrite === dest);
    if (!agreed && (await ipc.pathExists(dest))) return setOverwrite(dest);
    setBusy(true);
    try {
      const info = await exportDoc(doc.id, dest, { ...opts, frame }, tags);
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
        <input type="text" value={name} onChange={(e) => rename(e.target.value)} data-testid="export-name" autoFocus />
        <button type="button" onClick={() => void pick().catch(notifyError)}>{t("file.export.choose")}</button>
      </label>
      <div className="file-row">
        <span>{t("finder.popover.tags")}</span>
        <TagsInput tags={tags} onChange={setTags} />
      </div>
      <FolderField folder={folder} setFolder={moveTo} />
      <OptionsFields opts={opts} onChange={changeOpts} currentDpi={dpi} />
      {hasPages(doc) && (
        <p className="file-hint" data-testid="export-page">{t("file.export.onlyPage", { page: frame + 1, total: doc.frames })}</p>
      )}
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
  // Com várias miniaturas selecionadas na barra lateral, só elas vêm marcadas; senão, todas.
  const [chosen, setChosen] = useState<Set<number>>(() => {
    const picked = batchTargets();
    return new Set(picked.length > 1 ? picked : docs.map((d) => d.id));
  });
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
    const failed: BatchFailure[] = [];
    for (const [i, d] of list.entries()) {
      try {
        const dest = await freeName(folder.trim(), stem(d.name), EXTENSIONS[opts.format]);
        await exportDoc(d.id, dest, { ...opts, resize: fitLongest(d.width, d.height, Number(longest)) });
        ok++;
      } catch (e) {
        console.error(e);
        failed.push({ id: d.id, name: d.name, error: String((e as { message?: unknown } | null)?.message ?? e) });
      }
      setProgress({ done: i + 1, total: list.length });
    }
    lastFolder = folder.trim();
    // Uma falha não interrompe as demais; no fim, um só aviso diz quais arquivos falharam.
    if (failed.length) reportBatch({ total: list.length, done: ok, failed });
    else notify(t("file.exportedMany", { count: ok }));
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
