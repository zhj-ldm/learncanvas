/* LearnCanvas —— 主逻辑：布局 / 对话 / Agent 循环 / 框选引用 */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const uid = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const DEFAULT_SETTINGS = {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-flash',
    temperature: 0.6,
    thinking: 'medium',
    details: false,
    workdir: '~/LearnCanvas',
    searchBin: '',
    theme: 'light',
    voiceInput: false,
    voiceOutput: false,
    ttsEngine: 'edge',
    ttsVoice: '',
    ttsSpeed: 1,
  };

  const state = {
    sessions: [],
    activeId: '',
    blocks: [],
    chat: [],
    ink: [],
    settings: { ...DEFAULT_SETTINGS },
    ui: { chatWidth: 420, collapsed: false, ink: { color: '#2b2f36', width: 4 } },
  };

  const canvasEl = $('#canvas');
  const canvasPane = $('#canvasPane');
  const chatPane = $('#chatPane');
  const messagesEl = $('#messages');
  const composerWrap = $('#composerWrap');
  const composerSlot = document.createComment('composer-slot');
  chatPane.insertBefore(composerSlot, $('#rail'));
  const inputEl = $('#input');
  const sendBtn = $('#sendBtn');
  const chipsEl = $('#chips');
  const floatDock = $('#floatDock');
  const floatHost = $('#floatHost');
  const railSnippet = $('#railSnippet');
  const railDot = $('#railDot');
  const peekEl = $('#peek');
  const pill = $('#selPill');
  const pillText = $('#selPillText');

  let chips = [];               // 待发送的框选引用
  let attachments = [];         // 待发送图片（dataURL）
  let busy = false;
  let currentReqId = null;
  let lastAssistantText = '';
  let saveTimer = null;

  /* --------------------------------------------------------- persistence - */
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      syncActive();
      window.api.saveState({
        sessions: state.sessions,
        activeId: state.activeId,
        settings: state.settings,
        ui: state.ui,
      });
      renderSessionList();
    }, 400);
  }

  /* ---------------------------------------------------------- sessions ---- */
  function makeSession() {
    return {
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      title: '新对话',
      blocks: [],
      chat: [],
      ink: [],
      ts: Date.now(),
    };
  }

  function currentSession() {
    return state.sessions.find((s) => s.id === state.activeId) || null;
  }

  function syncActive() {
    const s = currentSession();
    if (!s) return;
    s.blocks = window.CanvasView.getBlocks();
    s.chat = state.chat;
    s.ink = state.ink;
    s.ts = Date.now();
    if (!s.title || s.title === '新对话') {
      const first = (s.chat || []).find((m) => m.role === 'user' && (m.displayText || m.text));
      if (first) {
        const t = String(first.displayText || first.text).split('【框选引用】')[0].replace(/\s+/g, ' ').trim();
        s.title = t.slice(0, 26) || '新对话';
      }
    }
  }

  function timeAgo(ts) {
    const d = Date.now() - (ts || 0);
    if (d < 60e3) return '刚刚';
    if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
    if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
    return Math.floor(d / 86400e3) + ' 天前';
  }

  function renderSessionList() {
    const list = $('#sessionList');
    if (!list) return;
    list.innerHTML = '';
    const items = [...state.sessions].sort((a, b) => (b.ts || 0) - (a.ts || 0));
    for (const s of items) {
      const row = el('div', 'sb-item' + (s.id === state.activeId ? ' active' : ''));
      const body = el('div', 'sb-body');
      body.append(
        el('div', 'sb-name', s.title || '新对话'),
        el('div', 'sb-meta', ((s.chat || []).filter((m) => m.role === 'user').length) + ' 问 · ' + timeAgo(s.ts)),
      );
      const exp = el('button', 'sb-exp');
      exp.title = '导出对话（JSON）';
      exp.innerHTML = '<svg viewBox="0 0 20 20" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5V13M6.5 9.5L10 13l3.5-3.5"/><path d="M3.5 14.5v1.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-1.5"/></svg>';
      exp.addEventListener('click', (e) => { e.stopPropagation(); exportSession(s.id); });
      const del = el('button', 'sb-del', '✕');
      del.title = '删除对话';
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteSession(s.id); });
      row.append(body, exp, del);
      row.addEventListener('click', () => switchSession(s.id));
      list.appendChild(row);
    }
  }

  function loadSession(s) {
    state.activeId = s.id;
    state.blocks = s.blocks || [];
    state.chat = s.chat || [];
    state.ink = s.ink || [];
    window.CanvasView.setBlocks(state.blocks);
    renderChat();
    if (!state.chat.length) renderWelcomeNote();
    const lastA = [...state.chat].reverse().find((m) => m.role === 'assistant');
    lastAssistantText = lastA ? (lastA.displayText || lastA.text || '') : '';
    loadInk();
    updateEmptyState();
    updateRailSnippet();
    updateUsageChip();
    renderSessionList();
  }

  function switchSession(id) {
    if (id === state.activeId) return;
    if (busy) { setStatus('正在生成，稍后再切换'); return; }
    syncActive();
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return;
    loadSession(s);
    save();
  }

  function deleteSession(id) {
    if (busy) return;
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return;
    if (!confirm('删除对话「' + (s.title || '新对话') + '」？此操作不可撤销。')) return;
    state.sessions = state.sessions.filter((x) => x.id !== id);
    if (state.activeId === id) {
      if (state.sessions.length) loadSession([...state.sessions].sort((a, b) => (b.ts || 0) - (a.ts || 0))[0]);
      else {
        const ns = makeSession();
        state.sessions = [ns];
        loadSession(ns);
      }
    } else {
      renderSessionList();
    }
    save();
  }

  function setSidebar(open) {
    document.body.classList.toggle('sidebar-open', !!open);
    if (open) renderSessionList();
  }

  /* ------------------------------------------------------ export/import -- */
  async function exportSession(id) {
    if (busy) { setStatus('正在生成，稍后再导出'); return; }
    syncActive();
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return;
    const payload = {
      app: 'learncanvas-session',
      version: 1,
      exportedAt: new Date().toISOString(),
      session: { title: s.title || '新对话', blocks: s.blocks || [], chat: s.chat || [], ink: s.ink || [], ts: s.ts || Date.now() },
    };
    const name = String(s.title || '对话').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) + '.json';
    const r = await window.api.exportJson({ defaultName: name, text: JSON.stringify(payload, null, 1) });
    if (r && r.ok) setStatus('已导出 ' + (r.path || '').split('/').pop());
    else if (r && r.error) setStatus('导出失败：' + r.error);
    else setStatus('');
  }

  async function importSession() {
    if (busy) { setStatus('正在生成，稍后再导入'); return; }
    const r = await window.api.importJson();
    if (!r || !r.ok) { if (r && r.error) setStatus('导入失败：' + r.error); return; }
    let data;
    try { data = JSON.parse(r.text); } catch { setStatus('导入失败：不是有效的 JSON 文件'); return; }
    const s = data && data.session && Array.isArray(data.session.blocks) ? data.session : (data && Array.isArray(data.blocks) ? data : null);
    if (!s) { setStatus('导入失败：文件不是 LearnCanvas 对话导出'); return; }
    syncActive();
    const ns = makeSession();
    ns.title = String(s.title || '导入的对话').slice(0, 60);
    ns.blocks = s.blocks || [];
    ns.chat = s.chat || [];
    ns.ink = s.ink || [];
    ns.ts = s.ts || Date.now();
    state.sessions.unshift(ns);
    chips = [];
    attachments = [];
    loadSession(ns);
    save();
    setStatus('已导入「' + ns.title + '」');
  }

  /* -------------------------------------------------------------- prompt - */
  function systemPrompt() {
    const wd = state.settings.workdir || '~/LearnCanvas';
    return `你是 LearnCanvas 的学习导师 Agent，运行在用户本机（macOS）的桌面学习软件里。

## 界面
- 左侧「画布」：完全由你掌控的渲染区，支持 Markdown/LaTeX、Mermaid、SVG、可交互 HTML。用户在这里阅读，并会框选内容发给你。
- 右侧「对话」：用户与你交流，可发图片。用户框选时，系统会把「块 ID + 该块源码行号 + 选中源码」一并发给你。

## 目标
用最有效的方式让用户真正学会一个知识点：先建立直觉（图/类比），再给定义，再给具体例子，最后给可操作的检验。可视化优先、小步推进。

## 画布输出协议
需要展示或修改画布时，在回复里写一个 \`\`\`canvas 代码块，内容为 JSON：
{"ops":[ ... ]}

支持的 op：
- {"op":"add","id":"b4","kind":"markdown","title":"标题","after":"b2","content":"源码"}   // after 省略=末尾；"start"=最前
- {"op":"patch","id":"b3","from":12,"to":15,"content":"替换第 12-15 行的新源码"}
- {"op":"replace","id":"b3","kind":"markdown","title":"新标题","content":"整块源码"}
- {"op":"remove","id":"b3"}
- {"op":"focus","id":"b4"}   // 滚动定位
- {"op":"clear"}             // 仅在用户明确要求时使用

kind：
- markdown（默认）：支持 $...$ / $$...$$、表格、代码、任务列表
- mermaid：flowchart / mindmap 等，源码直接写图定义
- svg：内联 SVG 绘图（自适应宽度，不要外链）
- html：可交互教学小部件（滑块、按钮、canvas 动画）。写自包含片段，含 <style> 与 <script>，禁止外链 CDN，body 背景透明、尺寸自适应。
  教学动画必须实现「可被 AI 操控」协议：组件内监听 message，收到 lc:command 就执行并把状态回报给父窗口：
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type !== 'lc:command') return;
    // m.action 是指令名（如 "progress"/"step"/"set"/"play"/"reset"），m.value 是参数
    applyCommand(m.action, m.value);            // ← 你自己实现：更新画面
    parent.postMessage({ type: 'lc:result', ok: true, data: { action: m.action, state: '当前状态摘要' } }, '*');
  });
  指令名由你自拟，但创建后要前后一致，并用 canvas_control 逐步驱动，实现「用户问一句、演示推进一步」。
- image：content 为图片 URL 或 data URI

行号指该块源码行，从 1 开始。用户框选会给出块 ID 与行号：就地修改用 patch，在下方补充用 add + after。

## 工具（重要）
调用工具的唯一正确写法：在回复中写 \`\`\`tool 代码块（围栏语言必须是 tool），块内只放一个 JSON：
\`\`\`tool
{"name":"read_file","input":{"path":"..."}}
\`\`\`
- 一次一个调用（可写多个代码块）。系统会执行，并把结果以 <tool_result> 用户消息返回。
- 严禁自己输出 <tool_result> 标签、也不要把工具调用写成纯 JSON 而不加 \`\`\`tool 围栏，那样系统无法执行，用户也听不到朗读。
- 只接受 \`\`\`tool 围栏；不要用 \`\`\`json 等其它围栏替代。

可用工具：
- read_file {path, offset?, limit?}
- write_file {path, content}
- edit_file {path, old_string, new_string, replace_all?}
- list_dir {path}
- glob {pattern, path?}
- grep {pattern, path?, include?}
- move_file {from, to}
- delete_file {path}
- run_command {command, cwd?, timeout_ms?}
- web_search {query, max?}   多引擎联网搜索
- web_fetch {url}            抓取网页正文
- canvas_control {block_id, action, value?, note?}  向画布上的 html 组件发指令（组件会执行该 action 并回报状态），用于分步演示动画/实验进度
- speak {text}                把一段话读出来（本地 TTS）。每轮最多调用一次，且必须一次写完整段要朗读的内容；不要拆成多次调用

${state.settings.voiceOutput ? `## 语音朗读（已开启，强制）
- 用户已开启语音朗读：本轮【必须】调用且只调用一次 speak 工具，否则视为本轮未完成，系统会强制你重来。
- 把所有要讲给用户听的内容一次性完整写进 speak.text，不要拆成多次调用，不要只读一半。
- 调用位置：在给出最终文字回答的同一轮里，先写 speak 工具块，再写简短文字。
- speak 之后不要再调用第二次；想补充的内容合并进同一次 speak。
- 最终的文字回答可以很短（例如"已在语音里说明"），主要内容通过朗读传达。` : `## 语音朗读（已关闭）
- 本轮不要调用 speak 工具。`}

工作目录：${wd}（相对路径以此为基准）。不要臆造工具结果；修改文件前先读取了解现状。

## 风格
- 对话区只写简短自然语言（1-4 句）：结论、引导、下一步或提问；长篇内容放画布。
- 数学必须 LaTeX；中文提问用中文回答。
- 不要重复画布已有内容，不要无理由清空画布。
- 每轮推进一个小目标，并且尽量产出至少一个画布 op（用户只是闲聊或确认时可省略）。
- 分步教学：先创建可操控的 html 组件，之后每轮用 canvas_control 只推进一步，并在对话区用一两句话解释这一步看到了什么、下一步做什么。`;
  }

  function canvasOutline() {
    const bs = window.CanvasView.getBlocks();
    if (!bs.length) return '【画布现状】当前画布为空，可按需创建。';
    const lines = bs.map((b) => `${b.id} · ${b.kind} · ${b.title ? '「' + b.title + '」' : '(无标题)'} · ${String(b.source || '').split('\n').length} 行`);
    return '【画布现状】' + lines.length + ' 块\n' + lines.join('\n');
  }

  /* ------------------------------------------------------- chat messages - */
  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderUserEntry(entry) {
    const wrap = el('div', 'msg msg-user');
    const bubble = el('div', 'bubble');
    if (entry.displayText) bubble.appendChild(document.createTextNode(entry.displayText));
    for (const q of entry.quotes || []) {
      const qEl = el('div', 'msg-quote');
      qEl.textContent = '↳ ' + q.label + (q.preview ? '\n' + q.preview : '');
      bubble.appendChild(qEl);
    }
    if (entry.images && entry.images.length) {
      const imgs = el('div', 'msg-images');
      for (const src of entry.images) {
        const im = el('img');
        im.src = src;
        imgs.appendChild(im);
      }
      bubble.appendChild(imgs);
    }
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
  }

  function renderNote(entry) {
    const n = el('div', 'msg-note', entry.text);
    messagesEl.appendChild(n);
  }

  function renderWelcomeNote() {
    renderNote({
      role: 'note',
      text: '框选左侧内容后按 Enter，引用会显示在输入框上方，并连同「块 ID + 源码行号 + 原文」一起发给 AI。',
    });
  }

  function buildAssistantView(entry, live) {
    const wrap = el('div', 'msg msg-assistant');
    const logWrap = el('div', 'logs');
    const stepsEl = el('div', 'steps');
    const head = el('div', 'steps-head');
    head.innerHTML = '<span class="caret-arrow">▶</span><span class="steps-dot running"></span><span class="steps-label">准备中…</span>';
    const body = el('div', 'steps-body');
    stepsEl.append(head, body);
    const bubble = el('div', 'bubble');
    const usageEl = el('div', 'usage');
    wrap.append(logWrap, stepsEl, bubble, usageEl);
    messagesEl.appendChild(wrap);

    stepsEl.style.display = (entry.steps && entry.steps.length) ? '' : 'none';
    let thinkingEl = null;
    let rows = [];

    head.addEventListener('click', () => stepsEl.classList.toggle('open'));

    function addStepRow(name, arg) {
      const row = el('div', 'step');
      row.innerHTML = '<div class="step-line"><span class="step-name">' + esc(name) + '</span><span class="step-arg">' + esc(arg) + '</span><span class="step-time">…</span></div><div class="step-detail"></div>';
      row.addEventListener('click', () => row.classList.toggle('open'));
      body.appendChild(row);
      stepsEl.style.display = '';
      stepsEl.classList.add('open');
      const dot = head.querySelector('.steps-dot');
      dot.className = 'steps-dot running';
      head.querySelector('.steps-label').textContent = '执行中 · ' + name;
      if (live) setStatus('执行 ' + name);
      return row;
    }

    function addCanvasLogs(logs) {
      for (const l of logs || []) {
        const line = el('div', 'canvas-log');
        const tag = el('span', 'tag', '画布');
        let text = '';
        if (l.type === 'add') text = '新增 ' + l.id + ' · ' + l.kind + (l.title ? ' 「' + l.title + '」' : '');
        else if (l.type === 'update') text = '更新 ' + l.id + ' · ' + l.kind;
        else if (l.type === 'patch') text = '修补 ' + l.id + ' 第 ' + l.from + '–' + l.to + ' 行';
        else if (l.type === 'replace') text = '重写 ' + l.id;
        else if (l.type === 'remove') text = '移除 ' + l.id;
        else if (l.type === 'clear') text = '清空画布';
        else text = l.text || '画布操作';
        line.append(tag, el('span', null, text));
        if (l.id) {
          line.style.cursor = 'pointer';
          line.addEventListener('click', () => window.CanvasView.focusBlock(l.id));
        }
        logWrap.appendChild(line);
      }
    }

    return {
      addStepRow,
      addCanvasLogs,
      setThinking(t) {
        if (!thinkingEl) {
          thinkingEl = el('div', 'thinking');
          wrap.insertBefore(thinkingEl, stepsEl);
        }
        thinkingEl.textContent = t.slice(-900);
      },
      setUsage(u) {
        if (!u) return;
        usageEl.textContent = usageLine(u);
        usageEl.title = '本句输入 / 输出 / 缓存命中 token';
      },
      append(text) {
        const cut = text.search(/```(?:canvas|tool)/);
        bubble.textContent = cut >= 0 ? text.slice(0, cut) : text;
        bubble.classList.add('streaming');
        scrollBottom();
      },
      finishStep(row, res, ms) {
        const ok = !!(res && res.ok);
        row.querySelector('.step-dot');
        const t = row.querySelector('.step-time');
        if (t) t.textContent = (ms / 1000).toFixed(1) + 's';
        const d = row.querySelector('.step-detail');
        if (d) {
          d.textContent = String((res && res.output) || '').slice(0, 1600) || '(无输出)';
          d.classList.toggle('err', !ok);
        }
        row.dataset.ok = ok ? '1' : '0';
        const dot = head.querySelector('.steps-dot');
        if (dot) dot.className = 'steps-dot ' + (ok ? 'running' : 'error');
      },
      finishSteps(count, ms) {
        if (!count) { stepsEl.style.display = 'none'; return; }
        const dot = head.querySelector('.steps-dot');
        if (dot) dot.className = 'steps-dot done';
        head.querySelector('.steps-label').textContent = '完成 ' + count + ' 个工具 · 用时 ' + (ms / 1000).toFixed(1) + 's';
        stepsEl.classList.remove('open');
      },
      finalize(text) {
        if (thinkingEl) thinkingEl.remove();
        bubble.classList.remove('streaming');
        bubble.innerHTML = '';
        const t = (text || '').trim();
        if (!t) { bubble.remove(); return; }
        window.CanvasView.renderMarkdown(bubble, t);
        bubble.classList.add('md');
        scrollBottom();
      },
      error(message) {
        if (thinkingEl) thinkingEl.remove();
        bubble.classList.remove('streaming');
        bubble.innerHTML = '';
        bubble.classList.add('msg-error');
        bubble.textContent = message;
        scrollBottom();
      },
      el: wrap,
    };
  }

  function renderAssistantEntry(entry) {
    const view = buildAssistantView(entry, false);
    view.addCanvasLogs(entry.canvasLogs);
    if (entry.steps && entry.steps.length) {
      for (const s of entry.steps) {
        const row = view.addStepRow(s.name, s.arg);
        const t = row.querySelector('.step-time');
        if (t) t.textContent = ((s.ms || 0) / 1000).toFixed(1) + 's';
        const d = row.querySelector('.step-detail');
        if (d) { d.textContent = s.output || '(无输出)'; d.classList.toggle('err', s.ok === false); }
      }
      view.finishSteps(entry.steps.length, entry.totalMs || 0);
    }
    // 历史记录里的工具调用/画布指令可能残留，渲染前再清洗一次
    const shown = entry.text ? (parseBlocks(entry.text).clean || entry.displayText) : entry.displayText;
    view.finalize(shown);
    if (entry.usage) view.setUsage(entry.usage);
  }

  function renderChat() {
    messagesEl.innerHTML = '';
    for (const m of state.chat) {
      if (m.role === 'user') renderUserEntry(m);
      else if (m.role === 'assistant') renderAssistantEntry(m);
      else if (m.role === 'note') renderNote(m);
    }
    scrollBottom();
  }

  /* --------------------------------------------------------------- API --- */
  const tokenHandlers = new Map();
  window.api.onToken((d) => {
    const h = tokenHandlers.get(d.requestId);
    if (h) h(d);
  });

  function buildApiMessages() {
    const msgs = [{ role: 'system', content: systemPrompt() }];
    const hist = state.chat.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-36);
    hist.forEach((m, i) => {
      if (m.role === 'user') {
        let text = m.text || '';
        if (i === hist.length - 1) text += '\n\n' + canvasOutline();
        const parts = [{ type: 'text', text }];
        for (const img of m.images || []) parts.push({ type: 'image_url', image_url: { url: img } });
        msgs.push({ role: 'user', content: parts.length > 1 ? parts : text });
      } else {
        msgs.push({ role: 'assistant', content: m.displayText || m.text || '（画布已更新）' });
      }
    });
    return msgs;
  }

  function callModel(messages, onToken) {
    const requestId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    currentReqId = requestId;
    tokenHandlers.set(requestId, onToken);
    return window.api.chat({ requestId, messages, settings: state.settings })
      .finally(() => {
        tokenHandlers.delete(requestId);
        if (currentReqId === requestId) currentReqId = null;
      });
  }

  /* ------------------------------------------------------------ parsing -- */
  const TOOL_NAMES = new Set([
    'read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep',
    'move_file', 'delete_file', 'run_command', 'web_search', 'web_fetch',
    'canvas_control', 'speak',
  ]);

  function tryJson(s) {
    const t = String(s || '').trim();
    if (!t) return null;
    try { return JSON.parse(t); } catch (_) {}
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) {} }
    const c = t.indexOf('['), d = t.lastIndexOf(']');
    if (c >= 0 && d > c) { try { return JSON.parse(t.slice(c, d + 1)); } catch (_) {} }
    return null;
  }

  function isToolCall(j) {
    return !!(j && typeof j === 'object' && !Array.isArray(j) && (TOOL_NAMES.has(j.name) || Array.isArray(j.calls)));
  }

  function pushToolCall(tools, j) {
    if (!j) return;
    if (j.name) {
      tools.push({ name: j.name, input: j.input || j.arguments || j.params || {} });
    } else if (Array.isArray(j.calls)) {
      tools.push(...j.calls.filter((c) => c && c.name).map((c) => ({ name: c.name, input: c.input || c.arguments || {} })));
    }
  }

  /* 从一段文本中摘掉裸 JSON 工具调用（模型有时不写 ```tool 代码块） */
  function stripBareToolCalls(text, tools) {
    let out = '';
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c !== '{') { out += c; i++; continue; }
      // 平衡括号扫描（跳过字符串内的括号）
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let k = i; k < text.length; k++) {
        const ch = text[k];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = k; break; } }
      }
      if (end < 0) { out += text.slice(i); break; }
      const chunk = text.slice(i, end + 1);
      let j = null;
      try { j = JSON.parse(chunk); } catch (_) {}
      if (isToolCall(j)) {
        pushToolCall(tools, j);
        i = end + 1;
        continue;
      }
      out += chunk;
      i = end + 1;
    }
    return out;
  }

  function parseBlocks(text) {
    const ops = [];
    const tools = [];
    let out = '';
    // 1) 任意围栏代码块：canvas 当画布指令，含 name 的 JSON 当工具调用，其余原样保留
    const fenceRe = /```([A-Za-z_]*)[ \t]*\r?\n([\s\S]*?)```/g;
    let last = 0, m;
    while ((m = fenceRe.exec(text))) {
      out += text.slice(last, m.index);
      last = m.index + m[0].length;
      const lang = (m[1] || '').toLowerCase();
      const bodyText = m[2].trim();
      const j = tryJson(bodyText);
      if (lang === 'canvas' && j) {
        if (Array.isArray(j)) ops.push(...j);
        else if (Array.isArray(j.ops)) ops.push(...j.ops);
        else ops.push(j);
        continue;
      }
      if (j && isToolCall(j)) { pushToolCall(tools, j); continue; }
      out += m[0];
    }
    out += text.slice(last);

    // 2) 模型有时把工具调用包成 <tool_result>...</tool_result>，一并识别并从正文去掉
    out = out.replace(/<tool_result[^>]*>([\s\S]*?)<\/tool_result>/gi, (whole, inner) => {
      const j = tryJson(inner);
      if (j && isToolCall(j)) { pushToolCall(tools, j); return ''; }
      return whole;
    });
    // 3) 未闭合的 ```tool 代码块，或完全裸的 JSON 工具调用
    out = out.replace(/```(?:tool|tool_call|json)[ \t]*\r?\n([\s\S]*)$/i, (whole, inner) => {
      const j = tryJson(inner);
      if (j && isToolCall(j)) { pushToolCall(tools, j); return ''; }
      return whole;
    });
    out = stripBareToolCalls(out, tools);

    const clean = out.replace(/\n{3,}/g, '\n\n').trim();
    return { ops, tools, clean };
  }

  function toolArgSummary(name, input) {
    const i = input || {};
    if (name === 'canvas_control') return String(i.block_id || '?') + ' · ' + String(i.action || '?') + (i.value !== undefined ? ' = ' + JSON.stringify(i.value) : '');
    if (name === 'speak') { const t = String(i.text || i.content || ''); return t.slice(0, 80) + (t.length > 80 ? '…' : ''); }
    if (i.path) return String(i.path);
    if (i.query) return String(i.query);
    if (i.command) return String(i.command).slice(0, 90);
    if (i.url) return String(i.url);
    if (i.pattern) return String(i.pattern);
    if (i.from || i.to) return String(i.from) + ' → ' + String(i.to);
    const s = JSON.stringify(i);
    return s.length > 90 ? s.slice(0, 90) + '…' : s;
  }

  /* --------------------------------------------------------- agent turn -- */
  function setBusy(v) {
    busy = v;
    $('#btnStop').hidden = !v;
    sendBtn.disabled = v;
    setStatus(v ? '思考中…' : '');
    railDot.classList.toggle('running', v);
    if (!v) railDot.classList.remove('running');
  }

  function setStatus(t) {
    $('#chatStatus').textContent = t || '';
  }

  /* ------------------------------------------------------------- usage --- */
  function fmtTok(n) {
    n = Number(n) || 0;
    if (n >= 100000) return Math.round(n / 1000) + 'k';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }

  function cachedOf(u) {
    if (!u) return 0;
    return Number(u.prompt_cache_hit_tokens || (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens)) || 0;
  }

  function usageLine(u) {
    if (!u) return '';
    const parts = [
      '输入 ' + fmtTok(u.prompt_tokens),
      '输出 ' + fmtTok(u.completion_tokens),
      '缓存命中 ' + fmtTok(cachedOf(u)),
    ];
    const rt = u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens;
    if (rt) parts.push('思考 ' + fmtTok(rt));
    return parts.join(' · ');
  }

  function totalUsage() {
    let total = 0, cached = 0;
    for (const m of state.chat) {
      if (!m.usage) continue;
      total += Number(m.usage.total_tokens) || 0;
      cached += cachedOf(m.usage);
    }
    return { total, cached };
  }

  function updateUsageChip() {
    const chip = $('#usageChip');
    const on = !!state.settings.details;
    chip.hidden = !on;
    if (!on) return;
    const t = totalUsage();
    chip.textContent = t.total
      ? '本次会话 ' + fmtTok(t.total) + ' tokens · 缓存命中 ' + fmtTok(t.cached)
      : '暂无用量';
    chip.title = '本次会话累计 token（输入+输出），以及其中命中的缓存 token';
  }

  /* --------------------------------------------------------------- ink --- */
  const inkCanvas = document.createElement('canvas');
  inkCanvas.className = 'ink-canvas';
  let inkCtx = null;
  let inkMode = false;
  let inkStroke = null;
  let inkRaf = 0;

  function inkPrefs() {
    if (!state.ui.ink) state.ui.ink = { color: '#2b2f36', width: 4 };
    return state.ui.ink;
  }

  function scheduleInkResize() {
    if (inkRaf) return;
    inkRaf = requestAnimationFrame(() => { inkRaf = 0; inkResize(); });
  }

  function inkResize() {
    if (!canvasEl) return;
    const w = Math.max(1, canvasEl.clientWidth);
    const h = Math.max(canvasEl.clientHeight + 1, canvasEl.scrollHeight);
    const dpr = window.devicePixelRatio || 1;
    inkCanvas.style.width = w + 'px';
    inkCanvas.style.height = h + 'px';
    inkCanvas.width = Math.round(w * dpr);
    inkCanvas.height = Math.round(h * dpr);
    inkCtx = inkCanvas.getContext('2d');
    inkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    inkCtx.lineCap = 'round';
    inkCtx.lineJoin = 'round';
    redrawInk();
  }

  function drawStroke(s) {
    if (!inkCtx || !s || !s.pts || !s.pts.length) return;
    inkCtx.strokeStyle = s.color;
    inkCtx.fillStyle = s.color;
    inkCtx.lineWidth = s.width;
    if (s.pts.length === 1) {
      inkCtx.beginPath();
      inkCtx.arc(s.pts[0][0], s.pts[0][1], s.width / 2, 0, Math.PI * 2);
      inkCtx.fill();
      return;
    }
    inkCtx.beginPath();
    inkCtx.moveTo(s.pts[0][0], s.pts[0][1]);
    for (let i = 1; i < s.pts.length; i++) inkCtx.lineTo(s.pts[i][0], s.pts[i][1]);
    inkCtx.stroke();
  }

  function redrawInk() {
    if (!inkCtx) return;
    inkCtx.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
    for (const s of state.ink) drawStroke(s);
  }

  function inkPoint(e) {
    const r = inkCanvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function setInkMode(on) {
    inkMode = !!on;
    document.body.classList.toggle('ink-open', inkMode);
    if (inkMode) { scheduleInkResize(); hidePill(); }
  }

  function syncInkUI() {
    const p = inkPrefs();
    document.querySelectorAll('#inkColors .ink-color').forEach((b) => {
      b.classList.toggle('active', b.dataset.color === p.color);
    });
    document.querySelectorAll('#inkWidths .ink-dot').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.w) === Number(p.width));
    });
  }

  function loadInk() {
    scheduleInkResize();
  }

  function bindInk() {
    canvasEl.appendChild(inkCanvas);
    inkCanvas.addEventListener('pointerdown', (e) => {
      // 只有主指针的「左键按下」才落笔；滚轮/触控板滚动、非主指针一律放行
      if (!inkMode || !e.isPrimary || e.button !== 0 || e.buttons !== 1) return;
      if (e.pointerType === 'mouse' && e.ctrlKey) return;
      if (e.pointerType !== 'touch') e.preventDefault();
      inkCanvas.setPointerCapture(e.pointerId);
      const p = inkPoint(e);
      inkStroke = { color: inkPrefs().color, width: inkPrefs().width, pts: [p] };
      state.ink.push(inkStroke);
      drawStroke(inkStroke);
    });
    inkCanvas.addEventListener('pointermove', (e) => {
      if (!inkStroke) return;
      const p = inkPoint(e);
      const prev = inkStroke.pts[inkStroke.pts.length - 1];
      if (Math.abs(p[0] - prev[0]) + Math.abs(p[1] - prev[1]) < 1.2) return;
      inkStroke.pts.push(p);
      inkCtx.strokeStyle = inkStroke.color;
      inkCtx.lineWidth = inkStroke.width;
      inkCtx.beginPath();
      inkCtx.moveTo(prev[0], prev[1]);
      inkCtx.lineTo(p[0], p[1]);
      inkCtx.stroke();
    });
    const end = () => { if (inkStroke) { inkStroke = null; save(); } };
    inkCanvas.addEventListener('pointerup', end);
    inkCanvas.addEventListener('pointercancel', end);

    $('#inkBall').addEventListener('click', () => { setInkMode(!inkMode); syncInkUI(); });
    $('#inkColors').addEventListener('click', (e) => {
      const b = e.target.closest('.ink-color');
      if (!b) return;
      inkPrefs().color = b.dataset.color;
      syncInkUI();
      setInkMode(true);
    });
    $('#inkWidths').addEventListener('click', (e) => {
      const b = e.target.closest('.ink-dot');
      if (!b) return;
      inkPrefs().width = Number(b.dataset.w);
      syncInkUI();
      setInkMode(true);
    });
    $('#inkUndo').addEventListener('click', () => { state.ink.pop(); redrawInk(); save(); });
    $('#inkClear').addEventListener('click', () => {
      if (!state.ink.length || confirm('清空当前对话的笔迹？')) {
        state.ink = [];
        redrawInk();
        save();
      }
    });
    $('#inkDone').addEventListener('click', () => setInkMode(false));

    new ResizeObserver(scheduleInkResize).observe(canvasEl);
    const inner = canvasEl.querySelector('.canvas-inner');
    if (inner) new ResizeObserver(scheduleInkResize).observe(inner);
    window.addEventListener('resize', scheduleInkResize);
    syncInkUI();
  }

  /* ------------------------------------------------------ canvas_control - */
  function controlCanvas(input) {
    return new Promise((resolve) => {
      const id = String(input.block_id || '');
      const ifr = document.querySelector('iframe[data-lc-block="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if (!ifr) { resolve({ ok: false, output: '错误：找不到块 ' + id + '，或该块不是 html 组件' }); return; }
      let done = false;
      const finish = (r) => { if (done) return; done = true; window.removeEventListener('message', onMsg); clearTimeout(timer); resolve(r); };
      const onMsg = (e) => {
        const d = e.data;
        if (!d || d.type !== 'lc:result') return;
        finish({ ok: d.ok !== false, output: '组件回报：' + JSON.stringify(d.data != null ? d.data : (d.note || 'ok')).slice(0, 4000) });
      };
      const timer = setTimeout(() => finish({ ok: true, output: '指令已发送到组件 ' + id + '（未收到 lc:result 回报，组件可能未实现应答）' }), 2500);
      window.addEventListener('message', onMsg);
      try {
        ifr.contentWindow.postMessage({ type: 'lc:command', action: input.action, value: input.value === undefined ? null : input.value, note: input.note || '' }, '*');
      } catch (err) {
        finish({ ok: false, output: '发送失败：' + String((err && err.message) || err) });
      }
    });
  }

  /* --------------------------------------------------------------- voice -- */
  const orb = $('#voiceOrb');
  const orbTipEl = $('#voiceOrbTip');
  let ptt = null;
  let pttStarting = false;
  let audioCtx = null;
  let speakQueue = [];
  let speaking = false;
  let speechGen = 0;
  let currentSource = null;
  let currentAudio = null;
  let currentStop = null;
  let voiceStatusCache = null;

  function speechText(text) {
    let s = String(text || '');
    s = s.replace(/```[\s\S]*?```/g, ' ');
    s = s.replace(/\$\$[\s\S]*?\$\$/g, ' ');
    s = s.replace(/\$[^$\n]*\$/g, ' ');
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = s.replace(/https?:\/\/\S+/g, ' ');
    s = s.replace(/[#>*_`~|]/g, ' ');
    s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  /* 按句切块，长段落拆成多段依次合成，避免一次性合成过长文本 */
  function splitSpeech(text, maxLen = 80) {
    const s = speechText(text);
    if (!s) return [];
    const parts = s.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [s];
    const out = [];
    let buf = '';
    for (const p of parts) {
      const seg = p.trim();
      if (!seg) continue;
      if (buf && buf.length + seg.length > maxLen) { out.push(buf); buf = ''; }
      buf += seg;
      while (buf.length > maxLen * 2) { out.push(buf.slice(0, maxLen)); buf = buf.slice(maxLen); }
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  function ensureAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function stopSpeech() {
    speechGen += 1;
    speakQueue = [];
    speaking = false;
    if (currentSource) {
      try { currentSource.stop(); } catch (_) {}
      currentSource = null;
    }
    if (currentAudio) {
      try { currentAudio.pause(); } catch (_) {}
      currentAudio = null;
    }
    if (currentStop) {
      try { currentStop(); } catch (_) {}
      currentStop = null;
    }
  }

  function enqueueSpeech(text) {
    // 本地引擎合成较慢，切得更短以便尽快出声；Edge 在线合成快，可用长句更自然
    const maxLen = (state.settings.ttsEngine || 'edge') === 'edge' ? 100 : 28;
    const chunks = splitSpeech(text, maxLen);
    if (!chunks.length) return;
    speakQueue.push(...chunks);
    if (!speaking) playSpeechQueue();
  }

  async function playSpeechQueue() {
    if (speaking) return;
    speaking = true;
    const gen = speechGen;
    const request = (text) => window.api.voiceTts({
      text,
      speed: state.settings.ttsSpeed || 1,
      engine: state.settings.ttsEngine || 'edge',
      voice: state.settings.ttsVoice || '',
    });
    // 预取下一句：播放当前音频时后台合成下一句，减少句间空档
    let prefetched = null;
    try {
      while (gen === speechGen && (speakQueue.length || prefetched)) {
        let req;
        if (prefetched && prefetched.text === speakQueue[0]) {
          speakQueue.shift();
          req = prefetched.promise;
        } else {
          req = request(speakQueue.shift());
        }
        prefetched = null;
        if (speakQueue.length) {
          const nt = speakQueue[0];
          prefetched = { text: nt, promise: request(nt) };
        }
        let r;
        try {
          r = await req;
        } catch (err) {
          if (gen !== speechGen) break;
          setStatus('朗读失败：' + ((err && err.message) || err));
          continue;
        }
        if (gen !== speechGen) break;
        if (!r || !r.ok) {
          setStatus('朗读失败：' + ((r && r.error) || '未知错误'));
          if (r && r.needDownload) refreshVoiceUi();
          continue;
        }
        if (r.audio) await playBase64Audio(r.audio);
        else await playSamples(r.samples, r.sampleRate);
      }
    } finally {
      // 预取的结果没人消费时忽略，避免未处理的 rejection
      if (prefetched && prefetched.promise && prefetched.promise.catch) prefetched.promise.catch(() => {});
      if (gen === speechGen) speaking = false;
    }
  }

  function playSamples(samples, sampleRate) {
    return new Promise((resolve) => {
      const ctx = ensureAudioCtx();
      const f32 = samples instanceof Float32Array ? samples : new Float32Array(samples);
      if (!f32.length) return resolve();
      const buf = ctx.createBuffer(1, f32.length, sampleRate || 44100);
      buf.copyToChannel(f32, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      currentSource = src;
      const ms = Math.round((buf.duration || 0) * 1000) + 800;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (currentSource === src) currentSource = null;
        if (currentStop === finish) currentStop = null;
        resolve();
      };
      currentStop = finish;
      src.onended = finish;
      setTimeout(finish, ms);
      try { src.start(); } catch (_) { finish(); }
    });
  }

  function base64ToBlobUrl(b64, mime) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  }

  function playBase64Audio(b64) {
    return new Promise((resolve) => {
      let url = '';
      let a;
      try {
        url = base64ToBlobUrl(b64, 'audio/mpeg');
        a = new Audio(url);
      } catch (_) { return resolve(); }
      currentAudio = a;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (currentAudio === a) currentAudio = null;
        if (currentStop === finish) currentStop = null;
        if (url) URL.revokeObjectURL(url);
        resolve();
      };
      currentStop = finish;
      a.onended = finish;
      a.onerror = finish;
      const ms = (a.duration && isFinite(a.duration) ? a.duration * 1000 : 120000) + 1500;
      setTimeout(finish, ms);
      const p = a.play();
      if (p && p.catch) p.catch(finish);
    });
  }

  /* 按住空格说话 ---------------------------------------------------------- */
  function resampleTo16k(input, fromRate) {
    if (fromRate === 16000) return input;
    const ratio = fromRate / 16000;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const frac = pos - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return out;
  }

  function showOrb(thinking) {
    orb.classList.remove('hidden');
    orb.classList.toggle('thinking', !!thinking);
    orbTipEl.textContent = thinking ? '识别中…' : '松手发送';
  }

  function hideOrb() { orb.classList.add('hidden'); }

  async function startPTT() {
    if (ptt || pttStarting) return;
    if (!state.settings.voiceInput) return;
    if (!$('#settingsModal').classList.contains('hidden')) return;
    if (document.body.classList.contains('ink-open')) return;
    pttStarting = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const source = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const chunks = [];
      let level = 0;
      proc.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(d));
        let sum = 0;
        for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
        level = Math.sqrt(sum / d.length);
        if (ptt) ptt.level = level;
      };
      source.connect(proc);
      proc.connect(ctx.destination);
      ptt = { ctx, stream, source, proc, chunks, level: 0, raf: 0 };
      showOrb(false);
      const tick = () => {
        if (!ptt) return;
        const lv = Math.min(1, ptt.level * 9);
        orb.querySelectorAll('.orb-core span').forEach((s, i) => {
          s.style.transform = 'scaleY(' + (0.7 + lv * (0.6 + Math.abs(Math.sin((Date.now() / 140) + i)) * 1.6)) + ')';
          s.style.animation = 'none';
        });
        ptt.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (err) {
      pttStarting = false;
      hideOrb();
      setStatus('无法使用麦克风：' + ((err && err.message) || err));
      return;
    }
    pttStarting = false;
  }

  async function finishPTT() {
    if (pttStarting) { pttStarting = false; }
    if (!ptt) return;
    const p = ptt;
    ptt = null;
    cancelAnimationFrame(p.raf);
    try { p.proc.disconnect(); p.source.disconnect(); } catch (_) {}
    p.stream.getTracks().forEach((t) => t.stop());
    const rate = p.ctx.sampleRate;
    p.ctx.close().catch(() => {});
    let total = 0;
    for (const c of p.chunks) total += c.length;
    if (!total || total < rate * 0.25) {
      hideOrb();
      setStatus('说话时间太短');
      return;
    }
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of p.chunks) { merged.set(c, off); off += c.length; }
    const samples = resampleTo16k(merged, rate);
    showOrb(true);
    let r;
    try {
      r = await window.api.voiceAsr(samples, 16000);
    } catch (err) {
      r = { ok: false, error: (err && err.message) || String(err) };
    }
    hideOrb();
    if (!r || !r.ok) {
      setStatus('识别失败：' + ((r && r.error) || '未知错误'));
      if (r && r.needDownload) refreshVoiceUi();
      return;
    }
    const text = String(r.text || '').trim();
    if (!text) { setStatus('没听清，再说一次？'); return; }
    if (busy) {
      inputEl.value = (inputEl.value ? inputEl.value + ' ' : '') + text;
      autoGrow();
      inputEl.focus();
      setStatus('已填入输入框（AI 正在回答）');
      return;
    }
    inputEl.value = text;
    autoGrow();
    send();
  }

  /* 模型状态 / 下载 -------------------------------------------------------- */
  async function refreshVoiceUi() {
    let st;
    try { st = await window.api.voiceStatus(); } catch (_) { st = null; }
    voiceStatusCache = st;
    const hint = $('#voiceModelHint');
    const line = $('#voiceStatusLine');
    const btn = $('#btnVoiceDownload');
    const setText = (t) => { if (hint) hint.textContent = t; if (line) line.textContent = t; };
    if (!hint && !line) return;
    const engine = state.settings.ttsEngine || 'edge';
    if (engine === 'edge') {
      setText(st ? (st.asrReady ? 'Edge 在线语音就绪（识别模型已装）' : 'Edge 在线语音就绪（识别模型未安装）') : '语音服务不可用');
      if (btn) btn.hidden = true;
      return;
    }
    if (engine === 'system') {
      setText('使用 macOS 系统语音，无需下载');
      if (btn) btn.hidden = true;
      return;
    }
    if (!st) { setText('语音服务不可用'); if (btn) btn.hidden = true; return; }
    if (engine === 'kokoro') {
      if (st.kokoroReady) {
        setText('Kokoro 本地模型已就绪');
        if (btn) btn.hidden = true;
      } else {
        setText('Kokoro 本地模型未安装');
        if (btn) { btn.hidden = false; btn.textContent = '下载 Kokoro 模型'; }
      }
      return;
    }
    if (st.ttsReady) {
      setText('本地模型已就绪');
      if (btn) btn.hidden = true;
    } else {
      setText('本地朗读模型未安装');
      if (btn) { btn.hidden = false; btn.textContent = '下载朗读模型'; }
    }
  }

  async function downloadVoiceModels() {
    const btn = $('#btnVoiceDownload');
    const bar = $('#voiceProgress');
    const fill = bar && bar.querySelector('i');
    btn.disabled = true;
    btn.textContent = '下载中…';
    bar.hidden = false;
    const off = window.api.onVoiceProgress((p) => {
      if (!p) return;
      if (p.finished) { if (fill) fill.style.width = '100%'; return; }
      const pct = p.len ? Math.round((p.got / p.len) * 100) : 0;
      if (fill) fill.style.width = Math.max(2, pct) + '%';
      const hint = $('#voiceModelHint');
      if (hint) hint.textContent = p.file + (p.len ? ' · ' + pct + '%' : '');
    });
    const r = await window.api.voiceDownload();
    off();
    btn.disabled = false;
    bar.hidden = true;
    if (r && r.ok) { setStatus('语音模型已安装'); refreshVoiceUi(); }
    else { setStatus('模型下载失败：' + ((r && r.error) || '未知错误')); btn.textContent = '重试下载'; }
  }

  function syncVoiceSwitches() {
    const bIn = $('#setVoiceInput');
    const bOut = $('#setVoiceOutput');
    const inOn = !!state.settings.voiceInput;
    const outOn = !!state.settings.voiceOutput;
    if (bIn) bIn.checked = inOn;
    if (bOut) bOut.checked = outOn;
    const eng = $('#setTtsEngine');
    if (eng) eng.value = state.settings.ttsEngine || 'edge';
    const sp = $('#setTtsSpeed');
    if (sp) sp.value = state.settings.ttsSpeed || 1;
    const out = $('#speedOut');
    if (out) out.textContent = Number(state.settings.ttsSpeed || 1).toFixed(1);
    const vsel = $('#setTtsVoice');
    if (vsel) vsel.value = state.settings.ttsVoice || '';
    const btnIn = $('#btnVoiceInput');
    if (btnIn) {
      btnIn.classList.toggle('active', inOn);
      btnIn.setAttribute('aria-pressed', inOn ? 'true' : 'false');
    }
    const btnOut = $('#btnVoiceOutput');
    if (btnOut) {
      btnOut.classList.toggle('active', outOn);
      btnOut.setAttribute('aria-pressed', outOn ? 'true' : 'false');
    }
  }

  let voiceListLoaded = false;
  let voiceListCache = [];
  function populateVoiceSelect() {
    const sel = $('#setTtsVoice');
    if (!sel) return;
    if (!voiceListCache.length && !voiceListLoaded) loadSystemVoices();
    const engine = state.settings.ttsEngine || 'edge';
    const kind = engine === 'edge' ? 'edge' : engine === 'kokoro' ? 'kokoro' : engine === 'melo' ? 'melo' : 'system';
    const keep = state.settings.ttsVoice || '';
    sel.innerHTML = '<option value="">自动选择</option>';
    for (const v of voiceListCache) {
      if (v.kind !== kind) continue;
      const o = document.createElement('option');
      o.value = v.name;
      o.textContent = (v.label || v.name) + '（' + String(v.locale || '').replace('_', '-') + (v.sample ? ' · ' + v.sample : '') + '）';
      sel.appendChild(o);
    }
    sel.value = keep;
    if (sel.value !== keep) sel.value = '';
    state.settings.ttsVoice = sel.value || '';
  }

  async function loadSystemVoices() {
    if (voiceListLoaded) return;
    voiceListLoaded = true;
    try { voiceListCache = await window.api.voiceVoices(); } catch (_) { voiceListCache = []; }
    populateVoiceSelect();
  }

  async function runTurn() {
    if (busy) return;
    setBusy(true);
    stopSpeech();
    let spokeThisTurn = false;
    let voiceRetry = 0;
    const apiMessages = buildApiMessages();
    const turnT0 = performance.now();
    let rounds = 0;

    while (rounds++ < 12) {
      const entry = { id: uid(), role: 'assistant', text: '', displayText: '', steps: [], canvasLogs: [], ts: Date.now() };
      const view = buildAssistantView(entry, true);
      let raw = '';
      let reasoning = '';
      const res = await callModel(apiMessages, (d) => {
        if (d.kind === 'reasoning') { reasoning += d.text; view.setThinking(reasoning); }
        else { raw += d.text; view.append(raw); }
      });

      if (!res || !res.ok) {
        const msg = (res && res.aborted) ? '已停止。' : ('请求失败：' + ((res && res.error) || '未知错误'));
        view.error(msg);
        entry.displayText = msg;
        state.chat.push(entry);
        save();
        break;
      }

      if (!raw && res.text) raw = res.text;
      const { ops, tools, clean } = parseBlocks(raw);

      entry.text = raw;
      entry.displayText = clean;
      entry.usage = (res && res.usage) || null;
      if (entry.usage) view.setUsage(entry.usage);
      updateUsageChip();

      let logs = [];
      if (ops.length) {
        logs = window.CanvasView.applyOps(ops);
        state.blocks = window.CanvasView.getBlocks();
      }
      entry.canvasLogs = logs;
      view.addCanvasLogs(logs);

      // 工具
      let stepCount = 0;
      const stepT0 = performance.now();
      if (tools.length) {
        apiMessages.push({ role: 'assistant', content: raw });
        for (const tool of tools) {
          const row = view.addStepRow(tool.name, toolArgSummary(tool.name, tool.input));
          const t0 = performance.now();
          const input = { ...(tool.input || {}) };
          if ((tool.name === 'web_search' || tool.name === 'web_fetch') && !input.bin && state.settings.searchBin) {
            input.bin = state.settings.searchBin;
          }
          let result;
          try {
            if (tool.name === 'canvas_control') result = await controlCanvas(input);
            else if (tool.name === 'speak') {
              const say = speechText(input.text || input.content || '');
              if (!say) result = { ok: false, output: '没有可朗读的内容' };
              else if (!state.settings.voiceOutput) result = { ok: false, output: '语音朗读已关闭（用户没开"语音朗读"）' };
              else if (spokeThisTurn) result = { ok: false, output: '本轮已经朗读过，已忽略本次调用（每轮只朗读一次）' };
              else {
                spokeThisTurn = true;
                enqueueSpeech(say);
                result = { ok: true, output: '已开始朗读（' + say.length + ' 字）。本轮不要再调用 speak。' };
              }
            } else result = await window.api.runTool(tool.name, input, state.settings.workdir);
          } catch (err) {
            result = { ok: false, output: String((err && err.message) || err) };
          }
          const ms = performance.now() - t0;
          view.finishStep(row, result, ms);
          stepCount++;
          entry.steps.push({
            name: tool.name,
            arg: toolArgSummary(tool.name, tool.input),
            ok: !!(result && result.ok),
            ms,
            output: String((result && result.output) || '').slice(0, 1200),
          });
          const out = String((result && result.output) || '').slice(0, 12000);
          apiMessages.push({
            role: 'user',
            content: `<tool_result name="${tool.name}" status="${result && result.ok ? 'ok' : 'error'}">\n${out}\n</tool_result>`,
          });
        }
        entry.totalMs = performance.now() - stepT0;
      }

      view.finishSteps(stepCount, entry.totalMs || 0);
      view.finalize(clean);
      entry.totalMs = Math.round(entry.totalMs || 0);
      state.chat.push(entry);
      lastAssistantText = clean;
      updateRailSnippet();
      updateUsageChip();
      save();

      if (!tools.length) {
        // 硬约束：语音开启时，本轮必须调用一次 speak，否则不允许结束对话
        if (state.settings.voiceOutput && !spokeThisTurn && voiceRetry < 2 && (clean || '').trim()) {
          voiceRetry++;
          apiMessages.push({ role: 'assistant', content: raw });
          apiMessages.push({
            role: 'user',
            content: '<system>你还没有调用 speak 工具。用户开启了语音，本轮必须调用且只调用一次 speak 播报内容，否则本轮不完整。现在请只输出一个 ```tool 代码块的 speak 调用，text 写完整要朗读的内容，不要再输出其他内容。</system>',
          });
          setStatus('等待语音播报…');
          continue;
        }
        break;
      }
      setStatus('继续思考…');
    }

    const total = performance.now() - turnT0;
    setBusy(false);
    setStatus('');
    state.blocks = window.CanvasView.getBlocks();
    save();

    if (state.ui.collapsed) {
      updatePeek();
      railDot.classList.add('new');
    } else if (total > 0) {
      scrollBottom();
    }

    // 语音开启时兜底：AI 若没调用 speak，就朗读本轮最终回答
    if (state.settings.voiceOutput && !spokeThisTurn && lastAssistantText) {
      enqueueSpeech(lastAssistantText);
    }
  }

  /* -------------------------------------------------------- composer ----- */
  function renderChips() {
    chipsEl.innerHTML = '';
    attachments.forEach((src, i) => {
      const c = el('span', 'chip');
      const im = el('img');
      im.src = src;
      im.style.cssText = 'width:18px;height:18px;object-fit:cover;border-radius:4px';
      const x = el('button', 'chip-x', '✕');
      x.addEventListener('click', () => { attachments.splice(i, 1); renderChips(); });
      c.append(im, el('span', 'chip-text', '图片 ' + (i + 1)), x);
      chipsEl.appendChild(c);
    });
    chips.forEach((s, i) => {
      const c = el('span', 'chip');
      const label = s.blockId + ' · ' + s.start + '–' + s.end + ' 行';
      const preview = (s.preview || '').replace(/\s+/g, ' ').slice(0, 42);
      const x = el('button', 'chip-x', '✕');
      x.addEventListener('click', () => { chips.splice(i, 1); renderChips(); });
      const t = el('span', 'chip-text', label + (preview ? ' · ' + preview : ''));
      c.append(el('span', 'chip-text', '引用'), t, x);
      chipsEl.appendChild(c);
    });
  }

  function quoteLabel(sel) {
    return '块 ' + sel.blockId + (sel.title ? '「' + sel.title + '」' : '') + ' · ' + sel.kind + ' · 源码第 ' + sel.start + '–' + sel.end + ' 行（共 ' + sel.total + ' 行）';
  }

  function buildQuoteApi(sel) {
    const b = window.CanvasView.getBlock(sel.blockId);
    if (!b) return '';
    const lines = String(b.source || '').split('\n');
    const whole = lines.length <= 32;
    const from = whole ? 1 : Math.max(1, sel.start - 8);
    const to = whole ? lines.length : Math.min(lines.length, sel.end + 8);
    const numbered = [];
    for (let i = from; i <= to; i++) numbered.push(String(i).padStart(4) + '| ' + lines[i - 1]);
    return [
      '【框选引用】' + quoteLabel(sel),
      '选中文本：',
      (sel.preview || '').slice(0, 800),
      whole ? '该块完整源码（带行号）：' : '该块源码（带行号，含选中行附近上下文）：',
      numbered.join('\n'),
    ].join('\n');
  }

  async function send() {
    if (busy) return;
    const typed = inputEl.value.trim();
    if (!typed && !chips.length && !attachments.length) return;

    const quotesApi = chips.map(buildQuoteApi).filter(Boolean);
    const quotesDisplay = chips.map((s) => ({
      label: s.blockId + ' · 第 ' + s.start + '–' + s.end + ' 行' + (s.title ? ' · ' + s.title : ''),
      preview: (s.preview || '').replace(/\s+/g, ' ').slice(0, 90),
    }));
    const fullText = [typed, ...quotesApi].filter(Boolean).join('\n\n');

    const entry = {
      id: uid(),
      role: 'user',
      text: fullText,
      displayText: typed,
      quotes: quotesDisplay,
      images: attachments.slice(),
      ts: Date.now(),
    };
    state.chat.push(entry);
    renderUserEntry(entry);
    scrollBottom();

    inputEl.value = '';
    autoGrow();
    chips = [];
    attachments = [];
    renderChips();
    save();

    await runTurn();
  }

  /* ---------------------------------------------------------- selection -- */
  function hidePill() { pill.classList.add('hidden'); }

  function showPill(info) {
    if (!info || !info.rect) return hidePill();
    const paneRect = canvasPane.getBoundingClientRect();
    let x = info.rect.left - paneRect.left + info.rect.width / 2;
    let y = info.rect.top - paneRect.top;
    const below = y < 110;
    if (below) y = info.rect.bottom - paneRect.top + 9;
    x = Math.max(90, Math.min(x, paneRect.width - 90));
    y = Math.max(8, y);
    pill.classList.toggle('below', below);
    pill.style.left = x + 'px';
    pill.style.top = y + 'px';
    pillText.textContent = info.selections.length > 1
      ? '引用 ' + info.selections.length + ' 处 · 发送给 AI'
      : '引用 ' + info.selections[0].blockId + ' · ' + info.selections[0].start + '–' + info.selections[0].end + ' 行';
    pill.classList.remove('hidden');
  }

  function checkSelection() {
    const info = window.CanvasView.selectionInfo();
    if (!info) return hidePill();
    showPill(info);
  }

  function attachSelection() {
    const info = window.CanvasView.selectionInfo();
    if (!info) return;
    for (const s of info.selections) {
      const dup = chips.some((c) => c.blockId === s.blockId && c.start === s.start && c.end === s.end);
      if (!dup) chips.push(s);
    }
    renderChips();
    hidePill();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    inputEl.focus();
  }

  /* --------------------------------------------------------- collapse ---- */
  function updateRailSnippet() {
    railSnippet.textContent = (lastAssistantText || '').replace(/[#*`>]/g, '').slice(0, 400);
    updatePeek();
  }

  function updatePeek() {
    if (!state.ui.collapsed) { peekEl.classList.add('hidden'); return; }
    if (!lastAssistantText) { peekEl.classList.add('hidden'); return; }
    peekEl.textContent = lastAssistantText.replace(/[#*`>]/g, '').slice(0, 300);
    peekEl.classList.remove('hidden');
  }

  function setCollapsed(v) {
    state.ui.collapsed = !!v;
    document.body.classList.toggle('chat-collapsed', state.ui.collapsed);
    if (state.ui.collapsed) {
      floatHost.appendChild(composerWrap);
      floatDock.classList.remove('hidden');
      updatePeek();
      railDot.classList.remove('new');
      railDot.style.display = '';
    } else {
      composerSlot.parentNode.insertBefore(composerWrap, composerSlot);
      floatDock.classList.add('hidden');
      peekEl.classList.add('hidden');
      railDot.classList.remove('new');
      scrollBottom();
    }
    save();
  }

  /* ------------------------------------------------------------- layout -- */
  function applyChatWidth(w) {
    state.ui.chatWidth = w;
    document.documentElement.style.setProperty('--chat-w', w + 'px');
  }

  function initSplitter() {
    const splitter = $('#splitter');
    let dragging = false;
    splitter.addEventListener('pointerdown', (e) => {
      dragging = true;
      splitter.classList.add('dragging');
      splitter.setPointerCapture(e.pointerId);
      document.body.style.userSelect = 'none';
    });
    splitter.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = $('#workspace').getBoundingClientRect();
      let w = rect.right - e.clientX;
      w = Math.max(320, Math.min(w, rect.width - 360));
      applyChatWidth(Math.round(w));
    });
    splitter.addEventListener('pointerup', () => {
      dragging = false;
      splitter.classList.remove('dragging');
      document.body.style.userSelect = '';
      save();
    });
    splitter.addEventListener('dblclick', () => { applyChatWidth(400); save(); });
  }

  /* ------------------------------------------------------------ settings - */
  function applyTheme(t) {
    const theme = t === 'dark' ? 'dark' : 'light';
    state.settings.theme = theme;
    document.documentElement.dataset.theme = theme;
    window.CanvasView.setTheme(theme);
    document.querySelectorAll('#themeSplit button').forEach((b) => {
      b.classList.toggle('active', b.dataset.themeValue === theme);
    });
  }

  function applyDetails() {
    document.body.classList.toggle('show-usage', !!state.settings.details);
    updateUsageChip();
  }

  function syncThinkSeg() {
    const v = state.settings.thinking || 'medium';
    document.querySelectorAll('#thinkSeg button').forEach((b) => {
      b.classList.toggle('active', b.dataset.think === v);
    });
  }

  function openSettings() {
    document.querySelectorAll('#themeSplit button').forEach((b) => {
      b.classList.toggle('active', b.dataset.themeValue === (state.settings.theme || 'light'));
    });
    $('#setBaseUrl').value = state.settings.baseUrl || '';
    $('#setApiKey').value = state.settings.apiKey || '';
    $('#setModel').value = state.settings.model || '';
    $('#setDetails').checked = !!state.settings.details;
    $('#setTemperature').value = state.settings.temperature;
    $('#tempOut').textContent = Number(state.settings.temperature ?? 0.6).toFixed(1);
    $('#setWorkdir').value = state.settings.workdir || '';
    $('#setSearchBin').value = state.settings.searchBin || '';
    $('#workdirHint').textContent = state.settings.workdir || '~/LearnCanvas';
    loadSystemVoices();
    syncVoiceSwitches();
    refreshVoiceUi();
    $('#settingsModal').classList.remove('hidden');
  }

  function closeSettings() { $('#settingsModal').classList.add('hidden'); }

  function saveSettings() {
    state.settings.baseUrl = $('#setBaseUrl').value.trim() || DEFAULT_SETTINGS.baseUrl;
    state.settings.apiKey = $('#setApiKey').value.trim();
    state.settings.model = $('#setModel').value.trim() || DEFAULT_SETTINGS.model;
    state.settings.details = $('#setDetails').checked;
    const t = Number($('#setTemperature').value);
    state.settings.temperature = isNaN(t) ? 0.6 : Math.max(0, Math.min(1.5, t));
    state.settings.workdir = $('#setWorkdir').value.trim() || DEFAULT_SETTINGS.workdir;
    state.settings.searchBin = $('#setSearchBin').value.trim();
    state.settings.voiceInput = $('#setVoiceInput').checked;
    state.settings.voiceOutput = $('#setVoiceOutput').checked;
    state.settings.ttsEngine = $('#setTtsEngine').value || 'edge';
    state.settings.ttsVoice = $('#setTtsVoice').value || '';
    const sp = Number($('#setTtsSpeed').value);
    state.settings.ttsSpeed = isNaN(sp) ? 1 : Math.max(0.6, Math.min(1.5, sp));
    $('#modelChip').textContent = state.settings.model;
    syncVoiceSwitches();
    applyDetails();
    closeSettings();
    save();
  }

  /* ------------------------------------------------------------ helpers -- */
  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 168) + 'px';
  }

  function updateEmptyState() {
    let empty = document.getElementById('canvasEmpty');
    const hasBlocks = window.CanvasView.getBlocks().length > 0;
    if (hasBlocks) { if (empty) empty.remove(); return; }
    if (empty) return;
    empty = el('div', 'canvas-empty');
    empty.id = 'canvasEmpty';
    empty.innerHTML =
      '<h1>想让 AI 教你点什么？</h1>' +
      '<p>在右侧输入任何知识点（例如“讲讲微积分里的极限”），AI 会在左侧画布上用图、公式、交互演示来讲解。</p>' +
      '<p>用三指拖拽或鼠标框选画布内容，按 <kbd>⏎</kbd> 引用给 AI：会把「块 ID + 源码行号 + 附近源码」一并带上。</p>' +
      '<p>AI 还能读写文件、执行命令、联网搜索 —— 模型与工作目录在「设置」里调整。</p>';
    canvasEl.prepend(empty);
  }

  function readImageFile(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  async function addImageFiles(files) {
    for (const f of files) {
      if (!f.type || !f.type.startsWith('image/')) continue;
      if (f.size > 6 * 1024 * 1024) continue;
      const url = await readImageFile(f);
      attachments.push(url);
    }
    renderChips();
  }

  function newSession() {
    if (busy) return;
    syncActive();
    const s = makeSession();
    state.sessions.unshift(s);
    chips = [];
    attachments = [];
    lastAssistantText = '';
    loadSession(s);
    renderChips();
    closeSettings();
    save();
    inputEl.focus();
  }

  /* ------------------------------------------------------------- events -- */
  function bindEvents() {
    $('#btnSettings').addEventListener('click', openSettings);
    $('#btnCloseSettings').addEventListener('click', closeSettings);
    $('#btnSaveSettings').addEventListener('click', saveSettings);
    $('#settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') closeSettings(); });
    $('#btnPickWorkdir').addEventListener('click', async () => {
      const p = await window.api.pickFolder();
      if (p) $('#setWorkdir').value = p;
    });

    document.querySelectorAll('#themeSplit button').forEach((b) => {
      b.addEventListener('click', () => { applyTheme(b.dataset.themeValue); save(); });
    });
    document.querySelectorAll('#thinkSeg button').forEach((b) => {
      b.addEventListener('click', () => {
        state.settings.thinking = b.dataset.think;
        syncThinkSeg();
        save();
      });
    });
    $('#setDetails').addEventListener('change', (e) => {
      state.settings.details = e.target.checked;
      applyDetails();
      save();
    });
    $('#btnCollapseInline').addEventListener('click', () => setCollapsed(true));
    $('#btnExpandRail').addEventListener('click', () => setCollapsed(false));
    $('#btnSidebarOpen').addEventListener('click', () => setSidebar(true));
    $('#btnSidebarClose').addEventListener('click', () => setSidebar(false));
    $('#btnNewSession').addEventListener('click', newSession);
    $('#btnImportSession').addEventListener('click', importSession);
    $('#setTemperature').addEventListener('input', (e) => { $('#tempOut').textContent = Number(e.target.value).toFixed(1); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (document.body.classList.contains('ink-open')) { setInkMode(false); return; }
      if (!$('#settingsModal').classList.contains('hidden')) { closeSettings(); return; }
    });
    $('#btnStop').addEventListener('click', () => { stopSpeech(); if (currentReqId) window.api.abort(currentReqId); });

    // 语音输入 / 语音朗读：两个独立开关，可各自单开
    const applyVoiceInput = (on) => {
      state.settings.voiceInput = !!on;
      const sw = $('#setVoiceInput');
      if (sw) sw.checked = !!on;
      const btn = $('#btnVoiceInput');
      if (btn) {
        btn.classList.toggle('active', !!on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      if (!on && ptt) finishPTT();
      setStatus(on ? '语音输入已开启' : '语音输入已关闭');
      save();
    };
    const applyVoiceOutput = (on) => {
      state.settings.voiceOutput = !!on;
      const sw = $('#setVoiceOutput');
      if (sw) sw.checked = !!on;
      const btn = $('#btnVoiceOutput');
      if (btn) {
        btn.classList.toggle('active', !!on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      if (!on) stopSpeech();
      setStatus(on ? '语音朗读已开启' : '语音朗读已关闭');
      save();
    };
    $('#btnVoiceInput').addEventListener('click', () => applyVoiceInput(!state.settings.voiceInput));
    $('#btnVoiceOutput').addEventListener('click', () => applyVoiceOutput(!state.settings.voiceOutput));
    $('#setVoiceInput').addEventListener('change', (e) => applyVoiceInput(e.target.checked));
    $('#setVoiceOutput').addEventListener('change', (e) => applyVoiceOutput(e.target.checked));
    $('#setTtsEngine').addEventListener('change', (e) => {
      state.settings.ttsEngine = e.target.value;
      state.settings.ttsVoice = '';
      populateVoiceSelect();
      refreshVoiceUi();
      save();
    });
    $('#setTtsVoice').addEventListener('change', (e) => { state.settings.ttsVoice = e.target.value; save(); });
    $('#setTtsSpeed').addEventListener('input', (e) => {
      const v = Number(e.target.value);
      state.settings.ttsSpeed = v;
      $('#speedOut').textContent = v.toFixed(1);
    });
    $('#setTtsSpeed').addEventListener('change', () => save());
    $('#btnPreviewVoice').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '合成中…';
      try {
        const r = await window.api.voiceTts({
          text: '你好，我是你的学习助手。这句话用来试听当前音色。',
          speed: Number($('#setTtsSpeed').value) || 1,
          engine: $('#setTtsEngine').value || 'edge',
          voice: $('#setTtsVoice').value || '',
        });
        if (r && r.ok && r.audio) playBase64Audio(r.audio);
        else if (r && r.ok && r.samples) playSamples(r.samples, r.sampleRate);
        else setStatus('试听失败：' + ((r && r.error) || '未知错误'));
      } catch (err) {
        setStatus('试听失败：' + ((err && err.message) || err));
      }
      btn.disabled = false;
      btn.textContent = '试听';
    });
    $('#btnVoiceDownload').addEventListener('click', downloadVoiceModels);

    // 按住空格说话，松手发送
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || e.repeat) return;
      const ae = document.activeElement;
      const tag = ae && ae.tagName;
      if (ae === inputEl) {
        // 输入框为空时，空格用来说话；已经在输入内容时，空格正常输入
        if (inputEl.value.trim()) return;
      } else if (tag === 'TEXTAREA' || tag === 'INPUT' || (ae && ae.isContentEditable)) return;
      if (!$('#settingsModal').classList.contains('hidden')) return;
      if (document.body.classList.contains('ink-open')) return;
      if (!pill.classList.contains('hidden')) return;
      e.preventDefault();
      startPTT();
    });
    document.addEventListener('keyup', (e) => {
      if (e.code !== 'Space' || !ptt) return;
      e.preventDefault();
      finishPTT();
    });
    window.addEventListener('blur', () => { if (ptt) finishPTT(); });

    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('input', autoGrow);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
    inputEl.addEventListener('paste', async (e) => {
      const items = Array.from((e.clipboardData && e.clipboardData.files) || []);
      if (items.length) { e.preventDefault(); await addImageFiles(items); }
    });
    composerWrap.addEventListener('dragover', (e) => e.preventDefault());
    composerWrap.addEventListener('drop', async (e) => {
      e.preventDefault();
      await addImageFiles(Array.from(e.dataTransfer.files || []));
    });

    $('#attachBtn').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', async (e) => {
      await addImageFiles(Array.from(e.target.files || []));
      e.target.value = '';
    });

    pill.addEventListener('click', attachSelection);
    peekEl.addEventListener('click', () => setCollapsed(false));

    // 三指拖拽 / 鼠标拖拽框选：selectionchange 实时跟随
    let selTimer = null;
    document.addEventListener('selectionchange', () => {
      clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) { hidePill(); return; }
        checkSelection();
      }, 160);
    });

    document.addEventListener('mousedown', (e) => {
      if (canvasPane.contains(e.target)) return;
      hidePill();
    });

    document.addEventListener('mouseup', (e) => {
      if (pill.contains(e.target)) return;
      setTimeout(checkSelection, 10);
    });
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Escape') return hidePill();
      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) setTimeout(checkSelection, 10);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag !== 'TEXTAREA' && tag !== 'INPUT' && !pill.classList.contains('hidden')) {
          e.preventDefault();
          attachSelection();
        }
      }
      if (e.key === 'Escape') { hidePill(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setCollapsed(!state.ui.collapsed);
      }
    });
    canvasEl.addEventListener('scroll', hidePill, { passive: true });
  }

  /* --------------------------------------------------------------- boot -- */
  async function boot() {
    let saved = null;
    try { saved = await window.api.loadState(); } catch (e) {}
    if (saved) {
      Object.assign(state.settings, saved.settings || {});
      // 一次性迁移：旧版默认的本地引擎改为 Edge 在线语音
      if (!state.settings.engineMigrated) {
        state.settings.engineMigrated = true;
        if (state.settings.ttsEngine === 'melo') state.settings.ttsEngine = 'edge';
      }
      // 一次性迁移：旧的「开启语音」总开关拆分为 语音输入 / 语音朗读
      if (!state.settings.voiceSplitMigrated) {
        state.settings.voiceSplitMigrated = true;
        const legacy = saved.settings && typeof saved.settings === 'object' && 'voiceOn' in saved.settings
          ? !!saved.settings.voiceOn
          : false;
        if (state.settings.voiceInput === undefined) state.settings.voiceInput = legacy;
        if (state.settings.voiceOutput === undefined) state.settings.voiceOutput = legacy;
      }
      delete state.settings.voiceOn;
      Object.assign(state.ui, saved.ui || {});
      if (!state.ui.ink) state.ui.ink = { color: '#2b2f36', width: 4 };
      if (Array.isArray(saved.sessions) && saved.sessions.length) {
        state.sessions = saved.sessions.map((s) => ({ ...s, ink: s.ink || [], chat: s.chat || [], blocks: s.blocks || [] }));
        state.activeId = state.sessions.some((s) => s.id === saved.activeId) ? saved.activeId : state.sessions[0].id;
      } else if (saved.blocks || saved.chat) {
        // 旧版本单会话状态 → 迁移为第一个对话
        const s = makeSession();
        s.blocks = saved.blocks || [];
        s.chat = saved.chat || [];
        s.ink = [];
        state.sessions = [s];
        state.activeId = s.id;
      }
    }
    if (!state.sessions.length) {
      const s = makeSession();
      state.sessions = [s];
      state.activeId = s.id;
    }
    const act = currentSession();
    state.blocks = act.blocks || [];
    state.chat = act.chat || [];
    state.ink = act.ink || [];
    const lastA = [...state.chat].reverse().find((m) => m.role === 'assistant');
    if (lastA) lastAssistantText = lastA.displayText || lastA.text || '';

    window.CanvasView.init(canvasEl, {
      onChange: (blocks) => {
        state.blocks = blocks;
        updateEmptyState();
        save();
      },
    });
    applyTheme(state.settings.theme || 'light');
    applyDetails();
    syncThinkSeg();
    window.CanvasView.setBlocks(state.blocks);

    applyChatWidth(state.ui.chatWidth || 420);
    $('#modelChip').textContent = state.settings.model || '未配置模型';
    $('.brand-sub').title = state.settings.baseUrl || '';

    renderChat();
    if (!state.chat.length) renderWelcomeNote();
    renderSessionList();
    bindInk();
    updateEmptyState();
    updateRailSnippet();
    updateUsageChip();
    renderChips();
    bindEvents();
    initSplitter();
    syncVoiceSwitches();
    refreshVoiceUi();
    if (state.ui.collapsed) setCollapsed(true);
    autoGrow();
    inputEl.focus();
  }

  boot();
})();
