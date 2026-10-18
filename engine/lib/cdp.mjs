// Minimal Chrome DevTools Protocol client for the Doubao desktop app (Chromium 147).
// Uses Node's built-in global WebSocket (Node 22+), so no npm dependencies are needed.
import fs from 'node:fs';

export const DEFAULT_PORT = 9333;

export async function listTargets(port = DEFAULT_PORT) {
  const res = await fetch('http://127.0.0.1:' + port + '/json/list');
  return res.json();
}

export async function findChatTarget(port = DEFAULT_PORT) {
  const targets = await listTargets(port);
  const chat = targets.find((t) => t.type === 'page' && /doubao-chat\/chat/.test(t.url) && !/cross-site-support/.test(t.url));
  if (!chat) throw new Error('chat target not found; targets=' + targets.map((t) => t.url).join(', '));
  return chat;
}

export class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  static async attach(port = DEFAULT_PORT) {
    const target = await findChatTarget(port);
    const cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.connect();
    return cdp;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), 15000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(this); });
      ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('CDP socket error: ' + (e.message || 'unknown'))); });
      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
          else res(msg.result);
        }
      });
      ws.addEventListener('close', () => {
        for (const { reject: rej } of this.pending.values()) rej(new Error('CDP socket closed'));
        this.pending.clear();
      });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 90000);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, timeoutMs = 90000) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('page exception: ' + (d.exception?.description || d.text));
    }
    return r.result.value;
  }

  // Call a page-side function source with a JSON args object.
  async call(fnSource, args = {}) {
    const payload = JSON.stringify(args);
    return this.eval('(' + fnSource + ')(' + payload + ')');
  }

  async screenshot(filePath) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(filePath, Buffer.from(r.data, 'base64'));
    return filePath;
  }

  close() { try { this.ws?.close(); } catch {} }
}
