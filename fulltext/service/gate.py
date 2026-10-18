"""全局并发闸（分块-F4 步 3）：同时运行 ≤ max_running；排队 ≤ queue_max；队满或等待超时返回 False（调用方回 503 busy）。

限流不在这里做（F4 §三：按 IP 限流放 EdgeOne 函数层）；这里只兜 CPU。
"""
import threading
import time


class Gate:
    def __init__(self, max_running, queue_max):
        self.max_running = max_running
        self.queue_max = queue_max
        self._cond = threading.Condition()
        self._running = 0
        self._waiting = 0

    @property
    def running(self):
        with self._cond:
            return self._running

    def acquire(self, timeout):
        deadline = time.monotonic() + timeout
        with self._cond:
            if self._running < self.max_running:
                self._running += 1
                return True
            if self._waiting >= self.queue_max:
                return False
            self._waiting += 1
            try:
                while self._running >= self.max_running:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        return False
                    self._cond.wait(left)
                self._running += 1
                return True
            finally:
                self._waiting -= 1

    def release(self):
        with self._cond:
            self._running -= 1
            self._cond.notify()
