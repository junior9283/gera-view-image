// E2E contra o binário release via tauri-driver (WebKitWebDriver no Linux).
// Build antes: `npm run tauri build -- --no-bundle` (ou CARGO_TARGET_DIR próprio + GVI_BINARY).
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(root, "src-tauri", "target");
const binary = process.env.GVI_BINARY ?? path.join(targetDir, "release", "gera-view-image");
export const fixtures = path.join(root, "src-tauri", "tests", "fixtures");

// Portas próprias: outros agentes/execuções usam 4446/4447 (e o padrão 4444 do WebKitWebDriver).
const PORT = Number(process.env.GVI_E2E_PORT ?? 4445);
const NATIVE_PORT = PORT + 100;

let driver: ChildProcess | undefined;
let exiting = false;

export const config: WebdriverIO.Config = {
  hostname: "127.0.0.1",
  port: PORT,
  specs: ["./e2e/specs/**/*.e2e.ts"],
  maxInstances: 1,
  capabilities: [
    {
      // Arquivos de argv: válido, truncado (erro) e SVG grande (escala < 100 % ao ajustar).
      "tauri:options": {
        application: binary,
        args: ["alpha.png", "truncado.jpg", "img.svg"].map((f) => path.join(fixtures, f)),
      },
    } as WebdriverIO.Capabilities,
  ],
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 60000 },
  logLevel: "warn",

  beforeSession: () => {
    driver = spawn(path.join(os.homedir(), ".cargo", "bin", "tauri-driver"), ["--port", String(PORT), "--native-port", String(NATIVE_PORT)], {
      stdio: [null, process.stdout, process.stderr],
    });
    driver.on("error", (e) => {
      console.error("tauri-driver:", e);
      process.exit(1);
    });
    driver.on("exit", (code) => {
      if (!exiting) {
        console.error("tauri-driver saiu com código", code);
        process.exit(1);
      }
    });
  },
  afterSession: () => {
    exiting = true;
    driver?.kill();
  },
};

for (const sig of ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    exiting = true;
    driver?.kill();
    if (sig !== "exit") process.exit();
  });
}
