'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fsp = require('fs/promises');
const fs = require('fs');
const { execFile } = require('child_process');
const voice = require('./voice');

const BIN_DIR = path.join(__dirname, 'bin');
const DEFAULT_SEARCH_BIN = path.join(BIN_DIR, 'aggrsearch');

app.setName('LearnCanvas');

let win = null;
const controllers = new Map();

function statePath() {
  return path.join(app.getPath('userData'), 'state.json');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#f4f2ee',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 允许页面使用麦克风（按住空格说话）
  try {
    win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'media' || permission === 'audioCapture');
    });
    win.webContents.session.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'audioCapture');
  } catch (_) {}
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log('[renderer]', message, line ? `(${sourceId}:${line})` : '');
  });
  win.webContents.on('render-process-gone', (_e, details) => console.log('[renderer-gone]', details));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // Agent 默认工作目录
  try { fs.mkdirSync(path.join(require('os').homedir(), 'LearnCanvas'), { recursive: true }); } catch (_) {}
  voice.setModelsRoot(path.join(app.getPath('userData'), 'models'));
  createWindow();
  setTimeout(() => voice.warmup(), 2500);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------------------------------------------------------- state ---- */

ipcMain.handle('state:load', async () => {
  try {
    return JSON.parse(await fsp.readFile(statePath(), 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.handle('state:save', async (_e, data) => {
  try {
    await fsp.mkdir(path.dirname(statePath()), { recursive: true });
    await fsp.writeFile(statePath(), JSON.stringify(data), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('io:export-json', async (_e, { defaultName, text }) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: defaultName || 'learncanvas-session.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    await fsp.writeFile(r.filePath, String(text || ''), 'utf8');
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('io:import-json', async () => {
  const r = await dialog.showOpenDialog(win, {
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  try {
    return { ok: true, text: await fsp.readFile(r.filePaths[0], 'utf8') };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('open-external', async (_e, url) => {
  if (/^https?:/i.test(url)) await shell.openExternal(url);
  return true;
});

/* ----------------------------------------------------------------- voice --- */

ipcMain.handle('voice:status', async () => voice.status());

ipcMain.handle('voice:download', async (event) => {
  try {
    const st = await voice.downloadModels((p) => {
      if (!event.sender.isDestroyed()) event.sender.send('voice:progress', p);
    });
    return { ok: true, status: st };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('voice:asr', async (_e, { samples, sampleRate }) => {
  try {
    return await voice.transcribe(samples, sampleRate);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('voice:tts', async (_e, { text, speed, engine, voice: voiceName }) => {
  try {
    return await voice.synthesize(text, speed, engine, voiceName);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('voice:voices', async () => {
  try { return await voice.listVoices(); } catch (_) { return []; }
});

/* ------------------------------------------------------------------ ai ----- */

function chatUrl(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) u = 'https://api.deepseek.com/v1';
  if (/\/(chat\/completions|responses)$/.test(u) || /\/completions$/.test(u)) return u;
  return u + '/chat/completions';
}

ipcMain.handle('ai:chat', async (event, payload) => {
  const { requestId, messages, settings } = payload || {};
  const ctrl = new AbortController();
  controllers.set(requestId, ctrl);

  const send = (kind, text) => {
    if (event.sender.isDestroyed()) return;
    event.sender.send('ai:token', { requestId, kind, text });
  };

  try {
    const body = {
      model: settings.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: typeof settings.temperature === 'number' ? settings.temperature : 0.6,
    };

    // 思考强度：off → 关闭思考；low/medium/high → reasoning_effort（DeepSeek 兼容接口）
    const thinking = ['off', 'low', 'medium', 'high'].includes(settings.thinking) ? settings.thinking : 'medium';
    if (/deepseek/i.test(settings.baseUrl || '') || /deepseek/i.test(settings.model || '')) {
      if (thinking === 'off') body.thinking = { type: 'disabled' };
      else {
        body.thinking = { type: 'enabled' };
        body.reasoning_effort = thinking;
      }
    } else if (thinking !== 'off') {
      body.reasoning_effort = thinking;
    }
    const res = await fetch(chatUrl(settings.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (settings.apiKey || ''),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, error: 'HTTP ' + res.status + ' ' + txt.slice(0, 600) };
    }

    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('application/json')) {
      const j = await res.json();
      const msg = j.choices && j.choices[0] && j.choices[0].message;
      const text = (msg && (msg.content || '')) || '';
      if (text) send('content', text);
      return { ok: true, text, usage: j.usage || null };
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let full = '';
    let reasoning = '';
    let usage = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        const d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
        if (j.usage) usage = j.usage;
        if (d.reasoning_content) { reasoning += d.reasoning_content; send('reasoning', d.reasoning_content); }
        if (d.content) { full += d.content; send('content', d.content); }
      }
    }
    return { ok: true, text: full, reasoning, usage };
  } catch (err) {
    if (ctrl.signal.aborted) return { ok: false, aborted: true, error: '已中止' };
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    controllers.delete(requestId);
  }
});

ipcMain.handle('ai:abort', async (_e, requestId) => {
  const c = controllers.get(requestId);
  if (c) c.abort();
  return true;
});

/* ---------------------------------------------------------------- tools ---- */

const OUT_LIMIT = 14000;

function clamp(t, n = OUT_LIMIT) {
  t = String(t == null ? '' : t);
  return t.length > n ? t.slice(0, n) + `\n…（已截断，共 ${t.length} 字符）` : t;
}

function resolveP(workdir, p) {
  const base = workdir || process.env.HOME || '/';
  if (!p) return base;
  let s = String(p).replace(/^~(?=$|\/)/, process.env.HOME || '~');
  return path.isAbsolute(s) ? s : path.resolve(base, s);
}

function runSearchBin(bin, args, timeout = 45000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error((err && err.message) || '执行失败') + (stderr ? '\n' + stderr.slice(0, 400) : ''));
      resolve(stdout || '');
    });
  });
}

async function walkFiles(root, maxFiles = 4000) {
  const out = [];
  async function rec(dir, depth) {
    if (out.length >= maxFiles || depth > 8) return;
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= maxFiles) return;
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'target') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await rec(full, depth + 1);
      else out.push(full);
    }
  }
  await rec(root, 0);
  return out;
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$', 'i');
}

async function runTool(_event, { name, input, workdir }) {
  const inp = input || {};
  try {
    switch (name) {
      case 'read_file': {
        const p = resolveP(workdir, inp.path);
        const stat = await fsp.stat(p);
        if (stat.isDirectory()) return { ok: false, output: `错误：${p} 是目录，请用 list_dir` };
        const text = await fsp.readFile(p, 'utf8');
        const lines = text.split('\n');
        const offset = Math.max(1, Number(inp.offset) || 1);
        const limit = Math.min(2000, Number(inp.limit) || 400);
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const numbered = slice.map((l, i) => String(offset + i).padStart(5) + '| ' + l).join('\n');
        return {
          ok: true,
          output: `${p}（共 ${lines.length} 行，显示 ${offset}-${offset + slice.length - 1}）\n` + numbered,
        };
      }
      case 'write_file': {
        const p = resolveP(workdir, inp.path);
        await fsp.mkdir(path.dirname(p), { recursive: true });
        await fsp.writeFile(p, String(inp.content == null ? '' : inp.content), 'utf8');
        const n = String(inp.content || '').split('\n').length;
        return { ok: true, output: `已写入 ${p}（${n} 行）` };
      }
      case 'edit_file': {
        const p = resolveP(workdir, inp.path);
        const oldS = String(inp.old_string == null ? '' : inp.old_string);
        const newS = String(inp.new_string == null ? '' : inp.new_string);
        if (!oldS) return { ok: false, output: '错误：old_string 不能为空' };
        let text = await fsp.readFile(p, 'utf8');
        const count = text.split(oldS).length - 1;
        if (count === 0) return { ok: false, output: `错误：在 ${p} 中未找到 old_string` };
        if (count > 1 && !inp.replace_all) return { ok: false, output: `错误：old_string 匹配 ${count} 处，请提供更长的唯一样本或设置 replace_all:true` };
        text = inp.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, newS);
        await fsp.writeFile(p, text, 'utf8');
        return { ok: true, output: `已更新 ${p}（替换 ${inp.replace_all ? count : 1} 处）` };
      }
      case 'list_dir': {
        const p = resolveP(workdir, inp.path || '.');
        const ents = await fsp.readdir(p, { withFileTypes: true });
        const lines = ents.slice(0, 400).map((e) => (e.isDirectory() ? '[dir]  ' : '[file] ') + e.name);
        return { ok: true, output: `${p}\n` + (lines.join('\n') || '(空)') };
      }
      case 'glob': {
        const root = resolveP(workdir, inp.path || '.');
        const re = globToRegExp(inp.pattern || '*');
        const files = await walkFiles(root);
        const hit = files.filter((f) => re.test(path.relative(root, f).split(path.sep).join('/')) || re.test(path.basename(f)));
        return { ok: true, output: hit.slice(0, 200).join('\n') || '(无匹配)' };
      }
      case 'grep': {
        const root = resolveP(workdir, inp.path || '.');
        const pat = new RegExp(inp.pattern || '', 'i');
        const include = inp.include ? globToRegExp(inp.include) : null;
        const files = await walkFiles(root, 3000);
        const out = [];
        for (const f of files) {
          if (out.length >= 80) break;
          if (include && !include.test(path.basename(f))) continue;
          let text;
          try {
            const st = await fsp.stat(f);
            if (st.size > 800 * 1024) continue;
            text = await fsp.readFile(f, 'utf8');
          } catch { continue; }
          if (text.includes('\u0000')) continue;
          const ls = text.split('\n');
          for (let i = 0; i < ls.length && out.length < 80; i++) {
            if (pat.test(ls[i])) out.push(`${path.relative(root, f)}:${i + 1}: ${ls[i].trim().slice(0, 240)}`);
          }
        }
        return { ok: true, output: out.join('\n') || '(无匹配)' };
      }
      case 'move_file': {
        const from = resolveP(workdir, inp.from);
        const to = resolveP(workdir, inp.to);
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.rename(from, to);
        return { ok: true, output: `已移动 ${from} → ${to}` };
      }
      case 'delete_file': {
        const p = resolveP(workdir, inp.path);
        await fsp.rm(p, { recursive: true, force: true });
        return { ok: true, output: `已删除 ${p}` };
      }
      case 'run_command': {
        const cwd = resolveP(workdir, inp.cwd || '.');
        const timeout = Math.min(Number(inp.timeout_ms) || 30000, 180000);
        const out = await new Promise((resolve) => {
          execFile('/bin/zsh', ['-lc', String(inp.command || '')], { cwd, timeout, maxBuffer: 4 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
            const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
            resolve(
              `$ ${inp.command}\n(exit ${code})\n` +
              (stdout ? `--- stdout ---\n${stdout}` : '') +
              (stderr ? `\n--- stderr ---\n${stderr}` : '') +
              (err && err.killed ? '\n(超时被终止)' : '')
            );
          });
        });
        return { ok: true, output: clamp(out) };
      }
      case 'web_search': {
        const bin = inp.bin || DEFAULT_SEARCH_BIN;
        if (!fs.existsSync(bin)) return { ok: false, output: `错误：未找到 aggrsearch 可执行文件（${bin}）` };
        const max = Math.min(Math.max(Number(inp.max) || 6, 1), 20);
        const raw = await runSearchBin(bin, ['search', String(inp.query || ''), '--max', String(max), '--json']);
        let j;
        try { j = JSON.parse(raw); } catch { return { ok: false, output: '搜索输出解析失败：' + clamp(raw, 800) }; }
        const results = (j.results || []).slice(0, max);
        const text = results.map((r, i) => `${i + 1}. ${r.title || '(无标题)'}\n   ${r.url}\n   ${(r.snippet || r.content || '').replace(/\s+/g, ' ').slice(0, 260)}`).join('\n');
        return { ok: true, output: `查询：${inp.query}\n` + (text || '(无结果)') };
      }
      case 'web_fetch': {
        const bin = inp.bin || DEFAULT_SEARCH_BIN;
        if (!fs.existsSync(bin)) return { ok: false, output: `错误：未找到 aggrsearch 可执行文件（${bin}）` };
        const raw = await runSearchBin(bin, ['fetch', String(inp.url || ''), '--json']);
        let j;
        try { j = JSON.parse(raw); } catch { return { ok: false, output: clamp(raw) }; }
        if (j.error) return { ok: false, output: '抓取失败：' + j.error };
        return { ok: true, output: `${inp.url}\n\n${clamp(j.body || '', 9000)}` };
      }
      default:
        return { ok: false, output: `未知工具：${name}` };
    }
  } catch (err) {
    return { ok: false, output: `工具执行失败：${(err && err.message) || err}` };
  }
}

ipcMain.handle('tool:run', runTool);
