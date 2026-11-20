import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
    setDecorations: async () => {},
    theme: async () => "light",
    onThemeChanged: async () => () => {},
  }),
}));

import { TitleBar } from "./TitleBar";

afterEach(cleanup);

describe("TitleBar", () => {
  it("mostra o título e os slots de menu e ferramentas", () => {
    render(<TitleBar title="foto.png" leading={<span>m</span>}>{<span>f</span>}</TitleBar>);
    expect(screen.getByText("foto.png")).toBeTruthy();
    expect(screen.getByText("m")).toBeTruthy();
    expect(screen.getByText("f")).toBeTruthy();
  });

  it("na decoração nativa esconde o título duplicado (o sistema já mostra)", () => {
    render(<TitleBar title="foto.png" nativeDecorations />);
    expect(screen.queryByText("foto.png")).toBeNull();
  });
});
