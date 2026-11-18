/* ============================================================
 * Petal-PH — Shared Messenger-style chat UI
 * Loaded after js/app.js in messages.html and admin.html.
 * Exposes a global PetalChatUI with init() and refresh().
 * ============================================================ */
const PetalChatUI = (() => {
  const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  const MAX_VOICE_SECONDS = 120;
  const GROUP_GAP_MS = 2 * 60 * 1000;   // same sender within 2 min = one group
  const DIVIDER_GAP_MS = 15 * 60 * 1000; // new time divider when gap > 15 min or day changes
  const DOUBLE_TAP_MS = 300;

  let cfg = null; // { me, meSender, other, conversationUserId, markRead, getMessages, sendText, sendImage, sendVoice, unsend, pin, react, getAttachmentUrl, elements: {...} }
  let st = {
    msgs: [],
    urls: {},
    openMenuId: null,
    openPickerId: null,
    openPopoverId: null,
    mediaRecorder: null,
    audioChunks: [],
    voiceSeconds: 0,
    voiceTimerId: null,
    voiceStream: null,
    voiceBlob: null,
    longPressTimer: null,
    longPressEl: null,
    lastTapTime: 0,
    lastTapId: null,
    isAtBottom: true,
    currentAudioId: null,
    audioEl: new Audio(),
  };

  const $ = (id) => (cfg && cfg.elements && cfg.elements[id]) ? cfg.elements[id] : document.getElementById(id);
  const e = (s) => PetalApp.escapeHtml(s);

  /* ---------- small helpers ---------- */
  function isOwn(m) { return m.sender === cfg.meSender; }
  function readCol() { return cfg.meSender === 'user' ? 'read_by_admin' : 'read_by_user'; }
  function nameOf(p) { return (p && p.nickname) || (p && p.email) || 'Customer'; }
  function initials(p) { return (nameOf(p) || '?').charAt(0).toUpperCase(); }
  function avatarSrc(p) { return (p && p.avatar) ? e(p.avatar) : ''; }

  function fmtClock(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
  }
  function fmtDivider(iso) {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    if (today) return 'Today ' + d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
  }
  function relativeTime(iso) {
    const d = new Date(iso);
    const now = new Date();
    const sec = Math.floor((now - d) / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm';
    const h = Math.floor(min / 60);
    if (h < 24) return h + 'h';
    return d.toLocaleDateString('en-PH', { weekday: 'short' });
  }

  /* ---------- grouping ---------- */
  function buildGroups(msgs) {
    const groups = [];
    msgs.forEach((m) => {
      const prevGroup = groups[groups.length - 1];
      const prev = prevGroup && prevGroup.msgs[prevGroup.msgs.length - 1];
      const sameSender = prev && prev.sender === m.sender;
      const closeEnough = prev && (new Date(m.created_at) - new Date(prev.created_at)) <= GROUP_GAP_MS;
      if (!prevGroup || !sameSender || !closeEnough) {
        groups.push({ sender: m.sender, divider: false, msgs: [] });
      }
      const g = groups[groups.length - 1];
      if (prevGroup !== g && groups.length > 1) {
        const lastPrev = groups[groups.length - 2].msgs[groups[groups.length - 2].msgs.length - 1];
        const gap = new Date(m.created_at) - new Date(lastPrev.created_at);
        const dayChanged = new Date(m.created_at).toDateString() !== new Date(lastPrev.created_at).toDateString();
        g.divider = gap > DIVIDER_GAP_MS || dayChanged;
      }
      g.msgs.push(m);
    });
    groups.forEach((g) => {
      g.msgs.forEach((m, i) => {
        m._pos = i === 0 ? 'first' : (i === g.msgs.length - 1 ? 'last' : 'mid');
        m._single = g.msgs.length === 1;
      });
    });
    return groups;
  }

  /* ---------- reactions ---------- */
  function reactionsOf(messageId) {
    return PetalApp.reactionsFor(messageId);
  }
  function reactionPillHtml(m) {
    const r = reactionsOf(m.id);
    if (!r.counts || Object.keys(r.counts).length === 0) return '';
    const items = Object.entries(r.counts).map(([emoji, count]) => {
      const active = r.own === emoji ? ' active' : '';
      return `<span class="chat-reaction-pill-item" data-emoji="${e(emoji)}" title="${e(emoji)} ${count}">${e(emoji)}${count > 1 ? '<span class="chat-reaction-count">' + count + '</span>' : ''}</span>`;
    }).join('');
    return `<div class="chat-reaction-pill" data-msgid="${e(m.id)}">${items}</div>`;
  }

  /* ---------- message html ---------- */
  function statusHtml(m) {
    if (!isOwn(m)) return '';
    const rc = readCol();
    const seen = m[rc] === true || m[rc] === 1;
    const status = seen ? 'Seen' : 'Sent';
    return `<div class="chat-status">${e(status)}</div>`;
  }

  function attachHtml(m, urls) {
    const e = PetalApp.escapeHtml;
    if (m.deleted_at) return '';
    if (m.kind === 'image') {
      const url = urls[m.id] || '';
      return `<img class="chat-img" src="${e(url)}" alt="Photo" data-msgid="${e(m.id)}" data-src="${e(url)}">`;
    }
    if (m.kind === 'voice') {
      const url = urls[m.id] || '';
      const dur = m.duration_seconds ? Math.floor(m.duration_seconds) : 0;
      return `
        <div class="chat-voice-player" data-msgid="${e(m.id)}" data-src="${e(url)}" data-dur="${dur}">
          <button class="chat-voice-play" aria-label="Play voice message">▶</button>
          <div class="chat-voice-progress"><div class="chat-voice-progress-fill" style="width:0%"></div></div>
          <span class="chat-voice-dur">${dur ? dur + 's' : '0s'}</span>
        </div>`;
    }
    return '';
  }

  function bodyHtml(m, urls) {
    if (m.deleted_at) {
      const who = isOwn(m) ? 'You unsent a message' : (nameOf(cfg.other) + ' unsent a message');
      return `<span class="chat-unsent">${e(who)}</span>`;
    }
    if (m.kind === 'text') return `<div class="chat-body">${e(m.body)}</div>`;
    return attachHtml(m, urls);
  }

  function bubbleWrapHtml(m, urls) {
    const own = isOwn(m);
    const pinned = !!m.pinned_at && !m.deleted_at;
    const time = fmtClock(m.created_at);
    const pinnedBadge = pinned ? '<span class="chat-pinned-badge">Pinned</span>' : '';
    const reactions = reactionPillHtml(m);
    const status = statusHtml(m);
    const singleCls = m._single ? ' chat-pos-single' : (' chat-pos-' + m._pos);
    return `
      <div class="chat-msg-row ${own ? 'chat-mine' : 'chat-them'}">
        <div class="chat-bubble-wrap${singleCls}" data-msgid="${e(m.id)}">
          ${pinnedBadge}
          <div class="chat-bubble ${own ? 'chat-bubble-own' : 'chat-bubble-recv'}${singleCls}" data-msgid="${e(m.id)}" title="${e(fmtClock(m.created_at))}">
            ${bodyHtml(m, urls)}
          </div>
          ${reactions}
          ${status}
        </div>
      </div>`;
  }

  function groupHtml(g, urls) {
    let out = '';
    if (g.divider) {
      out += `<div class="chat-divider"><span>${e(fmtDivider(g.msgs[0].created_at))}</span></div>`;
    }
    // avatar on last message of received groups
    g.msgs.forEach((m, i) => {
      const last = i === g.msgs.length - 1;
      const showAvatar = !isOwn(m) && last;
      const avatar = showAvatar ? `<div class="chat-avatar chat-avatar-msg" data-userid="${e(m.user_id)}"><img src="${avatarSrc(cfg.other)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span>${e(initials(cfg.other))}</span></div>` : '';
      out += `<div class="chat-msg-line${showAvatar ? ' chat-has-avatar' : ''}">${avatar}${bubbleWrapHtml(m, urls)}</div>`;
    });
    return out;
  }

  async function render() {
    if (!cfg) return;
    const raw = cfg.getMessages ? cfg.getMessages() : [];
    const msgs = raw.filter(m => m.user_id === cfg.conversationUserId);
    msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    st.msgs = msgs;

    // load attachment urls for media messages
    const todo = msgs.filter(m => (m.kind === 'image' || m.kind === 'voice') && m.attachment_path && !m.deleted_at && !st.urls[m.id]);
    await Promise.all(todo.map(async (m) => {
      try { st.urls[m.id] = await cfg.getAttachmentUrl(m.attachment_path); } catch (err) { st.urls[m.id] = null; }
    }));

    const groups = buildGroups(msgs);
    const container = $('container');
    const pinnedBar = $('pinnedBar');
    const headerName = $('headerName');
    if (headerName && cfg.other) headerName.textContent = nameOf(cfg.other) || 'Conversation';

    if (!msgs.length) {
      container.innerHTML = '<div class="chat-empty">No messages yet. Start the conversation.</div>';
      if (pinnedBar) pinnedBar.classList.add('hidden');
      return;
    }

    // pinned bar (slim strip, up to 3)
    const pinned = msgs.filter(m => m.pinned_at && !m.deleted_at).slice(0, 3);
    if (pinnedBar) {
      pinnedBar.innerHTML = pinned.map(m => {
        const preview = m.deleted_at ? 'Message unsent' : (m.kind === 'image' ? '📷 Photo' : (m.kind === 'voice' ? '🎤 Voice message' : (m.body || '')));
        return `<div class="chat-pinned-item" data-msgid="${e(m.id)}" title="${e(fmtClock(m.created_at))}"><span class="chat-pinned-icon">📌</span>${e(preview)}</div>`;
      }).join('');
      pinnedBar.classList.toggle('hidden', pinned.length === 0);
    }

    container.innerHTML = groups.map(g => groupHtml(g, st.urls)).join('');
    manageScroll();
  }

  /* ---------- scroll / new-messages button ---------- */
  function manageScroll() {
    const container = $('container');
    if (!container) return;
    const nearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 60;
    st.isAtBottom = nearBottom;
    const btn = $('newMsgBtn');
    if (!nearBottom && btn) btn.classList.remove('hidden');
    if (nearBottom && btn) btn.classList.add('hidden');
    if (nearBottom) scrollToBottom(false);
  }

  function scrollToBottom(immediate) {
    const container = $('container');
    if (!container) return;
    if (immediate) { container.scrollTop = container.scrollHeight; return; }
    requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
  }

  function setupScrollTracking() {
    const container = $('container');
    if (!container) return;
    const btn = $('newMsgBtn');
    container.addEventListener('scroll', () => {
      const nearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 60;
      st.isAtBottom = nearBottom;
      if (btn) btn.classList.toggle('hidden', nearBottom);
    });
    if (btn) {
      btn.addEventListener('click', () => { scrollToBottom(false); btn.classList.add('hidden'); });
    }
  }

  /* ---------- public render entry ---------- */
  function init(options) {
    cfg = options;
    bindContainer();
    bindComposer();
    bindVoice();
    bindVoicePlayer();
    bindOverlays();
    renderOnce();
  }

  function renderOnce() { render(); setupScrollTracking(); }

  function switchConversation(other, conversationUserId) {
    if (!cfg) return;
    cfg.other = other || cfg.other;
    cfg.conversationUserId = conversationUserId;
    const headerName = $('headerName');
    if (headerName) headerName.textContent = nameOf(cfg.other) || 'Conversation';
    renderOnce();
    scrollToBottom(true);
  }

  /* ---------- action cluster (hover desktop / long-press mobile) ---------- */
  let clusterHideTimer = null;

  function closeMenus() {
    st.openMenuId = null;
    st.openPickerId = null;
    st.openPopoverId = null;
    const menu = $('msgMenu');
    const picker = $('msgPicker');
    const popover = $('reactionPopover');
    if (menu) menu.classList.add('hidden');
    if (picker) picker.classList.add('hidden');
    if (popover) popover.classList.add('hidden');
    clearLongPress();
    if (clusterHideTimer) { clearTimeout(clusterHideTimer); clusterHideTimer = null; }
  }

  function clearLongPress() {
    if (st.longPressTimer) { clearTimeout(st.longPressTimer); st.longPressTimer = null; }
    st.longPressEl = null;
  }

  function showCluster(msgId) {
    if (st.openMenuId === msgId) return;
    closeMenus();
    st.openMenuId = msgId;
    const menu = $('msgMenu');
    if (!menu) return;
    menu.dataset.msgid = msgId;
    const m = st.msgs.find(x => x.id === msgId);
    const pinBtn = $('menuPin');
    if (pinBtn && m) pinBtn.textContent = m.pinned_at ? 'Unpin' : 'Pin';
    const unsendBtn = $('menuUnsend');
    if (unsendBtn && m) unsendBtn.style.display = isOwn(m) ? 'block' : 'none';
    const bubble = document.querySelector('[data-msgid="' + e(msgId) + '"] .chat-bubble');
    if (bubble) {
      const rect = bubble.getBoundingClientRect();
      menu.style.left = (rect.right + 8) + 'px';
      menu.style.top = (rect.top - 6) + 'px';
      menu.classList.remove('hidden');
    }
  }

  function hideClusterDelayed() {
    if (clusterHideTimer) { clearTimeout(clusterHideTimer); clusterHideTimer = null; }
    clusterHideTimer = setTimeout(() => {
      const menu = $('msgMenu');
      if (menu && !menu.matches(':hover')) { menu.classList.add('hidden'); st.openMenuId = null; }
      clusterHideTimer = null;
    }, 120);
  }

  function openPicker(msgId, anchorEl) {
    closeMenus();
    st.openPickerId = msgId;
    const picker = $('msgPicker');
    const items = $('msgPickerItems');
    if (!picker || !items) return;
    items.innerHTML = EMOJIS.map(emoji => `<button class="chat-emoji-pick" data-emoji="${e(emoji)}">${e(emoji)}</button>`).join('');
    const rect = anchorEl.getBoundingClientRect();
    picker.style.left = Math.max(8, rect.left) + 'px';
    picker.style.top = (rect.top - 42) + 'px';
    picker.classList.remove('hidden');
  }

  function openPicker(msgId, anchorEl) {
    closeMenus();
    st.openPickerId = msgId;
    const picker = $('msgPicker');
    const items = $('msgPickerItems');
    if (!picker || !items) return;
    items.innerHTML = EMOJIS.map(emoji => `<button class="chat-emoji-pick" data-emoji="${e(emoji)}">${e(emoji)}</button>`).join('');
    const rect = anchorEl.getBoundingClientRect();
    picker.style.left = Math.max(8, rect.left) + 'px';
    picker.style.top = (rect.top - 42) + 'px';
    picker.classList.remove('hidden');
  }

  async function doReact(msgId, emoji) {
    closeMenus();
    const res = await cfg.react(msgId, emoji);
    if (!res.ok) { showMsg(res.message || 'Could not react.', true); return; }
    await refresh();
  }

  async function doUnsend(msgId) {
    closeMenus();
    if (!confirm('Unsend this message? It will be removed for everyone.')) return;
    const res = await cfg.unsend(msgId);
    if (!res.ok) { showMsg(res.message || 'Could not unsend message.', true); return; }
    await refresh();
  }

  async function doPin(msgId) {
    closeMenus();
    const m = st.msgs.find(x => x.id === msgId);
    if (!m) return;
    const res = await cfg.pin(msgId, !m.pinned_at);
    if (!res.ok) { showMsg(res.message || 'Could not ' + (m.pinned_at ? 'unpin' : 'pin') + ' message.', true); return; }
    await refresh();
  }

  function openReactionPopover(msgId, anchorEl) {
    closeMenus();
    st.openPopoverId = msgId;
    const r = reactionsOf(msgId);
    const entries = Object.entries(r.counts || {}).flatMap(([emoji, count]) => {
      return Array(count).fill(emoji);
    });
    // build who-reacted: we don't have names per reaction in cache; show emoji + count
    const popover = $('reactionPopover');
    const items = $('reactionPopoverItems');
    if (!popover || !items) return;
    let html = '';
    Object.entries(r.counts || {}).forEach(([emoji, count]) => {
      const active = r.own === emoji ? ' chat-selected' : '';
      html += `<div class="chat-popover-entry${active}" data-emoji="${e(emoji)}">${e(emoji)} <span class="chat-popover-count">${count}</span>${r.own === emoji ? ' (you)' : ''}</div>`;
    });
    items.innerHTML = html || '<div class="chat-popover-empty">No reactions yet.</div>';
    const rect = anchorEl.getBoundingClientRect();
    popover.style.left = Math.max(8, rect.left) + 'px';
    popover.style.top = (rect.top - popover.offsetHeight - 8) + 'px';
    popover.classList.remove('hidden');
  }

  /* ---------- voice ---------- */
  function setRecordingUI(recording) {
    const micBtn = $('micBtn');
    const recorder = $('voiceRecorder');
    const preview = $('voicePreview');
    const textarea = $('textarea');
    const sendBtn = $('sendBtn');
    const photoBtn = $('photoBtn');
    if (micBtn) micBtn.classList.toggle('recording', recording);
    if (recorder) recorder.classList.toggle('hidden', !recording);
    if (preview) preview.classList.add('hidden');
    if (textarea) textarea.style.display = recording ? 'none' : 'block';
    if (photoBtn) photoBtn.style.display = recording ? 'none' : 'block';
    if (sendBtn) sendBtn.style.display = recording ? 'none' : 'block';
    st.voiceBlob = null;
    if (!recording) { st.voiceSeconds = 0; const t = $('voiceTimer'); if (t) t.textContent = '0:00'; }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      st.voiceStream = stream;
      let mime = 'audio/webm';
      if (!MediaRecorder.isTypeSupported(mime)) mime = 'audio/ogg';
      if (!MediaRecorder.isTypeSupported(mime)) mime = 'audio/mp4';
      if (!MediaRecorder.isTypeSupported(mime)) { showMsg('Voice recording is not supported by this browser.', true); return; }
      st.mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
      st.audioChunks = [];
      st.mediaRecorder.ondataavailable = e => { if (e.data.size) st.audioChunks.push(e.data); };
      st.mediaRecorder.onstop = () => {
        const blob = new Blob(st.audioChunks, { type: mime });
        if (st.voiceTimerId) { clearInterval(st.voiceTimerId); st.voiceTimerId = null; }
        setRecordingUI(false);
        const url = URL.createObjectURL(blob);
        const audio = $('voiceAudio');
        if (audio) audio.src = url;
        st.voiceBlob = blob;
        const preview = $('voicePreview');
        if (preview) preview.classList.remove('hidden');
      };
      st.mediaRecorder.start(1000);
      st.voiceSeconds = 0;
      const t = $('voiceTimer');
      if (t) t.textContent = '0:00';
      st.voiceTimerId = setInterval(() => {
        st.voiceSeconds++;
        if (t) t.textContent = Math.floor(st.voiceSeconds / 60) + ':' + String(st.voiceSeconds % 60).padStart(2, '0');
        if (st.voiceSeconds >= MAX_VOICE_SECONDS) stopRecording();
      }, 1000);
    } catch (err) {
      showMsg('Microphone access denied or unavailable. Text and photo still work.', true);
    }
  }

  function stopRecording() {
    if (st.mediaRecorder && st.mediaRecorder.state !== 'inactive') st.mediaRecorder.stop();
    if (st.voiceStream) { st.voiceStream.getTracks().forEach(tr => tr.stop()); st.voiceStream = null; }
  }

  function bindVoice() {
    const micBtn = $('micBtn');
    if (micBtn) micBtn.addEventListener('click', () => {
      closeMenus();
      if (st.mediaRecorder && st.mediaRecorder.state === 'recording') { stopRecording(); return; }
      startRecording();
    });
    const vStop = $('voiceStop');
    if (vStop) vStop.addEventListener('click', stopRecording);
    const vCancel = $('voiceCancel');
    if (vCancel) vCancel.addEventListener('click', () => {
      stopRecording();
      setRecordingUI(false);
      const preview = $('voicePreview');
      if (preview) preview.classList.add('hidden');
      st.voiceBlob = null;
    });
    const vRetry = $('voiceRetry');
    if (vRetry) vRetry.addEventListener('click', () => {
      const preview = $('voicePreview');
      if (preview) preview.classList.add('hidden');
      st.voiceBlob = null;
      startRecording();
    });
    const vSend = $('voiceSend');
    if (vSend) vSend.addEventListener('click', async () => {
      if (!st.voiceBlob || !cfg.conversationUserId) return;
      vSend.disabled = true;
      const res = await cfg.sendVoice(st.voiceBlob, st.voiceSeconds);
      vSend.disabled = false;
      const preview = $('voicePreview');
      if (preview) preview.classList.add('hidden');
      st.voiceBlob = null;
      const audio = $('voiceAudio');
      if (audio) audio.src = '';
      if (!res.ok) { showMsg(res.message || 'Could not send voice message.', true); return; }
      const textarea = $('textarea');
      if (textarea) textarea.value = '';
      await refresh();
    });
  }

  /* ---------- voice player (custom controls) ---------- */
  function bindVoicePlayer() {
    const container = $('container');
    if (!container) return;
    container.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('.chat-voice-play');
      if (!btn) return;
      const wrap = btn.closest('.chat-voice-player');
      const msgId = wrap.dataset.msgid;
      const src = wrap.dataset.src;
      const dur = Number(wrap.dataset.dur) || 0;
      if (st.currentAudioId === msgId && !st.audioEl.paused) {
        st.audioEl.pause();
        btn.textContent = '▶';
        return;
      }
      st.currentAudioId = msgId;
      st.audioEl.src = src;
      btn.textContent = '⏸';
      try { await st.audioEl.play(); } catch (err) { /* blocked by browser */ }
      st.audioEl.onended = () => { btn.textContent = '▶'; };
    });
  }

  /* ---------- composer ---------- */
  function bindComposer() {
    const form = $('form');
    const textarea = $('textarea');
    const sendBtn = $('sendBtn');
    const photoBtn = $('photoBtn');
    const photoInput = $('photoInput');

    // auto-grow textarea
    if (textarea) {
      textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px'; // ~5 lines
        updateSendBtn();
      });
      textarea.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submitText(); }
      });
    }

    if (sendBtn) sendBtn.addEventListener('click', submitText);
    if (form) form.addEventListener('submit', (ev) => { ev.preventDefault(); submitText(); });

    if (photoBtn && photoInput) {
      photoBtn.addEventListener('click', () => { closeMenus(); photoInput.click(); });
      photoInput.addEventListener('change', async () => {
        const file = photoInput.files && photoInput.files[0];
        if (!file) return;
        photoInput.value = '';
        const res = await cfg.sendImage(file);
        if (!res.ok) { showMsg(res.message || 'Could not send photo.', true); return; }
        await refresh();
      });
    }

    function updateSendBtn() {
      if (!sendBtn || !textarea) return;
      sendBtn.disabled = textarea.value.trim().length === 0;
    }
    if (textarea) textarea.addEventListener('input', updateSendBtn);
    updateSendBtn();

    async function submitText() {
      if (!textarea || !cfg.conversationUserId) return;
      const text = textarea.value.trim();
      if (!text) return;
      sendBtn.disabled = true;
      const res = await cfg.sendText(text);
      sendBtn.disabled = false;
      if (!res.ok) { showMsg(res.message || 'Could not send message.', true); return; }
      textarea.value = '';
      textarea.style.height = 'auto';
      updateSendBtn();
      await refresh();
    }
  }

  /* ---------- overlays & delegation ---------- */
  function bindOverlays() {
    // outside click closes menus/picker/popover
    document.addEventListener('click', (ev) => {
      const menu = $('msgMenu');
      const picker = $('msgPicker');
      const popover = $('reactionPopover');
      const trig = ev.target.closest('.chat-bubble, [data-msgid], .chat-emoji-pick, .chat-popover-entry, .chat-reaction-pill-item');
      if (!menu.contains(ev.target) && !picker.contains(ev.target) && !popover.contains(ev.target) && !trig) closeMenus();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closeMenus();
    });

    // message menu buttons
    const menuReact = $('menuReact');
    if (menuReact) menuReact.addEventListener('click', () => {
      const id = $('msgMenu').dataset.msgid;
      const el = document.querySelector('[data-msgid="' + e(id) + '"] .chat-bubble');
      openPicker(id, el);
    });
    const menuPin = $('menuPin');
    if (menuPin) menuPin.addEventListener('click', () => { doPin($('msgMenu').dataset.msgid); });
    const menuUnsend = $('menuUnsend');
    if (menuUnsend) menuUnsend.addEventListener('click', () => { doUnsend($('msgMenu').dataset.msgid); });

    // emoji pick
    document.addEventListener('click', (ev) => {
      const pick = ev.target.closest('.chat-emoji-pick');
      if (!pick) return;
      doReact(st.openPickerId, pick.dataset.emoji);
    });

    // reaction pill click -> popover
    document.addEventListener('click', (ev) => {
      const pill = ev.target.closest('.chat-reaction-pill');
      if (!pill) return;
      ev.stopPropagation();
      openReactionPopover(pill.dataset.msgid, pill);
    });
    // popover entry click (remove own reaction)
    document.addEventListener('click', (ev) => {
      const entry = ev.target.closest('.chat-popover-entry');
      if (!entry) return;
      ev.stopPropagation();
      const emoji = entry.dataset.emoji;
      doReact(st.openPopoverId, emoji);
    });

    // pinned bar click -> scroll
    const pinnedBar = $('pinnedBar');
    if (pinnedBar) {
      pinnedBar.addEventListener('click', (ev) => {
        const item = ev.target.closest('.chat-pinned-item');
        if (!item) return;
        closeMenus();
        scrollToMsg(item.dataset.msgid);
      });
    }

    // image click -> lightbox
    document.addEventListener('click', (ev) => {
      const img = ev.target.closest('.chat-img');
      if (!img) return;
      const modal = $('imageModal');
      const modalImg = $('imageModalImg');
      if (modal && modalImg) {
        modalImg.src = img.dataset.src || img.src;
        modal.classList.remove('hidden');
      }
    });
    const imageClose = $('imageClose');
    const imageModal = $('imageModal');
    if (imageClose) imageClose.addEventListener('click', () => { imageModal.classList.add('hidden'); imageModalImg.src = ''; });
    if (imageModal) imageModal.addEventListener('click', (ev) => { if (ev.target === imageModal) { imageModal.classList.add('hidden'); imageModalImg.src = ''; } });

    // long press on bubble (mobile) -> action cluster
    document.addEventListener('touchstart', (ev) => {
      const bubble = ev.target.closest('.chat-bubble');
      if (!bubble) return;
      st.longPressEl = bubble;
      st.longPressTimer = setTimeout(() => {
        const msgId = bubble.dataset.msgid;
        openMenu(msgId);
      }, 400);
    }, { passive: true });
    document.addEventListener('touchend', (ev) => {
      clearLongPress();
      // double tap heart
      const bubble = ev.target.closest('.chat-bubble');
      if (!bubble) return;
      const msgId = bubble.dataset.msgid;
      const now = Date.now();
      if (st.lastTapId === msgId && now - st.lastTapTime <= DOUBLE_TAP_MS) {
        doReact(msgId, '❤️');
        st.lastTapId = null;
      } else {
        st.lastTapId = msgId;
        st.lastTapTime = now;
      }
    });
    document.addEventListener('touchmove', clearLongPress);
    // desktop double click heart
    document.addEventListener('dblclick', (ev) => {
      const bubble = ev.target.closest('.chat-bubble');
      if (!bubble) return;
      doReact(bubble.dataset.msgid, '❤️');
    });

    // hover cluster on desktop
    document.addEventListener('mouseover', (ev) => {
      const bubble = ev.target.closest('.chat-bubble');
      if (!bubble) return;
      const msgId = bubble.dataset.msgid;
      if (clusterHideTimer) { clearTimeout(clusterHideTimer); clusterHideTimer = null; }
      showCluster(msgId);
    });
    document.addEventListener('mouseout', (ev) => {
      const bubble = ev.target.closest('.chat-bubble');
      if (!bubble) return;
      const menu = $('msgMenu');
      if (menu && menu.matches(':hover')) return;
      hideClusterDelayed();
    });
    const msgMenuEl = $('msgMenu');
    if (msgMenuEl) {
      msgMenuEl.addEventListener('mouseenter', () => { if (clusterHideTimer) { clearTimeout(clusterHideTimer); clusterHideTimer = null; } });
      msgMenuEl.addEventListener('mouseleave', () => { hideClusterDelayed(); });
    }
  }

  /* ---------- message container (no click-to-open; cluster via hover/long-press) ---------- */
  function bindContainer() {
    const container = $('container');
    if (!container) return;
    // voice player custom controls handled in bindVoicePlayer via delegation on container
  }

  function bindPinnedBar() {
    // handled in bindOverlays via delegation
  }

  function scrollToMsg(msgId) {
    const el = document.querySelector('[data-msgid="' + e(msgId) + '"]');
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); closeMenus(); }
  }

  function showMsg(text, isError) {
    const el = $('chatMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'chat-msg' + (isError && text ? ' error' : '');
  }

  /* ---------- public ---------- */
  return {
    init: init,
    switchConversation: switchConversation,
    refresh: renderOnce,
    scrollToMsg: scrollToMsg,
    closeMenus: closeMenus,
    destroy: function () {
      st.mediaRecorder && stopRecording();
      cfg = null;
    }
  };
})();
