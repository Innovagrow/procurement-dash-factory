# -*- coding: utf-8 -*-
"""
Make the console safe for Greek text.

Every message this package prints is Greek, and a Windows console still starts
in a legacy code page (cp437 / cp1252) that has no Greek letters. Printing into
it raises UnicodeEncodeError and the run dies partway through - after the crawl,
before the results. Nothing about the analysis is wrong; the terminal simply
cannot spell it.

`ensure_utf8()` reconfigures the streams to UTF-8 at start-up, and asks Windows
for the matching console code page so the characters render rather than turning
into boxes. Both steps are best-effort: on a stream that cannot be reconfigured
it falls back to replacing unencodable characters, which is ugly but finishes.
"""
from __future__ import annotations

import sys


def ensure_utf8() -> None:
    """Call once at CLI start-up, before anything is printed."""
    if sys.platform.startswith("win"):
        try:
            import ctypes

            # 65001 = UTF-8. Without this the glyphs are missing even once
            # Python is encoding correctly.
            ctypes.windll.kernel32.SetConsoleOutputCP(65001)
            ctypes.windll.kernel32.SetConsoleCP(65001)
        except Exception:  # noqa: BLE001 - a redirected stream has no console
            pass

    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass
