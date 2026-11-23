import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import * as ipc from "../ipc/commands";
import type { ScanDevice, ScanKind, ScanOptions } from "../ipc/types";
import { useModal } from "../lib/modal";
import { useDocs } from "../store/docs";
import { activate } from "../viewer/actions";
import "./file.css";

export const useScan = create<{ open: boolean }>(() => ({ open: false }));
const closeScanDialog = () => useScan.setState({ open: false });

type Busy = "devices" | "options" | "scanning" | null;

/** Mensagem de um erro do Rust (`AppError`) ou do `scanimage`. */
const messageOf = (e: unknown): string =>
  typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);

/** Arquivo › Importar do Scanner: dispositivo, modo e resolução; a área inteira. */
export function ScanDialog() {
  const open = useScan((s) => s.open);
  return open ? <ScanForm /> : null;
}

function ScanForm() {
  const { t } = useTranslation();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const [devices, setDevices] = useState<ScanDevice[] | null>(null);
  const [device, setDevice] = useState("");
  const [options, setOptions] = useState<ScanOptions | null>(null);
  const [mode, setMode] = useState<ScanKind>("color");
  const [dpi, setDpi] = useState(300);
  const [busy, setBusy] = useState<Busy>("devices");
  const [error, setError] = useState<string | null>(null);
  /** Desmontado ou cancelado: respostas atrasadas não mexem mais no diálogo. */
  const alive = useRef(true);

  const fail = (e: unknown) => {
    const msg = messageOf(e);
    setError(msg === "timeout" ? t("scan.timeout") : t("scan.failed", { message: msg }));
  };

  const cancel = () => {
    alive.current = false;
    if (busy) void ipc.scanCancel().catch(() => {});
    closeScanDialog();
  };
  useModal(dialog, { onClose: cancel });

  /** Pedido de opções mais recente (trocar de dispositivo descarta a resposta do anterior). */
  const asked = useRef("");
  const choose = (name: string) => {
    asked.current = name;
    setDevice(name);
    setOptions(null);
    setBusy("options");
    ipc.scanOptions(name).then(
      (o) => {
        if (asked.current !== name || !alive.current || !o) return;
        setOptions(o);
        setMode((m) => (o.modes.includes(m) ? m : o.modes[0] ?? "color"));
        setDpi(o.resolution);
        setBusy(null);
      },
      (e) => {
        if (asked.current !== name || !alive.current) return;
        setBusy(null);
        fail(e);
      },
    );
  };

  useEffect(() => {
    alive.current = true;
    ipc.scanDevices().then(
      (list) => {
        if (!alive.current || !list) return;
        setDevices(list);
        setBusy(null);
        if (list.length) choose(list[0].name);
        else setError(t("scan.noDevice"));
      },
      (e) => {
        if (!alive.current) return;
        setBusy(null);
        setDevices([]);
        fail(e);
      },
    );
    return () => {
      alive.current = false;
    };
    // Uma busca por abertura do diálogo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scan = async () => {
    setError(null);
    setBusy("scanning");
    try {
      const info = await ipc.scanImage(device, mode, dpi, t("file.untitled"));
      if (!alive.current) {
        // Cancelado depois de o scanimage sair (decodificando): o documento já existe no Rust.
        if (info) void ipc.closeDocument(info.id).catch(() => {});
        return;
      }
      if (info) {
        useDocs.getState().add([info]);
        activate(info.id);
      }
      closeScanDialog();
    } catch (e) {
      if (!alive.current) return;
      setBusy(null);
      fail(e);
    }
  };

  const status = busy === "devices" ? "scan.searching" : busy === "scanning" ? "scan.scanning" : null;
  const ready = !!device && !!options && !busy;
  return (
    <div className="file-backdrop" role="presentation">
      <div
        ref={dialog} className="file-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
        aria-busy={!!busy} data-testid="scan-dialog"
      >
        <h3 id={titleId}>{t("scan.title")}</h3>
        <label className="file-row">
          <span>{t("scan.device")}</span>
          <select value={device} onChange={(e) => choose(e.target.value)} disabled={!devices?.length || busy === "scanning"}>
            {devices?.map((d) => (
              <option key={d.name} value={d.name} title={d.name}>{d.label}</option>
            ))}
          </select>
        </label>
        <label className="file-row">
          <span>{t("scan.mode")}</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as ScanKind)} disabled={!options || busy === "scanning"}>
            {options?.modes.map((m) => <option key={m} value={m}>{t(`scan.modes.${m}`)}</option>)}
          </select>
        </label>
        <label className="file-row">
          <span>{t("scan.resolution")}</span>
          <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))} disabled={!options || busy === "scanning"}>
            {options?.resolutions.map((r) => <option key={r} value={r}>{t("scan.dpi", { value: r })}</option>)}
          </select>
        </label>
        <p className="file-hint">{t("scan.area")}</p>
        {status && <p role="status" className="file-hint">{t(status)}</p>}
        {busy === "scanning" && <progress className="file-progress" aria-label={t("scan.scanning")} />}
        {error && <p role="alert" className="file-error">{error}</p>}
        <div className="file-actions">
          <span className="file-spacer" />
          <button type="button" onClick={cancel}>{t("scan.cancel")}</button>
          <button type="button" className="file-primary" onClick={scan} disabled={!ready}>{t("scan.scan")}</button>
        </div>
      </div>
    </div>
  );
}
