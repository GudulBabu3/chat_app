#!/usr/bin/env bash
set -euo pipefail

sticker_dir="${1:-public/stickers}"

# Each animation moves the complete, already-approved drawing as one unit.
# This keeps the character model perfectly stable instead of synthesizing
# in-between artwork that can change the face, markings, or proportions.
make_gif() {
  local source="$1"
  local output="$2"
  local motion="$3"
  local frame_dir
  frame_dir="$(mktemp -d /tmp/tukurumukuru-gif-XXXXXX)"
  trap 'rm -rf "$frame_dir"' RETURN

  case "$motion" in
    bounce)
      magick "$source" -background none -gravity center -extent 320x320 -gravity center -crop 300x300+0+4 +repage "$frame_dir/0.png"
      magick "$source" -background none -gravity center -extent 320x320 -gravity center -crop 300x300+0-2 +repage "$frame_dir/1.png"
      magick "$source" -background none -gravity center -extent 320x320 -gravity center -crop 300x300+0-5 +repage "$frame_dir/2.png"
      magick "$source" -background none -gravity center -extent 320x320 -gravity center -crop 300x300+0-2 +repage "$frame_dir/3.png"
      ;;
    shake)
      magick "$source" -background none -gravity center -extent 320x320 -gravity center -crop 300x300-3+0 +repage "$frame_dir/0.png"
      magick "$source" -background none -gravity center -extent 320x320 -gravity center -crop 300x300+3+0 +repage "$frame_dir/1.png"
      magick "$source" -background none -gravity center -extent 320x320 -gravity center -crop 300x300-2+0 +repage "$frame_dir/2.png"
      magick "$source" -background none -gravity center -extent 320x320 -gravity center -crop 300x300+2+0 +repage "$frame_dir/3.png"
      ;;
    sway)
      magick "$source" -background none -gravity center -rotate -1.5 -resize 300x300 -gravity center -extent 300x300 "$frame_dir/0.png"
      cp "$source" "$frame_dir/1.png"
      magick "$source" -background none -gravity center -rotate 1.5 -resize 300x300 -gravity center -extent 300x300 "$frame_dir/2.png"
      cp "$source" "$frame_dir/3.png"
      ;;
    breathe)
      magick "$source" -resize 296x296 -background none -gravity center -extent 300x300 "$frame_dir/0.png"
      magick "$source" -resize 298x298 -background none -gravity center -extent 300x300 "$frame_dir/1.png"
      cp "$source" "$frame_dir/2.png"
      magick "$source" -resize 298x298 -background none -gravity center -extent 300x300 "$frame_dir/3.png"
      ;;
  esac

  magick -dispose Background -delay 18 "$frame_dir/0.png" "$frame_dir/1.png" "$frame_dir/2.png" "$frame_dir/3.png" \
    -delay 70 "$frame_dir/0.png" -loop 0 -layers OptimizeTransparency "$output"
}

for source in "$sticker_dir"/*.webp; do
  name="$(basename "$source" .webp)"
  mood="${name%-2}"
  case "$mood" in
    excited|greeting|hungry|playful) motion=bounce ;;
    laughing|startled) motion=shake ;;
    annoyed|curious|sad|sleepy) motion=sway ;;
    affectionate|napping|neutral) motion=breathe ;;
    *) motion=breathe ;;
  esac
  make_gif "$source" "$sticker_dir/$name.gif" "$motion"
done

echo "Generated GIFs for every WebP sticker in $sticker_dir"
