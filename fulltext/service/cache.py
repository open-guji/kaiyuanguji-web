"""章 md 的 LRU 缓存，按字节封顶（FT_LRU_BYTES，分块-F4 步 3）。

大小按 UTF-8 字节计；单条超过上限则不入缓存。reload 时整体 clear。
"""
import threading
from collections import OrderedDict


class ByteLRU:
    def __init__(self, max_bytes):
        self.max_bytes = max_bytes
        self._d = OrderedDict()           # key -> (value, nbytes)
        self._size = 0
        self._lock = threading.Lock()

    @property
    def size(self):
        with self._lock:
            return self._size

    def __len__(self):
        with self._lock:
            return len(self._d)

    def get(self, key):
        with self._lock:
            hit = self._d.get(key)
            if hit is None:
                return None
            self._d.move_to_end(key)
            return hit[0]

    def put(self, key, value):
        n = len(value.encode('utf-8'))
        with self._lock:
            old = self._d.pop(key, None)
            if old is not None:
                self._size -= old[1]
            if n > self.max_bytes:
                return
            self._d[key] = (value, n)
            self._size += n
            while self._size > self.max_bytes:
                _, (_, m) = self._d.popitem(last=False)
                self._size -= m

    def get_or_load(self, key, loader):
        v = self.get(key)
        if v is None:
            v = loader(key)
            self.put(key, v)
        return v

    def clear(self):
        with self._lock:
            self._d.clear()
            self._size = 0
