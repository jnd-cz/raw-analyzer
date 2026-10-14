/*
 * Runs RL.decode in a Web Worker built from the RAW_MODULES sources (a Blob
 * worker also works when the page is opened from file://). Falls back to the
 * main thread if workers are unavailable.
 */
(function () {
  'use strict';

  const RL = {};
  for (const m of self.RAW_MODULES) m(RL);
  window.RL = RL;

  const workerSource = () => [
    'const RL = {};',
    ...self.RAW_MODULES.map((f) => '(' + f.toString() + ')(RL);'),
    `self.onmessage = function (e) {
      let last = 0;
      const progress = (p) => {
        const now = Date.now();
        if (now - last > 60) { last = now; self.postMessage({ type: 'progress', p }); }
      };
      try {
        const res = RL.decode(e.data.buffer, e.data.name, progress);
        const transfer = [res.raw.buffer];
        for (const t of res.thumbs) transfer.push(t.data.buffer);
        self.postMessage({ type: 'done', res }, transfer);
      } catch (err) {
        self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err), stack: err && err.stack });
      }
    };`,
  ].join('\n');

  let workerUrl = null;

  function decodeOnMainThread(buffer, name, onProgress) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try { resolve(RL.decode(buffer, name, onProgress)); } catch (e) { reject(e); }
      }, 30);
    });
  }

  /** Decodes an ArrayBuffer. The buffer is transferred (unusable afterwards). */
  window.decodeRaw = function (buffer, name, onProgress) {
    let worker;
    try {
      if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }));
      worker = new Worker(workerUrl);
    } catch (e) {
      console.warn('Worker unavailable, decoding on the main thread', e);
      return decodeOnMainThread(buffer, name, onProgress);
    }
    const copy = buffer.slice(0); // keep a copy in case the worker fails to start
    return new Promise((resolve, reject) => {
      let started = false;
      worker.onmessage = (e) => {
        started = true;
        const m = e.data;
        if (m.type === 'progress') onProgress && onProgress(m.p);
        else if (m.type === 'done') { worker.terminate(); resolve(m.res); }
        else if (m.type === 'error') { worker.terminate(); reject(new Error(m.message)); }
      };
      worker.onerror = (e) => {
        worker.terminate();
        if (!started) {
          console.warn('Worker failed, decoding on the main thread', e.message);
          decodeOnMainThread(copy, name, onProgress).then(resolve, reject);
        } else reject(new Error(e.message || 'Decoder crashed'));
      };
      worker.postMessage({ buffer, name }, [buffer]);
    });
  };
})();
