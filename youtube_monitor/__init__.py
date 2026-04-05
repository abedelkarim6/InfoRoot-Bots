# YouTube Monitor & Summarizer module

from googleapiclient.discovery_cache.base import Cache as _Cache


class _MemoryCache(_Cache):
    """In-process cache for Google API discovery docs (avoids file_cache/oauth2client warning)."""
    _store: dict = {}

    def get(self, url: str):
        return _MemoryCache._store.get(url)

    def set(self, url: str, content) -> None:
        _MemoryCache._store[url] = content


# Shared singleton — pass as `cache=yt_memory_cache` to googleapiclient build()
yt_memory_cache = _MemoryCache()
