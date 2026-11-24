import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { track } from "./inflight";
import type {
  AppEntry, CaptureMode, ColorAdjust, ColorProfile, DetectedCode, DocId, DocInfo, DragSource, ExportOptions, FileStat,
  FileVersion, Histogram, Incoming, Mask, Metadata, MetadataEdits, Op, PrintOptions, PrintPreview, QuitOutcome, Rect, RevertTarget, SaveOutcome, TaggedExport, TextLine,
  ViewBuffer, WindowEntry,
} from "./types";
// Lote 6
import type { Device } from "./types";
import type { LinkInfo, OcrModels, WebKind } from "./types";
import type { ScanDevice, ScanKind, ScanOptions } from "./types";

/** `invoke` que conta os comandos em andamento por documento (`whenIdle`). */
const invoke = <T>(...args: Parameters<typeof tauriInvoke>): Promise<T> => track(args[0], args[1], tauriInvoke<T>(...args));

/** Lê o formato de `render_view`/`thumbnail`: `u32 LE w`, `u32 LE h`, RGBA. */
export function decodeViewBuffer(raw: ArrayBuffer | Uint8Array): ViewBuffer {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength < 8) throw new Error("buffer de prévia sem cabeçalho");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dv.getUint32(0, true);
  const height = dv.getUint32(4, true);
  const len = width * height * 4;
  if (bytes.byteLength < 8 + len) throw new Error("buffer de prévia truncado");
  // O IPC do Tauri entrega ArrayBuffer comum (nunca SharedArrayBuffer).
  return { width, height, data: new Uint8ClampedArray(bytes.buffer as ArrayBuffer, bytes.byteOffset + 8, len) };
}

export const openDocuments = (paths: string[]) => invoke<DocInfo[]>("open_documents", { paths });

/** Documentos de `argv[1..]`, já abertos pelo Rust durante a inicialização. */
export const startupDocuments = () => invoke<DocInfo[]>("startup_documents");

export const closeDocument = (id: DocId) => invoke<void>("close_document", { id });

export const folderImages = (path: string) => invoke<string[]>("folder_images", { path });

export const renderView = async (id: DocId, frame: number, maxW: number, maxH: number, region: Rect | null = null) =>
  decodeViewBuffer(await invoke<ArrayBuffer>("render_view", { id, frame, maxW, maxH, region }));

/** `renderView` do visor e da lupa: com a prova de cor do documento. */
export const renderScreen = async (id: DocId, frame: number, maxW: number, maxH: number, region: Rect | null = null) =>
  decodeViewBuffer(await invoke<ArrayBuffer>("render_view", { id, frame, maxW, maxH, region, proof: true }));

export const thumbnail = async (id: DocId, frame: number, size: number) =>
  decodeViewBuffer(await invoke<ArrayBuffer>("thumbnail", { id, frame, size }));

/** `JSON.stringify(Uint8Array)` vira objeto; os bytes do PNG precisam ir como lista. */
const toWire = (op: Op): Op =>
  op.type === "composite" && op.data.png instanceof Uint8Array ? { ...op, data: { ...op.data, png: Array.from(op.data.png) } } : op;

/** `frame`: só essa página (documento de várias páginas); ausente = a imagem toda, como sempre. */
export const applyOp = (id: DocId, op: Op, frame?: number) =>
  invoke<DocInfo>("apply_op", { id, op: toWire(op), ...(frame === undefined ? {} : { frame }) });

export const undo = (id: DocId) => invoke<DocInfo>("undo", { id });

export const redo = (id: DocId) => invoke<DocInfo>("redo", { id });

/** A primeira página é o padrão no Rust. */
const onFrame = (frame: number) => (frame ? { frame } : {});

/** Alfa Instantâneo: máscara contígua à cor do pixel (x, y); tolerância 0..1. */
export const instantAlpha = (id: DocId, x: number, y: number, tolerance: number, frame = 0) =>
  invoke<Mask>("instant_alpha", { id, x, y, tolerance, ...onFrame(frame) });

/** Laço magnético: devolve o caminho colado nas bordas. */
export const snapLasso = (id: DocId, points: [number, number][], frame = 0) =>
  invoke<[number, number][]>("snap_lasso", { id, points, ...onFrame(frame) });

/** Copia a região da página (ou ela toda, sem máscara) para a área de transferência como PNG. */
export const copyRegion = (id: DocId, mask: Mask | null, frame = 0) =>
  invoke<void>("copy_region", { id, mask, ...onFrame(frame) });

/** Prévia de um ajuste de cor no trecho `region` da página `frame`; não altera o documento. */
export const previewAdjust = async (id: DocId, adjust: ColorAdjust, maxW: number, maxH: number, frame = 0, region: Rect | null = null) =>
  decodeViewBuffer(await invoke<ArrayBuffer>("preview_adjust", { id, adjust, maxW, maxH, region, ...onFrame(frame) }));

export const histogram = (id: DocId, frame = 0) => invoke<Histogram>("histogram", { id, ...onFrame(frame) });

export const autoLevels = (id: DocId, frame = 0) => invoke<ColorAdjust>("auto_levels", { id, ...onFrame(frame) });

/** Metadados do arquivo; as dimensões são as da página. */
export const metadata = (id: DocId, frame = 0) => invoke<Metadata>("metadata", { id, ...onFrame(frame) });

// ---------- Arquivo (Task 11) ----------

/** Salvar viraria Exportar? Sondagem leve, sem gravar nem achatar nada. */
export const saveNeedsExport = (id: DocId) => invoke<boolean>("save_needs_export", { id });

/** `keywords`: palavras-chave editadas no inspetor (`null` = manter as do arquivo). */
export const save = (id: DocId, keywords: string[] | null) => invoke<SaveOutcome>("save", { id, keywords });

export const exportDoc = (id: DocId, dest: string, opts: ExportOptions, keywords: string[] | null) =>
  invoke<DocInfo>("export", { id, dest, opts, keywords });

export const estimateSize = (id: DocId, opts: ExportOptions) => invoke<number>("estimate_size", { id, opts });

/** Há codificador HEVC (libkvazaar, opcional): sem ele o HEIC some do Exportar. */
export const heicEncoderAvailable = () => invoke<boolean>("heic_encoder_available");

export const revert = (id: DocId, to: RevertTarget) => invoke<DocInfo>("revert", { id, to });

export const renameDoc = (id: DocId, name: string) => invoke<DocInfo>("rename", { id, name });

export const moveTo = (id: DocId, dir: string) => invoke<DocInfo>("move_to", { id, dir });

export const duplicate = (id: DocId, name: string) => invoke<DocInfo>("duplicate", { id, name });

/** DPI atual (do arquivo ou do último Ajustar Tamanho da página); `null` se o arquivo não informa. */
export const documentDpi = (id: DocId, frame = 0) => invoke<number | null>("document_dpi", { id, ...onFrame(frame) });

/** Pixels CSS por polegada do monitor da janela; `null` se o sistema não informa o tamanho. */
export const screenPpi = () => invoke<number | null>("screen_ppi");

export const pathExists = (path: string) => invoke<boolean>("path_exists", { path });

export const ignoreDiskChange = (id: DocId) => invoke<void>("ignore_disk_change", { id });

export const openWith = (id: DocId) => invoke<void>("open_with", { id });

export const reveal = (id: DocId) => invoke<void>("reveal", { id });

/** Arraste nativo para fora da janela; resolve quando ele termina. */
export const startDrag = (items: DragSource[]) => invoke<void>("start_drag", { items });

/** Copia como arquivos (e, com um só, também a imagem da página `frame`). */
export const copyFiles = (items: DragSource[], frame = 0) => invoke<void>("copy_files", { items, ...onFrame(frame) });
/** Arquivos na área de transferência. */
export const clipboardFiles = () => invoke<string[]>("clipboard_files");


export const newFromClipboard = (name: string) => invoke<DocInfo>("new_from_clipboard", { name });

/** `null` = o usuário cancelou a captura. */
export const captureScreen = (mode: CaptureMode, name: string) =>
  invoke<DocInfo | null>("capture_screen", { mode, name });

// ---------- Lotes de paridade (stubs do Lote 0: rejeitam com `unsupported` até o lote implementar) ----------

// Lote 1: cor
export const displayProfile = () => invoke<string | null>("display_profile");
export const listProfiles = () => invoke<ColorProfile[]>("list_profiles");
export const assignProfile = (id: DocId, profile: string) => invoke<DocInfo>("assign_profile", { id, profile });
/** Perfil atual (o atribuído, ou o embutido com `id` vazio); `null` = sRGB presumido. */
export const documentProfile = (id: DocId) => invoke<ColorProfile | null>("document_profile", { id });

/** Perfis da Prova de Cor: os de `listProfiles` e também os CMYK e cinza instalados. */
export const listProofProfiles = () => invoke<ColorProfile[]>("list_proof_profiles");

/** Troca o perfil de prova (`null` = nenhum; caminho de um .icc ou id de `ColorProfile`). Só a exibição. */
export const setProofProfile = (id: DocId, profile: string | null) =>
  invoke<ColorProfile | null>("set_proof_profile", { id, profile });
export const setColorManagement = (enabled: boolean) => invoke<void>("set_color_management", { enabled });

// Lote 2: PNG da área de transferência, para colar como camada
export const clipboardImage = async () => new Uint8Array(await invoke<ArrayBuffer>("clipboard_image"));
/** PNG do primeiro quadro de um arquivo solto sobre a imagem aberta. */
export const imageFilePng = async (path: string) => new Uint8Array(await invoke<ArrayBuffer>("image_file_png", { path }));
/** Copiar com as anotações (`png` no tamanho da imagem) compostas por cima; `mask` nula = imagem inteira. */
export const copyImage = (id: DocId, mask: Mask | null, png: Uint8Array | number[], frame = 0) =>
  invoke<void>("copy_image", { id, mask, png: Array.from(png), ...onFrame(frame) });

/** Copia anotações: `data` (JSON) fica no núcleo, para qualquer janela colar, e `png` vai para o sistema. */
export const copyAnnotations = (data: string, png: Uint8Array) => invoke<void>("copy_annotations", { data, png: Array.from(png) });
/** As anotações copiadas, se a cópia delas ainda for a última do sistema. */
export const pastedAnnotations = () => invoke<string | null>("pasted_annotations");

// Lote 3: Texto ao Vivo e fala
export const recognizeText = (id: DocId, frame: number) => invoke<TextLine[]>("recognize_text", { id, frame });
export const detectCodes = (id: DocId, frame: number) => invoke<DetectedCode[]>("detect_codes", { id, frame });
export const speak = (text: string) => invoke<void>("speak", { text });
export const stopSpeaking = () => invoke<void>("stop_speaking");
export const ocrModels = () => invoke<OcrModels>("ocr_models");
export const downloadOcrModels = () => invoke<void>("download_ocr_models");
export const cancelTextRecognition = () => invoke<void>("cancel_text_recognition");
export const copyText = (text: string) => invoke<void>("copy_text", { text });
export const inspectLink = (text: string) => invoke<LinkInfo>("inspect_link", { text });
export const openWeb = (kind: WebKind, text: string, lang: string) => invoke<void>("open_web", { kind, text, lang });

// Lote 4: sujeito
export const segmentSubject = (id: DocId, frame = 0) => invoke<Mask>("segment_subject", { id, ...onFrame(frame) });
/** O modelo de segmentação já está no disco? Falso = `segmentSubject` vai baixá-lo (4,4 MB). */
export const segmentModelReady = () => invoke<boolean>("segment_model_ready");
export const segmentCancel = () => invoke<void>("segment_cancel");

// Lote 5: Finder
export const fileTags = (id: DocId) => invoke<string[]>("file_tags", { id });
/** Devolve a lista gravada (sem vazias nem repetidas). */
export const setFileTags = (id: DocId, tags: string[]) => invoke<string[]>("set_file_tags", { id, tags });
export const setLocked = (id: DocId, locked: boolean) => invoke<DocInfo>("set_locked", { id, locked });
export const moveToTrash = (id: DocId) => invoke<void>("move_to_trash", { id });
export const listVersions = (id: DocId) => invoke<FileVersion[]>("list_versions", { id });
export const restoreVersion = (id: DocId, version: string) => invoke<DocInfo>("restore_version", { id, version });
export const saveAs = (id: DocId, dest: string, opts: ExportOptions, keywords: string[] | null = null) =>
  invoke<DocInfo>("save_as", { id, dest, opts, keywords });
export const fileLocked = (id: DocId) => invoke<boolean>("file_locked", { id });
export const versionPreview = async (id: DocId, version: string, size: number) =>
  decodeViewBuffer(await invoke<ArrayBuffer>("version_preview", { id, version, size }));
/** `prefs.versionsMaxMb` (0 desliga as versões novas). */
export const setVersionsLimit = (mb: number) => invoke<void>("set_versions_limit", { mb });

// Lote 6: Compartilhar
export const shareEmail = (ids: DocId[]) => invoke<void>("share_email", { ids });
export const shareDevice = (ids: DocId[], device: string) => invoke<void>("share_device", { ids, device });
export const shareDevices = () => invoke<Device[]>("share_devices");
export const shareDeviceAvailable = () => invoke<boolean>("share_device_available");
export const openWithApps = (id: DocId) => invoke<AppEntry[]>("open_with_apps", { id });
export const openWithApp = (id: DocId, app: string) => invoke<void>("open_with_app", { id, app });

// Lote 7: Ordenar Por
export const fileStats = (ids: DocId[]) => invoke<FileStat[]>("file_stats", { ids });

// Lote 9: metadados editáveis
export const editMetadata = (id: DocId, edits: MetadataEdits) => invoke<void>("edit_metadata", { id, edits });
/** Lote 9: avisos da última gravação sobre os textos (`xmpRebuilt`, `exifDropped`, `textNotSaved`). */
export const takeMetaNotes = (id: DocId) => invoke<string[]>("take_meta_notes", { id });

// Lote 10: fontes do sistema
export const systemFonts = () => invoke<string[]>("system_fonts");
/** Arma/desarma o consentimento da câmera da assinatura (só vale para um pedido de vídeo). */
export const cameraAllow = (allowed: boolean) => invoke<void>("camera_allow", { allowed });

// Lote 11: PDF e impressão nativa
export const exportPdf = (ids: DocId[], dest: string) => invoke<void>("export_pdf", { ids, dest });
/** `true` = entregue à impressora (ou gravado em arquivo); `false` = cancelado. */
export const printNative = (ids: DocId[], opts: PrintOptions, title: string) =>
  invoke<boolean>("print_native", { ids, opts, title });
export const printPreview = (ids: DocId[], opts: PrintOptions) => invoke<PrintPreview>("print_preview", { ids, opts });
export const exportTagged = (id: DocId, dest: string, opts: ExportOptions, keywords: string[] | null, tags: string[]) =>
  invoke<TaggedExport>("export_tagged", { id, dest, opts, keywords, tags });

// Lote 12: janelas e scanner
/** Passa os documentos (com o estado da interface, opaco) para uma janela nova; devolve o rótulo dela. */
export const newWindow = (ids: DocId[], state: string) => invoke<string>("new_window", { ids, state });
export const moveDocuments = (ids: DocId[], to: string, state: string) => invoke<void>("move_documents", { ids, to, state });
/** Retira os documentos entregues a esta janela. */
export const takeDocuments = () => invoke<Incoming[]>("take_documents");
export const listWindows = () => invoke<WindowEntry[]>("list_windows");
export const focusWindow = (label: string) => invoke<void>("focus_window", { label });
export const bringAllToFront = () => invoke<void>("bring_all_to_front");
/** Pede às outras janelas que mandem seus documentos para esta. */
export const mergeWindows = () => invoke<void>("merge_windows");
export const setWindowTitle = (title: string) => invoke<void>("set_window_title", { title });
/** Os caminhos que não estão abertos em outra janela; `focus` traz para a frente a janela dos outros. */
export const focusOpenPaths = (paths: string[], focus: boolean) => invoke<string[]>("focus_open_paths", { paths, focus });
/**
 * Começa a fechar esta janela; falso = há documentos chegando (retire-os e pergunte de novo). `quit` é a
 * rodada da saída: se ela for cancelada, o selo cai.
 */
export const sealWindow = (quit: number | null) => invoke<boolean>("seal_window", { quit });
export const unsealWindow = () => invoke<void>("unseal_window");
/** Fecha esta janela (só depois de selada). */
export const closeWindow = () => invoke<void>("close_window");
export const closeOtherWindows = () => invoke<void>("close_other_windows");
/** Pergunta a cada janela; `skip` = as que não respondem e o usuário decidiu não esperar. */
export const confirmQuit = (skip: string[]) => invoke<QuitOutcome>("confirm_quit", { skip });
export const answerClose = (round: number, ok: boolean) => invoke<void>("answer_close", { round, ok });
export const pong = (n: number) => invoke<void>("pong", { n });
/** Juntar Todas as Janelas: esta não pode ir agora. */
export const declineMerge = (to: string) => invoke<void>("decline_merge", { to });
export const cancelQuit = () => invoke<void>("cancel_quit");
export const quitApp = () => invoke<void>("quit_app");
/** Importar do Scanner (`scanimage` externo). Os `null` = cancelado. */
export const scanAvailable = () => invoke<boolean>("scan_available");
export const scanDevices = () => invoke<ScanDevice[] | null>("scan_devices");
export const scanOptions = (device: string) => invoke<ScanOptions | null>("scan_options", { device });
export const scanImage = (device: string, mode: ScanKind, resolution: number, name: string) =>
  invoke<DocInfo | null>("scan_image", { device, mode, resolution, name });
export const scanCancel = () => invoke<void>("scan_cancel");
/** Arquivos que outra execução do app pediu para esta janela abrir. */
export const takeOpenRequests = () => invoke<string[]>("take_open_requests");
