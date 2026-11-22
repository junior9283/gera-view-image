// Ícones próprios da barra de Marcação (SVG 20×20, traço na cor do texto).
import type { ReactNode } from "react";

const svg = (children: ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const ICONS = {
  select: svg(<rect x="3.5" y="3.5" width="13" height="13" strokeDasharray="2.5 2" />),
  sketch: svg(<path d="M3 14c2-6 4 2 6-3s3-6 5-2 2 4 3 3" />),
  draw: svg(<path d="M4 16l1-4 8-8 3 3-8 8zM12 5l3 3" />),
  shapes: svg(
    <>
      <rect x="3" y="9" width="8" height="8" />
      <circle cx="13" cy="7" r="4" />
    </>,
  ),
  text: svg(<path d="M5 5h10M10 5v11M7.5 16h5" />),
  signature: svg(<path d="M3 14c3-8 4-8 4-4s0 5 2 2 2-4 3-1 2 2 5 0M3 17h14" />),
  lineStyle: svg(
    <>
      <path d="M3 5h14" strokeWidth="1" />
      <path d="M3 10h14" strokeWidth="2" />
      <path d="M3 15.5h14" strokeWidth="3.2" />
    </>,
  ),
  stroke: svg(<rect x="4" y="4" width="12" height="12" rx="2" strokeWidth="2.6" />),
  fill: svg(<rect x="4" y="4" width="12" height="12" rx="2" fill="currentColor" />),
  textStyle: svg(<path d="M3 16l4-11 4 11M4.5 12h5M13 16v-5.5a2 2 0 014 0V16M17 13h-4" />),
  rotate: svg(<path d="M6 7a5.5 5.5 0 11-1 6M6 3v4h4" />),
  crop: svg(<path d="M6 2v12h12M2 6h12v12" />),
  colors: svg(
    <>
      <circle cx="10" cy="10" r="7" />
      <circle cx="7.5" cy="8" r="1" fill="currentColor" />
      <circle cx="12" cy="7.5" r="1" fill="currentColor" />
      <circle cx="12.5" cy="12" r="1" fill="currentColor" />
    </>,
  ),
  fonts: svg(<path d="M3 16l4-11 4 11M4.5 12h5M13 7h4M15 7v9" />),
  adjustColor: svg(
    <>
      <path d="M3 6h14M3 14h14" />
      <circle cx="7" cy="6" r="2" fill="currentColor" />
      <circle cx="13" cy="14" r="2" fill="currentColor" />
    </>,
  ),
  resize: svg(<path d="M4 16V9h7v7zM9 11V4h7v7M11 9l4-4" />),
  properties: svg(<path d="M3 5h14M3 10h14M3 15h14M7 3v4M13 8v4M9 13v4" />),
  description: svg(<path d="M3.5 4.5h13v9h-7l-3.5 3v-3h-2.5zM6.5 8h7M6.5 10.5h4" />),
};
