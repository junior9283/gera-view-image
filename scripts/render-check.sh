#!/usr/bin/env bash
# Uso: scripts/render-check.sh <comando do app...>
# Abre uma imagem no Xvfb e confere se a JANELA INTEIRA foi desenhada, não só a última região
# redesenhada (bug da 0.3.0, ver docs/testes/bugs.md).
# Precisa de xvfb-run, dbus-run-session, xdotool e ImageMagick.
set -euo pipefail
if [ -z "${GVI_RENDER_CHECK_XVFB:-}" ]; then
  export GVI_RENDER_CHECK_XVFB=1
  exec xvfb-run -a -s "-screen 0 1300x900x24" "$0" "$@"
fi
# Com o defeito sobram 1 a 3 cores no miolo; com a imagem inteira, uma por linha do gradiente.
min_cores=150
tmp=$(mktemp -d)
app=
# --one-file-system: os portais do barramento isolado montam FUSE em $tmp/run; não atravessar.
limpa() {
  [ -z "$app" ] || { kill -- "-$app"; wait "$app"; } 2>/dev/null || true
  rm -rf --one-file-system "$tmp" 2>/dev/null || true
}
trap limpa EXIT
mkdir "$tmp/home"
mkdir -m 700 "$tmp/run"
if command -v magick >/dev/null; then conv=magick; else conv=convert; fi
"$conv" -size 900x600 gradient:red-blue "$tmp/teste.png"
# Sem rede: o aviso de versão nova redesenha a janela inteira e esconderia o defeito.
setsid env -u WAYLAND_DISPLAY GDK_BACKEND=x11 HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/run" NO_AT_BRIDGE=1 \
  http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 \
  dbus-run-session -- "$@" "$tmp/teste.png" >"$tmp/app.log" 2>&1 &
app=$!
# Miolo da imagem, longe das bordas e dos menus.
inteira() {
  cores=$(import -window root -crop 400x400+500+150 +repage -format '%k' info:)
  [ "$cores" -gt "$min_cores" ]
}
falha() {
  echo "render FALHOU ($1): só $cores cores no miolo da janela" >&2
  tail -20 "$tmp/app.log" >&2
  exit 1
}
for _ in $(seq 40); do
  sleep 1
  inteira && break
done
inteira || falha "a imagem não apareceu"
# A primeira pintura sai inteira mesmo com o defeito; é o redesenho parcial que apaga o resto.
sleep 6
for passo in 1 2 3; do
  xdotool mousemove $((30 + passo * 50)) 20 click 1
  sleep 2
  inteira || falha "a janela sumiu ao abrir o menu $passo"
  xdotool key Escape
  sleep 1
done
echo "render ok: $cores cores no miolo da janela"
