#!/usr/bin/env bash
# Uso: fix-latest-json.sh <latest.json> <tag>
# Com releaseDraft, o tauri-action pode gravar URLs .../releases/download/untagged-<hash>/...
# no latest.json; depois de publicado, elas quebram o updater. Reescreve para a tag e valida.
set -euo pipefail
f="$1" tag="$2"
tmp="$(mktemp "$f.XXXXXX")"
jq --arg tag "$tag" '
  walk(if type == "string"
       then sub("/releases/download/untagged-[^/]*/"; "/releases/download/\($tag)/"; "g")
       else . end)
' "$f" > "$tmp"
mv "$tmp" "$f"
# Toda URL de plataforma precisa apontar para a tag; nenhum "untagged-" pode sobrar.
jq -e --arg tag "$tag" '
  (.platforms | length > 0)
  and ([.platforms[].url] | all(contains("/releases/download/\($tag)/")))
  and ([.. | strings] | all(contains("/releases/download/untagged-") | not))
' "$f" > /dev/null || { echo "latest.json com URL sem a tag $tag" >&2; exit 1; }
