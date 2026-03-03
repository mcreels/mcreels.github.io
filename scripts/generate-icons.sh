#!/usr/bin/env bash
set -euo pipefail

if ! command -v convert >/dev/null 2>&1; then
  echo "Error: ImageMagick 'convert' is required." >&2
  exit 1
fi

SRC="${1:-}"
if [[ -z "$SRC" ]]; then
  echo "Usage: bash scripts/generate-icons.sh <source-image>" >&2
  exit 1
fi

if [[ ! -f "$SRC" ]]; then
  echo "Error: file not found: $SRC" >&2
  exit 1
fi

OUT_DIR="icons"
mkdir -p "$OUT_DIR"

png_out() {
  local size="$1"
  local out="$2"
  convert "$SRC" \
    -auto-orient \
    -resize "${size}x${size}^" \
    -gravity center \
    -extent "${size}x${size}" \
    -filter Lanczos \
    -define png:compression-level=9 \
    "$out"
}

maskable_out() {
  local size="$1"
  local inner="$2"
  local blur="$3"
  local out="$4"
  convert "$SRC" \
    -auto-orient \
    -resize "${size}x${size}^" \
    -gravity center \
    -extent "${size}x${size}" \
    \( -clone 0 -blur "0x${blur}" -modulate 95,110 \) \
    \( -clone 0 -resize "${inner}x${inner}" \) \
    -delete 0 \
    -gravity center \
    -compose over \
    -composite \
    -filter Lanczos \
    -define png:compression-level=9 \
    "$out"
}

png_out 512 "$OUT_DIR/icon-512.png"
png_out 192 "$OUT_DIR/icon-192.png"
png_out 180 "$OUT_DIR/apple-touch-icon.png"
png_out 32 "$OUT_DIR/favicon-32.png"
png_out 16 "$OUT_DIR/favicon-16.png"

maskable_out 512 420 18 "$OUT_DIR/maskable-512.png"
maskable_out 192 158 10 "$OUT_DIR/maskable-192.png"

convert "$OUT_DIR/favicon-32.png" -define icon:auto-resize=64,48,32,16 "$OUT_DIR/favicon.ico"

echo "Wrote icons to $OUT_DIR/"
