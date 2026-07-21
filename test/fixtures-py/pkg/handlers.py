import functools

from . import util as u
from .util import to_upper


class Handler:
    def handle_one(self, s):
        self.log(s)
        return prepare(s)

    def log(self, s):
        self._last = s


@functools.lru_cache(maxsize=None)
def prepare(s):
    return to_upper(s)


def handle(text):
    h = Handler()
    h.handle_one(text)
    return u.trim(text)
