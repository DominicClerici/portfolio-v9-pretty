"""
Font subsetting script for dominicclerici.com via Claude Code :)

Trims self-hosted font files down to only the glyphs actually used on the site.
Run this whenever you change visible text and introduce new characters.

Requirements:
    pip install fonttools brotli

Usage:
    pnpm build              # build first so dist/ has resolved HTML
    python subset-fonts.py  # subset fonts based on the built output
    pnpm build              # rebuild with the new subset fonts

The script scans the built HTML in dist/ (where all Astro template expressions
have been resolved to real text), figures out which characters each font needs,
and writes trimmed font files to public/fonts/.
"""

import os
import re
import sys
from html.entities import html5
from html.parser import HTMLParser
from pathlib import Path

try:
    from fontTools.subset import Subsetter, Options, load_font, save_font
except ImportError:
    print("Missing dependency. Run: pip install fonttools brotli")
    sys.exit(1)

ROOT = Path(__file__).parent
DIST = ROOT / "dist"
FONTS_DIR = ROOT / "public" / "fonts"
FULL_FONTS_DIR = ROOT / "fonts-src"

# Tailwind class -> font key
FONT_CLASSES = {
    "font-display": "aspekta",
    "font-mono": "roboto-mono",
    "font-body": "inter",
}

# The <body> in Layout.astro carries font-body, so anything that never hits a
# font-* class inherits Inter. Keep this in sync with that class.
DEFAULT_FONT = "inter"

# Tags whose text content is not visible and should be skipped.
# Only tags that have closing tags — void elements (meta, link) can't
# contain text and don't have end tags, so they must NOT be listed here
# or they'll increment skip depth without ever decrementing it.
SKIP_TAGS = {"script", "style", "noscript", "title"}

# Non-breaking / en / em / thin / hair / narrow-nbsp. These render as visible
# advance width but report isprintable() == False, so the printable filter in
# collect_chars() would otherwise discard them.
TYPOGRAPHIC_SPACES = {
    "\u00a0",  # no-break space
    "\u2002",  # en space
    "\u2003",  # em space
    "\u2009",  # thin space
    "\u200a",  # hair space
    "\u202f",  # narrow no-break space
}


class FontTextExtractor(HTMLParser):
    """Walks built HTML and collects text characters grouped by font."""

    def __init__(self):
        super().__init__()
        self.chars = {name: set() for name in FONT_CLASSES.values()}
        self._font_stack = [DEFAULT_FONT]
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in SKIP_TAGS:
            self._skip_depth += 1
            return

        classes = dict(attrs).get("class", "")
        font = None
        for cls, name in FONT_CLASSES.items():
            if cls in classes:
                font = name
                break
        self._font_stack.append(font or self._font_stack[-1])

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if len(self._font_stack) > 1:
            self._font_stack.pop()

    def handle_data(self, data):
        if self._skip_depth > 0:
            return
        # Strip only to test for emptiness \u2014 str.strip() also eats U+00A0,
        # U+2002 and U+2009, which are glyphs we need, so collect from raw.
        if data.strip():
            font = self._font_stack[-1]
            self.chars[font].update(data)

    def handle_entityref(self, name):
        if self._skip_depth > 0:
            return
        # Resolve against the full HTML5 entity table rather than a hand-kept
        # map \u2014 a missing entry here drops the glyph silently, which is how
        # &ensp; &thinsp; &larr; &nearr; and &times; went unsubset.
        char = html5.get(name + ";") or html5.get(name, "")
        if char:
            self.chars[self._font_stack[-1]].update(char)

    def handle_charref(self, name):
        if self._skip_depth > 0:
            return
        try:
            if name.startswith("x"):
                char = chr(int(name[1:], 16))
            else:
                char = chr(int(name))
            self.chars[self._font_stack[-1]].add(char)
        except (ValueError, OverflowError):
            pass


def collect_chars():
    """Scan all built HTML files in dist/ and return chars per font."""
    html_files = sorted(DIST.rglob("*.html"))
    print(f"Scanning {len(html_files)} built HTML files in dist/...\n")

    extractor = FontTextExtractor()
    for fpath in html_files:
        content = fpath.read_text(encoding="utf-8")
        extractor.feed(content)

    # Always include space
    for font_name in extractor.chars:
        extractor.chars[font_name].add(" ")
        # Drop control chars and the newlines/tabs picked up from HTML
        # indentation. Typographic spaces are str.isprintable() == False but
        # are real glyphs used as separators, so keep them explicitly.
        extractor.chars[font_name] = {
            c
            for c in extractor.chars[font_name]
            if c.isprintable() or c in TYPOGRAPHIC_SPACES
        }

    return extractor.chars


def chars_to_unicodes(charset):
    """Convert a set of characters to a comma-separated U+XXXX string."""
    codepoints = sorted(set(ord(c) for c in charset))
    return ",".join(f"U+{cp:04X}" for cp in codepoints)


def parse_unicodes(unicodes_str):
    """Parse a U+XXXX,U+YYYY string into a set of integer codepoints."""
    codepoints = set()
    for part in unicodes_str.split(","):
        part = part.strip()
        if not part:
            continue
        codepoints.add(int(part.replace("U+", ""), 16))
    return codepoints


def subset_font(input_path, output_path, unicodes_str):
    """Subset a font file to only the specified unicode codepoints."""
    options = Options()
    options.flavor = "woff2"
    options.layout_features = ["kern", "liga", "calt", "ccmp", "locl"]
    options.hinting = False
    options.desubroutinize = True

    font = load_font(str(input_path), options)
    subsetter = Subsetter(options=options)
    subsetter.populate(unicodes=parse_unicodes(unicodes_str))
    subsetter.subset(font)
    save_font(font, str(output_path), options)
    font.close()


def main():
    if not DIST.exists():
        print("ERROR: dist/ not found. Build the site first:")
        print("  pnpm build")
        sys.exit(1)

    if not FULL_FONTS_DIR.exists():
        print(f"ERROR: {FULL_FONTS_DIR} not found.")
        print("Place the original (un-subset) .woff2 files in fonts-src/")
        print("Files needed:")
        print("  - aspekta-400.woff2")
        print("  - roboto-mono-latin-400.woff2")
        print("  - inter-latin-400.woff2")
        sys.exit(1)

    char_sets = collect_chars()

    for font_name, chars in sorted(char_sets.items()):
        printable = "".join(sorted(chars, key=ord))
        print(f"  {font_name}: {len(chars)} chars -> {repr(printable)}")
    print()

    font_files = [
        ("aspekta-400.woff2", "aspekta"),
        ("roboto-mono-latin-400.woff2", "roboto-mono"),
        ("inter-latin-400.woff2", "inter"),
    ]

    total_before = 0
    total_after = 0

    for filename, font_key in font_files:
        full_path = FULL_FONTS_DIR / filename
        out_path = FONTS_DIR / filename

        if not full_path.exists():
            print(f"  SKIP {filename} — not found in full/")
            continue

        unicodes = chars_to_unicodes(char_sets[font_key])
        before = full_path.stat().st_size
        subset_font(full_path, out_path, unicodes)
        after = out_path.stat().st_size

        total_before += before
        total_after += after
        saved = before - after
        pct = (saved / before) * 100

        print(f"  {filename}")
        print(f"    {before:,}B -> {after:,}B  (saved {saved:,}B / {pct:.0f}%)")

    print()
    total_saved = total_before - total_after
    total_pct = (total_saved / total_before) * 100
    print(
        f"  Total: {total_before:,}B -> {total_after:,}B  (saved {total_saved:,}B / {total_pct:.0f}%)"
    )
    print()
    print("Done. Run `pnpm build` again to deploy with the new subset fonts.")


if __name__ == "__main__":
    main()
