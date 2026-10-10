# Gate diagnostic font

A gate-specific derivative of Maple Mono NF CN Regular that adds only `위` / `치`
(U+C704 / U+CE58). It is **not** a full Korean font. All 41,617 original glyph
outlines and horizontal metrics are verified unchanged; the new glyphs use 1000 UPM,
1200 advance and rounded Regular strokes, emitted as unhinted WOFF2.

The binary lives only in the local external font directory and in R2; it is not
committed to Git and not shipped with Pages. The source and the derivative are
covered by `OFL.txt` in this directory.

```sh
.venv-build/bin/python ops/fonts/build_gate_font.py \
  /Users/lime/Documents/Project/Fonts/MapleMono-NF-CN/MapleMono-NF-CN-Regular.ttf \
  /Users/lime/Documents/Project/Fonts/MapleMono-Gate-KR
```

The script writes the full Regular TTF plus a WOFF2 subset containing only the
characters the diagnostic copy needs. The original family name is preserved. The R2
bucket is `limooo-fonts`; the public asset is
`https://fonts.limooo.cn/maple-mono-nf-cn-regular-subset.woff2` and the OFL text is
published next to it. CORS allows pages to load the font cross-origin.
