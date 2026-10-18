// High-level driver for the Doubao desktop app: send an image prompt, wait for
// the generated candidates, and pull the full-resolution files out of the page.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Cdp, DEFAULT_PORT } from './cdp.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadConfig() {
  const p = new URL('../config.json', import.meta.url);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export async function probe(port) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function ensureApp(port, exe, { relaunch = true } = {}) {
  let v = await probe(port);
  if (v) return { launched: false, version: v.Browser };

  if (!relaunch) throw new Error('Doubao debug port ' + port + ' is not open');
  if (!fs.existsSync(exe)) throw new Error('Doubao.exe not found: ' + exe);

  // The app is single-instance and locks its profile, so it must be restarted
  // with the debugging flag. Login state lives in the profile and survives.
  await new Promise((resolve) => {
    const k = spawn('taskkill', ['/IM', 'Doubao.exe', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.on('exit', resolve);
    k.on('error', resolve);
  });
  await sleep(3000);

  const child = spawn(exe, ['--remote-debugging-port=' + port], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    v = await probe(port);
    if (v) break;
  }
  if (!v) throw new Error('Doubao did not open debug port ' + port);
  return { launched: true, version: v.Browser };
}

const stateFn = function () {
  const imgs = Array.from(document.querySelectorAll('img')).filter(function (im) {
    const s = im.currentSrc || im.src || '';
    if (s.indexOf('rc_gen_image') < 0) return false;
    return im.clientWidth > 150 || im.naturalWidth >= 1024;
  });
  const byKey = {};
  imgs.forEach(function (im) {
    const s = im.currentSrc || im.src;
    const m = s.match(/rc_gen_image\/([0-9a-zA-Z]+)\./);
    const key = m ? m[1] : s.split('?')[0].split('~')[0];
    const rank = s.indexOf('cgen') >= 0 ? 2 : 1;
    if (!byKey[key] || rank > byKey[key].rank) {
      byKey[key] = { key: key, url: s, rank: rank, w: im.naturalWidth, h: im.naturalHeight, lowRes: rank < 2 };
    }
  });
  const composer = document.querySelector('[contenteditable="true"]');
  const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
  const labels = buttons.map(function (b) { return (b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '').trim(); });
  const stopping = labels.filter(function (t) { return t.indexOf('停止') >= 0; }).length > 0;
  const body = document.body ? document.body.innerText : '';
  return {
    url: location.href,
    title: document.title,
    hasComposer: !!composer,
    composerText: composer ? composer.innerText : '',
    generating: stopping || body.indexOf('正在生成') >= 0 || body.indexOf('生成中') >= 0,
    candidates: Object.keys(byKey).map(function (k) { return byKey[k]; }),
    tail: body.slice(-900),
  };
};

export async function getState(cdp) {
  return cdp.call(stateFn.toString(), {});
}

export async function attach(cfg) {
  const port = cfg.port || DEFAULT_PORT;
  const cdp = await Cdp.attach(port);
  return cdp;
}

const newChatFn = function () {
  const btns = Array.from(document.querySelectorAll('button'));
  for (let i = 0; i < btns.length; i++) {
    const b = btns[i];
    const t = (b.innerText || '').trim();
    const a = b.getAttribute('aria-label') || '';
    if ((t.indexOf('新对话') === 0 || a === '新对话') && b.offsetParent !== null) {
      b.click();
      return 'clicked';
    }
  }
  return 'not-found';
};

export async function ensureFreshChat(cdp, { force = true } = {}) {
  const state = await getState(cdp);
  const onHome = /doubao-chat\/chat(\?|$)/.test(state.url);
  if (onHome && !force) return state;
  if (!onHome) {
    const r = await cdp.call(newChatFn.toString(), {});
    if (r === 'not-found') {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75, modifiers: 10 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75, modifiers: 10 });
    }
    await sleep(1800);
  }
  const after = await getState(cdp);
  after.newChat = /doubao-chat\/chat(\?|$)/.test(after.url);
  return after;
}

const focusFn = function () {
  const el = document.querySelector('[contenteditable="true"]');
  if (!el) return false;
  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
};

export async function sendPrompt(cdp, text) {
  const ok = await cdp.call(focusFn.toString(), {});
  if (!ok) throw new Error('composer not found');
  await sleep(300);
  await cdp.send('Input.insertText', { text: text });
  await sleep(500);
  const typed = await cdp.eval('document.querySelector(\'[contenteditable="true"]\').innerText');
  if (!typed || !typed.trim()) throw new Error('failed to type prompt into composer');
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  return typed;
}

const downloadFn = function (urls) {
  return (async function () {
    const out = [];
    for (const u of urls) {
      const r = await fetch(u, { credentials: 'include' });
      const ab = await r.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      }
      out.push({ url: u, b64: btoa(bin), type: r.headers.get('content-type'), status: r.status });
    }
    return out;
  })();
};

export function extFor(contentType) {
  if (!contentType) return 'png';
  if (contentType.indexOf('jpeg') >= 0 || contentType.indexOf('jpg') >= 0) return 'jpg';
  if (contentType.indexOf('webp') >= 0) return 'webp';
  return 'png';
}

// Doubao's CDN labels everything image/png even when the payload is JPEG.
// Trust the magic bytes so downstream tools do not open a .png that is really a JPEG.
export function sniffExt(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export async function downloadAll(cdp, candidates, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const urls = candidates.map((c) => c.url);
  const files = await cdp.call(downloadFn.toString(), urls);
  const saved = [];
  files.forEach((f, i) => {
    const buf = Buffer.from(f.b64, 'base64');
    const ext = sniffExt(buf) || extFor(f.type);
    const p = path.join(dir, 'cand-' + (i + 1) + '.' + ext);
    fs.writeFileSync(p, buf);
    saved.push({ index: i + 1, path: p, bytes: buf.length, type: f.type, format: ext, source: f.url });
  });
  return saved;
}

export { Cdp, DEFAULT_PORT };
