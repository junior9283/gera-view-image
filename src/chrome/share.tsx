// Compartilhar: e-mail (portal), KDE Connect (com escolha do aparelho) e Abrir com ▸ apps.
import { useId, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import * as ipc from "../ipc/commands";
import type { Device, DocId } from "../ipc/types";
import { useModal } from "../lib/modal";
import { current } from "../file/fileActions";
import { notify, notifyError } from "./notify";
import "../prefs/prefs.css";

/** Documento ativo com arquivo em disco (o que se compartilha é o arquivo). */
export const sharedDoc = () => {
  const d = current();
  return d?.path ? d : null;
};

let deviceAvailable = false;
/** `kdeconnect-cli` no PATH (consultado uma vez, no registro). */
export const hasDeviceShare = () => deviceAvailable;
export async function probeDeviceShare(): Promise<boolean> {
  deviceAvailable = await ipc.shareDeviceAvailable().catch(() => false);
  return deviceAvailable;
}

export async function shareByEmail(): Promise<void> {
  const d = sharedDoc();
  if (d) await ipc.shareEmail([d.id]).catch(notifyError);
}

interface Pick {
  ids: DocId[];
  devices: Device[];
}
let pick: Pick | null = null;
const listeners = new Set<() => void>();
const setPick = (p: Pick | null) => {
  pick = p;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

async function sendTo(ids: DocId[], device: Device): Promise<void> {
  try {
    await ipc.shareDevice(ids, device.id);
    notify(i18n.t("share.sent", { name: device.name }));
  } catch (e) {
    notifyError(e);
  }
}

/** Um aparelho: envia direto; vários: pergunta qual (`DevicePicker`). */
export async function shareToDevice(): Promise<void> {
  const d = sharedDoc();
  if (!d) return;
  try {
    const devices = await ipc.shareDevices();
    if (!devices.length) notify(i18n.t("share.noDevice"));
    else if (devices.length === 1) await sendTo([d.id], devices[0]);
    else setPick({ ids: [d.id], devices });
  } catch (e) {
    notifyError(e);
  }
}

/** Escolha do aparelho do KDE Connect (montado no slot `below-toolbar`). */
export function DevicePicker() {
  const { t } = useTranslation();
  const p = useSyncExternalStore(subscribe, () => pick);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useModal(dialog, { active: !!p, onClose: () => setPick(null) });
  if (!p) return null;
  const choose = (dev: Device) => {
    setPick(null);
    void sendTo(p.ids, dev);
  };
  return (
    <div className="prefs-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setPick(null)}>
      <div ref={dialog} className="prefs-dialog device-picker" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h3 id={titleId}>{t("share.pickDevice")}</h3>
        <ul className="device-list">
          {p.devices.map((dev) => (
            <li key={dev.id}>
              <button type="button" onClick={() => choose(dev)}>
                {dev.name}
              </button>
            </li>
          ))}
        </ul>
        <div className="prefs-actions">
          <button type="button" onClick={() => setPick(null)}>
            {t("share.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Só para testes. */
export function resetShareForTests(available = false): void {
  deviceAvailable = available;
  setPick(null);
}
