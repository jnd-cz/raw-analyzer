"""Local test server: serves the app and the test page, plus sample files,
reference data, snapshots and the export check.

    python tests/server.py      then open http://127.0.0.1:8765/tests/run.html

Listens on 127.0.0.1 only.
"""
import http.server, json, os, sys, traceback, urllib.parse
from samples import samples, HERE

ROOT = os.path.dirname(HERE)
REF = os.path.join(HERE, 'ref')
OUT = os.path.join(HERE, 'out')
PORT = int(os.environ.get('PORT', 8765))


def safe_name(name):
    name = os.path.basename(name)
    if not name or name.startswith('.'):
        raise ValueError('bad name')
    return name


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def reply(self, data, ctype='application/json', code=200):
        if isinstance(data, (dict, list)):
            data = json.dumps(data).encode()
        elif isinstance(data, str):
            data = data.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        return self.rfile.read(int(self.headers.get('Content-Length') or 0))

    def do_GET(self):
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        try:
            if path == '/tests/api/samples':
                sm = samples()
                return self.reply([{'name': n, 'ref': os.path.exists(os.path.join(REF, n + '.json')),
                                    'snapshot': os.path.exists(os.path.join(REF, n + '.snap.json'))} for n in sorted(sm)])
            if path.startswith('/tests/api/sample/'):
                p = samples().get(path[len('/tests/api/sample/'):])
                if not p:
                    return self.reply('unknown sample', 'text/plain', 404)
                return self.reply(open(p, 'rb').read(), 'application/octet-stream')
            if path.startswith('/tests/api/ref/'):
                p = os.path.join(REF, safe_name(path[len('/tests/api/ref/'):]))
                if not os.path.exists(p):
                    return self.reply('no reference', 'text/plain', 404)
                return self.reply(open(p, 'rb').read(), 'application/octet-stream')
        except Exception as e:
            return self.reply(str(e), 'text/plain', 500)
        return super().do_GET()

    def do_POST(self):
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        try:
            if path.startswith('/tests/api/snapshot/'):
                os.makedirs(REF, exist_ok=True)
                open(os.path.join(REF, safe_name(path[len('/tests/api/snapshot/'):]) + '.snap.json'), 'wb').write(self.body())
                return self.reply({'ok': True})
            if path.startswith('/tests/api/export/'):
                os.makedirs(OUT, exist_ok=True)
                open(os.path.join(OUT, safe_name(path[len('/tests/api/export/'):])), 'wb').write(self.body())
                return self.reply({'ok': True})
            if path == '/tests/api/check-export':
                import importlib, check_export
                importlib.reload(check_export)  # pick up edits without restarting
                meta = json.loads(self.body())
                meta['path'] = samples().get(meta['sample'])
                return self.reply({'report': check_export.check(OUT, meta)})
        except Exception:
            return self.reply(traceback.format_exc(), 'text/plain', 500)
        self.send_error(404)


if __name__ == '__main__':
    sys.path.insert(0, HERE)
    print(f'Raw Analyzer tests: http://127.0.0.1:{PORT}/tests/run.html')
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
