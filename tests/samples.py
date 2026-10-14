"""Sample raw files for the tests.

The files in examples/ and tests/samples/ are used, plus every file or folder
listed in tests/samples.txt (one path per line, # starts a comment). The last two
are kept out of git.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = ('.crw', '.cr2', '.cr3', '.tif', '.tiff')


def _files(path):
    if os.path.isdir(path):
        for name in sorted(os.listdir(path)):
            p = os.path.join(path, name)
            if os.path.isfile(p) and name.lower().endswith(EXT):
                yield p
    elif os.path.isfile(path):
        yield path


def samples():
    """{name: path}, names unique (a folder prefix is added on clashes)."""
    paths = list(_files(os.path.join(os.path.dirname(HERE), 'examples'))) + list(_files(os.path.join(HERE, 'samples')))
    listing = os.path.join(HERE, 'samples.txt')
    if os.path.exists(listing):
        for line in open(listing, encoding='utf-8'):
            line = line.split('#', 1)[0].strip()
            if line:  # relative paths are relative to the repository root
                paths.extend(_files(os.path.join(os.path.dirname(HERE), os.path.expanduser(line))))
    out = {}
    for p in paths:
        name = os.path.basename(p)
        if name in out and os.path.abspath(out[name]) != os.path.abspath(p):
            name = os.path.basename(os.path.dirname(p)) + '_' + name
        out[name] = p
    return out
