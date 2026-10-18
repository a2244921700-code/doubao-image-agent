// CLI front-end for the Doubao image agent.
// Every command prints a single JSON object so an orchestrating agent can parse it.
import fs from 'node:fs';
import path from 'node:path';
import {
  loadConfig, ensureApp, attach, getState, ensureFreshChat, sendPrompt,
  downloadAll, sleep, probe,
} from './lib/doubao.mjs';
import { CATEGORIES, CATEGORY_MAP, suggestCategory, composePrompt, checkRatio, pixelSize } from './lib/ratios.mjs';

// Decide the canvas before generating. Doubao defaults to 1:1 when the prompt is
// silent, which wastes the frame for anything that is not square.
function decideRatio(rawPrompt, categoryArg, ratioArg) {
  if (ratioArg) return { ratio: ratioArg, source: 'cli', category: categoryArg || null };
  const explicit = rawPrompt.match(/(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)/);
  if (explicit) return { ratio: explicit[1] + ':' + explicit[2], source: 'prompt', category: categoryArg || null };
  const hit = categoryArg ? CATEGORY_MAP[categoryArg] : suggestCategory(rawPrompt);
  if (hit) return { ratio: hit.ratio, source: categoryArg ? 'category' : 'auto-category', category: hit.id };
  return { ratio: '1:1', source: 'fallback-1x1', category: null };
}

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
function flag(name) { return process.argv.includes('--' + name); }

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function slugify(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'untitled';
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

const cmd = process.argv[2];
const cfg = loadConfig();

try {
  if (cmd === 'ratios') {
    out({
      ok: true,
      note: '按用途选比例，不要凭感觉；提示词里必须带上比例。',
      categories: CATEGORIES.map((c) => ({
        id: c.id, label: c.label, ratio: c.ratio, pixels: pixelSize(c.ratio, 2048), comp: c.comp,
      })),
    });
  } else if (cmd === 'health') {
    const v = await probe(cfg.port);
    if (!v) { out({ ok: false, reason: 'debug port closed', port: cfg.port }); process.exit(0); }
    const cdp = await attach(cfg);
    const s = await getState(cdp);
    cdp.close();
    out({ ok: true, browser: v.Browser, port: cfg.port, url: s.url, hasComposer: s.hasComposer, generating: s.generating, knownCandidates: s.candidates.length });
  } else if (cmd === 'launch') {
    const r = await ensureApp(cfg.port, cfg.exe);
    out({ ok: true, ...r });
  } else if (cmd === 'status') {
    const cdp = await attach(cfg);
    const s = await getState(cdp);
    cdp.close();
    out({ ok: true, url: s.url, generating: s.generating, hasComposer: s.hasComposer, candidates: s.candidates.length, tail: s.tail.slice(-400) });
  } else if (cmd === 'open') {
    const conv = arg('conversation');
    if (!conv) { out({ ok: false, error: 'missing --conversation <id|url>' }); process.exit(2); }
    const url = /^(https?|chrome|doubao):/.test(conv) ? conv : 'chrome://doubao-chat/chat/' + conv;
    const cdp = await attach(cfg);
    await cdp.send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 2500));
    const s = await getState(cdp);
    cdp.close();
    out({ ok: true, requested: url, url: s.url, hasComposer: s.hasComposer, candidates: s.candidates.length });
  } else if (cmd === 'new-chat') {
    const cdp = await attach(cfg);
    const s = await ensureFreshChat(cdp, { force: true });
    cdp.close();
    out({ ok: true, url: s.url, hasComposer: s.hasComposer });
  } else if (cmd === 'gen') {
    const promptFile = arg('prompt-file');
    const promptArg = arg('prompt');
    const prompt = promptFile ? fs.readFileSync(promptFile, 'utf8').trim() : (promptArg || '');
    if (!prompt) { out({ ok: false, error: 'no prompt (use --prompt-file or --prompt)' }); process.exit(2); }

    // 比例必须在出图前定死：豆包对没有任何比例线索的提示词一律回 1:1。
    const decision = decideRatio(prompt, arg('category'), arg('ratio'));
    const finalPrompt = decision.source === 'prompt'
      ? prompt
      : composePrompt({
          subject: prompt,
          category: decision.category,
          ratio: decision.ratio,
          allowText: flag('allow-text'),
        });

    const expect = Number(arg('expect', cfg.expectCount || 3));
    const timeoutSec = Number(arg('timeout', cfg.generationTimeoutSec || 300));
    const reuse = flag('reuse');
    const stageRoot = arg('stage', cfg.stageDir);
    const title = arg('title', 'untitled');
    const stageDir = path.join(stageRoot, Date.now() + '-' + slugify(title));

    const app = await ensureApp(cfg.port, cfg.exe);
    const cdp = await attach(cfg);

    // After a cold launch the renderer needs a few seconds before the composer exists.
    let readyState = null;
    for (let i = 0; i < 30; i++) {
      readyState = await getState(cdp);
      if (readyState.hasComposer && readyState.url.indexOf('doubao-chat') >= 0) break;
      await sleep(1000);
    }
    if (!readyState || !readyState.hasComposer) throw new Error('Doubao UI not ready: composer missing (url=' + (readyState ? readyState.url : '?') + ')');

    if (!reuse) await ensureFreshChat(cdp, { force: true });
    // Baseline must be taken *inside* the target conversation, otherwise images
    // restored from a previous chat can be mistaken for this round's output.
    const before = await getState(cdp);
    const baseline = new Set(before.candidates.map((c) => c.key));

    await sendPrompt(cdp, finalPrompt);

    const started = Date.now();
    let lastCount = -1;
    let lastChange = Date.now();
    let fresh = [];
    let timedOut = false;

    while (true) {
      await sleep(1500);
      const s = await getState(cdp);
      fresh = s.candidates.filter((c) => !baseline.has(c.key));
      if (fresh.length !== lastCount) { lastCount = fresh.length; lastChange = Date.now(); }
      const stableMs = Date.now() - lastChange;

      // Full set arrived and nothing changed for a while -> done.
      if (fresh.length >= expect && stableMs > 4000 && !s.generating) break;
      // Generation ended with fewer images than expected; do not hang until timeout.
      if (fresh.length >= 1 && stableMs > 12000 && !s.generating) break;
      if (Date.now() - started > timeoutSec * 1000) { timedOut = true; break; }
    }

    const finalState = await getState(cdp);
    let saved = [];
    if (fresh.length > 0) saved = await downloadAll(cdp, fresh, stageDir);
    cdp.close();

    // Verify Doubao actually honoured the requested canvas.
    saved = saved.map((s, i) => {
      const src = fresh[i] || {};
      const chk = checkRatio(src.w || 0, src.h || 0, decision.ratio);
      return { ...s, width: src.w || null, height: src.h || null, ratioCheck: chk };
    });
    const ratioOk = saved.length > 0 && saved.every((s) => s.ratioCheck.ok);

    const manifest = {
      ok: fresh.length >= 1,
      partial: fresh.length < expect,
      timedOut,
      prompt: finalPrompt,
      brief: prompt,
      ratio: decision.ratio,
      ratioSource: decision.source,
      ratioOk,
      category: decision.category,
      categoryLabel: decision.category && CATEGORY_MAP[decision.category] ? CATEGORY_MAP[decision.category].label : null,
      expectedPixels: pixelSize(decision.ratio, 2048),
      title,
      conversationUrl: finalState.url,
      stageDir,
      count: saved.length,
      candidates: saved,
      elapsedSec: Math.round((Date.now() - started) / 1000),
      launchedApp: app.launched,
      tail: finalState.tail.slice(-500),
    };
    if (saved.length > 0) fs.writeFileSync(path.join(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    out(manifest);
    if (!manifest.ok) process.exit(1);
  } else if (cmd === 'pick') {
    const stageDir = arg('stage');
    const pickArg = arg('pick', '1');
    const title = arg('title', 'untitled');
    const project = arg('project', '');
    const outDir = arg('out', cfg.outputDir);
    const nameTpl = arg('name', cfg.naming || '{date}_{slug}_{seq}');
    if (!stageDir) { out({ ok: false, error: 'missing --stage' }); process.exit(2); }
    const manifest = JSON.parse(fs.readFileSync(path.join(stageDir, 'manifest.json'), 'utf8'));
    const picks = pickArg === 'all' ? manifest.candidates : manifest.candidates.filter((c) => String(c.index) === String(pickArg));
    if (!picks.length) { out({ ok: false, error: 'candidate index not found', available: manifest.candidates.map((c) => c.index) }); process.exit(2); }

    fs.mkdirSync(outDir, { recursive: true });
    const date = stamp(new Date());
    const slug = slugify(title);
    const savedFiles = [];
    picks.forEach((c, i) => {
      const seq = String(c.index).padStart(2, '0');
      let base = nameTpl
        .replace(/\{date\}/g, date)
        .replace(/\{slug\}/g, slug)
        .replace(/\{project\}/g, slugify(project))
        .replace(/\{seq\}/g, seq)
        .replace(/\{i\}/g, String(i + 1));
      base = slugify(base).replace(/-{2,}/g, '-');
      let dest = path.join(outDir, base + path.extname(c.path));
      let n = 1;
      while (fs.existsSync(dest)) { dest = path.join(outDir, base + '-' + n + path.extname(c.path)); n++; }
      fs.copyFileSync(c.path, dest);
      const sidecar = {
        file: path.basename(dest),
        title,
        project,
        ratio: manifest.ratio,
        ratioSource: manifest.ratioSource,
        width: c.width || null,
        height: c.height || null,
        prompt: manifest.prompt,
        candidateIndex: c.index,
        sourceUrl: c.source,
        generatedAt: new Date().toISOString(),
        conversationUrl: manifest.conversationUrl,
        watermark: '豆包AI生成 (baked into the image by Doubao)',
      };
      fs.writeFileSync(dest.replace(/\.[^.]+$/, '') + '.json', JSON.stringify(sidecar, null, 2));
      savedFiles.push({ file: dest, bytes: c.bytes });
    });
    out({ ok: true, saved: savedFiles, outDir });
  } else {
    out({ ok: false, error: 'unknown command', commands: ['health', 'launch', 'status', 'new-chat', 'gen', 'pick'] });
    process.exit(2);
  }
} catch (e) {
  out({ ok: false, error: String(e && e.message ? e.message : e) });
  process.exit(1);
}
process.exit(0);
