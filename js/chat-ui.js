/* ============================================================
 * Petal-PH — Shared Messenger-style chat UI
 * Loaded after js/app.js in messages.html and admin.html.
 * Exposes a global PetalChatUI with init() and refresh().
 * ============================================================ */
const PetalChatUI = (() => {
  const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  const MAX_VOICE_SECONDS = 120;
  const GROUP_GAP_MS = 2 * 60 * 1000;
  const DIVIDER_GAP_MS = 15 * 60 * 1000;
  const DOUBLE_TAP_MS = 300;

  let cfg = null;
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
    reactionPickerEl: null,
    reactionPopoverEl: null,
  };

  const $ = (id) => (cfg && cfg.elements && cfg.elements[id]) ? cfg.elements[id] : document.getElementById(id);
  const e = (s) => PetalApp.escapeHtml(s);

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

  function statusHtml(m, isLastOwnMsg) {
    if (!isOwn(m) || !isLastOwnMsg) return '';
    const rc = readCol();
    const seen = m[rc] === true || m[rc] === 1;
    const status = seen ? 'Seen' : 'Sent';
    return `<div class="chat-status"><svg class="chat-status-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>${e(status)}</div>`;
  }

  function attachHtml(m, urls) {
    const esc = PetalApp.escapeHtml;
    if (m.deleted_at) return '';
    if (m.kind === 'image') {
      const url = urls[m.id] || '';
      return `<img class="chat-img" src="${esc(url)}" alt="Photo" data-msgid="${esc(m.id)}" data-src="${esc(url)}">`;
    }
    if (m.kind === 'voice') {
      const url = urls[m.id] || '';
      const dur = m.duration_seconds ? Math.floor(m.duration_seconds) : 0;
      return `
        <div class="chat-voice-player" data-msgid="${esc(m.id)}" data-src="${esc(url)}" data-dur="${dur}">
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

  function bubbleWrapHtml(m, urls, isLastOwnMsg) {
    const own = isOwn(m);
    const pinned = !!m.pinned_at && !m.deleted_at;
    const time = fmtClock(m.created_at);
    const pinnedBadge = pinned ? '<span class="chat-pinned-badge">Pinned</span>' : '';
    const reactions = reactionPillHtml(m);
    const status = statusHtml(m, isLastOwnMsg);
    const posClass = m._single ? ' single' : (m._pos === 'first' ? ' first' : (m._pos === 'last' ? ' last' : ' mid'));
    const bubbleClass = own ? 'mine' : 'their';
    return `
      <div class="chat-bubble-wrap${posClass}" data-msgid="${e(m.id)}">
        ${pinnedBadge}
        <div class="chat-bubble ${bubbleClass}${posClass}" data-msgid="${e(m.id)}" title="${e(time)}">
          ${bodyHtml(m, urls)}
        </div>
        ${reactions}
        ${status}
      </div>`;
  }

  function groupHtml(g, urls, lastOwnMsgId) {
    let out = '';
    if (g.divider) {
      out += `<div class="chat-divider"><span>${e(fmtDivider(g.msgs[0].created_at))}</span></div>`;
    }
    g.msgs.forEach((m, i) => {
      const last = i === g.msgs.length - 1;
      const showAvatar = !isOwn(m) && last;
      const avatar = showAvatar ? `<div class="chat-avatar chat-avatar-msg" data-userid="${e(m.user_id)}"><img src="${avatarSrc(cfg.other)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span class="chat-avatar-fallback">${e(initials(cfg.other))}</span></div>` : '';
      const spacer = !isOwn(m) && !last ? '<div class="chat-avatar" style="visibility:hidden"></div>' : '';
      const rowClass = own ? 'mine' : 'them';
      const groupPos = i === 0 ? 'group-first' : (last ? 'group-last' : 'group-mid');
      const isLastOwnMsg = isOwn(m) && m.id === lastOwnMsgId;
      out += `<div class="chat-msg-line${showAvatar ? ' has-avatar' : ''}">${avatar}${spacer}<div class="chat-msg-row ${rowClass} ${groupPos}">${bubbleWrapHtml(m, urls, isLastOwnMsg)}</div></div>`;
    });
    return out;
  }

  async function render() {
    if (!cfg) return;
    const headerName = $('headerName');
    if (headerName && cfg.other) headerName.textContent = nameOf(cfg.other) || 'Conversation';
    try {
      const raw = cfg.getMessages ? cfg.getMessages() : [];
      const msgs = raw.filter(m => m.user_id === cfg.conversationUserId);
      msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      st.msgs = msgs;

      const todo = msgs.filter(m => (m.kind === 'image' || m.kind === 'voice') && m.attachment_path && !m.deleted_at && !st.urls[m.id]);
      await Promise.all(todo.map(async (m) => {
        try { st.urls[m.id] = await cfg.getAttachmentUrl(m.attachment_path); } catch (err) { st.urls[m.id] = null; }
      }));

      const groups = buildGroups(msgs);
      const container = $('container');
      const pinnedBar = $('pinnedBar');

      if (!msgs.length) {
        container.innerHTML = '<div class="chat-empty">No messages yet. Start the conversation.</div>';
        if (pinnedBar) pinnedBar.classList.add('hidden');
        updateHeaderEmpty(true);
        return;
      }
      updateHeaderEmpty(false);

      const pinned = msgs.filter(m => m.pinned_at && !m.deleted_at).slice(0, 3);
      if (pinnedBar) {
        pinnedBar.innerHTML = pinned.map(m => {
          const preview = m.deleted_at ? 'Message unsent' : (m.kind === 'image' ? '📷 Photo' : (m.kind === 'voice' ? '🎤 Voice message' : (m.body || '')));
          return `<div class="chat-pinned-item" data-msgid="${e(m.id)}" title="${e(fmtClock(m.created_at))}"><span class="chat-pinned-icon">📌</span>${e(preview)}</div>`;
        }).join('');
        pinnedBar.classList.toggle('hidden', pinned.length === 0);
      }

      const lastOwnMsg = [...msgs].reverse().find(m => isOwn(m) && !m.deleted_at);
      const lastOwnMsgId = lastOwnMsg ? lastOwnMsg.id : null;

      container.innerHTML = groups.map(g => groupHtml(g, st.urls, lastOwnMsgId)).join('');
      manageScroll();
      attachActionClusterListeners();
    } catch (err) {
      const container = $('container');
      if (container) container.innerHTML = '<div class="chat-empty error">Chat could not be loaded. Please refresh and try again.</div>';
      console.error('Petal-PH: chat render failed', err);
    }
  }

  function updateHeaderEmpty(empty) {
    const header = document.querySelector('.chat-header, .chat-header-customer');
    if (!header) return;
    const avatar = header.querySelector('.chat-header-avatar, .chat-header-avatar-fallback, .brand-logo');
    const name = header.querySelector('.chat-header-name, .chat-header-customer-name');
    const sub = header.querySelector('.chat-header-sub, .chat-header-customer-sub');
    if (empty) {
      header.classList.add('empty');
      if (avatar) avatar.style.display = 'none';
      if (name) { name.textContent = 'Select a conversation'; name.style.justifyContent = 'center'; name.style.width = '100%'; }
      if (sub) sub.style.display = 'none';
    } else {
      header.classList.remove('empty');
      if (avatar) avatar.style.display = '';
      if (name) { name.style.justifyContent = ''; name.style.width = ''; }
      if (sub) sub.style.display = '';
    }
  }

  function manageScroll() {
    const container = $('container');
    if (!container) return;
    const nearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 60;
    st.isAtBottom = nearBottom;
    const btn = $('newMsgBtn');
    if (!nearBottom && btn) btn.classList.add('visible');
    if (nearBottom && btn) btn.classList.remove('visible');
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
      if (btn) btn.classList.toggle('visible', !nearBottom);
    });
    if (btn) {
      btn.addEventListener('click', () => { scrollToBottom(false); btn.classList.remove('visible'); });
    }
  }

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
    const headerSub = document.querySelector('.chat-header-sub');
    if (headerSub) headerSub.textContent = 'Petal-PH customer';
    renderOnce();
    scrollToBottom(true);
  }

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
    if (st.reactionPickerEl) { st.reactionPickerEl.remove(); st.reactionPickerEl = null; }
    if (st.reactionPopoverEl) { st.reactionPopoverEl.remove(); st.reactionPopoverEl = null; }
    clearLongPress();
    if (clusterHideTimer) { clearTimeout(clusterHideTimer); clusterHideTimer = null; }
  }

  function clearLongPress() {
    if (st.longPressTimer) { clearTimeout(st.longPressTimer); st.longPressTimer = null; }
    st.longPressEl = null;
  }

  function showActionCluster(msgId) {
    if (st.openMenuId === msgId) return;
    closeMenus();
    st.openMenuId = msgId;
    const bubble = document.querySelector('[data-msgid="' + e(msgId) + '"] .chat-bubble');
    if (!bubble) return;
    let cluster = bubble.querySelector('.chat-action-cluster');
    if (!cluster) {
      cluster = document.createElement('div');
      cluster.className = 'chat-action-cluster';
      cluster.innerHTML = `
        <button class="chat-action-btn" data-action="react" aria-label="React" title="React">😊</button>
        <button class="chat-action-btn" data-action="more" aria-label="More" title="More">⋯</button>
      `;
      bubble.appendChild(cluster);
      cluster.addEventListener('click', (ev) => {
        const btn = ev.target.closest('.chat-action-btn');
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === 'react') openReactionPicker(msgId, btn);
        else if (action === 'more') openMessageMenu(msgId, btn);
      });
    }
  }

  function hideClusterDelayed() {
    if (clusterHideTimer) { clearTimeout(clusterHideTimer); clusterHideTimer = null; }
    clusterHideTimer = setTimeout(() => {
      const menu = $('msgMenu');
      if (menu && menu.matches(':hover')) return;
      closeMenus();
      clusterHideTimer = null;
    }, 120);
  }

  function openMessageMenu(msgId, anchorBtn) {
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
    const rect = anchorBtn.getBoundingClientRect();
    menu.style.left = (rect.left - menu.offsetWidth - 8) + 'px';
    menu.style.top = (rect.top) + 'px';
    menu.classList.remove('hidden');
  }

  function openReactionPicker(msgId, anchorBtn) {
    closeMenus();
    st.openPickerId = msgId;
    if (st.reactionPickerEl) { st.reactionPickerEl.remove(); st.reactionPickerEl = null; }
    const picker = document.createElement('div');
    picker.className = 'chat-reaction-picker';
    picker.innerHTML = EMOJIS.map(emoji => `<button class="chat-emoji-pick" data-emoji="${e(emoji)}">${e(emoji)}</button>`).join('');
    document.body.appendChild(picker);
    st.reactionPickerEl = picker;
    const rect = anchorBtn.getBoundingClientRect();
    picker.style.left = Math.max(8, rect.left - picker.offsetWidth / 2 + rect.width / 2) + 'px';
    picker.style.top = (rect.top - 48) + 'px';
    document.addEventListener('click', closePickerOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
  }

  function closePickerOnOutsideClick(ev) {
    if (st.reactionPickerEl && !st.reactionPickerEl.contains(ev.target) && !ev.target.closest('.chat-action-btn[data-action="react"]')) {
      closeMenus();
      document.removeEventListener('click', closePickerOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    }
  }

  function closeOnEscape(ev) {
    if (ev.key === 'Escape') {
      closeMenus();
      document.removeEventListener('click', closePickerOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
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
    if (st.reactionPopoverEl) { st.reactionPopoverEl.remove(); st.reactionPopoverEl = null; }
    const popover = document.createElement('div');
    popover.className = 'chat-reaction-popover';
    let html = '';
    Object.entries(r.counts || {}).forEach(([emoji, count]) => {
      const active = r.own === emoji ? ' own' : '';
      html += `<div class="chat-reaction-popover-entry${active}" data-emoji="${e(emoji)}">${e(emoji)} <span class="chat-reaction-popover-count">${count}</span>${r.own === emoji ? '<span class="chat-reaction-popover-you">(you)</span>' : ''}</div>`;
    });
    popover.innerHTML = html || '<div class="chat-popover-empty">No reactions yet.</div>';
    document.body.appendChild(popover);
    st.reactionPopoverEl = popover;
    const rect = anchorEl.getBoundingClientRect();
    popover.style.left = Math.max(8, rect.left) + 'px';
    popover.style.top = (rect.top - popover.offsetHeight - 8) + 'px';
    document.addEventListener('click', closePopoverOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
  }

  function closePopoverOnOutsideClick(ev) {
    if (st.reactionPopoverEl && !st.reactionPopoverEl.contains(ev.target) && !ev.target.closest('.chat-reaction-pill')) {
      closeMenus();
      document.removeEventListener('click', closePopoverOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    }
  }

  function attachActionClusterListeners() {
    document.querySelectorAll('.chat-msg-line').forEach(line => {
      line.addEventListener('mouseenter', () => {
        const bubble = line.querySelector('.chat-bubble');
        if (bubble) {
          const msgId = bubble.dataset.msgid;
          if (clusterHideTimer) { clearTimeout(clusterHideTimer); clusterHideTimer = null; }
          showActionCluster(msgId);
        }
      });
      line.addEventListener('mouseleave', () => {
        hideClusterDelayed();
      });
    });
  }

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
      const progressFill = wrap.querySelector('.chat-voice-progress-fill');
      const updateProgress = () => {
        if (st.currentAudioId !== msgId || st.audioEl.paused) return;
        progressFill.style.width = (st.audioEl.currentTime / (dur || 1)) * 100 + '%';
        requestAnimationFrame(updateProgress);
      };
      updateProgress();
    });
  }

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

  function bindOverlays() {
    document.addEventListener('click', (ev) => {
      const menu = $('msgMenu');
      const picker = $('msgPicker');
      const popover = $('reactionPopover');
      const trig = ev.target.closest('.chat-bubble, [data-msgid], .chat-emoji-pick, .chat-popover-entry, .chat-reaction-pill-item, .chat-action-btn');
      if (!menu?.contains(ev.target) && !picker?.contains(ev.target) && !popover?.contains(ev.target) && !trig && !st.reactionPickerEl?.contains(ev.target) && !st.reactionPopoverEl?.contains(ev.target)) {
        closeMenus();
      }
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closeMenus();
    });

    const menuReact = $('menuReact');
    if (menuReact) menuReact.addEventListener('click', () => {
      const id = $('msgMenu').dataset.msgid;
      const el = document.querySelector('[data-msgid="' + e(id) + '"] .chat-action-btn[data-action="react"]');
      if (el) openReactionPicker(id, el);
    });
    const menuPin = $('menuPin');
    if (menuPin) menuPin.addEventListener('click', () => { doPin($('msgMenu').dataset.msgid); });
    const menuUnsend = $('menuUnsend');
    if (menuUnsend) menuUnsend.addEventListener('click', () => { doUnsend($('msgMenu').dataset.msgid); });

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
      const entry = ev.target.closest('.chat-reaction-popover-entry');
      if (!entry) return;
      ev.stopPropagation();
      const emoji = entry.dataset.emoji;
      doReact(st.openPopoverId, emoji);
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
        modal.classList.remove('hidden');
      }
    });
    const imageClose = $('imageClose');
    const imageModal = $('imageModal');
    if (imageClose) imageClose.addEventListener('click', () => { imageModal.classList.add('hidden'); if (imageModalImg) imageModalImg.src = ''; });
    if (imageModal) imageModal.addEventListener('click', (ev) => { if (ev.target === imageModal) { imageModal.classList.add('hidden'); if (imageModalImg) imageModalImg.src = ''; } });

    document.addEventListener('touchstart', (ev) => {
      const bubble = ev.target.closest('.chat-bubble');
      if (!bubble) return;
      st.longPressEl = bubble;
      st.longPressTimer = setTimeout(() => {
        const msgId = bubble.dataset.msgid;
        const line = bubble.closest('.chat-msg-line');
        if (line) line.classList.add('long-press');
        showActionCluster(msgId);
      }, 400);
    }, { passive: true });
    document.addEventListener('touchend', (ev) => {
      document.querySelectorAll('.chat-msg-line.long-press').forEach(el => el.classList.remove('long-press'));
      clearLongPress();
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
    document.addEventListener('dblclick', (ev) => {
      const bubble = ev.target.closest('.chat-bubble');
      if (!bubble) return;
      doReact(bubble.dataset.msgid, '❤️');
    });
  }

  function bindContainer() {
    const container = $('container');
    if (!container) return;
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