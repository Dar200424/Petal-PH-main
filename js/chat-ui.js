/* ============================================================
 * Petal-PH — Shared Messenger-style chat UI
 * Loaded after js/app.js in messages.html and admin.html.
 * Exposes a global PetalChatUI with init() and refresh().
 * ============================================================ */
const PetalChatUI = (() => {
  const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  const MAX_VOICE_SECONDS = 120;
  const GROUP_GAP_MS = 2 * 60 * 1000;    // same sender within 2 min = one group
  const DIVIDER_GAP_MS = 15 * 60 * 1000; // divider when gap > 15 min or day changes
  const DOUBLE_TAP_MS = 300;
  const LONG_PRESS_MS = 450;

  let cfg = null;
  let st = {
    msgs: [],
    urls: {},
    openMoreId: null,
    openPickerId: null,
    openPopoverId: null,
    mediaRecorder: null,
    audioChunks: [],
    voiceSeconds: 0,
    voiceTimerId: null,
    voiceStream: null,
    voiceBlob: null,
    longPressTimer: null,
    longPressRow: null,
    lastTapTime: 0,
    lastTapId: null,
    isAtBottom: true,
    currentAudioId: null,
    audioEl: new Audio(),
    lastSig: '',
    pendingRender: false,
    markingRead: false,
    totalSeen: 0,
  };

  const $ = (id) => (cfg && cfg.elements && cfg.elements[id]) ? cfg.elements[id] : document.getElementById(id);
  const e = (s) => PetalApp.escapeHtml(s);

  /* ---------- small helpers ---------- */
  function isOwn(m) { return m.sender === cfg.meSender; }
  function readCol() { return cfg.meSender === 'user' ? 'read_by_admin' : 'read_by_user'; }
  function myReadCol() { return cfg.meSender === 'user' ? 'read_by_user' : 'read_by_admin'; }
  function nameOf(p) { return (p && p.nickname) || (p && p.email) || 'Customer'; }
  function initials(p) { return (nameOf(p) || '?').charAt(0).toUpperCase(); }
  function avatarSrc(p) { return (p && p.avatar) ? PetalApp.escapeHtml(p.avatar) : ''; }

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
        m._groupStart = i === 0;
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
      return `<span class="chat-reaction-pill-item${active}" data-emoji="${e(emoji)}" title="${e(emoji)} ${count}">${e(emoji)}${count > 1 ? '<span class="chat-reaction-count">' + count + '</span>' : ''}</span>`;
    }).join('');
    return `<div class="chat-reaction-pill" data-msgid="${e(m.id)}" role="button" tabindex="0">${items}</div>`;
  }

  /* ---------- message html ---------- */
  function statusHtml(m) {
    if (!isOwn(m) || !m._lastOwn) return '';
    const rc = readCol();
    const seen = m[rc] === true || m[rc] === 1;
    return `<div class="chat-status">${e(seen ? 'Seen' : 'Sent')}</div>`;
  }

  function attachHtml(m, urls) {
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
          <button class="chat-voice-play" aria-label="Play voice message" type="button">▶</button>
          <div class="chat-voice-progress"><div class="chat-voice-progress-fill" style="width:0%"></div></div>
          <span class="chat-voice-dur">${dur ? dur + 's' : '0s'}</span>
        </div>`;
    }
    return '';
  }

  function bodyHtml(m, urls) {
    if (m.deleted_at) return `<span class="chat-unsent">This message was unsent</span>`;
    if (m.kind === 'text') return `<div class="chat-body">${e(m.body)}</div>`;
    return attachHtml(m, urls);
  }

  function avatarHtml() {
    const src = avatarSrc(cfg.other);
    const letter = e(initials(cfg.other));
    if (!src) return `<span class="chat-avatar chat-avatar-fallback-on"><span class="chat-avatar-initial">${letter}</span></span>`;
    return `<span class="chat-avatar"><span class="chat-avatar-initial">${letter}</span><img src="${src}" alt="" onerror="this.parentNode.classList.add('chat-avatar-fallback-on');this.style.display='none'"></span>`;
  }

  function actionsHtml(m) {
    if (m.deleted_at) return '';
    return `<div class="chat-actions" data-msgid="${e(m.id)}">
      <button type="button" class="chat-act-btn" data-act="react" aria-label="React" title="React">🙂</button>
      <button type="button" class="chat-act-btn" data-act="more" aria-label="More options" title="More">⋯</button>
    </div>`;
  }

  function bubbleWrapHtml(m, urls) {
    const own = isOwn(m);
    const pinned = !!m.pinned_at && !m.deleted_at;
    const pinMark = pinned ? '<span class="chat-pin-inline" aria-label="Pinned message">📌</span>' : '';
    const reactions = reactionPillHtml(m);
    const singleCls = m._single ? ' chat-pos-single' : (' chat-pos-' + m._pos);
    const imgCls = m.kind === 'image' && !m.deleted_at ? ' chat-bubble-img' : '';
    const wrapCls = 'chat-bubble-wrap' + singleCls + (reactions ? ' has-reactions' : '');
    return `
        <div class="${wrapCls}" data-msgid="${e(m.id)}">
          <div class="chat-bubble ${own ? 'chat-bubble-own' : 'chat-bubble-recv'}${imgCls}" data-msgid="${e(m.id)}" title="${e(fmtClock(m.created_at))}">
            ${pinMark}${bodyHtml(m, urls)}
          </div>
          ${reactions}
          ${statusHtml(m)}
        </div>`;
  }

  function rowHtml(m, urls) {
    const own = isOwn(m);
    const showAvatar = !own && (m._single || m._pos === 'last');
    const actions = actionsHtml(m);
    const gapCls = m._groupStart ? ' chat-group-start' : '';
    return `
      <div class="chat-msg-row ${own ? 'chat-mine' : 'chat-them'}${gapCls}" data-side="${own ? 'own' : 'other'}" data-msgid="${e(m.id)}">
        ${own ? '' : (showAvatar ? avatarHtml() : '<span class="chat-avatar-spacer"></span>')}
        ${own ? actions : ''}
        ${bubbleWrapHtml(m, urls)}
        ${own ? '' : actions}
      </div>`;
  }

  function groupHtml(g, urls) {
    let out = '';
    if (g.divider) out += `<div class="chat-divider">${e(fmtDivider(g.msgs[0].created_at))}</div>`;
    out += g.msgs.map(m => rowHtml(m, urls)).join('');
    return out;
  }

  /* ---------- header / empty state ---------- */
  function updateHeader() {
    const hasConv = !!cfg.conversationUserId;
    const main = $('main');
    const empty = $('emptyState');
    if (main) main.classList.toggle('chat-idle', !hasConv && !!empty);
    if (empty) empty.classList.toggle('hidden', hasConv);
    if (!hasConv) return;

    const nameEl = $('headerName');
    if (nameEl) nameEl.textContent = nameOf(cfg.other);
    const subEl = $('headerSub');
    if (subEl) subEl.textContent = cfg.subText || 'Petal-PH customer';
    const img = $('headerAvatar');
    const fb = $('headerAvatarFallback');
    const src = avatarSrc(cfg.other);
    if (img) {
      if (src) { img.src = src; img.classList.remove('hidden'); }
      else { img.classList.add('hidden'); }
    }
    if (fb) {
      if (src) { fb.classList.add('hidden'); }
      else { fb.textContent = initials(cfg.other); fb.classList.remove('hidden'); }
    }
  }

  /* ---------- signature: skip DOM work when nothing changed ---------- */
  function signature(msgs) {
    return msgs.map(m => [
      m.id, m.body, m.kind, m.attachment_path || '', m.duration_seconds || 0,
      m.deleted_at ? 1 : 0, m.pinned_at ? 1 : 0,
      m.read_by_user ? 1 : 0, m.read_by_admin ? 1 : 0,
      st.urls[m.id] ? 1 : 0,
      JSON.stringify(reactionsOf(m.id).counts || {}) + '/' + (reactionsOf(m.id).own || '')
    ].join('|')).join('~') + '@' + (cfg.conversationUserId || '');
  }

  function isBusy() {
    const recording = st.mediaRecorder && st.mediaRecorder.state === 'recording';
    const playing = st.audioEl && !st.audioEl.paused && !st.audioEl.ended;
    return recording || playing;
  }

  async function loadUrls(msgs) {
    const todo = msgs.filter(m => (m.kind === 'image' || m.kind === 'voice') && m.attachment_path && !m.deleted_at && !(m.id in st.urls));
    await Promise.all(todo.map(async (m) => {
      try {
        const url = await cfg.getAttachmentUrl(m.attachment_path);
        st.urls[m.id] = url || '';
      } catch (err) {
        st.urls[m.id] = '';
      }
    }));
  }

  function renderPinned(msgs) {
    const pinnedBar = $('pinnedBar');
    if (!pinnedBar) return;
    const pinned = msgs.filter(m => m.pinned_at && !m.deleted_at).slice(0, 3);
    pinnedBar.innerHTML = pinned.map(m => {
      const preview = m.kind === 'image' ? '📷 Photo' : (m.kind === 'voice' ? '🎤 Voice message' : (m.body || ''));
      return `<div class="chat-pinned-item" data-msgid="${e(m.id)}" title="${e(fmtClock(m.created_at))}"><span class="chat-pinned-icon">📌</span>${e(preview)}</div>`;
    }).join('');
    pinnedBar.classList.toggle('hidden', pinned.length === 0);
  }

  function markIncomingRead(msgs) {
    if (!cfg.markRead) return;
    const col = myReadCol();
    const unread = msgs.some(m => !isOwn(m) && !m.deleted_at && !m[col]);
    if (!unread || st.markingRead) return;
    st.markingRead = true;
    Promise.resolve(cfg.markRead())
      .catch(() => {})
      .then(() => { st.markingRead = false; });
  }

  function renderMessages(msgs) {
    const container = $('container');
    if (!container) return;
    if (!msgs.length) {
      container.innerHTML = '<div class="chat-empty">No messages yet. Start the conversation.</div>';
      return;
    }
    const prevTop = container.scrollTop;
    const wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 60;
    container.innerHTML = buildGroups(msgs).map(g => groupHtml(g, st.urls)).join('');
    if (!wasAtBottom) container.scrollTop = prevTop;
  }

  async function render(force) {
    if (!cfg) return;
    if (!cfg.conversationUserId) {
      st.msgs = [];
      st.lastSig = '';
      const container = $('container');
      if (container) container.innerHTML = '';
      const pinnedBar = $('pinnedBar');
      if (pinnedBar) pinnedBar.classList.add('hidden');
      updateHeader();
      return;
    }

    try {
      const raw = cfg.getMessages ? cfg.getMessages() : [];
      const msgs = raw.filter(m => m.user_id === cfg.conversationUserId);
      msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      msgs.forEach((m) => { m._lastOwn = false; });
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (isOwn(msgs[i]) && !msgs[i].deleted_at) { msgs[i]._lastOwn = true; break; }
      }
      st.msgs = msgs;

      await loadUrls(msgs);
      updateHeader();
      renderPinned(msgs);
      markIncomingRead(msgs);

      const sig = signature(msgs);
      if (!force && sig === st.lastSig) { manageScroll(); return; }
      if (!force && isBusy()) { st.pendingRender = true; return; }
      st.lastSig = sig;
      renderMessages(msgs);
      manageScroll(msgs.length);
      restoreOverlays();
    } catch (err) {
      const container = $('container');
      if (container) container.innerHTML = '<div class="chat-empty">Chat could not be loaded. Please refresh and try again.</div>';
      console.error('Petal-PH: chat render failed', err);
    }
  }

  /* ---------- scroll / new-messages button ---------- */
  function manageScroll(count) {
    const container = $('container');
    if (!container) return;
    const nearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 60;
    st.isAtBottom = nearBottom;
    const firstLoad = typeof count === 'number' && st.totalSeen === 0 && count > 0;
    const btn = $('newMsgBtn');
    if (btn) {
      const grew = typeof count === 'number' && count > st.totalSeen;
      if (nearBottom || !grew) btn.classList.add('hidden');
      else btn.classList.remove('hidden');
    }
    if (typeof count === 'number') st.totalSeen = count;
    if (nearBottom || firstLoad) scrollToBottom(firstLoad);
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
    if (btn) btn.addEventListener('click', () => { scrollToBottom(false); btn.classList.add('hidden'); });
  }

  /* ---------- public entry ---------- */
  function init(options) {
    cfg = options;
    bindComposer();
    bindVoice();
    bindVoicePlayer();
    bindOverlays();
    setupScrollTracking();
    st.audioEl.addEventListener('ended', () => {
      if (st.pendingRender) { st.pendingRender = false; render(true); }
    });
    render(true);
  }

  function switchConversation(other, conversationUserId) {
    if (!cfg) return;
    cfg.other = other || cfg.other;
    cfg.conversationUserId = conversationUserId;
    st.urls = {};
    st.lastSig = '';
    st.totalSeen = 0;
    closeMenus();
    render(true);
    scrollToBottom(true);
  }

  /* ---------- overlays ---------- */
  function rowsWithActions() {
    return document.querySelectorAll('.chat-msg-row.chat-actions-open');
  }
  function closeMenus() {
    st.openMoreId = null;
    st.openPickerId = null;
    st.openPopoverId = null;
    const menu = $('msgMenu');
    const picker = $('msgPicker');
    const popover = $('reactionPopover');
    if (menu) menu.classList.add('hidden');
    if (picker) picker.classList.add('hidden');
    if (popover) popover.classList.add('hidden');
    rowsWithActions().forEach(r => r.classList.remove('chat-actions-open'));
    clearLongPress();
  }

  function clearLongPress() {
    if (st.longPressTimer) { clearTimeout(st.longPressTimer); st.longPressTimer = null; }
    st.longPressRow = null;
  }

  function rowOf(msgId) {
    return document.querySelector('.chat-msg-row[data-msgid="' + e(msgId) + '"]');
  }

  function openActions(msgId) {
    closeMenus();
    const row = rowOf(msgId);
    if (row) row.classList.add('chat-actions-open');
  }

  function openMoreMenu(msgId, anchorEl) {
    closeMenus();
    const m = st.msgs.find(x => x.id === msgId);
    if (!m) return;
    st.openMoreId = msgId;
    const menu = $('msgMenu');
    if (!menu) return;
    menu.dataset.msgid = msgId;
    const pinBtn = $('menuPin');
    if (pinBtn) pinBtn.textContent = m.pinned_at ? '📌 Unpin' : '📌 Pin';
    const unsendBtn = $('menuUnsend');
    if (unsendBtn) unsendBtn.style.display = isOwn(m) ? 'flex' : 'none';
    menu.classList.remove('hidden');
    const rect = anchorEl.getBoundingClientRect();
    const mw = menu.offsetWidth || 150;
    let left = rect.right + 8;
    if (left + mw > window.innerWidth - 8) left = Math.max(8, rect.left - mw - 8);
    menu.style.left = left + 'px';
    menu.style.top = Math.max(8, rect.top) + 'px';
    const row = rowOf(msgId);
    if (row) row.classList.add('chat-actions-open');
  }

  function openPicker(msgId, anchorEl) {
    closeMenus();
    st.openPickerId = msgId;
    const picker = $('msgPicker');
    const items = $('msgPickerItems');
    if (!picker || !items) return;
    items.innerHTML = EMOJIS.map(emoji => `<button type="button" class="chat-emoji-pick" data-emoji="${e(emoji)}">${e(emoji)}</button>`).join('');
    picker.classList.remove('hidden');
    const rect = anchorEl.getBoundingClientRect();
    const pw = picker.offsetWidth || 240;
    const ph = picker.offsetHeight || 44;
    picker.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - pw - 8)) + 'px';
    picker.style.top = Math.max(8, rect.top - ph - 8) + 'px';
    const row = rowOf(msgId);
    if (row) row.classList.add('chat-actions-open');
  }

  function openReactionPopover(msgId, anchorEl) {
    closeMenus();
    st.openPopoverId = msgId;
    const r = reactionsOf(msgId);
    const popover = $('reactionPopover');
    const items = $('reactionPopoverItems');
    if (!popover || !items) return;
    let html = '';
    Object.entries(r.counts || {}).forEach(([emoji, count]) => {
      const active = r.own === emoji ? ' chat-selected' : '';
      html += `<div class="chat-popover-entry${active}" data-emoji="${e(emoji)}">${e(emoji)} <span class="chat-popover-count">${count}</span>${r.own === emoji ? ' (you)' : ''}</div>`;
    });
    items.innerHTML = html || '<div class="chat-popover-empty">No reactions yet.</div>';
    popover.classList.remove('hidden');
    const rect = anchorEl.getBoundingClientRect();
    const pw = popover.offsetWidth || 140;
    popover.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - pw - 8)) + 'px';
    popover.style.top = Math.max(8, rect.top - popover.offsetHeight - 8) + 'px';
    const row = rowOf(msgId);
    if (row) row.classList.add('chat-actions-open');
  }

  function restoreOverlays() {
    if (st.openMoreId) {
      const row = rowOf(st.openMoreId);
      const anchor = row && row.querySelector('.chat-act-btn[data-act="more"]');
      if (anchor) openMoreMenu(st.openMoreId, anchor); else closeMenus();
      return;
    }
    if (st.openPickerId) {
      const row = rowOf(st.openPickerId);
      const anchor = row && row.querySelector('.chat-bubble');
      if (anchor) openPicker(st.openPickerId, anchor); else closeMenus();
      return;
    }
    if (st.openPopoverId) {
      const row = rowOf(st.openPopoverId);
      const anchor = row && row.querySelector('.chat-reaction-pill');
      if (anchor) openReactionPopover(st.openPopoverId, anchor); else closeMenus();
    }
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
    st.urls = {};
    st.lastSig = '';
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
      st.mediaRecorder.ondataavailable = ev => { if (ev.data.size) st.audioChunks.push(ev.data); };
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
        if (st.pendingRender) { st.pendingRender = false; render(true); }
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
      await refresh();
    });
  }

  /* ---------- voice player ---------- */
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
      try { await st.audioEl.play(); } catch (err) { btn.textContent = '▶'; }
      st.audioEl.onended = () => { btn.textContent = '▶'; };
      st.audioEl.ontimeupdate = () => {
        const fill = wrap.querySelector('.chat-voice-progress-fill');
        if (fill && dur) fill.style.width = Math.min(100, (st.audioEl.currentTime / dur) * 100) + '%';
      };
    });
  }

  /* ---------- composer ---------- */
  function bindComposer() {
    const form = $('form');
    const textarea = $('textarea');
    const sendBtn = $('sendBtn');
    const photoBtn = $('photoBtn');
    const photoInput = $('photoInput');

    if (textarea) {
      textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
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
    document.addEventListener('click', (ev) => {
      const menu = $('msgMenu');
      const picker = $('msgPicker');
      const popover = $('reactionPopover');
      const inOverlay = (menu && menu.contains(ev.target)) || (picker && picker.contains(ev.target)) || (popover && popover.contains(ev.target));

      const act = ev.target.closest('.chat-act-btn');
      if (act) {
        const row = act.closest('.chat-msg-row');
        if (row) {
          if (act.dataset.act === 'react') {
            const bubble = row.querySelector('.chat-bubble');
            openPicker(row.dataset.msgid, bubble || act);
          } else {
            openMoreMenu(row.dataset.msgid, act);
          }
        }
        ev.stopPropagation();
        return;
      }

      if (inOverlay) return;

      const trigger = ev.target.closest('.chat-act-btn, .chat-emoji-pick, .chat-popover-entry, .chat-reaction-pill, .chat-pinned-item');
      if (!trigger) closeMenus();
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closeMenus();
    });

    const menuPin = $('menuPin');
    const menu = $('msgMenu');
    if (menuPin && menu) menuPin.addEventListener('click', () => { doPin(menu.dataset.msgid); });
    const menuUnsend = $('menuUnsend');
    if (menuUnsend && menu) menuUnsend.addEventListener('click', () => { doUnsend(menu.dataset.msgid); });

    document.addEventListener('click', (ev) => {
      const pick = ev.target.closest('.chat-emoji-pick');
      if (!pick) return;
      doReact(st.openPickerId, pick.dataset.emoji);
    });

    document.addEventListener('click', (ev) => {
      const pill = ev.target.closest('.chat-reaction-pill');
      if (!pill) return;
      ev.stopPropagation();
      openReactionPopover(pill.dataset.msgid, pill);
    });

    document.addEventListener('click', (ev) => {
      const entry = ev.target.closest('.chat-popover-entry');
      if (!entry) return;
      ev.stopPropagation();
      doReact(st.openPopoverId, entry.dataset.emoji);
    });

    const pinnedBar = $('pinnedBar');
    if (pinnedBar) {
      pinnedBar.addEventListener('click', (ev) => {
        const item = ev.target.closest('.chat-pinned-item');
        if (!item) return;
        closeMenus();
        scrollToMsg(item.dataset.msgid);
      });
    }

    document.addEventListener('click', (ev) => {
      const img = ev.target.closest('.chat-img');
      if (!img) return;
      const modal = $('imageModal');
      const modalImg = $('imageModalImg');
      if (modal && modalImg) {
        modalImg.src = img.dataset.src || img.src;
        openImageModal(modal);
      }
    });
    const imageClose = $('imageClose');
    const imageModal = $('imageModal');
    if (imageClose) imageClose.addEventListener('click', () => { if (imageModal) closeImageModal(imageModal); });
    if (imageModal) imageModal.addEventListener('click', (ev) => { if (ev.target === imageModal) closeImageModal(imageModal); });
    document.querySelectorAll('.modal-x').forEach((x) => {
      x.addEventListener('click', () => {
        const modal = x.closest('.modal');
        if (modal) closeImageModal(modal);
      });
    });

    /* long-press (mobile) -> action cluster */
    document.addEventListener('touchstart', (ev) => {
      if (ev.target.closest('.chat-voice-play, .chat-img, .chat-reaction-pill')) return;
      const bubble = ev.target.closest('.chat-bubble');
      if (!bubble) return;
      const row = bubble.closest('.chat-msg-row');
      if (!row) return;
      st.longPressRow = row;
      st.longPressTimer = setTimeout(() => {
        openActions(row.dataset.msgid);
      }, LONG_PRESS_MS);
    }, { passive: true });
    document.addEventListener('touchend', (ev) => {
      clearLongPress();
      if (ev.target.closest('.chat-voice-play, .chat-img, .chat-reaction-pill')) return;
      const bubble = ev.target.closest('.chat-bubble');
      if (!bubble) return;
      const row = bubble.closest('.chat-msg-row');
      if (!row || row.classList.contains('chat-actions-open')) return;
      const msgId = row.dataset.msgid;
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

    /* desktop double-click = quick heart */
    document.addEventListener('dblclick', (ev) => {
      if (ev.target.closest('.chat-voice-play, .chat-img, .chat-reaction-pill')) return;
      const bubble = ev.target.closest('.chat-bubble');
      if (!bubble) return;
      const row = bubble.closest('.chat-msg-row');
      if (row) doReact(row.dataset.msgid, '❤️');
    });
  }

  /* ---------- lightbox ---------- */
  let scrollYSaved = 0;

  function openImageModal(modal) {
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('open');
    scrollYSaved = window.scrollY || document.documentElement.scrollTop;
    document.body.style.position = 'fixed';
    document.body.style.top = '-' + scrollYSaved + 'px';
    document.body.style.overflow = 'hidden';
  }

  function closeImageModal(modal) {
    if (!modal) return;
    modal.classList.remove('open');
    modal.classList.add('hidden');
    const img = modal.querySelector('img');
    if (img) img.src = '';
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.overflow = '';
    window.scrollTo(0, scrollYSaved);
    scrollYSaved = 0;
  }

  function scrollToMsg(msgId) {
    const el = document.querySelector('.chat-msg-row[data-msgid="' + e(msgId) + '"]');
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
    refresh: function () { return render(false); },
    scrollToMsg: scrollToMsg,
    closeMenus: closeMenus,
    destroy: function () {
      if (st.mediaRecorder) stopRecording();
      if (st.voiceTimerId) clearInterval(st.voiceTimerId);
      cfg = null;
    }
  };
})();
