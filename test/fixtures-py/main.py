from pkg import handlers, init_app
from pkg.util import to_upper
import pkg.util as util_mod


def main():
    init_app()
    text = to_upper("hello")
    handlers.handle(text)
    return util_mod.shorten(text)


def run():
    def inner():
        return main()

    return inner()
