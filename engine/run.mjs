// 交互式入口：双击 run.cmd 即可使用，不需要记命令。
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, CATEGORY_MAP, suggestCategory, composePrompt, pixelSize } from './lib/ratios.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const say = (s = '') => output.write(s + '\n');

// When stdin is a pipe (scripted run) read everything up front: a fast-closing
// pipe makes readline emit 'close' before the first question is asked.
let rl = null;
let queue = null;
if (input.isTTY) {
  rl = readline.createInterface({ input, output });
} else {
  const chunks = [];
  for await (const chunk of input) chunks.push(chunk);
  queue = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
}

const ask = async (q, def = '') => {
  if (queue) {
    const raw = queue.length ? queue.shift() : '';
    output.write(q + raw + '\n');
    return raw.trim() || def;
  }
  const a = (await rl.question(q)).trim();
  return a || def;
};

function runAgent(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, 'agent.mjs'), ...args], { cwd: HERE });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => {
      let json = null;
      const i = out.indexOf('{');
      if (i >= 0) {
        try { json = JSON.parse(out.slice(i)); } catch { /* keep null */ }
      }
      resolve({ code, json, out, err });
    });
  });
}

function showCandidates(m) {
  say('');
  say('  完成：' + m.count + ' 张   比例 ' + m.ratio + '（' + m.ratioSource + '）   比例校验 ' + (m.ratioOk ? '通过' : '未通过'));
  if (!m.ratioOk) say('  注意：豆包没有完全按比例出图，建议重做或改比例。');
  for (const c of m.candidates) {
    const px = (c.width || '?') + 'x' + (c.height || '?');
    say('   ' + c.index + ') ' + px + '  ' + Math.round(c.bytes / 1024) + 'KB  ' + path.basename(c.path));
  }
  say('   图片目录：' + m.stageDir);
}

async function generate(promptFile, title, category, ratio, reuse) {
  const args = ['gen', '--prompt-file', promptFile, '--title', title];
  if (category) args.push('--category', category);
  if (ratio) args.push('--ratio', ratio);
  if (reuse) args.push('--reuse');
  say('');
  say('  生成中…（通常 30-60 秒，请不要关闭豆包窗口）');
  return runAgent(args);
}

async function main() {
  say('==============================================');
  say('  豆包生图 agent   ·   本机桌面版驱动');
  say('==============================================');

  const health = await runAgent(['health']);
  if (!health.json || !health.json.ok) {
    say('');
    say('  豆包调试端口没开，正在自动启动（会重启豆包客户端）…');
    const launch = await runAgent(['launch']);
    if (!launch.json || !launch.json.ok) {
      say('  启动失败：' + ((launch.json && launch.json.error) || launch.err || '').slice(0, 300));
      if (rl) rl.close();
      return;
    }
    say('  已启动。');
  }

  while (true) {
    say('');
    const brief = await ask('描述你要的图（中文即可，直接回车退出）：');
    if (!brief) break;

    say('');
    say('用途决定画幅比例，选一个（直接回车 = 让我按关键词判断）：');
    CATEGORIES.forEach((c, i) => {
      const px = pixelSize(c.ratio, 2048).join('x');
      say('  ' + String(i + 1).padStart(2) + ') ' + c.label.padEnd(26, ' ') + ' ' + c.ratio.padStart(7) + '  ' + px);
    });
    say('   0) 我自己指定比例');

    let category = null;
    let ratio = null;
    const sel = await ask('编号：');
    if (sel === '0') {
      ratio = await ask('输入比例，例如 16:9 / 3:1 / 4:5：', '1:1');
    } else if (sel) {
      const idx = parseInt(sel, 10) - 1;
      if (CATEGORIES[idx]) category = CATEGORIES[idx].id;
      else say('  编号无效，改为自动判断。');
    }

    if (!category && !ratio) {
      const auto = suggestCategory(brief);
      if (auto) {
        category = auto.id;
        say('  自动判断用途：' + auto.label + '  ->  ' + auto.ratio);
      } else {
        say('  认不出用途，先按 1:1 出图（想要别的比例可以点 0 指定）。');
        ratio = '1:1';
      }
    }

    const catObj = category ? CATEGORY_MAP[category] : null;
    const shownRatio = ratio || (catObj ? catObj.ratio : '1:1');
    const preview = composePrompt({ subject: brief, category, ratio: shownRatio });
    say('');
    say('将要发送的提示词：');
    say('  ' + preview);
    const go = await ask('回车开始生成，输入 n 返回：');
    if (go.toLowerCase() === 'n') continue;

    const tmp = path.join(os.tmpdir(), 'doubao-brief-' + Date.now() + '.txt');
    fs.writeFileSync(tmp, brief, 'utf8');
    const titleSlug = 'manual-' + Date.now();
    let res = await generate(tmp, titleSlug, category, ratio, false);
    if (!res.json || !res.json.ok) {
      say('  生成失败：' + String((res.json && res.json.error) || res.err || res.out).slice(0, 300));
      continue;
    }
    let manifest = res.json;
    showCandidates(manifest);

    // 打回重做循环
    for (let round = 0; round < 3; round++) {
      const pick = await ask('保留哪张？（1/2/3/all，回车=第 1 张，n=不满意重做）：', '1');
      if (pick.toLowerCase() !== 'n') {
        const title = await ask('文件名标题（中文即可）：', '未命名');
        const pr = await runAgent(['pick', '--stage', manifest.stageDir, '--pick', pick, '--title', title]);
        if (pr.json && pr.json.ok) {
          say('');
          say('  已归档：');
          for (const f of pr.json.saved) say('    ' + f.file);
          say('  目录：' + pr.json.outDir);
        } else {
          say('  归档失败：' + String((pr.json && pr.json.error) || pr.err).slice(0, 300));
        }
        break;
      }

      const fb = await ask('哪里不满意？写具体要改的点：');
      if (!fb) break;
      const fbFile = path.join(os.tmpdir(), 'doubao-feedback-' + Date.now() + '.txt');
      fs.writeFileSync(fbFile, fb, 'utf8');
      res = await generate(fbFile, titleSlug, category, ratio, true);
      if (!res.json || !res.json.ok) { say('  重做失败：' + String(res.err).slice(0, 200)); break; }
      manifest = res.json;
      showCandidates(manifest);
      if (round === 2) {
        say('  连续 3 轮不满意，建议换个描述方式重来。');
      }
    }
  }

  say('');
  say('  已退出。');
  if (rl) rl.close();
}

main().catch((e) => {
  say('出错了：' + (e && e.message ? e.message : String(e)));
  try { if (rl) rl.close(); } catch {}
  process.exit(1);
});
