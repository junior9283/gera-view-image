// Ícones próprios da barra de ferramentas (traço de 1,5 px em 18×18, cor do texto).
import type { ReactNode } from "react";

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

export const SidebarIcon = () => (
  <Svg>
    <rect x="2" y="3" width="14" height="12" rx="2" />
    <path d="M7 3v12M3.8 6h1.5M3.8 8.5h1.5M3.8 11h1.5" />
  </Svg>
);

export const ZoomOutIcon = () => (
  <Svg>
    <circle cx="7.5" cy="7.5" r="5" />
    <path d="M11.2 11.2 16 16M5 7.5h5" />
  </Svg>
);

export const ZoomInIcon = () => (
  <Svg>
    <circle cx="7.5" cy="7.5" r="5" />
    <path d="M11.2 11.2 16 16M5 7.5h5M7.5 5v5" />
  </Svg>
);

export const ShareIcon = () => (
  <Svg>
    <path d="M6 7H4.5A1.5 1.5 0 0 0 3 8.5v6A1.5 1.5 0 0 0 4.5 16h9a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 13.5 7H12" />
    <path d="M9 11V2M6 4.8 9 2l3 2.8" />
  </Svg>
);

export const MarkupIcon = () => (
  <Svg>
    <circle cx="9" cy="9" r="7" />
    <path d="m6 12 .6-2.2 4.3-4.3a1.1 1.1 0 0 1 1.6 1.6l-4.3 4.3Z" />
  </Svg>
);

export const RotateIcon = () => (
  <Svg>
    <rect x="6" y="7" width="9" height="8" rx="1.5" />
    <path d="M3 9.5V7a4 4 0 0 1 4-4h2.5M7.5 1.5 9.5 3l-2 1.5" />
  </Svg>
);

export const InspectorIcon = () => (
  <Svg>
    <circle cx="9" cy="9" r="7" />
    <path d="M9 8v4.5M9 5.6v.1" />
  </Svg>
);
