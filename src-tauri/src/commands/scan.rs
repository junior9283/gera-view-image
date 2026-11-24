//! Arquivo › Importar do Scanner: o `scanimage` (sane-utils) externo, sem ligar a libsane e sem
//! shell. Os argumentos vão em vetor; o dispositivo e o modo só valem se vieram do próprio
//! `scanimage` nesta janela (`scan_devices`/`scan_options`). Tudo o que ele escreve é entrada não
//! confiável: nomes com controles são descartados e o PNG passa pelo decodificador do app.
use super::{blocking, pipe::Drain, window::claimed_one};
use crate::{
    doc::{
        model::{DocInfo, SourceFormat},
        store::DocStore,
    },
    error::{AppError, AppResult},
    image::decode::{self, Decoded},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ffi::OsString,
    fs::File,
    io::Read,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State, WebviewWindow};

pub const PROGRAM: &str = "scanimage";
/// `scanimage -L` e `-A` procuram e abrem o dispositivo: rede e USB podem demorar.
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(15);
/// Uma página em 1200 ppp num scanner lento.
pub const SCAN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Teto do PNG digitalizado: um scanner de rede hostil (eSCL/sane-airscan anunciado pelo mDNS)
/// poderia escrever sem parar. Um A4 em 1200 ppp com 16 bits por canal tem ~840 MB crus.
pub const MAX_SCAN_BYTES: u64 = 1 << 30;
pub const MIN_DPI: u32 = 75;
pub const MAX_DPI: u32 = 1200;
/// Resoluções oferecidas quando o dispositivo aceita uma faixa contínua (ou não diz).
const STANDARD_DPI: [u32; 8] = [75, 100, 150, 200, 300, 400, 600, 1200];
const DEFAULT_DPI: u32 = 300;
/// Separador da lista formatada (`%d<US>%v %m`): um controle não aparece em nome válido.
const SEP: char = '\u{1f}';
const MAX_NAME: usize = 256;
const MAX_LABEL: usize = 128;
const MAX_DEVICES: usize = 64;
/// Teto do que se guarda da saída de texto (o resto é lido e descartado).
const MAX_TEXT: usize = 1 << 20;
const MAX_MESSAGE: usize = 300;
/// Mensagem de erro de tempo esgotado (a interface a traduz).
pub const TIMEOUT: &str = "timeout";

// ---------- funções puras ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScanDevice {
    pub name: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanKind {
    Color,
    Gray,
    Lineart,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScanOptions {
    /// Modos que o dispositivo oferece, na ordem Cor, Cinza, Preto e branco.
    pub modes: Vec<ScanKind>,
    pub resolutions: Vec<u32>,
    /// Resolução inicial do diálogo.
    pub resolution: u32,
    /// Valor do `--mode` do dispositivo para cada modo (não vai para a interface).
    #[serde(skip)]
    pub values: HashMap<ScanKind, String>,
}

/// Valor que pode ir para um argumento: sem controles, sem cara de opção, tamanho limitado.
fn plain(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.starts_with('-') && !s.chars().any(char::is_control)
}

/// Texto para mostrar: sem controles, aparado e limitado a `max` caracteres.
pub fn clean_text(s: &str, max: usize) -> String {
    let kept: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    kept.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

/// Saída de `scanimage --formatted-device-list=%d<US>%v %m%n`.
pub fn parse_devices(out: &str) -> Vec<ScanDevice> {
    let mut devices: Vec<ScanDevice> = Vec::new();
    for line in out.split('\n') {
        let (name, label) = line.split_once(SEP).unwrap_or((line, ""));
        if !plain(name, MAX_NAME) || devices.iter().any(|d| d.name == name) {
            continue;
        }
        let label = clean_text(label, MAX_LABEL);
        let label = if label.is_empty() {
            clean_text(name, MAX_LABEL)
        } else {
            label
        };
        devices.push(ScanDevice {
            name: name.to_string(),
            label,
        });
        if devices.len() == MAX_DEVICES {
            break;
        }
    }
    devices
}

/// O modo de um valor do `--mode` do backend ("Color", "24bit Color", "True Gray", "Lineart"…).
pub fn classify_mode(value: &str) -> Option<ScanKind> {
    let v = value.to_ascii_lowercase();
    if v.contains("colo") {
        Some(ScanKind::Color)
    } else if v.contains("gray") || v.contains("grey") {
        Some(ScanKind::Gray)
    } else if ["lineart", "binary", "black", "halftone", "monochrome"]
        .iter()
        .any(|k| v.contains(k))
    {
        Some(ScanKind::Lineart)
    } else {
        None
    }
}

/// Valores da linha `--opção a|b|c [atual]` de `scanimage -A`; `None` se inativa ou ausente.
fn option_values<'a>(help: &'a str, option: &str) -> Option<&'a str> {
    let prefix = format!("{option} ");
    help.lines().map(str::trim_start).find_map(|line| {
        let rest = line.strip_prefix(&prefix)?;
        let (values, current) = rest.rsplit_once(" [").unwrap_or((rest, ""));
        (!current.starts_with("inactive")).then_some(values.trim())
    })
}

/// Resoluções aceitas entre 75 e 1200 ppp: a lista do dispositivo ou, numa faixa, as usuais
/// dentro dela.
fn parse_resolutions(spec: &str) -> Vec<u32> {
    let spec = spec
        .split(" (")
        .next()
        .unwrap_or(spec)
        .trim_end_matches("dpi");
    let num = |s: &str| {
        s.trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite() && *n >= 0.0)
    };
    let mut out: Vec<u32> = if let Some((lo, hi)) = spec.split_once("..") {
        match (num(lo), num(hi)) {
            (Some(lo), Some(hi)) => STANDARD_DPI
                .into_iter()
                .filter(|&d| (lo..=hi).contains(&f64::from(d)))
                .collect(),
            _ => Vec::new(),
        }
    } else {
        // `as u32` satura: valores absurdos caem fora da faixa abaixo.
        spec.split('|')
            .filter_map(num)
            .map(|n| n.round() as u32)
            .collect()
    };
    out.retain(|d| (MIN_DPI..=MAX_DPI).contains(d));
    out.sort_unstable();
    out.dedup();
    out
}

/// Opções de `scanimage -A -d <dispositivo>`. Sem as linhas (ou ilegíveis), os nomes e
/// resoluções padrão do SANE.
pub fn parse_options(help: &str) -> ScanOptions {
    let mut values = HashMap::new();
    for v in option_values(help, "--mode")
        .into_iter()
        .flat_map(|s| s.split('|'))
    {
        let v = v.trim();
        if let Some(kind) = classify_mode(v)
            && plain(v, MAX_LABEL)
        {
            values.entry(kind).or_insert_with(|| v.to_string());
        }
    }
    if values.is_empty() {
        values = [
            (ScanKind::Color, "Color"),
            (ScanKind::Gray, "Gray"),
            (ScanKind::Lineart, "Lineart"),
        ]
        .into_iter()
        .map(|(k, v)| (k, v.to_string()))
        .collect();
    }
    let modes = [ScanKind::Color, ScanKind::Gray, ScanKind::Lineart]
        .into_iter()
        .filter(|k| values.contains_key(k))
        .collect();
    let mut resolutions = option_values(help, "--resolution")
        .map(parse_resolutions)
        .unwrap_or_default();
    if resolutions.is_empty() {
        resolutions = STANDARD_DPI.to_vec();
    }
    let resolution = *resolutions
        .iter()
        .min_by_key(|d| d.abs_diff(DEFAULT_DPI))
        .unwrap_or(&DEFAULT_DPI);
    ScanOptions {
        modes,
        resolutions,
        resolution,
        values,
    }
}

/// Argumentos da digitalização (área inteira, PNG na saída padrão).
pub fn scan_args(device: &str, mode: &str, dpi: u32) -> Vec<OsString> {
    [
        format!("--device-name={device}"),
        "--format=png".to_string(),
        format!("--mode={mode}"),
        format!("--resolution={dpi}"),
    ]
    .into_iter()
    .map(OsString::from)
    .collect()
}

/// Primeiro `name` executável nas pastas de `path` (o `PATH`), sem shell.
pub fn find_program(name: &str, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::env::split_paths(path?)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|p| {
            p.metadata()
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
}

// ---------- processos ----------

struct Running {
    token: u64,
    child: Child,
}

/// Processos do `scanimage` em andamento (um por janela) e o que cada janela já viu dele.
#[derive(Default)]
pub struct Scans {
    running: Mutex<HashMap<String, Running>>,
    devices: Mutex<HashMap<String, Vec<ScanDevice>>>,
    options: Mutex<HashMap<(String, String), ScanOptions>>,
    next: AtomicU64,
    /// Teto da saída do `scanimage` em bytes; `None` = `MAX_SCAN_BYTES` (os testes usam um menor).
    limit: Option<u64>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Mata o grupo do processo e o espera. Antes do `wait` o pid não pode ter sido reutilizado.
fn stop(child: &mut Child) {
    if let Ok(pid) = i32::try_from(child.id()) {
        // SAFETY: só envia um sinal ao grupo criado por `process_group(0)` no `spawn`.
        unsafe { libc::kill(-pid, libc::SIGKILL) };
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Como um processo terminou.
pub struct Finished {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl Scans {
    #[cfg(test)]
    fn with_limit(limit: u64) -> Self {
        Scans {
            limit: Some(limit),
            ..Default::default()
        }
    }

    /// Roda `program args` para a janela `label`. `None` = cancelado. A saída padrão vai para
    /// `stdout` (arquivo) ou volta em `Finished::stdout`.
    pub fn run(
        &self,
        label: &str,
        program: &Path,
        args: &[OsString],
        stdout: Option<File>,
        timeout: Duration,
    ) -> AppResult<Option<Finished>> {
        let watch = stdout.as_ref().map(File::try_clone).transpose()?;
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(stdout.map_or_else(Stdio::piped, Stdio::from))
            .stderr(Stdio::piped())
            // Grupo próprio: matar leva junto qualquer filho que segure os canos.
            .process_group(0)
            .spawn()?;
        // A saída em arquivo é olhada a cada volta do laço: acima do teto, o processo morre.
        let max = self.max_output();
        let over = |f: &File| f.metadata().is_ok_and(|m| m.len() > max);
        let out = child.stdout.take().map(|o| Drain::start(o, MAX_TEXT));
        let err = child.stderr.take().map(|e| Drain::start(e, MAX_TEXT));
        let token = self.next.fetch_add(1, Ordering::Relaxed);
        if let Some(mut old) = self
            .lock_running()
            .insert(label.to_string(), Running { token, child })
        {
            stop(&mut old.child);
        }
        let started = Instant::now();
        let status = loop {
            std::thread::sleep(Duration::from_millis(40));
            let mut running = self.lock_running();
            let Some(r) = running.get_mut(label).filter(|r| r.token == token) else {
                break None; // cancelado: quem tirou da lista já matou e esperou
            };
            let full = watch.as_ref().is_some_and(over);
            match r.child.try_wait() {
                Ok(Some(status)) => {
                    running.remove(label);
                    break Some(status);
                }
                Ok(None) if started.elapsed() < timeout && !full => {}
                result => {
                    stop(&mut r.child);
                    running.remove(label);
                    return Err(match result {
                        Err(e) => e.into(),
                        _ if full => too_big(max),
                        _ => AppError::Io(TIMEOUT.into()),
                    });
                }
            }
        };
        let (stdout, stderr) = (out.map_or_else(Vec::new, Drain::finish), err.map_or_else(Vec::new, Drain::finish));
        Ok(status.map(|status| Finished {
            status,
            stdout,
            stderr,
        }))
    }

    fn max_output(&self) -> u64 {
        self.limit.unwrap_or(MAX_SCAN_BYTES)
    }

    fn lock_running(&self) -> std::sync::MutexGuard<'_, HashMap<String, Running>> {
        lock(&self.running)
    }

    /// Cancela o que a janela estiver rodando (mata o processo).
    pub fn cancel(&self, label: &str) {
        if let Some(mut r) = self.lock_running().remove(label) {
            stop(&mut r.child);
        }
    }

    /// Sair do app: nenhum `scanimage` fica para trás.
    pub fn cancel_all(&self) {
        for (_, mut r) in self.lock_running().drain() {
            stop(&mut r.child);
        }
    }

    /// A janela fechou: esquece o que ela viu.
    pub fn forget(&self, label: &str) {
        self.cancel(label);
        lock(&self.devices).remove(label);
        lock(&self.options).retain(|(l, _), _| l != label);
    }

    /// Dispositivos que `scanimage` lista. `None` = cancelado.
    pub fn list(&self, label: &str, program: &Path) -> AppResult<Option<Vec<ScanDevice>>> {
        let format = OsString::from(format!("--formatted-device-list=%d{SEP}%v %m%n"));
        let Some(done) = self.run(label, program, &[format], None, QUERY_TIMEOUT)? else {
            return Ok(None);
        };
        if !done.status.success() {
            return Err(failure(&done.stderr));
        }
        let devices = parse_devices(&String::from_utf8_lossy(&done.stdout));
        lock(&self.devices).insert(label.to_string(), devices.clone());
        Ok(Some(devices))
    }

    /// O dispositivo veio de `list` nesta janela?
    fn known(&self, label: &str, device: &str) -> AppResult<()> {
        let devices = lock(&self.devices);
        match devices.get(label) {
            Some(list) if list.iter().any(|d| d.name == device) => Ok(()),
            _ => Err(AppError::NotFound(format!(
                "dispositivo desconhecido: {}",
                clean_text(device, MAX_LABEL)
            ))),
        }
    }

    /// Modos e resoluções do dispositivo. `None` = cancelado.
    pub fn options(
        &self,
        label: &str,
        program: &Path,
        device: &str,
    ) -> AppResult<Option<ScanOptions>> {
        self.known(label, device)?;
        let args = [
            OsString::from(format!("--device-name={device}")),
            OsString::from("--all-options"),
        ];
        let Some(done) = self.run(label, program, &args, None, QUERY_TIMEOUT)? else {
            return Ok(None);
        };
        // Sem as opções (dispositivo ocupado, backend estranho), o diálogo ainda oferece as padrão.
        let help = if done.status.success() {
            String::from_utf8_lossy(&done.stdout)
        } else {
            Default::default()
        };
        let options = parse_options(&help);
        lock(&self.options).insert((label.to_string(), device.to_string()), options.clone());
        Ok(Some(options))
    }

    /// Digitaliza para `out` e devolve a imagem (só PNG). `None` = cancelado.
    pub fn scan(
        &self,
        label: &str,
        program: &Path,
        device: &str,
        kind: ScanKind,
        dpi: u32,
        out: &Path,
    ) -> AppResult<Option<Decoded>> {
        self.known(label, device)?;
        let options = lock(&self.options)
            .get(&(label.to_string(), device.to_string()))
            .cloned()
            .unwrap_or_else(|| parse_options(""));
        let bad = || AppError::Unsupported("opção de digitalização inválida".into());
        let mode = options.values.get(&kind).ok_or_else(bad)?;
        if !options.resolutions.contains(&dpi) {
            return Err(bad());
        }
        let file = private_file(out)?;
        let Some(done) = self.run(
            label,
            program,
            &scan_args(device, mode, dpi),
            Some(file),
            SCAN_TIMEOUT,
        )?
        else {
            return Ok(None);
        };
        if !done.status.success() {
            return Err(failure(&done.stderr));
        }
        read_png(out, self.max_output()).map(Some)
    }
}

/// Erro do `scanimage`, com a última linha útil dele (limpa).
fn failure(stderr: &[u8]) -> AppError {
    let text = String::from_utf8_lossy(stderr);
    let line = text
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("");
    AppError::Io(clean_text(
        line.trim_start_matches("scanimage:"),
        MAX_MESSAGE,
    ))
}

/// O limite em MiB vai como mensagem do código `too_large`; a interface monta o texto.
fn too_big(max: u64) -> AppError {
    AppError::TooLarge((max >> 20).to_string())
}

/// Lê a digitalização sem passar de `max` bytes e só aceita PNG.
fn read_png(path: &Path, max: u64) -> AppResult<Decoded> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(max.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max {
        return Err(too_big(max));
    }
    if decode::detect_format(path, &bytes) != Some(SourceFormat::Png) {
        return Err(AppError::Corrupt(
            "o scanner não devolveu uma imagem PNG".into(),
        ));
    }
    decode::decode_bytes(path, &bytes)
}

/// Arquivo novo só do dono (0600); não segue link nem reaproveita arquivo existente.
fn private_file(path: &Path) -> AppResult<File> {
    use std::os::unix::fs::OpenOptionsExt;
    Ok(std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?)
}

/// Pasta privada das digitalizações deste processo (`<cache>/scan/<pid>`, 0700).
pub struct ScanTemp(pub PathBuf);

// ---------- comandos ----------

fn program() -> AppResult<PathBuf> {
    find_program(PROGRAM, std::env::var_os("PATH").as_deref())
        .ok_or_else(|| AppError::Unsupported(PROGRAM.into()))
}

/// `scanimage` está instalado (no `PATH`)?
#[tauri::command]
pub async fn scan_available() -> AppResult<bool> {
    Ok(program().is_ok())
}

/// Dispositivos. `None` = cancelado.
#[tauri::command]
pub async fn scan_devices(
    app: AppHandle,
    window: WebviewWindow,
) -> AppResult<Option<Vec<ScanDevice>>> {
    let program = program()?;
    blocking(move || app.state::<Scans>().list(window.label(), &program)).await
}

/// Modos e resoluções de `device`. `None` = cancelado.
#[tauri::command]
pub async fn scan_options(
    app: AppHandle,
    window: WebviewWindow,
    device: String,
) -> AppResult<Option<ScanOptions>> {
    let program = program()?;
    blocking(move || {
        app.state::<Scans>()
            .options(window.label(), &program, &device)
    })
    .await
}

/// Digitaliza e abre como documento sem arquivo ("Sem título"). `None` = cancelado.
#[tauri::command]
pub async fn scan_image(
    app: AppHandle,
    window: WebviewWindow,
    device: String,
    mode: ScanKind,
    resolution: u32,
    name: String,
) -> AppResult<Option<DocInfo>> {
    let program = program()?;
    blocking(move || {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = app.state::<ScanTemp>().0.clone();
        super::drag::private_dir(&dir)?;
        let out = dir.join(format!("scan-{}.png", N.fetch_add(1, Ordering::Relaxed)));
        let decoded =
            app.state::<Scans>()
                .scan(window.label(), &program, &device, mode, resolution, &out);
        // A imagem fica no documento: o arquivo sai já, com ou sem erro.
        let _ = std::fs::remove_file(&out);
        match decoded? {
            Some(d) => {
                claimed_one(&window, app.state::<DocStore>().insert_untitled(&name, d)).map(Some)
            }
            None => Ok(None),
        }
    })
    .await
}

/// Cancela a busca ou a digitalização desta janela.
#[tauri::command]
pub async fn scan_cancel(window: WebviewWindow, scans: State<'_, Scans>) -> AppResult<()> {
    scans.cancel(window.label());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispositivos_validos_e_nomes_hostis_descartados() {
        let out = "test:0\u{1f}Noname frontend-tester\n\
                   epson2:net:192.168.0.9\u{1f}Epson  Perfection\u{7}V39\n\
                   -d\u{1f}flag\n\
                   bad\tname\u{1f}x\n\
                   test:0\u{1f}repetido\n\
                   \n\
                   só:nome";
        let d = parse_devices(out);
        assert_eq!(
            d,
            vec![
                ScanDevice {
                    name: "test:0".into(),
                    label: "Noname frontend-tester".into()
                },
                ScanDevice {
                    name: "epson2:net:192.168.0.9".into(),
                    label: "Epson Perfection V39".into()
                },
                ScanDevice {
                    name: "só:nome".into(),
                    label: "só:nome".into()
                },
            ]
        );
        assert!(parse_devices(&"x".repeat(MAX_NAME + 1)).is_empty());
    }

    #[test]
    fn modos_do_backend() {
        assert_eq!(classify_mode("Color"), Some(ScanKind::Color));
        assert_eq!(classify_mode("24bit Color[Fast]"), Some(ScanKind::Color));
        assert_eq!(classify_mode("True Gray"), Some(ScanKind::Gray));
        assert_eq!(classify_mode("Black & White"), Some(ScanKind::Lineart));
        assert_eq!(classify_mode("Lineart"), Some(ScanKind::Lineart));
        assert_eq!(classify_mode("Infrared"), None);
    }

    const HELP_TEST: &str = "\
All options specific to device `test:0':
  Scan Mode:
    --mode Gray|Color [Gray]
        Selects the scan mode (e.g., lineart, monochrome, or color).
    --depth 1|8|16 [8]
    --resolution 1..1200dpi (in steps of 1) [50]
        Sets the resolution of the scanned image.
";

    #[test]
    fn opcoes_do_backend_test_faixa() {
        let o = parse_options(HELP_TEST);
        assert_eq!(o.modes, vec![ScanKind::Color, ScanKind::Gray]);
        assert_eq!(o.values[&ScanKind::Gray], "Gray");
        assert_eq!(o.resolutions, STANDARD_DPI.to_vec());
        assert_eq!(o.resolution, 300);
    }

    #[test]
    fn opcoes_em_lista_e_inativas() {
        let help = "    --mode Lineart|Gray|24bit Color [Lineart]\n    --resolution 50|75|150|2400dpi [75]\n";
        let o = parse_options(help);
        assert_eq!(
            o.modes,
            vec![ScanKind::Color, ScanKind::Gray, ScanKind::Lineart]
        );
        assert_eq!(o.values[&ScanKind::Color], "24bit Color");
        assert_eq!(o.resolutions, vec![75, 150]);
        assert_eq!(o.resolution, 150);
        let o = parse_options(
            "    --resolution 75..300dpi [inactive]\n    --mode -x|Color\u{1b} [x]\n",
        );
        assert_eq!(o.resolutions, STANDARD_DPI.to_vec(), "inativa: padrão");
        assert_eq!(
            o.modes.len(),
            3,
            "valores hostis descartados: padrão do SANE"
        );
        assert_eq!(o.values[&ScanKind::Color], "Color");
        assert_eq!(
            parse_resolutions("100.0..600.0dpi"),
            vec![100, 150, 200, 300, 400, 600]
        );
        assert_eq!(parse_resolutions("1e40|NaN|-3|300"), vec![300]);
    }

    #[test]
    fn argumentos_em_vetor_sem_shell() {
        let a = scan_args("epson2:net:1.2.3.4; rm -rf ~", "24bit Color", 300);
        assert_eq!(a[0], "--device-name=epson2:net:1.2.3.4; rm -rf ~");
        assert_eq!(a[2], "--mode=24bit Color");
        assert_eq!(a.len(), 4);
    }

    #[test]
    fn acha_o_programa_no_path() {
        let dir = std::env::temp_dir().join(format!("gvi-scan-path-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("scanimage");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        let path = std::env::join_paths(["relativo", dir.to_str().unwrap()]).unwrap();
        assert_eq!(
            find_program("scanimage", Some(&path)),
            None,
            "sem permissão de execução"
        );
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(find_program("scanimage", Some(&path)), Some(exe));
        assert_eq!(find_program("scanimage", None), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn mensagem_de_erro_limpa() {
        let e = failure(b"aviso\nscanimage: open of device x failed: Invalid argument\x1b[31m\n");
        assert_eq!(
            e.to_string(),
            "open of device x failed: Invalid argument [31m"
        );
    }

    // ---------- processo: `scanimage` falso (tests/fixtures/fake-scanimage) ----------

    fn fake() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-scanimage")
    }

    fn out_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gvi-scan-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn lista_opcoes_e_digitaliza_pelo_script_falso() {
        let scans = Scans::default();
        let devices = scans.list("main", &fake()).unwrap().unwrap();
        let names: Vec<&str> = devices.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "fake:ok",
                "fake:slow",
                "fake:flood",
                "fake:jpeg",
                "fake:tree",
                "fake:fail;$(id)"
            ],
            "opção e controle descartados"
        );
        assert_eq!(devices[0].label, "Fake Scanner");

        // Dispositivo que não veio da lista (nem de outra janela) é recusado antes de rodar.
        assert_eq!(
            scans
                .options("doc-1", &fake(), "fake:ok")
                .unwrap_err()
                .code(),
            "not_found"
        );
        assert_eq!(
            scans
                .options("main", &fake(), "fake:outro")
                .unwrap_err()
                .code(),
            "not_found"
        );

        let o = scans.options("main", &fake(), "fake:ok").unwrap().unwrap();
        assert_eq!(
            o.modes,
            [ScanKind::Color, ScanKind::Gray, ScanKind::Lineart]
        );
        assert_eq!(o.resolutions, [75, 150, 300, 600]);
        assert_eq!(o.resolution, 300);

        let dir = out_dir("ok");
        let out = dir.join("scan.png");
        let bad = scans.scan("main", &fake(), "fake:ok", ScanKind::Color, 1200, &out);
        assert_eq!(
            bad.unwrap_err().code(),
            "unsupported",
            "resolução fora da lista do dispositivo"
        );
        assert!(!out.exists());
        let d = scans
            .scan("main", &fake(), "fake:ok", ScanKind::Gray, 300, &out)
            .unwrap()
            .unwrap();
        assert_eq!(d.frames[0].dimensions(), (30, 30));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(out.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        // O arquivo nunca é reaproveitado.
        assert!(
            scans
                .scan("main", &fake(), "fake:ok", ScanKind::Gray, 300, &out)
                .is_err()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn link_plantado_no_lugar_da_saida_nao_e_seguido() {
        let scans = Scans::default();
        scans.list("main", &fake()).unwrap();
        let dir = out_dir("link");
        let alvo = dir.join("alvo.txt");
        std::fs::write(&alvo, "intacto").unwrap();
        let out = dir.join("scan.png");
        std::os::unix::fs::symlink(&alvo, &out).unwrap();
        assert!(
            scans
                .scan("main", &fake(), "fake:ok", ScanKind::Color, 300, &out)
                .is_err()
        );
        assert_eq!(std::fs::read_to_string(&alvo).unwrap(), "intacto");
        assert!(out.symlink_metadata().unwrap().file_type().is_symlink());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn saida_sem_fim_e_interrompida_no_teto() {
        let scans = Scans::with_limit(1 << 20);
        scans.list("main", &fake()).unwrap();
        let dir = out_dir("flood");
        let out = dir.join("scan.png");
        let started = Instant::now();
        let e = scans
            .scan("main", &fake(), "fake:flood", ScanKind::Color, 300, &out)
            .unwrap_err();
        assert_eq!((e.code(), e.to_string().as_str()), ("too_large", "1"));
        assert!(started.elapsed() < Duration::from_secs(20));
        assert!(scans.lock_running().is_empty(), "o processo foi morto");
        // Sem poder parar no meio de uma escrita, passa no máximo o que cabe entre duas olhadas.
        assert!(out.metadata().unwrap().len() < 1 << 30);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn png_acima_do_teto_que_terminou_antes_da_olhada_e_recusado() {
        let scans = Scans::with_limit(64);
        scans.list("main", &fake()).unwrap();
        let dir = out_dir("teto");
        let e = scans
            .scan("main", &fake(), "fake:ok", ScanKind::Color, 300, &dir.join("a.png"))
            .unwrap_err();
        assert_eq!(e.code(), "too_large", "{e}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn saida_que_nao_e_png_e_recusada() {
        let scans = Scans::default();
        scans.list("main", &fake()).unwrap();
        let dir = out_dir("jpeg");
        let e = scans
            .scan("main", &fake(), "fake:jpeg", ScanKind::Color, 300, &dir.join("a.png"))
            .unwrap_err();
        assert_eq!(e.code(), "corrupt");
        assert!(e.to_string().contains("PNG"), "{e}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// O processo `pid` acabou (sumiu ou é zumbi à espera do `init`)?
    fn gone(pid: u32) -> bool {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Err(_) => true,
            Ok(stat) => stat
                .rsplit_once(") ")
                .is_some_and(|(_, rest)| rest.starts_with('Z') || rest.starts_with('X')),
        }
    }

    #[test]
    fn cancelar_mata_o_grupo_inteiro_com_o_neto() {
        let scans = std::sync::Arc::new(Scans::default());
        scans.list("main", &fake()).unwrap();
        let dir = out_dir("neto");
        let out = dir.join("a.png");
        let (s, o) = (scans.clone(), out.clone());
        let job = std::thread::spawn(move || {
            s.scan("main", &fake(), "fake:tree", ScanKind::Color, 300, &o)
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        let pid = loop {
            let text = std::fs::read_to_string(&out).unwrap_or_default();
            if let Ok(pid) = text.trim().parse::<u32>() {
                break pid;
            }
            assert!(Instant::now() < deadline, "o neto não começou");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(!gone(pid), "o neto está vivo antes de cancelar");
        scans.cancel("main");
        assert!(job.join().unwrap().unwrap().is_none());
        let deadline = Instant::now() + Duration::from_secs(5);
        while !gone(pid) {
            assert!(Instant::now() < deadline, "o neto {pid} sobreviveu ao cancelamento");
            std::thread::sleep(Duration::from_millis(20));
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn nome_hostil_vai_literal_e_o_erro_volta_limpo() {
        let scans = Scans::default();
        scans.list("main", &fake()).unwrap();
        let dir = out_dir("falha");
        let e = scans
            .scan(
                "main",
                &fake(),
                "fake:fail;$(id)",
                ScanKind::Color,
                300,
                &dir.join("x.png"),
            )
            .unwrap_err();
        assert_eq!(
            e.to_string(),
            "open of device fake:fail;$(id) failed: Invalid argument"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cancelar_e_tempo_esgotado_matam_o_processo() {
        let scans = std::sync::Arc::new(Scans::default());
        scans.list("main", &fake()).unwrap();
        scans.list("doc-1", &fake()).unwrap();
        let dir = out_dir("lento");
        let (s, out) = (scans.clone(), dir.join("a.png"));
        let started = Instant::now();
        let job = std::thread::spawn(move || {
            s.scan("main", &fake(), "fake:slow", ScanKind::Color, 300, &out)
        });
        std::thread::sleep(Duration::from_millis(300));
        scans.cancel("doc-1"); // outra janela: não mexe nesta
        assert!(!job.is_finished());
        scans.cancel("main");
        assert!(job.join().unwrap().unwrap().is_none());
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(scans.lock_running().is_empty());

        let args = scan_args("fake:slow", "Color", 300);
        let e = scans
            .run(
                "main",
                &fake(),
                &args,
                Some(private_file(&dir.join("b.png")).unwrap()),
                Duration::from_millis(200),
            )
            .err()
            .unwrap();
        assert_eq!(e.to_string(), TIMEOUT);
        assert!(scans.lock_running().is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Um neto em outra sessão (`setsid`) escapa do `kill` do grupo e segura o cano: o fim do
    /// processo não pode esperar o cano fechar (E-m7).
    #[test]
    fn neto_que_segura_o_cano_nao_prende_a_leitura() {
        let dir = out_dir("neto");
        let sh = dir.join("neto.sh");
        std::fs::write(&sh, "#!/bin/sh\necho oi\nsetsid sleep 8 &\nexit 0\n").unwrap();
        std::fs::set_permissions(&sh, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let started = Instant::now();
        let done = Scans::default()
            .run("main", &sh, &[], None, Duration::from_secs(30))
            .unwrap()
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(6), "esperou o neto");
        assert_eq!(String::from_utf8_lossy(&done.stdout).trim(), "oi");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `scanimage` de verdade com o backend `test` do SANE (imagem sintética, sem hardware):
    /// `SANE_CONFIG_DIR=<pasta com dll.conf contendo "test" e o test.conf>`
    /// `cargo test --lib scanimage_real -- --ignored`.
    #[test]
    #[ignore]
    fn scanimage_real_backend_test() {
        let program =
            find_program(PROGRAM, std::env::var_os("PATH").as_deref()).expect("scanimage no PATH");
        let scans = Scans::default();
        let devices = scans.list("main", &program).unwrap().unwrap();
        assert!(
            devices.iter().any(|d| d.name == "test:0"),
            "backend test não habilitado: {devices:?}"
        );
        let o = scans.options("main", &program, "test:0").unwrap().unwrap();
        assert!(
            o.modes.contains(&ScanKind::Gray) && o.resolutions.contains(&75),
            "{o:?}"
        );
        let dir = out_dir("real");
        let out = dir.join("t.png");
        let d = scans
            .scan("main", &program, "test:0", ScanKind::Color, 75, &out)
            .unwrap()
            .unwrap();
        assert!(d.frames[0].width() > 100 && d.frames[0].height() > 100);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
