/* LearnCanvas —— 画布渲染与框选映射 */
(function () {
  'use strict';

  const md = new marked.Marked({ gfm: true, breaks: false });
  md.use(markedKatex({ throwOnError: false, displayMode: true, nonStandard: true, output: 'html' }));

  let mermaidReady = false;
  function initMermaid(theme) {
    if (mermaidReady) return;
    mermaidReady = true;
    const dark = theme === 'dark';
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      securityLevel: 'loose',
      fontFamily: '-apple-system, "PingFang SC", sans-serif',
      themeVariables: dark ? {
        darkMode: true,
        background: '#0b0e13',
        primaryColor: '#16233a',
        primaryTextColor: '#dbe5f5',
        primaryBorderColor: '#3a5580',
        lineColor: '#5c7397',
        secondaryColor: '#1b2a3f',
        tertiaryColor: '#121a25',
        fontSize: '15px',
        edgeLabelBackground: '#0f141c',
        nodeTextColor: '#dbe5f5',
        cScale0: '#1b2a42', cScale1: '#17323a', cScale2: '#33291c', cScale3: '#2b2340',
        cScale4: '#1a2c3d', cScale5: '#37222b', cScale6: '#232a44', cScale7: '#1d332e',
        cScaleInv0: '#dbe5f5', cScaleInv1: '#dbe5f5', cScaleInv2: '#dbe5f5', cScaleInv3: '#dbe5f5',
        cScaleInv4: '#dbe5f5', cScaleInv5: '#dbe5f5', cScaleInv6: '#dbe5f5', cScaleInv7: '#dbe5f5',
      } : {
        darkMode: false,
        background: '#fcfbf8',
        primaryColor: '#eef3ff',
        primaryTextColor: '#1e2b40',
        primaryBorderColor: '#bfd2f4',
        lineColor: '#8d97a8',
        secondaryColor: '#f4f8ff',
        tertiaryColor: '#fbfaf7',
        fontSize: '15px',
        edgeLabelBackground: '#fcfbf8',
        nodeTextColor: '#243044',
        cScale0: '#dfe9fb', cScale1: '#ddf3ec', cScale2: '#fbeeda', cScale3: '#ebe4fb',
        cScale4: '#dcefff', cScale5: '#fbe2e6', cScale6: '#e5e8fb', cScale7: '#dff4ec',
        cScaleInv0: '#243044', cScaleInv1: '#243044', cScaleInv2: '#243044', cScaleInv3: '#243044',
        cScaleInv4: '#243044', cScaleInv5: '#243044', cScaleInv6: '#243044', cScaleInv7: '#243044',
      },
    });
  }

  const S = {
    root: null,     // #canvas
    inner: null,    // centered column
    blocks: [],
    hooks: {},
    seq: 0,
    chains: new Map(),
    theme: 'light',
  };

  /* ---------------------------------------------------------- helpers ---- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function lineIndex(source) {
    const starts = [0];
    for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
    return function (idx) {
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) {
        const m = (lo + hi + 1) >> 1;
        if (starts[m] <= idx) lo = m; else hi = m - 1;
      }
      return lo + 1;
    };
  }

  function assignItemLines(items, source, lineAt, from, to) {
    let cur = from;
    for (const it of items || []) {
      const raw = it.raw || '';
      let idx = source.indexOf(raw, cur);
      if (idx < 0 || idx > to) idx = cur;
      const trimmed = raw.replace(/\s+$/, '');
      it.__l = lineAt(idx);
      it.__e = lineAt(Math.max(idx + trimmed.length - 1, idx));
      if (it.tokens) {
        for (const t of it.tokens) {
          if (t.type === 'list' && t.items) assignItemLines(t.items, source, lineAt, idx, idx + Math.max(raw.length, 1));
        }
      }
      cur = idx + Math.max(raw.length, 1);
    }
  }

  function assignLines(tokens, source) {
    const lineAt = lineIndex(source);
    let cursor = 0;
    for (const t of tokens) {
      if (t.type === 'space') continue;
      const raw = t.raw || '';
      let idx = source.indexOf(raw, cursor);
      if (idx < 0) idx = cursor;
      const endIdx = Math.max(idx + raw.replace(/\s+$/, '').length - 1, idx);
      t.__l = lineAt(idx);
      t.__e = lineAt(endIdx);
      if (t.type === 'list' && t.items) assignItemLines(t.items, source, lineAt, idx, idx + raw.length);
      cursor = idx + raw.length;
    }
  }

  function flattenItems(items, out) {
    out = out || [];
    for (const it of items || []) {
      out.push(it);
      if (it.tokens) {
        for (const t of it.tokens) if (t.type === 'list' && t.items) flattenItems(t.items, out);
      }
    }
    return out;
  }

  /* -------------------------------------------------------- rendering ---- */
  function renderMarkdown(host, source) {
    let tokens = [];
    try {
      tokens = md.lexer(source || '');
      assignLines(tokens, source || '');
    } catch (e) {
      host.innerHTML = '<div class="blk-error">Markdown 解析失败：' + escapeHtml(e.message) + '</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const t of tokens) {
      if (t.type === 'space') continue;
      const unit = document.createElement('div');
      unit.className = 'md-unit';
      if (t.__l) { unit.dataset.l = t.__l; unit.dataset.e = t.__e || t.__l; }
      try {
        unit.innerHTML = md.parser([t]);
      } catch (e) {
        unit.innerHTML = '<div class="blk-error">渲染失败：' + escapeHtml(e.message) + '</div>';
      }
      if (t.type === 'list' && t.items) {
        const lis = unit.querySelectorAll('li');
        const items = flattenItems(t.items);
        if (lis.length === items.length) {
          items.forEach((it, i) => {
            if (it.__l) { lis[i].dataset.l = it.__l; lis[i].dataset.e = it.__e || it.__l; }
          });
        }
      }
      frag.appendChild(unit);
    }
    host.innerHTML = '';
    host.classList.add('md');
    host.appendChild(frag);
  }

  function buildIframe(block, host) {
    const id = block.id + '-' + (++S.seq);
    const dark = S.theme === 'dark';
    const fg = dark ? '#e7ebf2' : '#242a32';
    const accent = dark ? '#7aa2ff' : '#3f6ee0';
    const base = `<style>
      html,body{margin:0;padding:0;background:transparent;color:${fg};
        font:14px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;overflow:hidden}
      *{box-sizing:border-box}
      h1,h2,h3,h4{font-weight:600;line-height:1.35;margin:14px 0 10px}
      button{font-family:inherit;cursor:pointer}
      input[type=range]{accent-color:${accent}}
      code,pre{font-family:ui-monospace,Menlo,monospace}
    </style>`;
    const reporter = `<script>(function(){
      function report(){
        try{
          var h=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight,document.body.offsetHeight);
          parent.postMessage({__lc:{id:${JSON.stringify(id)},h:h}},'*');
        }catch(e){}
      }
      window.addEventListener('load',report);
      setTimeout(report,50);setTimeout(report,300);
      try{new ResizeObserver(report).observe(document.body)}catch(e){}
      window.addEventListener('error',function(e){
        parent.postMessage({__lc:{id:${JSON.stringify(id)},err:(e.message||'')}},'*');
      });
      ['click','input','change'].forEach(function(ev){document.addEventListener(ev,function(){setTimeout(report,40)});});
    })();<\/script>`;
    const iframe = document.createElement('iframe');
    iframe.className = 'widget-frame';
    iframe.dataset.lcId = id;
    iframe.dataset.lcBlock = block.id;
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.height = '160px';
    iframe.srcdoc = '<!doctype html><html><head><meta charset="utf-8">' + base + '</head><body>' + (block.source || '') + reporter + '</body></html>';
    host.appendChild(iframe);
  }

  function renderMermaid(block, host) {
    initMermaid(S.theme);
    const wrap = document.createElement('div');
    wrap.className = 'mermaid-wrap';
    wrap.style.minHeight = '40px';
    wrap.textContent = '……';
    host.appendChild(wrap);
    const prev = S.chains.get(block.id) || Promise.resolve();
    const next = prev.then(async () => {
      try {
        const { svg } = await mermaid.render('mmd_' + block.id + '_' + (++S.seq), block.source || '');
        wrap.innerHTML = svg;
        wrap.dataset.l = 1;
        wrap.dataset.e = (block.source || '').split('\n').length;
      } catch (e) {
        wrap.className = 'blk-error';
        wrap.textContent = 'Mermaid 渲染失败：' + (e && e.message ? e.message : e) + '\n\n' + (block.source || '');
      }
    }).catch(() => {});
    S.chains.set(block.id, next);
  }

  function renderBlockBody(block, host) {
    host.innerHTML = '';
    host.classList.remove('md');
    const kind = block.kind || 'markdown';
    const src = block.source == null ? '' : String(block.source);

    if (kind === 'markdown') {
      renderMarkdown(host, src);
    } else if (kind === 'mermaid') {
      renderMermaid(block, host);
    } else if (kind === 'svg') {
      const wrap = document.createElement('div');
      wrap.className = 'svg-wrap md';
      wrap.dataset.l = 1;
      wrap.dataset.e = src.split('\n').length;
      wrap.innerHTML = src;
      host.appendChild(wrap);
    } else if (kind === 'html') {
      const holder = document.createElement('div');
      holder.dataset.l = 1;
      holder.dataset.e = src.split('\n').length;
      host.appendChild(holder);
      buildIframe(block, holder);
    } else if (kind === 'image') {
      const wrap = document.createElement('div');
      wrap.className = 'img-wrap md';
      wrap.dataset.l = 1;
      wrap.dataset.e = src.split('\n').length;
      const img = document.createElement('img');
      img.src = src.trim();
      img.alt = block.title || '';
      wrap.appendChild(img);
      host.appendChild(wrap);
    } else {
      renderMarkdown(host, src);
    }
  }

  function blockEl(block) {
    const sec = document.createElement('section');
    sec.className = 'blk';
    sec.dataset.id = block.id;
    sec.dataset.kind = block.kind || 'markdown';

    const tag = document.createElement('div');
    tag.className = 'blk-tag';
    tag.textContent = block.id + ' · ' + (block.kind || 'markdown') + ' · ' + (String(block.source || '').split('\n').length) + ' 行';
    sec.appendChild(tag);

    const body = document.createElement('div');
    body.className = 'blk-body';
    sec.appendChild(body);
    renderBlockBody(block, body);
    return sec;
  }

  function findBlock(id) { return S.blocks.find((b) => b.id === id) || null; }

  function rerender(block) {
    const old = S.inner.querySelector('.blk[data-id="' + CSS.escape(block.id) + '"]');
    const fresh = blockEl(block);
    if (old) old.replaceWith(fresh);
    else S.inner.appendChild(fresh);
    const tag = fresh.querySelector('.blk-tag');
    if (tag) tag.textContent = block.id + ' · ' + block.kind + ' · ' + String(block.source || '').split('\n').length + ' 行';
  }

  function nextId() {
    let max = 0;
    for (const b of S.blocks) {
      const m = /^b(\d+)$/.exec(b.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return 'b' + (max + 1);
  }

  function normalizeOps(ops) {
    if (!ops) return [];
    if (Array.isArray(ops)) return ops;
    if (Array.isArray(ops.ops)) return ops.ops;
    if (typeof ops === 'object') return [ops];
    return [];
  }

  function applyOps(rawOps) {
    const ops = normalizeOps(rawOps);
    const logs = [];
    let changed = false;

    for (const op of ops) {
      if (!op || typeof op !== 'object') continue;
      const name = op.op || op.type;
      const kind = op.kind || 'markdown';

      if (name === 'add') {
        const id = String(op.id || nextId()).trim() || nextId();
        const src = typeof op.content === 'string' ? op.content : String(op.content == null ? '' : op.content);
        const existing = findBlock(id);
        const data = {
          id,
          kind,
          title: op.title || '',
          source: src,
          createdAt: Date.now(),
        };
        if (existing) {
          Object.assign(existing, { kind: data.kind, title: data.title, source: data.source });
          rerender(existing);
          logs.push({ type: 'update', id, kind, title: data.title });
        } else {
          let at = S.blocks.length;
          if (op.after === 'start') at = 0;
          else if (op.after) {
            const i = S.blocks.findIndex((b) => b.id === String(op.after));
            if (i >= 0) at = i + 1;
          }
          S.blocks.splice(at, 0, data);
          const el = blockEl(data);
          const ref = S.blocks[at + 1] ? S.inner.querySelector('.blk[data-id="' + CSS.escape(S.blocks[at + 1].id) + '"]') : null;
          if (ref) S.inner.insertBefore(el, ref); else S.inner.appendChild(el);
          logs.push({ type: 'add', id, kind, title: data.title });
        }
        changed = true;
      } else if (name === 'patch') {
        const b = findBlock(String(op.id || ''));
        if (!b) { logs.push({ type: 'error', text: 'patch 目标不存在：' + op.id }); continue; }
        const lines = String(b.source || '').split('\n');
        const from = Math.max(1, Math.min(Number(op.from) || 1, lines.length + 1));
        const to = Math.max(from, Math.min(Number(op.to) || from, lines.length));
        const replRaw = Array.isArray(op.content) ? op.content.join('\n') : String(op.content == null ? '' : op.content);
        const repl = replRaw === '' ? [] : replRaw.split('\n');
        b.source = lines.slice(0, from - 1).concat(repl, lines.slice(to)).join('\n');
        if (op.kind) b.kind = op.kind;
        if (op.title) b.title = op.title;
        rerender(b);
        logs.push({ type: 'patch', id: b.id, from, to });
        changed = true;
      } else if (name === 'replace') {
        const b = findBlock(String(op.id || ''));
        if (!b) { logs.push({ type: 'error', text: 'replace 目标不存在：' + op.id }); continue; }
        b.source = typeof op.content === 'string' ? op.content : String(op.content == null ? '' : op.content);
        if (op.kind) b.kind = op.kind;
        if (typeof op.title === 'string') b.title = op.title;
        rerender(b);
        logs.push({ type: 'replace', id: b.id });
        changed = true;
      } else if (name === 'remove') {
        const id = String(op.id || '');
        const i = S.blocks.findIndex((b) => b.id === id);
        if (i >= 0) {
          S.blocks.splice(i, 1);
          const el = S.inner.querySelector('.blk[data-id="' + CSS.escape(id) + '"]');
          if (el) el.remove();
          logs.push({ type: 'remove', id });
          changed = true;
        }
      } else if (name === 'clear') {
        S.blocks = [];
        S.inner.innerHTML = '';
        logs.push({ type: 'clear' });
        changed = true;
      } else if (name === 'focus') {
        focusBlock(String(op.id || ''));
      }
    }

    if (changed && S.hooks.onChange) S.hooks.onChange(S.blocks);
    return logs;
  }

  function focusBlock(id) {
    const el = S.inner.querySelector('.blk[data-id="' + CSS.escape(id) + '"]');
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  /* -------------------------------------------------------- selection ---- */
  function selectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const text = sel.toString();
    if (!text.trim()) return null;
    if (!S.inner || !S.inner.contains(range.commonAncestorContainer)) return null;

    const groups = new Map();
    const nodes = S.inner.querySelectorAll('[data-l]');
    for (const el of nodes) {
      let hit = false;
      try { hit = range.intersectsNode(el); } catch (e) { hit = false; }
      if (!hit) continue;
      const sec = el.closest('.blk');
      if (!sec) continue;
      const l = Number(el.dataset.l);
      const e = Number(el.dataset.e || el.dataset.l);
      if (!l || !e) continue;
      const id = sec.dataset.id;
      const g = groups.get(id) || { id, start: l, end: e };
      g.start = Math.min(g.start, l);
      g.end = Math.max(g.end, e);
      groups.set(id, g);
    }

    if (groups.size === 0) {
      const sec = (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest('.blk');
      if (sec) groups.set(sec.dataset.id, { id: sec.dataset.id, start: 1, end: 9999 });
    }

    const out = [];
    for (const g of groups.values()) {
      const b = findBlock(g.id);
      if (!b) continue;
      const total = String(b.source || '').split('\n').length;
      const start = Math.max(1, Math.min(g.start, total));
      const end = Math.max(start, Math.min(g.end, total));
      out.push({
        blockId: b.id,
        kind: b.kind,
        title: b.title || '',
        start,
        end,
        total,
        text: text.trim(),
      });
    }
    if (!out.length) return null;

    let rect = null;
    try { rect = range.getBoundingClientRect(); } catch (e) {}
    return { selections: out, rect, text: text.trim() };
  }

  /* ------------------------------------------------------------ public --- */
  const CanvasView = {
    init(root, hooks) {
      S.root = root;
      S.hooks = hooks || {};
      S.inner = document.createElement('div');
      S.inner.className = 'canvas-inner';
      S.root.innerHTML = '';
      S.root.appendChild(S.inner);

      // 链接外部打开
      S.inner.addEventListener('click', (ev) => {
        const a = ev.target.closest('a[href]');
        if (a) {
          ev.preventDefault();
          const href = a.getAttribute('href');
          if (/^https?:/i.test(href)) window.api.openExternal(href);
        }
      });

      window.addEventListener('message', (ev) => {
        const d = ev.data && ev.data.__lc;
        if (!d || !d.id) return;
        const ifr = S.inner.querySelector('iframe[data-lc-id="' + CSS.escape(d.id) + '"]');
        if (!ifr) return;
        if (d.h) ifr.style.height = Math.min(Math.max(d.h + 4, 44), 1400) + 'px';
        if (d.err) ifr.style.borderColor = '#4a2733';
      });
    },

    setBlocks(blocks) {
      S.blocks = (blocks || []).map((b) => ({
        id: b.id,
        kind: b.kind || 'markdown',
        title: b.title || '',
        source: b.source == null ? '' : String(b.source),
        createdAt: b.createdAt || Date.now(),
      }));
      S.inner.innerHTML = '';
      for (const b of S.blocks) S.inner.appendChild(blockEl(b));
    },

    getBlocks() { return S.blocks.map((b) => ({ ...b })); },
    getBlock(id) { const b = findBlock(id); return b ? { ...b } : null; },
    setTheme(t) {
      S.theme = t === 'dark' ? 'dark' : 'light';
      mermaidReady = false;
      for (const b of S.blocks) {
        const body = S.inner.querySelector('.blk[data-id="' + CSS.escape(b.id) + '"] .blk-body');
        if (body) renderBlockBody(b, body);
      }
    },
    applyOps,
    focusBlock,
    selectionInfo,
    nextId,
    renderMarkdown(host, source) { renderMarkdown(host, source); },
    clear() { S.blocks = []; S.inner.innerHTML = ''; },
  };

  window.CanvasView = CanvasView;
})();
