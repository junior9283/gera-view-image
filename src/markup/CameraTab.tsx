// Aba Câmera da Assinatura: o usuário assina num papel e mostra à webcam.
//
// Fluxo: explicação → confirmação explícita ("Permitir e ligar") → câmera ligada (indicador
// visível) → Capturar (a câmera desliga na hora) → ajustar a sensibilidade → Salvar. A câmera
// também desliga ao trocar de aba, fechar o painel ou esconder a janela. Nada é gravado além da
// assinatura (tinta preta sobre fundo transparente).
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CameraError,
  disarmCamera,
  frameToSignature,
  grabFrame,
  otsuThreshold,
  startCamera,
  type CameraErrorCode,
  type CameraSession,
} from "./camera";
import { PNG_DATA_URL } from "./model";
import { addSignature } from "./signatures";

type Frame = NonNullable<ReturnType<typeof grabFrame>>;
type Phase =
  | { name: "idle" }
  | { name: "consent" }
  | { name: "starting" }
  | { name: "live" }
  | { name: "captured"; frame: Frame }
  | { name: "error"; code: CameraErrorCode };

export function CameraTab() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [level, setLevel] = useState<number | null>(null); // `null` = limiar automático
  const [saving, setSaving] = useState(false);
  const session = useRef<CameraSession | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const alive = useRef(true);
  const starting = useRef(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const stop = () => {
    const s = session.current;
    session.current = null;
    void s?.stop();
    // Ainda ligando: desarma já; a sessão que chegar depois é desligada em `turnOn`.
    if (!s && starting.current) void disarmCamera();
  };

  // Desliga a câmera ao sair da aba/painel e quando a janela fica escondida.
  useEffect(() => {
    alive.current = true;
    const hidden = () => {
      if (document.hidden && (session.current || starting.current)) {
        stop();
        setPhase({ name: "idle" });
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      alive.current = false;
      document.removeEventListener("visibilitychange", hidden);
      stop();
    };
  }, []);

  useEffect(() => {
    if (phase.name === "live" && video.current && session.current) video.current.srcObject = session.current.stream;
  }, [phase.name]);

  const turnOn = async () => {
    setPhase({ name: "starting" });
    starting.current = true;
    try {
      const s = await startCamera(() => {
        // Webcam desconectada com a câmera ligada.
        stop();
        if (alive.current) setPhase({ name: "error", code: "disconnected" });
      });
      starting.current = false;
      // Fechou o painel ou escondeu a janela enquanto ligava: não deixa a câmera ligada.
      if (!alive.current || document.hidden) {
        void s.stop();
        if (alive.current) setPhase({ name: "idle" });
        return;
      }
      session.current = s;
      setPhase({ name: "live" });
    } catch (e) {
      starting.current = false;
      if (alive.current) setPhase({ name: "error", code: e instanceof CameraError ? e.code : "failed" });
    }
  };

  const capture = () => {
    const frame = video.current ? grabFrame(video.current) : null;
    stop();
    setLevel(null);
    setPhase(frame ? { name: "captured", frame } : { name: "error", code: "failed" });
  };

  const frame = phase.name === "captured" ? phase.frame : null;
  const auto = useMemo(() => (frame ? otsuThreshold(frame.data) : 128), [frame]);
  const threshold = level ?? auto;
  const png = useMemo(() => (frame ? frameToSignature(frame, threshold) : null), [frame, threshold]);

  const save = async () => {
    if (!png) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      await addSignature(png);
      setPhase({ name: "idle" });
    } catch (e) {
      console.error("falha ao salvar a assinatura da câmera:", e);
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sig-camera" data-testid="camera-tab">
      {phase.name === "idle" && (
        <>
          <p className="sig-hint">{t("markup.sig.camera.hint")}</p>
          <div className="sig-actions">
            <button type="button" data-testid="camera-start" onClick={() => setPhase({ name: "consent" })}>{t("markup.sig.camera.start")}</button>
          </div>
        </>
      )}
      {phase.name === "consent" && (
        <div role="alertdialog" aria-label={t("markup.sig.camera.consentTitle")} data-testid="camera-consent">
          <p className="sig-hint"><strong>{t("markup.sig.camera.consentTitle")}</strong></p>
          <p className="sig-hint">{t("markup.sig.camera.consentBody")}</p>
          <div className="sig-actions">
            <button type="button" onClick={() => setPhase({ name: "idle" })}>{t("markup.sig.camera.cancel")}</button>
            <button type="button" data-testid="camera-allow" onClick={() => void turnOn()}>{t("markup.sig.camera.allow")}</button>
          </div>
        </div>
      )}
      {phase.name === "starting" && <p className="sig-hint" role="status">{t("markup.sig.camera.starting")}</p>}
      {phase.name === "live" && (
        <>
          <p className="camera-on" role="status" data-testid="camera-on"><span className="camera-dot" aria-hidden="true" />{t("markup.sig.camera.on")}</p>
          <video ref={video} className="camera-video" autoPlay muted playsInline aria-label={t("markup.sig.camera.preview")} />
          <p className="sig-hint">{t("markup.sig.camera.aim")}</p>
          <div className="sig-actions">
            <button type="button" data-testid="camera-off" onClick={() => { stop(); setPhase({ name: "idle" }); }}>{t("markup.sig.camera.off")}</button>
            <button type="button" data-testid="camera-capture" onClick={capture}>{t("markup.sig.camera.capture")}</button>
          </div>
        </>
      )}
      {phase.name === "captured" && (
        <>
          <p className="camera-off" role="status">{t("markup.sig.camera.offNow")}</p>
          <div className="camera-result">{png ? <img src={PNG_DATA_URL + png} alt={t("markup.sig.camera.result")} /> : <p className="sig-error" role="alert">{t("markup.sig.camera.noInk")}</p>}</div>
          <label className="props-field">
            {t("markup.sig.camera.sensitivity")}
            <input type="range" min={20} max={235} value={threshold} onChange={(e) => setLevel(Number(e.target.value))} />
          </label>
          {saveFailed && <p className="sig-error" role="alert" data-testid="camera-save-error">{t("markup.sig.camera.saveFailed")}</p>}
          <div className="sig-actions">
            <button type="button" onClick={() => setPhase({ name: "idle" })}>{t("markup.sig.camera.retry")}</button>
            <button type="button" data-testid="camera-save" disabled={!png || saving} onClick={() => void save()}>{t("markup.sig.save")}</button>
          </div>
        </>
      )}
      {phase.name === "error" && (
        <>
          <p className="sig-error" role="alert" data-testid="camera-error">{t(`markup.sig.camera.error.${phase.code}`)}</p>
          <div className="sig-actions">
            <button type="button" onClick={() => setPhase({ name: "idle" })}>{t("markup.sig.camera.retry")}</button>
          </div>
        </>
      )}
    </div>
  );
}
