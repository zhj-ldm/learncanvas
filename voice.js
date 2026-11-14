'use strict';

/* 主进程语音服务：模型管理 + 推理 worker 调度 + 系统语音兜底。 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { generateSecMsGec } = require('./edge-drm');

const ASR_REPO = 'csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09';
const TTS_REPO = 'csukuangfj/vits-melo-tts-zh_en';
const KOKORO_REPO = 'csukuangfj/kokoro-int8-multi-lang-v1_1';
const MIRROR = 'https://hf-mirror.com';

const ASR_FILES = ['model.int8.onnx', 'tokens.txt'];
const TTS_FILES = [
  'model.int8.onnx',
  'tokens.txt',
  'lexicon.txt',
  'date.fst',
  'number.fst',
  'phone.fst',
  'new_heteronym.fst',
  'dict/hmm_model.utf8',
  'dict/idf.utf8',
  'dict/jieba.dict.utf8',
  'dict/stop_words.utf8',
  'dict/user.dict.utf8',
  'dict/pos_dict/char_state_tab.utf8',
  'dict/pos_dict/prob_emit.utf8',
  'dict/pos_dict/prob_start.utf8',
  'dict/pos_dict/prob_trans.utf8',
];
const KOKORO_FILES = [
  'model.int8.onnx',
  'tokens.txt',
  'voices.bin',
  'lexicon-us-en.txt',
  'lexicon-gb-en.txt',
  'lexicon-zh.txt',
  'date-zh.fst',
  'number-zh.fst',
  'phone-zh.fst',
];

// Kokoro v1.1 的中文音色（sid 见 sherpa-onnx 官方映射）
const KOKORO_VOICES = [
  { name: 'zf_xiaobei', label: '晓北', sid: 45, locale: 'zh-CN', sample: '女声 · 东北' },
  { name: 'zf_xiaoni', label: '晓妮', sid: 46, locale: 'zh-CN', sample: '女声 · 陕西' },
  { name: 'zf_xiaoxiao', label: '晓晓', sid: 47, locale: 'zh-CN', sample: '女声 · 温柔' },
  { name: 'zf_xiaoyi', label: '晓伊', sid: 48, locale: 'zh-CN', sample: '女声 · 活泼' },
  { name: 'zm_yunjian', label: '云健', sid: 49, locale: 'zh-CN', sample: '男声 · 沉稳' },
  { name: 'zm_yunxi', label: '云希', sid: 50, locale: 'zh-CN', sample: '男声 · 清朗' },
  { name: 'zm_yunxia', label: '云夏', sid: 51, locale: 'zh-CN', sample: '男声 · 少年' },
  { name: 'zm_yunyang', label: '云扬', sid: 52, locale: 'zh-CN', sample: '男声 · 播音' },
];

let modelsRoot = '';

function setModelsRoot(dir) {
  modelsRoot = dir;
}

function asrDir() { return path.join(modelsRoot, 'asr-paraformer'); }
function ttsDir() { return path.join(modelsRoot, 'tts-melo'); }
function kokoroDir() { return path.join(modelsRoot, 'kokoro-int8-v1_1'); }

function hasFiles(dir, files) {
  try {
    return files.every((f) => {
      const st = fs.statSync(path.join(dir, f));
      return st.size > 0;
    });
  } catch {
    return false;
  }
}

function status() {
  return {
    asrReady: hasFiles(asrDir(), ASR_FILES),
    ttsReady: hasFiles(ttsDir(), TTS_FILES),
    kokoroReady: hasFiles(kokoroDir(), KOKORO_FILES),
    modelsRoot,
  };
}

/* ------------------------------------------------------------ download --- */

async function downloadFile(url, dest, onChunk) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  const total = Number(res.headers.get('content-length')) || 0;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const fh = await fsp.open(tmp, 'w');
  let got = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await fh.write(Buffer.from(value));
      got += value.length;
      if (onChunk) onChunk(got, total);
    }
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, dest);
}

async function downloadModels(onProgress) {
  const jobs = [];
  for (const f of ASR_FILES) {
    jobs.push({ url: `${MIRROR}/${ASR_REPO}/resolve/main/${f}`, dest: path.join(asrDir(), f) });
  }
  for (const f of TTS_FILES) {
    jobs.push({ url: `${MIRROR}/${TTS_REPO}/resolve/main/${f}`, dest: path.join(ttsDir(), f) });
  }
  for (const f of KOKORO_FILES) {
    jobs.push({ url: `${MIRROR}/${KOKORO_REPO}/resolve/main/${f}`, dest: path.join(kokoroDir(), f) });
  }
  const total = jobs.length;
  for (let i = 0; i < total; i++) {
    const j = jobs[i];
    if (fs.existsSync(j.dest) && fs.statSync(j.dest).size > 0) {
      if (onProgress) onProgress({ index: i, total, file: path.basename(j.dest), done: true });
      continue;
    }
    if (onProgress) onProgress({ index: i, total, file: path.basename(j.dest), started: true });
    await downloadFile(j.url, j.dest, (got, len) => {
      if (onProgress) onProgress({ index: i, total, file: path.basename(j.dest), got, len });
    });
  }
  if (onProgress) onProgress({ index: total, total, finished: true });
  return status();
}

/* ------------------------------------------------------------- inference --- */

let sherpa = null;
let asr = null;

function needSherpa() {
  if (!sherpa) sherpa = require('sherpa-onnx-node');
  return sherpa;
}

function initAsr() {
  if (asr) return asr;
  const s = needSherpa();
  asr = new s.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      paraformer: { model: path.join(asrDir(), 'model.int8.onnx') },
      tokens: path.join(asrDir(), 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  });
  return asr;
}

/* TTS 跑在独立 Node 子进程里：Electron 主进程不允许原生音频 buffer */
const ttsProcs = new Map(); // kind -> { proc, pending }
let ttsSeq = 0;

function findNodeBin() {
  const cands = [
    '/opt/homebrew/bin/node',
    '/opt/homebrew/opt/node@22/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    process.env.LEARNCANVAS_NODE_BIN,
  ];
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

function ensureTtsProc(kind = 'vits') {
  const cur = ttsProcs.get(kind);
  if (cur && cur.proc.connected) return cur;
  const { fork } = require('child_process');
  const nodeBin = findNodeBin();
  const env = { ...process.env };
  if (!nodeBin) env.ELECTRON_RUN_AS_NODE = '1';
  const dir = kind === 'kokoro' ? kokoroDir() : ttsDir();
  const proc = fork(path.join(__dirname, 'voice-tts-server.js'), [dir, kind], {
    execPath: nodeBin || process.execPath,
    env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const pending = new Map();
  const entry = { proc, pending, idleTimer: null };
  const touch = () => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    // 空闲 5 分钟后退出子进程，释放模型占用的内存
    entry.idleTimer = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
    }, 5 * 60 * 1000);
  };
  proc.on('message', (m) => {
    if (!m || m.id == null) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    touch();
    p.resolve(m);
  });
  proc.on('exit', () => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    const cur2 = ttsProcs.get(kind);
    if (cur2 && cur2.proc === proc) ttsProcs.delete(kind);
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('TTS 进程已退出')); }
    pending.clear();
  });
  touch();
  ttsProcs.set(kind, entry);
  return entry;
}

function synthLocal(text, speed, kind = 'vits', sid = 0) {
  return new Promise((resolve, reject) => {
    let entry;
    try { entry = ensureTtsProc(kind); } catch (err) { return reject(err); }
    const id = ++ttsSeq;
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      reject(new Error('语音合成超时'));
    }, 180000);
    entry.pending.set(id, { resolve, reject, timer });
    entry.proc.send({ type: 'tts', id, text, speed, sid });
  });
}

async function transcribe(samples, sampleRate) {
  if (!status().asrReady) return { ok: false, error: 'ASR 模型未安装', needDownload: true };
  try {
    const engine = initAsr();
    const stream = engine.createStream();
    // 逐元素复制，避免 Electron 对「外部内存 buffer」的限制
    const pcm = Float32Array.from(samples || []);
    stream.acceptWaveform({ samples: pcm, sampleRate: sampleRate || 16000 });
    engine.decode(stream);
    const r = engine.getResult(stream);
    return { ok: true, text: (r && r.text) || '' };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((err.message || '') + (stderr ? ' ' + stderr.slice(0, 200) : '')));
      resolve(stdout);
    });
  });
}

/* macOS 系统语音兜底：say → aiff → wav(int16) */
async function systemSay(text, speed, voice) {
  if (process.platform !== 'darwin') {
    return { ok: false, error: '系统语音仅支持 macOS，请使用 Edge 或本地语音引擎' };
  }
  const base = path.join(os.tmpdir(), 'learncanvas-say-' + Date.now());
  const aiff = base + '.aiff';
  const wav = base + '.wav';
  const rate = Math.max(120, Math.min(320, Math.round(180 * (speed || 1))));
  const args = ['-r', String(rate)];
  if (voice) args.push('-v', voice);
  args.push('-o', aiff, text);
  await run('/usr/bin/say', args, 60000);
  await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@22050', aiff, wav], 30000);
  const buf = await fsp.readFile(wav);
  await fsp.rm(aiff, { force: true }).catch(() => {});
  await fsp.rm(wav, { force: true }).catch(() => {});
  const data = buf.subarray(44);
  const samples = new Float32Array(data.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { ok: true, samples, sampleRate: 22050, engine: 'system' };
}

/* ------------------------------------------------------------- edge tts -- */

const EDGE_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_VERSION = '2-143.0.3650.75';
const EDGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const EDGE_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
const EDGE_VOICES = [
  { name: 'zh-CN-XiaoxiaoNeural', label: '晓晓', locale: 'zh-CN', sample: '女声 · 温柔自然' },
  { name: 'zh-CN-XiaoyiNeural', label: '晓伊', locale: 'zh-CN', sample: '女声 · 活泼' },
  { name: 'zh-CN-YunxiNeural', label: '云希', locale: 'zh-CN', sample: '男声 · 清朗' },
  { name: 'zh-CN-YunyangNeural', label: '云扬', locale: 'zh-CN', sample: '男声 · 播音' },
  { name: 'zh-CN-YunjianNeural', label: '云健', locale: 'zh-CN', sample: '男声 · 沉稳' },
  { name: 'zh-CN-XiaochenNeural', label: '晓辰', locale: 'zh-CN', sample: '女声 · 亲切' },
  { name: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北', locale: 'zh-CN', sample: '女声 · 东北' },
  { name: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮', locale: 'zh-CN', sample: '女声 · 陕西' },
];

let edgeWs = null;
let edgeOpening = null;
const edgePending = new Map();
let edgeMuid = '';

function edgeEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function openEdge() {
  if (edgeWs && edgeWs.readyState === 1) return Promise.resolve(edgeWs);
  if (edgeOpening) return edgeOpening;
  edgeOpening = new Promise((resolve, reject) => {
    let WebSocket;
    try { WebSocket = require('ws'); } catch (err) { edgeOpening = null; return reject(err); }
    if (!edgeMuid) edgeMuid = crypto.randomBytes(16).toString('hex').toUpperCase();
    const connId = crypto.randomUUID().replace(/-/g, '');
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TOKEN}`
      + `&ConnectionId=${connId}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${EDGE_VERSION}`;
    let ws;
    try {
      ws = new WebSocket(url, {
        headers: {
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent': EDGE_UA,
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'en-US,en;q=0.9',
          Cookie: 'muid=' + edgeMuid + ';',
        },
      });
    } catch (err) {
      edgeOpening = null;
      return reject(err);
    }
    const timer = setTimeout(() => {
      edgeOpening = null;
      try { ws.terminate(); } catch (_) {}
      reject(new Error('Edge 语音连接超时'));
    }, 12000);
    ws.once('open', () => {
      clearTimeout(timer);
      edgeWs = ws;
      edgeOpening = null;
      const date = new Date().toString();
      ws.send(`X-Timestamp:${date}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } }));
      resolve(ws);
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const s = data.toString();
        const m = s.match(/X-RequestId:([0-9a-fA-F]+)/);
        if (s.includes('Path:turn.end')) {
          const rid = m ? m[1] : '';
          const p = edgePending.get(rid);
          if (p) { edgePending.delete(rid); clearTimeout(p.timer); p.resolve(Buffer.concat(p.chunks)); }
        }
        return;
      }
      const buf = Buffer.from(data);
      const hl = buf.readUInt16BE(0);
      const header = buf.subarray(2, 2 + hl).toString();
      if (!header.includes('Path:audio')) return;
      const rm = header.match(/X-RequestId:([0-9a-fA-F]+)/);
      const p = edgePending.get(rm ? rm[1] : '');
      if (p) p.chunks.push(buf.subarray(2 + hl));
    });
    const cleanup = (err) => {
      if (edgeWs === ws) edgeWs = null;
      edgeOpening = null;
      for (const [, p] of edgePending) { clearTimeout(p.timer); p.reject(err || new Error('Edge 语音连接已断开')); }
      edgePending.clear();
    };
    ws.on('close', () => cleanup());
    ws.on('error', (e) => cleanup(e));
  });
  return edgeOpening;
}

function edgeSynthesize(text, speed, voice) {
  const t = String(text || '').trim();
  if (!t) return Promise.reject(new Error('没有可朗读的文本'));
  return openEdge().then((ws) => new Promise((resolve, reject) => {
    const reqId = crypto.randomUUID().replace(/-/g, '');
    const rate = Math.round(((speed || 1) - 1) * 100);
    const v = (voice && /^zh-CN-[A-Za-z]+Neural$/.test(voice)) ? voice : EDGE_DEFAULT_VOICE;
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>`
      + `<voice name='${v}'><prosody rate='${rate >= 0 ? '+' : ''}${rate}%' pitch='+0Hz'>${edgeEscape(t)}</prosody></voice></speak>`;
    const timer = setTimeout(() => {
      edgePending.delete(reqId);
      reject(new Error('Edge 语音合成超时'));
    }, 20000);
    edgePending.set(reqId, { resolve, reject, timer, chunks: [] });
    ws.send(`X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toString()}\r\nPath:ssml\r\n\r\n${ssml}`);
  })).then((buf) => {
    if (!buf || !buf.length) throw new Error('Edge 语音返回空音频');
    return { ok: true, audio: buf.toString('base64'), format: 'mp3', sampleRate: 24000, engine: 'edge' };
  });
}

/* 把子进程回传的 int16 PCM 转成 Float32 波形 */
function pcmToSamples(b64) {
  const pcm = Buffer.from(b64, 'base64');
  const samples = new Float32Array(pcm.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  return samples;
}

/* Kokoro 音色名 → sid */
function kokoroSid(voiceName) {
  const v = KOKORO_VOICES.find((x) => x.name === voiceName || x.label === voiceName);
  return v ? v.sid : 47;
}

async function synthKokoro(text, speed, voiceName) {
  const r = await synthLocal(text, speed || 1.0, 'kokoro', kokoroSid(voiceName));
  if (!r.ok) throw new Error(r.error || 'Kokoro 语音合成失败');
  return { ok: true, samples: pcmToSamples(r.pcm), sampleRate: r.sampleRate, engine: 'kokoro' };
}

async function synthMelo(text, speed) {
  const r = await synthLocal(text, speed || 1.0, 'vits', 0);
  if (!r.ok) throw new Error(r.error || '语音合成失败');
  return { ok: true, samples: pcmToSamples(r.pcm), sampleRate: r.sampleRate, engine: 'melo' };
}

async function synthesize(text, speed = 1.0, engine = 'auto', voice = '') {
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: '没有可朗读的文本' };
  const st = status();

  if (engine === 'edge' || engine === 'auto') {
    try {
      return await edgeSynthesize(t, speed || 1.0, voice);
    } catch (err) {
      const msg = String((err && err.message) || err);
      console.log('[voice] edge tts failed:', msg);
      try { if (edgeWs) edgeWs.terminate(); } catch (_) {}
      edgeWs = null;
      if (engine === 'edge') {
        // 在线失败时用本地模型兜底：Kokoro → Melo → 系统语音
        if (st.kokoroReady) {
          try { return { ...(await synthKokoro(t, speed, voice)), fallback: msg }; } catch (_) {}
        }
        if (st.ttsReady) {
          try { return { ...(await synthMelo(t, speed)), fallback: msg }; } catch (_) {}
        }
        const s = await systemSay(t, speed, voice).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        return { ...s, fallback: msg };
      }
    }
  }

  if (engine === 'kokoro') {
    try {
      return await synthKokoro(t, speed, voice);
    } catch (err) {
      const msg = String((err && err.message) || err);
      console.log('[voice] kokoro tts failed:', msg);
      if (st.ttsReady) {
        try { return { ...(await synthMelo(t, speed)), fallback: msg }; } catch (_) {}
      }
      const s = await systemSay(t, speed, voice).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
      return { ...s, fallback: msg };
    }
  }

  if (engine === 'melo' || (engine !== 'system' && engine !== 'kokoro')) {
    if (st.ttsReady) {
      try {
        return await synthMelo(t, speed);
      } catch (err) {
        const msg = String((err && err.message) || err);
        console.log('[voice] melo tts failed:', msg);
        if (st.kokoroReady) {
          try { return { ...(await synthKokoro(t, speed, voice)), fallback: msg }; } catch (_) {}
        }
        const s = await systemSay(t, speed, voice).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        return { ...s, fallback: msg };
      }
    }
    if (st.kokoroReady) {
      try { return await synthKokoro(t, speed, voice); } catch (_) {}
    }
  }

  return systemSay(t, speed, voice);
}

/* 列出可用音色：Edge 在线音色 + Kokoro 本地音色 + 本机系统中文音色 */
async function listVoices() {
  const list = EDGE_VOICES.map((v) => ({ ...v, kind: 'edge' }));
  for (const v of KOKORO_VOICES) list.push({ ...v, kind: 'kokoro' });
  let out = '';
  try { out = await run('/usr/bin/say', ['-v', '?'], 15000); } catch (_) { return list; }
  for (const line of out.split('\n')) {
    const m = line.match(/^(.+?)\s{2,}(zh[_A-Za-z]+)\s+#\s*(.*)$/);
    if (m) list.push({ name: m[1].trim(), label: m[1].trim(), locale: m[2], sample: m[3].trim(), kind: 'system' });
  }
  return list;
}

function warmup() {
  const st = status();
  // 预连接 Edge 语音，省掉第一次朗读时的握手等待
  openEdge().catch(() => {});
  if (!st.ttsReady && !st.asrReady) return;
  // 预加载模型，避免第一次朗读等太久
  try { if (st.asrReady) initAsr(); } catch (_) {}
  try {
    if (st.ttsReady) {
      ensureTtsProc('vits').proc.send({ type: 'warmup' });
    }
  } catch (_) {}
}

module.exports = { setModelsRoot, status, downloadModels, transcribe, synthesize, warmup, listVoices };
