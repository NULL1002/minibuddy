/* 迷你搭子 MiniBuddy — 零依赖单页应用
 * 同一份代码同时跑在：Safari(PWA) / WKWebView(自签 iOS 壳)
 */
(function () {
  'use strict';

  var PREFIX = 'mb:';
  var BOOT = window.__MB_BOOTSTRAP__ || null;

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(PREFIX + key);
      if (raw !== null) return JSON.parse(raw);
    } catch (e) { /* 自定义 scheme 下可能不可用，回落到原生注入 */ }
    if (BOOT && Object.prototype.hasOwnProperty.call(BOOT, key)) return BOOT[key];
    return fallback;
  }
  function save(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch (e) {}
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.mbStore) {
        window.webkit.messageHandlers.mbStore.postMessage({ key: key, value: value });
      }
    } catch (e) {}
  }

  var DEFAULT_CFG = {
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    system: '你是「迷你搭子」，一个简洁、务实、说中文的助手。回答尽量短，能直接照做。',
    stream: true
  };

  var state = {
    cfg: Object.assign({}, DEFAULT_CFG, load('cfg', {}) || {}),
    chats: load('chats', []) || [],
    todos: load('todos', []) || [],
    notes: load('notes', []) || [],
    tab: 'chat', filter: 'all', query: '',
    busy: false, controller: null
  };

  var HELP = '我能做这些：\n\n' +
    '**对话** — 在「设置」填 API Key 后接入真实大模型（OpenAI 兼容接口，DeepSeek / 混元 / Kimi / OpenAI 都行）。\n\n' +
    '**待办** — 说「加个待办：整理会议纪要」，或直接去待办页添加。\n\n' +
    '**备忘** — 说「记一下：周五前提交报销单」，内容可随时编辑。\n\n' +
    '**查询** — 说「有哪些待办」「看看备忘」。\n\n' +
    '数据全部存在本机，不上传服务器。';

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function now() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function stamp(ts) {
    var d = new Date(ts || Date.now());
    return d.getMonth() + 1 + '月' + d.getDate() + '日 ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  /* ---------- 极简 Markdown ---------- */
  function md(text) {
    return String(text == null ? '' : text).split(/```/).map(function (part, i) {
      if (i % 2) return '<pre><code>' + esc(part.replace(/^\n/, '').replace(/\n$/, '')) + '</code></pre>';
      var s = esc(part)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
        .replace(/^###\s+(.+)$/gm, '<h4>$1</h4>')
        .replace(/^[-*]\s+(.+)$/gm, '• $1');
      return s.split(/\n{2,}/).map(function (p) {
        return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
      }).join('');
    }).join('');
  }

  /* ---------- 提示 / 弹窗 ---------- */
  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }
  var modalOk = null;
  function showModal(title, content, opts) {
    opts = opts || {};
    $('#modalTitle').textContent = title;
    if (opts.textarea) {
      $('#modalBody').innerHTML = '<textarea id="modalText" class="modal-textarea" spellcheck="false"></textarea>';
      $('#modalText').value = content || '';
    } else {
      $('#modalBody').innerHTML = '<div class="md">' + md(content) + '</div>';
    }
    $('#modalOk').textContent = opts.okLabel || '好';
    $('#modalCancel').style.display = opts.cancel === false ? 'none' : '';
    modalOk = opts.onOk || null;
    $('#modal').classList.add('show');
  }
  function closeModal() { $('#modal').classList.remove('show'); modalOk = null; }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制'); }, function () { legacyCopy(text); });
    } else legacyCopy(text);
  }
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('已复制'); } catch (e) { toast('复制失败，请长按选择'); }
    document.body.removeChild(ta);
  }

  /* ---------- 渲染 ---------- */
  function renderChat() {
    var box = $('#chatScroll');
    if (!state.chats.length) {
      box.innerHTML =
        '<div class="welcome">' +
          '<div class="big">✦</div>' +
          '<h2>嗨，我是迷你搭子</h2>' +
          '<p>一个装得进 iPhone 的简易 AI 助手。能聊天，也能帮你记事儿。</p>' +
          '<div class="cards">' +
            '<div><b>对话</b><span>接自己的模型 Key</span></div>' +
            '<div><b>待办</b><span>一句话记下任务</span></div>' +
            '<div><b>备忘</b><span>随手记，随时改</span></div>' +
            '<div><b>本地存储</b><span>数据不上传</span></div>' +
          '</div>' +
        '</div>';
    } else {
      box.innerHTML = state.chats.map(function (m) {
        var body = m.pending && !m.content
          ? '<span class="typing"><i></i><i></i><i></i></span>'
          : md(m.content);
        return '<div class="msg ' + (m.role === 'user' ? 'me' : 'bot') + '">' +
          '<div class="bubble md">' + body + '</div><time>' + esc(m.time || '') + '</time></div>';
      }).join('');
    }
    box.scrollTop = box.scrollHeight;
  }

  function setMsg(i, text) {
    state.chats[i].content = text;
    var nodes = $$('#chatScroll .msg');
    var bubble = nodes[i] && $('.bubble', nodes[i]);
    if (bubble) {
      bubble.innerHTML = md(text);
      var box = $('#chatScroll'); box.scrollTop = box.scrollHeight;
    } else renderChat();
  }

  function renderTodos() {
    var list = state.todos.filter(function (t) {
      return state.filter === 'all' || (state.filter === 'open' ? !t.done : t.done);
    });
    $('#todoList').innerHTML = list.map(function (t) {
      return '<div class="card ' + (t.done ? 'done' : '') + '">' +
        '<button class="check" data-act="check" data-id="' + t.id + '">✓</button>' +
        '<div class="body"><div class="text">' + esc(t.text) + '</div>' +
        '<div class="meta">' + stamp(t.at) + '</div></div>' +
        '<button class="del" data-act="del" data-id="' + t.id + '" aria-label="删除">×</button>' +
      '</div>';
    }).join('');
    $('#todoEmpty').hidden = list.length > 0;
  }

  function renderNotes() {
    var q = state.query.trim().toLowerCase();
    var list = state.notes.filter(function (n) { return !q || n.text.toLowerCase().indexOf(q) >= 0; });
    $('#noteList').innerHTML = list.map(function (n) {
      return '<div class="note-card" data-id="' + n.id + '">' +
        '<textarea spellcheck="false" data-role="note-text">' + esc(n.text) + '</textarea>' +
        '<div class="foot"><span>' + stamp(n.at) + '</span>' +
        '<button data-act="del">删除</button></div></div>';
    }).join('');
    $('#noteEmpty').hidden = list.length > 0;
  }

  function renderSettings() {
    $('#cfgBase').value = state.cfg.baseUrl || '';
    $('#cfgKey').value = state.cfg.apiKey || '';
    $('#cfgModel').value = state.cfg.model || '';
    $('#cfgSystem').value = state.cfg.system || '';
    $('#cfgStream').checked = !!state.cfg.stream;
  }

  function updateHead() {
    var map = {
      chat: ['对话', state.cfg.apiKey ? '迷你搭子 · 已接入模型' : '迷你搭子 · 离线演示模式'],
      todos: ['待办', '共 ' + state.todos.length + ' 条 · 未完成 ' + state.todos.filter(function (t) { return !t.done; }).length + ' 条'],
      notes: ['备忘', '共 ' + state.notes.length + ' 条'],
      settings: ['设置', '迷你搭子 MiniBuddy']
    };
    $('#pageTitle').textContent = map[state.tab][0];
    $('#pageSub').textContent = map[state.tab][1];
    $('#composerTip').textContent = state.cfg.apiKey
      ? (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.mbFetch
          ? '原生网络通道 · ' + state.cfg.model : '浏览器直连 · ' + state.cfg.model)
      : '离线演示模式 · 去「设置」填 API Key 即可接入真实模型';
  }

  function renderAll() { renderChat(); renderTodos(); renderNotes(); renderSettings(); updateHead(); }

  function switchTab(name) {
    state.tab = name;
    $$('.page').forEach(function (p) { p.hidden = p.id !== 'page-' + name; });
    $$('.tab').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === name); });
    updateHead();
    if (name === 'chat') setTimeout(function () { var b = $('#chatScroll'); b.scrollTop = b.scrollHeight; }, 0);
  }

  /* ---------- 待办 / 备忘操作 ---------- */
  function addTodo(text) {
    state.todos.unshift({ id: uid(), text: text, done: false, at: Date.now() });
    save('todos', state.todos); renderTodos(); updateHead();
  }
  function addNote(text) {
    state.notes.unshift({ id: uid(), text: text, at: Date.now() });
    save('notes', state.notes); renderNotes(); updateHead();
  }

  /* ---------- 离线演示模式 ---------- */
  function localReply(text) {
    var t = text.trim();
    var m;
    if ((m = t.match(/^(?:记一下|记个|备忘|记|note)\s*[:：,，]?\s*(.+)$/i))) {
      addNote(m[1]); return '已存到「备忘」：' + m[1] + '\n\n去「备忘」页可以直接编辑或删除。';
    }
    if ((m = t.match(/^(?:加个待办|添加待办|新建待办|待办|todo)\s*[:：,，]?\s*(.+)$/i))) {
      addTodo(m[1]); return '已加到「待办」：' + m[1] + '\n\n完成后点一下左边的方框就能勾掉。';
    }
    if (/^(有哪些|看看|列出|列表|list|查询)/.test(t) || (/待办|备忘/.test(t) && /吗|多少|几|没/.test(t))) {
      var open = state.todos.filter(function (x) { return !x.done; });
      return '待办共 ' + state.todos.length + ' 条，未完成 ' + open.length + ' 条：\n\n' +
        (open.length ? open.map(function (x) { return '• ' + x.text; }).join('\n') : '（全部完成）') +
        '\n\n备忘 ' + state.notes.length + ' 条。';
    }
    if (/^(你能干啥|能干啥|帮助|help|功能|你好|hi|hello)/i.test(t)) return HELP;
    if (/^(清空对话|清除对话|新建对话)/.test(t)) {
      state.chats = []; save('chats', state.chats); return '对话已清空，我们重新开始吧。';
    }
    return '现在是**离线演示模式**，我只能处理本地能力（待办 / 备忘 / 查询）。\n\n' +
      '你刚才说的是：' + t.slice(0, 80) + (t.length > 80 ? '…' : '') + '\n\n' +
      '想让我接真实大模型聊天，去「设置」填 Base URL + API Key + 模型名即可。' +
      'iPhone 原生壳里已内置网络桥，不受浏览器跨域限制。';
  }
  function typeIn(i, full) {
    return new Promise(function (resolve) {
      var n = 0;
      (function step() {
        n = Math.min(full.length, n + 7);
        setMsg(i, full.slice(0, n));
        if (n < full.length) setTimeout(step, 15); else resolve();
      })();
    });
  }

  /* ---------- 原生网络桥（绕开 CORS） ---------- */
  var nativeSeq = 0, nativePending = {};
  window.__mbNativeCallback = function (id, ok, payload) {
    var p = nativePending[id]; if (!p) return;
    delete nativePending[id];
    if (ok) p.resolve(payload); else p.reject(new Error(payload || '原生请求失败'));
  };
  function nativeFetch(url, headers, body) {
    return new Promise(function (resolve, reject) {
      var id = ++nativeSeq;
      nativePending[id] = { resolve: resolve, reject: reject };
      try {
        window.webkit.messageHandlers.mbFetch.postMessage({ id: id, url: url, headers: headers, body: body });
      } catch (e) { delete nativePending[id]; reject(e); return; }
      setTimeout(function () {
        if (nativePending[id]) { delete nativePending[id]; reject(new Error('请求超时（60 秒）')); }
      }, 60000);
    });
  }
  function hasNativeBridge() {
    return !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.mbFetch);
  }
  function pickContent(data, raw) {
    if (data && data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    var c = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!c) throw new Error('接口没返回内容：' + String(raw || '').slice(0, 160));
    return c;
  }

  /* ---------- 调用模型 ---------- */
  function callModel(i) {
    var c = state.cfg;
    var base = String(c.baseUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('还没填 Base URL');
    var url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
    var messages = [{ role: 'system', content: c.system || '' }].concat(
      state.chats.filter(function (m) {
        return m.role === 'user' || (m.role === 'assistant' && !m.pending && m.content);
      }).slice(-12).map(function (m) { return { role: m.role, content: m.content }; })
    );
    var headers = { 'Content-Type': 'application/json' };
    if (c.apiKey) headers['Authorization'] = 'Bearer ' + c.apiKey;
    var body = { model: c.model || 'deepseek-chat', messages: messages, temperature: 0.7, stream: !!c.stream };

    if (hasNativeBridge()) {
      var nativeBody = Object.assign({}, body, { stream: false });
      return nativeFetch(url, headers, nativeBody).then(function (raw) {
        var data;
        try { data = JSON.parse(raw); } catch (e) { throw new Error('接口返回的不是 JSON：' + String(raw).slice(0, 140)); }
        setMsg(i, pickContent(data, raw));
      });
    }

    var ctrl = new AbortController(); state.controller = ctrl;
    return fetch(url, {
      method: 'POST', headers: headers, body: JSON.stringify(body), signal: ctrl.signal
    }).then(function (res) {
      if (!res.ok) {
        return res.text().catch(function () { return ''; }).then(function (t) {
          throw new Error('HTTP ' + res.status + ' ' + t.slice(0, 160));
        });
      }
      if (!body.stream || !res.body) {
        return res.text().then(function (raw) {
          var data; try { data = JSON.parse(raw); } catch (e) { throw new Error('返回的不是 JSON：' + raw.slice(0, 140)); }
          setMsg(i, pickContent(data, raw));
        });
      }
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = '', acc = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { setMsg(i, acc || '（没有收到内容）'); return; }
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split(/\r?\n/); buf = lines.pop();
          for (var k = 0; k < lines.length; k++) {
            var line = lines[k].trim();
            if (line.indexOf('data:') !== 0) continue;
            var payload = line.slice(5).trim();
            if (payload === '[DONE]') { setMsg(i, acc); return; }
            var j;
            try { j = JSON.parse(payload); } catch (e) { continue; }
            if (j.error) throw new Error(j.error.message || '接口报错');
            var d = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message);
            if (d && typeof d.content === 'string') { acc += d.content; setMsg(i, acc); }
          }
          return pump();
        });
      }
      return pump();
    });
  }

  /* ---------- 发送 ---------- */
  function autoGrow() {
    var el = $('#input');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }
  function setBusy(on) {
    state.busy = on;
    var b = $('#btnSend');
    b.textContent = on ? '■' : '↑';
    b.classList.toggle('stop', on);
  }
  function stop() {
    if (state.controller) { state.controller.abort(); state.controller = null; }
    else toast('原生请求中，暂不可中断');
  }
  function send() {
    if (state.busy) return;
    var input = $('#input'), text = input.value.trim();
    if (!text) return;
    input.value = ''; autoGrow();
    state.chats.push({ role: 'user', content: text, time: now() });
    var idx = state.chats.push({ role: 'assistant', content: '', time: now(), pending: true }) - 1;
    save('chats', state.chats); renderChat(); setBusy(true);

    // 统一包进 Promise，保证 callModel 里的同步 throw 也能被下面的 catch 接住
    var task = Promise.resolve().then(function () {
      return state.cfg.apiKey ? callModel(idx) : typeIn(idx, localReply(text));
    });

    task.catch(function (err) {
      if (err && err.name === 'AbortError') {
        setMsg(idx, state.chats[idx].content + '\n\n（已停止）');
      } else {
        var msg = err && err.message ? err.message : String(err);
        setMsg(idx, '出错了：' + msg + '\n\n去「设置」检查 Base URL / API Key / 模型名；' +
          (hasNativeBridge() ? '也可以换一个网络环境重试。' : '网页版若被跨域(CORS)拦截，把 Base URL 换成自己的代理地址即可。'));
      }
    }).then(function () {
      state.chats[idx].pending = false;
      state.controller = null;
      setBusy(false);
      save('chats', state.chats);
      renderChat();
    });
  }

  /* ---------- 数据导入导出 ---------- */
  function exportData() {
    var data = {
      app: 'MiniBuddy', version: 1, exportedAt: new Date().toISOString(),
      cfg: state.cfg, chats: state.chats, todos: state.todos, notes: state.notes
    };
    showModal('导出数据（含 API Key，请勿外传）', JSON.stringify(data, null, 2), {
      textarea: true, okLabel: '复制全部',
      onOk: function () { copyText($('#modalText').value); }
    });
  }
  function importData() {
    showModal('导入数据', '', {
      textarea: true, okLabel: '导入并覆盖',
      onOk: function () {
        var d;
        try { d = JSON.parse($('#modalText').value.trim()); }
        catch (e) { toast('JSON 格式不对'); return false; }
        if (!d || typeof d !== 'object') { toast('数据格式不对'); return false; }
        if (Array.isArray(d.chats)) state.chats = d.chats;
        if (Array.isArray(d.todos)) state.todos = d.todos;
        if (Array.isArray(d.notes)) state.notes = d.notes;
        if (d.cfg && typeof d.cfg === 'object') state.cfg = Object.assign({}, DEFAULT_CFG, d.cfg);
        ['cfg', 'chats', 'todos', 'notes'].forEach(function (k) { save(k, state[k]); });
        renderAll(); toast('导入完成');
      }
    });
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $('#tabbar').addEventListener('click', function (e) {
      var b = e.target.closest('.tab'); if (b) switchTab(b.dataset.tab);
    });
    $('#btnSend').addEventListener('click', function () { state.busy ? stop() : send(); });
    $('#input').addEventListener('input', autoGrow);
    $('#input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    $('#quickRow').addEventListener('click', function (e) {
      var c = e.target.closest('.chip'); if (!c || state.busy) return;
      $('#input').value = c.dataset.q; autoGrow(); send();
    });
    $('#btnMore').addEventListener('click', function () {
      if (state.tab === 'chat') {
        showModal('清空对话？', '所有聊天记录会被删除，待办和备忘不受影响。', {
          okLabel: '清空', onOk: function () { state.chats = []; save('chats', state.chats); renderChat(); toast('已清空'); }
        });
      } else {
        showModal('关于', HELP, { cancel: false });
      }
    });

    $('#btnAddTodo').addEventListener('click', function () {
      var el = $('#todoInput'), v = el.value.trim();
      if (!v) return; addTodo(v); el.value = ''; toast('已添加');
    });
    $('#todoInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#btnAddTodo').click(); });
    $('#todoFilters').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      state.filter = b.dataset.f;
      $$('#todoFilters button').forEach(function (x) { x.classList.toggle('on', x === b); });
      renderTodos();
    });
    $('#todoList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      var id = b.dataset.id, item = state.todos.filter(function (t) { return t.id === id; })[0];
      if (!item) return;
      if (b.dataset.act === 'check') { item.done = !item.done; save('todos', state.todos); renderTodos(); updateHead(); }
      else {
        showModal('删除这条待办？', item.text, { okLabel: '删除', onOk: function () {
          state.todos = state.todos.filter(function (t) { return t.id !== id; });
          save('todos', state.todos); renderTodos(); updateHead();
        }});
      }
    });

    $('#btnAddNote').addEventListener('click', function () {
      var el = $('#noteInput'), v = el.value.trim();
      if (!v) return; addNote(v); el.value = ''; toast('已记下');
    });
    $('#noteInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#btnAddNote').click(); });
    $('#noteSearch').addEventListener('input', function (e) { state.query = e.target.value; renderNotes(); });
    $('#noteList').addEventListener('input', function (e) {
      if (e.target.dataset.role !== 'note-text') return;
      var card = e.target.closest('.note-card'), id = card && card.dataset.id;
      var item = state.notes.filter(function (n) { return n.id === id; })[0];
      if (item) { item.text = e.target.value; save('notes', state.notes); }
    });
    $('#noteList').addEventListener('click', function (e) {
      if (!e.target.closest('[data-act="del"]')) return;
      var card = e.target.closest('.note-card'), id = card && card.dataset.id;
      showModal('删除这条备忘？', '', { okLabel: '删除', onOk: function () {
        state.notes = state.notes.filter(function (n) { return n.id !== id; });
        save('notes', state.notes); renderNotes(); updateHead();
      }});
    });

    ['cfgBase', 'cfgKey', 'cfgModel', 'cfgSystem', 'cfgStream'].forEach(function (id) {
      $('#' + id).addEventListener('change', function (e) {
        var map = { cfgBase: 'baseUrl', cfgKey: 'apiKey', cfgModel: 'model', cfgSystem: 'system', cfgStream: 'stream' };
        state.cfg[map[id]] = id === 'cfgStream' ? e.target.checked : e.target.value.trim();
        save('cfg', state.cfg); updateHead(); toast('已保存');
      });
    });
    $('#btnEye').addEventListener('click', function () {
      var el = $('#cfgKey'), show = el.type === 'password';
      el.type = show ? 'text' : 'password';
      $('#btnEye').textContent = show ? '隐藏' : '显示';
    });
    $('#btnExport').addEventListener('click', exportData);
    $('#btnImport').addEventListener('click', importData);
    $('#btnClearAll').addEventListener('click', function () {
      showModal('清空全部数据？', '对话、待办、备忘都会被删除，且无法恢复。设置会保留。', {
        okLabel: '全部清空', onOk: function () {
          state.chats = []; state.todos = []; state.notes = [];
          ['chats', 'todos', 'notes'].forEach(function (k) { save(k, state[k]); });
          renderAll(); toast('已清空');
        }
      });
    });

    $('#modalCancel').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', function (e) { if (e.target === $('#modal')) closeModal(); });
    $('#modalOk').addEventListener('click', function () {
      var r = modalOk ? modalOk() : undefined;
      if (r !== false) closeModal();
    });
  }

  /* ---------- 启动 ---------- */
  bind();
  renderAll();
  switchTab('chat');
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
