'use strict';

/* 独立的 Node 子进程：加载本地 TTS 模型（sherpa-onnx）做语音合成。
   在纯 Node 环境运行，避免 Electron 对原生 buffer 的限制，也不阻塞主进程。
   用法：node voice-tts-server.js <模型目录> <kind>   kind = vits | kokoro
   协议：主进程 send {type:'tts'|'warmup', id, text, speed, sid}
        子进程 send {type:'ready'} / {type:'tts', id, ok, sampleRate, pcm(base64 int16)} */

const path = require('path');
const fs = require('fs');

const dir = process.argv[2] || '';
const kind = process.argv[3] || 'vits';
let sherpa = null;
let tts = null;

function fstList(names) {
  return names
    .map((f) => path.join(dir, f))
    .filter((p) => fs.existsSync(p))
    .join(',');
}

function buildConfig() {
  if (kind === 'kokoro') {
    return {
      model: {
        kokoro: {
          model: path.join(dir, 'model.int8.onnx'),
          voices: path.join(dir, 'voices.bin'),
          tokens: path.join(dir, 'tokens.txt'),
          lexicon: [path.join(dir, 'lexicon-us-en.txt'), path.join(dir, 'lexicon-zh.txt')].join(','),
          lengthScale: 1.0,
        },
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
      ruleFsts: fstList(['date-zh.fst', 'number-zh.fst', 'phone-zh.fst']),
      ruleFars: '',
      maxNumSentences: 1,
    };
  }
  return {
    model: {
      vits: {
        model: path.join(dir, 'model.int8.onnx'),
        lexicon: path.join(dir, 'lexicon.txt'),
        tokens: path.join(dir, 'tokens.txt'),
        dictDir: path.join(dir, 'dict'),
      },
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    ruleFsts: fstList(['date.fst', 'number.fst', 'phone.fst', 'new_heteronym.fst']),
    ruleFars: '',
    maxNumSentences: 1,
  };
}

function init() {
  if (tts) return tts;
  if (!sherpa) sherpa = require('sherpa-onnx-node');
  tts = new sherpa.OfflineTts(buildConfig());
  return tts;
}

process.on('message', (m) => {
  if (!m || !m.type) return;
  if (m.type === 'warmup') {
    try { init(); process.send({ type: 'warmup', ok: true }); }
    catch (err) { process.send({ type: 'warmup', ok: false, error: String((err && err.message) || err) }); }
    return;
  }
  if (m.type === 'tts') {
    try {
      const engine = init();
      const audio = engine.generate({
        text: String(m.text || ''),
        sid: Number.isFinite(m.sid) ? m.sid : 0,
        speed: m.speed || 1.0,
      });
      const src = audio.samples;
      const pcm = Buffer.alloc(src.length * 2);
      for (let i = 0; i < src.length; i++) {
        const v = Math.max(-1, Math.min(1, src[i]));
        pcm.writeInt16LE(Math.round(v * 32767), i * 2);
      }
      process.send({ type: 'tts', id: m.id, ok: true, sampleRate: engine.sampleRate, pcm: pcm.toString('base64') });
    } catch (err) {
      process.send({ type: 'tts', id: m.id, ok: false, error: String((err && err.message) || err) });
    }
  }
});

try {
  process.send({ type: 'ready' });
} catch (_) {}
