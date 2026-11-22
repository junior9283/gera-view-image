#!/usr/bin/env bash
# Confere as bibliotecas NEEDED do binário: só as da allowlist, nunca codecs opcionais
# ou ligados por acidente pelo cmake da libheif embutida.
# Uso: scripts/check-needed.sh caminho/do/gera-view-image
set -euo pipefail
bin="${1:?uso: $0 <binário>}"

# libde265/libkvazaar: abrir/gravar HEIC é opcional (dlopen em src-tauri/native/heic). libopenjp2:
# o JPEG 2000 é Rust puro (openjp2). libjpeg/libheif:
# a libheif é estática e o JPEG/J2K dela não deve vir do sistema.
forbidden='^lib(de265|heif|jpeg|openjp2|dav1d|x265|kvazaar|numa|vmaf|sharpyuv)\.'
allowed='^(ld-linux-x86-64|libc|libm|libdl|libpthread|librt|libutil|libgcc_s|libstdc\+\+|libz|libdbus-1|libaom|libgtk-3|libgdk-3|libwebkit2gtk-4\.1|libjavascriptcoregtk-4\.1|libsoup-3\.0|libgio-2\.0|libglib-2\.0|libgobject-2\.0|libgmodule-2\.0|libpango-1\.0|libpangocairo-1\.0|libharfbuzz|libcairo|libcairo-gobject|libgdk_pixbuf-2\.0|libatk-1\.0)\.so'

needed=$(readelf -d "$bin" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p')
echo "NEEDED de $bin:"
echo "$needed" | sed 's/^/  /'

bad=0
while read -r lib; do
  [ -z "$lib" ] && continue
  if [[ "$lib" =~ $forbidden ]]; then
    echo "PROIBIDA: $lib" >&2
    bad=1
  elif ! [[ "$lib" =~ $allowed ]]; then
    echo "fora da allowlist: $lib" >&2
    bad=1
  fi
done <<< "$needed"
exit "$bad"
