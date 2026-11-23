#!/usr/bin/env bash
# Uso: scripts/single-instance.sh <binário do app> [imagem]
# Instância única: com o app aberto, abrir de novo (com e sem arquivo) não deixa um segundo
# processo, e a segunda execução sai logo com sucesso. Roda num X virtual e num barramento de
# sessão próprios, com HOME e XDG_* temporários: nunca toca na sessão do usuário.
# Precisa de xvfb-run, dbus-run-session e dbus-send.
set -euo pipefail
bin=$(realpath "${1:?uso: $0 <binário> [imagem]}")
img=$(realpath "${2:-$(dirname "$0")/../src-tauri/tests/fixtures/alpha.png}")
name=io.github.junior9283.geraviewimage.SingleInstance

if [ -z "${GVI_SINGLE_INNER:-}" ]; then
  tmp=$(mktemp -d)
  # --one-file-system: os portais do barramento isolado podem montar FUSE em $tmp/run.
  trap 'rm -rf --one-file-system "$tmp" 2>/dev/null || true' EXIT
  mkdir "$tmp/home" "$tmp/config" "$tmp/cache" "$tmp/data" "$tmp/state"
  mkdir -m 700 "$tmp/run"
  env -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS GDK_BACKEND=x11 NO_AT_BRIDGE=1 \
    HOME="$tmp/home" XDG_CONFIG_HOME="$tmp/config" XDG_CACHE_HOME="$tmp/cache" \
    XDG_DATA_HOME="$tmp/data" XDG_STATE_HOME="$tmp/state" XDG_RUNTIME_DIR="$tmp/run" \
    http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 GVI_SINGLE_INNER=1 \
    xvfb-run -a dbus-run-session -- "$0" "$bin" "$img"
  exit
fi

first=
limpa() { [ -z "$first" ] || { kill "$first"; wait "$first"; } 2>/dev/null || true; }
trap limpa EXIT
falha() { echo "instância única FALHOU: $1" >&2; exit 1; }
dono() {
  dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
    org.freedesktop.DBus.NameHasOwner "string:$name" 2>/dev/null | grep -q 'boolean true'
}
quantos() { pgrep -c -x -f "$bin( .*)?" || true; }

"$bin" >"$XDG_RUNTIME_DIR/primeira.log" 2>&1 &
first=$!
for _ in $(seq 60); do dono && break; sleep 0.5; done
dono || falha "a primeira execução não registrou $name no D-Bus"

for args in "$img" "" "--flag-qualquer $img"; do
  # shellcheck disable=SC2086 # de propósito: lista de argumentos
  timeout 20 "$bin" $args >/dev/null 2>&1 || falha "a segunda execução ($args) não saiu com sucesso"
  sleep 0.5
  kill -0 "$first" 2>/dev/null || falha "a primeira execução terminou"
  [ "$(quantos)" = 1 ] || falha "há $(quantos) processos depois de abrir de novo ($args)"
done
echo "instância única ok: um processo só, segunda execução entregou e saiu"
