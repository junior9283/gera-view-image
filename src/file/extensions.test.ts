import { describe, expect, it } from "vitest";
import decodeRs from "../../src-tauri/src/image/decode.rs?raw";
import { SUPPORTED_EXTENSIONS } from "./extensions";

/** Extensões aceitas por `ext_format` (base de `is_supported_path`) no Rust. */
function rustExtensions(src: string): string[] {
  const raw = /const RAW_EXTS[^=]*=\s*&\[([\s\S]*?)\];/.exec(src)![1];
  const body = /fn ext_format[\s\S]*?Some\(match ext \{([\s\S]*?)_ => return None/.exec(src)![1];
  const quoted = (s: string) => [...s.matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]);
  return [...quoted(raw), ...quoted(body)];
}

describe("SUPPORTED_EXTENSIONS", () => {
  it("é igual à lista do Rust (is_supported_path)", () => {
    const rust = rustExtensions(decodeRs);
    expect(rust.length).toBeGreaterThan(30);
    expect([...SUPPORTED_EXTENSIONS].sort()).toEqual([...new Set(rust)].sort());
  });
});
