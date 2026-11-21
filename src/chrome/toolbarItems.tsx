// Itens da barra de ferramentas: os do padrão (como no Preview) e os opcionais do Personalizar.
import type { ComponentType, ReactNode } from "react";
import type { CommandId } from "../shortcuts/commands";
import { InspectorIcon, MarkupIcon, RotateIcon, ShareIcon, SidebarIcon, ZoomInIcon, ZoomOutIcon } from "./icons";

const Svg = ({ children }: { children: ReactNode }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 18 18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
);

const icon = (d: ReactNode) => () => <Svg>{d}</Svg>;

const CropIcon = icon(<path d="M5 1.5V13h11.5M1.5 5H13v11.5" />);
const AdjustColorIcon = icon(
  <>
    <path d="M3 4h12M3 9h12M3 14h12" />
    <circle cx="6" cy="4" r="1.6" fill="currentColor" />
    <circle cx="11.5" cy="9" r="1.6" fill="currentColor" />
    <circle cx="8" cy="14" r="1.6" fill="currentColor" />
  </>,
);
const ResizeIcon = icon(
  <>
    <rect x="2" y="8" width="8" height="8" rx="1" />
    <path d="M9 2h7v7M16 2l-6 6" />
  </>,
);
const InstantAlphaIcon = icon(<path d="M10.5 2.5 15.5 7.5 7 16H3v-4ZM9 4l5 5M2.5 2.5l1.5 1.5M6 1.5v2M1.5 6h2" />);
const FlipHIcon = icon(<path d="M9 1.5v15M7 4 2 14h5ZM11 4l5 10h-5Z" />);
const FlipVIcon = icon(<path d="M1.5 9h15M4 7l10-5v5ZM4 11l10 5v-5Z" />);
const PrintIcon = icon(
  <>
    <path d="M5 6V2h8v4M5 13H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-2" />
    <rect x="5" y="10" width="8" height="6" />
  </>,
);
const ExportIcon = icon(<path d="M9 2v9M5.5 5.5 9 2l3.5 3.5M3 11v3.5A1.5 1.5 0 0 0 4.5 16h9a1.5 1.5 0 0 0 1.5-1.5V11" />);
const ActualSizeIcon = icon(
  <>
    <rect x="2" y="3" width="14" height="12" rx="2" />
    <path d="M6 7v4M12 7v4M9 7.5v.1M9 10.5v.1" />
  </>,
);
const FitIcon = icon(<path d="M2 6V2h4M12 2h4v4M16 12v4h-4M6 16H2v-4" />);
const SlideshowIcon = icon(
  <>
    <rect x="2" y="3" width="14" height="10" rx="1.5" />
    <path d="m7.5 6 3.5 2-3.5 2ZM9 13v3M6 16h6" />
  </>,
);

export interface ToolbarButtonDef {
  command: CommandId;
  /** Chave de i18n do nome acessível (dica). */
  hint: string;
  Icon: ComponentType;
}

export interface ToolbarItemDef {
  id: string;
  /** Chave de i18n do nome curto (modo texto e Personalizar). */
  label: string;
  /** Um botão, ou vários lado a lado (Zoom). `share` é o menu Compartilhar. */
  buttons: ToolbarButtonDef[];
  share?: boolean;
}

const one = (id: string, command: CommandId, Icon: ComponentType, hint = `toolbar.items.${id}`): ToolbarItemDef => ({
  id,
  label: `toolbar.items.${id}`,
  buttons: [{ command, hint, Icon }],
});

/** Todos os itens, na ordem da paleta do Personalizar. */
export const TOOLBAR_ITEMS: ToolbarItemDef[] = [
  one("sidebar", "view.thumbnails", SidebarIcon, "toolbar.sidebar"),
  {
    id: "zoom",
    label: "toolbar.items.zoom",
    buttons: [
      { command: "view.zoomOut", hint: "toolbar.zoomOut", Icon: ZoomOutIcon },
      { command: "view.zoomIn", hint: "toolbar.zoomIn", Icon: ZoomInIcon },
    ],
  },
  { ...one("share", "file.shareEmail", ShareIcon, "toolbar.share"), share: true },
  one("markup", "view.markupBar", MarkupIcon, "toolbar.markup"),
  one("rotate", "tools.rotateLeft", RotateIcon, "toolbar.rotate"),
  one("inspector", "tools.inspector", InspectorIcon, "toolbar.inspector"),
  one("crop", "tools.crop", CropIcon),
  one("adjustColor", "tools.adjustColor", AdjustColorIcon),
  one("resize", "tools.resize", ResizeIcon),
  one("instantAlpha", "tools.instantAlpha", InstantAlphaIcon),
  one("flipH", "tools.flipH", FlipHIcon),
  one("flipV", "tools.flipV", FlipVIcon),
  one("actualSize", "view.actualSize", ActualSizeIcon),
  one("fit", "view.fit", FitIcon),
  one("slideshow", "view.slideshow", SlideshowIcon),
  one("export", "file.export", ExportIcon),
  one("print", "file.print", PrintIcon),
];

/** Conjunto padrão (o do Preview). */
export const DEFAULT_TOOLBAR = ["sidebar", "zoom", "share", "markup", "rotate", "inspector"];

const BY_ID = new Map(TOOLBAR_ITEMS.map((i) => [i.id, i]));
export const toolbarItem = (id: string) => BY_ID.get(id);

/** Itens da preferência (`null` = padrão), sem ids desconhecidos nem repetidos. */
export const resolveToolbar = (ids: string[] | null): string[] =>
  [...new Set(ids ?? DEFAULT_TOOLBAR)].filter((id) => BY_ID.has(id));

/** Põe `id` na posição `index` (contada na lista sem ele); tira de onde estava. */
export function moveItem(list: string[], id: string, index: number): string[] {
  const rest = list.filter((x) => x !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Posição de inserção para o ponteiro em `x`: antes do primeiro item cujo centro está à direita. */
export function insertIndex(rects: { left: number; width: number }[], x: number): number {
  const i = rects.findIndex((r) => x < r.left + r.width / 2);
  return i < 0 ? rects.length : i;
}
