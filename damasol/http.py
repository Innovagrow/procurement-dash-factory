"""
Polite HTTP fetcher: on-disk cache, rate limiting, exponential backoff and a
robots.txt gate.

Property portals are aggressively rate limited. Every request this package
makes goes through `PoliteFetcher`, which:

  * refuses to fetch a path that robots.txt disallows for `*`
  * waits `delay` seconds between requests to the same host
  * caches responses on disk so re-running a crawl costs nothing
  * backs off exponentially on 403 / 429 / 5xx instead of hammering
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Dict, Optional

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

DEFAULT_CACHE_DIR = os.path.join(".cache", "damasol")

# Names a site may use to address this agent specifically. A rule written for
# one of these is aimed at us and overrides anything the wildcard group says -
# in either direction. Sites do use both: xe.gr disallows `ClaudeBot` outright
# while granting `Claude-User` a narrow allow-list, and remax.gr disallows
# `ClaudeBot` across the whole site. Reading only the `*` group, as this gate
# originally did, would have walked straight past both.
SELF_AGENT_NAMES = (
    "claudebot", "claude-web", "claude-user", "claude-searchbot", "anthropic-ai",
)


class FetchError(RuntimeError):
    """Raised when a URL could not be retrieved after all retries."""


class RobotsGate:
    """robots.txt evaluator honouring both the wildcard and our own agent names.

    Two precedence rules, both standard and both load-bearing here:

    1. A group naming this agent wins outright over the `*` group. Sites
       increasingly write rules addressed to AI agents by name, and a gate that
       reads only `*` would ignore an explicit refusal aimed at us.
    2. Within the winning group, the longest matching rule wins, and `Allow`
       beats `Disallow` on an exact tie - portals routinely carve specific pages
       out of a broad `Disallow`.
    """

    def __init__(self, fetcher: "PoliteFetcher"):
        self._fetcher = fetcher
        self._rules: Dict[str, list] = {}
        self._named: Dict[str, str] = {}

    def _load(self, origin: str) -> list:
        """Parse robots.txt into groups, then return the group that applies to us."""
        if origin in self._rules:
            return self._rules[origin]

        try:
            body = self._fetcher.get(origin + "/robots.txt", respect_robots=False)
        except FetchError:
            # No robots.txt reachable -> treat as "no restrictions stated".
            self._rules[origin] = []
            self._named[origin] = ""
            return []

        groups: list = []          # [(agent_names, rules)]
        current = None
        for line in body.splitlines():
            line = line.split("#", 1)[0].strip()
            if not line or ":" not in line:
                continue
            field, _, value = line.partition(":")
            field = field.strip().lower()
            value = value.strip()
            if field == "user-agent":
                # Consecutive User-agent lines share one group of rules.
                if current is None or current[1]:
                    current = ([], [])
                    groups.append(current)
                current[0].append(value.lower())
            elif field in ("disallow", "allow") and current is not None and value:
                current[1].append((self._compile(value), len(value), field == "allow"))

        # Every group addressing the same agent applies, not just the first.
        # robots.txt files routinely repeat `User-agent: *` with a few rules
        # each - spitogatos.gr splits its wildcard rules across four such
        # blocks - and keeping only the first silently ignored the rest. Here
        # that meant reporting the disallowed map-search path as permitted.
        named_match = ""
        chosen: list = []
        for agents, rules in groups:
            hit = next((a for a in agents if a in SELF_AGENT_NAMES), "")
            if hit:
                named_match = named_match or hit
                chosen.extend(rules)
        if not named_match:
            for agents, rules in groups:
                if "*" in agents:
                    chosen.extend(rules)

        self._rules[origin] = chosen
        self._named[origin] = named_match
        return chosen

    @staticmethod
    def _compile(rule: str):
        # robots.txt patterns are not regexes: only `*` and a trailing `$`
        # carry meaning, and a rule anchors at the start of the path.
        escaped = "".join(
            ".*" if ch == "*" else ("$" if ch == "$" else re.escape(ch)) for ch in rule
        )
        return re.compile("^" + escaped)

    def allows(self, url: str) -> bool:
        parts = urllib.parse.urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query

        best_length, best_allows = -1, True
        for pattern, length, is_allow in self._load(origin):
            if pattern.match(path) and (
                length > best_length or (length == best_length and is_allow)
            ):
                best_length, best_allows = length, is_allow
        return best_allows

    def named_group(self, url: str) -> str:
        """Which of our own agent names the site addressed, if any."""
        parts = urllib.parse.urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        self._load(origin)
        return self._named.get(origin, "")

    def explain(self, url: str) -> str:
        verdict = "ALLOWED" if self.allows(url) else "DISALLOWED"
        named = self.named_group(url)
        via = f" [κανόνας για «{named}»]" if named else " [ομάδα *]"
        return f"{verdict} by robots.txt{via}: {url}"


class PoliteFetcher:
    def __init__(
        self,
        delay: float = 2.0,
        cache_dir: str = DEFAULT_CACHE_DIR,
        cache_ttl_hours: float = 24.0,
        timeout: float = 45.0,
        max_retries: int = 4,
        user_agent: str = DEFAULT_USER_AGENT,
        accept_language: str = "el-GR,el;q=0.9,en;q=0.8",
        verbose: bool = True,
        obey_robots: bool = True,
    ):
        self.delay = delay
        self.cache_dir = cache_dir
        self.cache_ttl = cache_ttl_hours * 3600.0
        self.timeout = timeout
        self.max_retries = max_retries
        self.user_agent = user_agent
        self.accept_language = accept_language
        self.verbose = verbose
        self.obey_robots = obey_robots
        self._last_request_at: Dict[str, float] = {}
        self._robots = RobotsGate(self)
        self.stats = {"cache_hits": 0, "network": 0, "retries": 0, "blocked": 0}
        if cache_dir:
            os.makedirs(cache_dir, exist_ok=True)

    # ---------------------------------------------------------------- cache
    def _cache_path(self, url: str) -> Optional[str]:
        if not self.cache_dir:
            return None
        digest = hashlib.sha1(url.encode("utf-8")).hexdigest()
        return os.path.join(self.cache_dir, digest[:2], digest + ".html.gz")

    def _cache_read(self, url: str) -> Optional[str]:
        path = self._cache_path(url)
        if not path or not os.path.exists(path):
            return None
        if self.cache_ttl and (time.time() - os.path.getmtime(path)) > self.cache_ttl:
            return None
        try:
            with gzip.open(path, "rt", encoding="utf-8") as fh:
                return fh.read()
        except OSError:
            return None

    def _cache_write(self, url: str, body: str) -> None:
        path = self._cache_path(url)
        if not path:
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with gzip.open(path, "wt", encoding="utf-8") as fh:
            fh.write(body)

    # -------------------------------------------------------------- fetching
    def _throttle(self, host: str) -> None:
        last = self._last_request_at.get(host)
        if last is not None:
            wait = self.delay - (time.time() - last)
            if wait > 0:
                time.sleep(wait)
        self._last_request_at[host] = time.time()

    def get(self, url: str, respect_robots: bool = True) -> str:
        cached = self._cache_read(url)
        if cached is not None:
            self.stats["cache_hits"] += 1
            return cached

        if respect_robots and self.obey_robots and not self._robots.allows(url):
            self.stats["blocked"] += 1
            raise FetchError(f"robots.txt disallows {url}")

        host = urllib.parse.urlsplit(url).netloc
        last_error: Optional[Exception] = None

        for attempt in range(self.max_retries):
            self._throttle(host)
            request = urllib.request.Request(
                url,
                headers={
                    "User-Agent": self.user_agent,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": self.accept_language,
                    "Cache-Control": "no-cache",
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    body = response.read().decode("utf-8", "replace")
                self.stats["network"] += 1
                self._cache_write(url, body)
                return body
            except urllib.error.HTTPError as exc:
                last_error = exc
                if exc.code not in (403, 408, 429, 500, 502, 503, 504):
                    raise FetchError(f"HTTP {exc.code} for {url}") from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_error = exc

            self.stats["retries"] += 1
            backoff = self.delay * (2 ** (attempt + 1)) + random.uniform(0, 1.5)
            if self.verbose:
                print(
                    f"  ! {type(last_error).__name__} on attempt {attempt + 1}"
                    f"/{self.max_retries} - backing off {backoff:.1f}s",
                    flush=True,
                )
            time.sleep(backoff)

        raise FetchError(f"giving up on {url}: {last_error}")

    def get_json_attribute(self, url: str, attribute: str) -> dict:
        """Fetch `url` and decode an HTML-escaped JSON blob held in `attribute`.

        Greek portals server-render their result payload into a data attribute
        rather than exposing a public API; this pulls that payload back out.
        """
        import html as html_module

        body = self.get(url)
        match = re.search(
            r'%s="(.*?)"(?=\s+[a-zA-Z0-9_:\-\.]+=|\s*/?>)' % re.escape(attribute),
            body,
            re.S,
        )
        if not match:
            raise FetchError(f"attribute {attribute} not found in {url}")
        return json.loads(html_module.unescape(match.group(1)))
