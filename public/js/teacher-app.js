// ── Globals ──────────────────────────────────────────────────────────────────
const params      = new URLSearchParams(location.search);
const isCoTeacher = params.get('coteacher') === '1';
const teacherName = params.get('name') || localStorage.getItem('teacherName') || 'Docent';
const teacherId   = params.get('tid')  || localStorage.getItem('teacherId')   || crypto.randomUUID();
const ctCode      = params.get('ctcode');
const roomFromParam = params.get('room');

let socket;
let roomCode      = null;
let myCoTeacherCode = null;
let teacherEngine = null;
let fsTempEngine  = null;            // temporary engine for fullscreen student view
let focusMode     = false;
let filledMode    = false;
let mathPendingPos = null;           // {x,y} in canonical coords for math insertion
let currentChartType = 'bar';
let pdfDoc        = null;
let selectedStudentId = null;

const students = new Map();          // studentId -> {name, online, strokes, background, engine, tile, tabAlert}

// ── MATH SYMBOLS ──────────────────────────────────────────────────────────────
const MATH_SYM = {
  greek: 'α β γ δ ε ζ η θ ι κ λ μ ν ξ π ρ σ τ υ φ χ ψ ω Γ Δ Θ Λ Ξ Π Σ Φ Ψ Ω'.split(' '),
  ops:   '+ − × ÷ = ≠ < > ≤ ≥ ≈ ± √ ∛ ∞ ∑ ∏ ∫ ∂ ∇ ∈ ∉ ⊂ ⊃ ∪ ∩ → ← ↔ ∀ ∃ ∅ ∥ ⊥'.split(' '),
  sup:   '⁰ ¹ ² ³ ⁴ ⁵ ⁶ ⁷ ⁸ ⁹ ⁺ ⁻ ⁼ ⁽ ⁾ ₀ ₁ ₂ ₃ ₄ ₅ ₆ ₇ ₈ ₉ ₊ ₋ ₌'.split(' '),
  frac:  '½ ⅓ ¼ ¾ ⅔ ⅛ ⅜ ⅝ ⅞ ⅙ ⅚ ‰ %'.split(' ')
};

// ── INIT ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  localStorage.setItem('teacherId', teacherId);
  if (!isCoTeacher && params.get('name')) localStorage.setItem('teacherName', teacherName);

  initSocket();
  initTeacherCanvas();
  initToolbar();
  buildMathGrid('mathGridGreek', 'mathGridOps', 'mathGridSup', 'mathGridFrac', 'mathInput');
  initChartEditor();
  initTabs();
  initFileHandlers();
  initEmotes();

  if (isCoTeacher) {
    joinAsCoTeacher();
  } else {
    createOrRejoinRoom();
  }
});

// ── SOCKET ───────────────────────────────────────────────────────────────────
function initSocket() {
  socket = io();

  socket.on('connect', () => {
    if (roomCode) {
      // Reconnect to existing room
      if (isCoTeacher) { joinAsCoTeacher(); }
      else { socket.emit('rejoin-as-teacher', { roomCode, teacherId }); }
    }
  });

  socket.on('room-created', ({ code, teacherId: tid, coTeacherCode }) => {
    roomCode = code;
    myCoTeacherCode = coTeacherCode;
    localStorage.setItem('lastRoom', code);
    updateRoomUI(code);
    toast(`Klas aangemaakt: ${code}`, 'success');
  });

  socket.on('room-rejoined', ({ code, teacherStrokes, teacherBackground, lockedLayer, focusMode: fm, students: stList }) => {
    roomCode = code;
    updateRoomUI(code);
    teacherEngine.setStrokes(teacherStrokes || []);
    if (teacherBackground) teacherEngine.setBackground(teacherBackground);
    updateLockedLayerUI(lockedLayer || []);
    focusMode = fm;
    updateFocusBtn(fm);
    stList.forEach(s => {
      addStudentToUI(s.studentId, s.name, s.online);
      const st = students.get(s.studentId);
      if (st) {
        st.strokes = s.strokes || [];
        st.background = s.background;
        st.engine.setStrokes(st.strokes);
        if (st.background) st.engine.setBackground(st.background);
      }
    });
    toast('Verbonden met klas', 'success');
  });

  socket.on('rejoin-error', () => {
    // Room gone (e.g. server restarted) — silently create a fresh room
    localStorage.removeItem('lastRoom');
    roomCode = null;
    socket.emit('create-room', { teacherName, teacherId });
  });

  socket.on('co-teacher-approved', ({ code, teacherStrokes, teacherBackground, lockedLayer, focusMode: fm, students: stList }) => {
    roomCode = code;
    updateRoomUI(code);
    teacherEngine.setStrokes(teacherStrokes || []);
    if (teacherBackground) teacherEngine.setBackground(teacherBackground);
    updateLockedLayerUI(lockedLayer || []);
    focusMode = fm;
    updateFocusBtn(fm);
    stList.forEach(s => {
      addStudentToUI(s.studentId, s.name, s.online);
      const st = students.get(s.studentId);
      if (st) { st.strokes = s.strokes||[]; st.background=s.background; st.engine.setStrokes(st.strokes); if(st.background) st.engine.setBackground(st.background); }
    });
    toast('Verbonden als co-docent', 'success');
  });

  socket.on('join-error', ({ message }) => toast(message, 'error'));

  // Lobby
  socket.on('student-waiting', ({ socketId, name, studentId }) => {
    addToPendingLobby(socketId, name, studentId);
  });
  socket.on('pending-cancelled', ({ socketId }) => removePending(socketId));

  // Student joins
  socket.on('student-joined', ({ studentId, name }) => {
    addStudentToUI(studentId, name, true);
    toast(`${name} heeft deelgenomen`);
  });

  socket.on('student-reconnected', ({ studentId, name }) => {
    updateStudentStatus(studentId, true);
    toast(`${name} is terug verbonden`);
  });

  socket.on('student-offline', ({ studentId }) => updateStudentStatus(studentId, false));

  socket.on('co-teacher-joined', ({ name }) => toast(`Co-docent ${name} verbonden`));

  // Drawing from students
  socket.on('student-stroke-points', ({ studentId, strokeId, points, color, width, tool }) => {
    const st = students.get(studentId);
    if (!st) return;
    st.engine.addStreamPoints(strokeId, points, color, width, tool);
  });

  socket.on('student-stroke-commit', ({ studentId, stroke }) => {
    const st = students.get(studentId);
    if (!st) return;
    st.strokes.push(stroke);
    st.engine.addStroke(stroke);
    st.engine.clearTemp();
    // Update fullscreen if this student is open
    if (fsTempEngine && selectedStudentId === studentId) {
      fsTempEngine.addStroke(stroke);
    }
  });

  socket.on('student-undo', ({ studentId, strokes }) => {
    const st = students.get(studentId);
    if (!st) return;
    st.strokes = strokes;
    st.engine.setStrokes(strokes);
    if (fsTempEngine && selectedStudentId === studentId) fsTempEngine.setStrokes(strokes);
  });

  socket.on('canvas-cleared', () => {});
  socket.on('student-canvas-cleared', ({ studentId }) => {
    const st = students.get(studentId);
    if (!st) return;
    st.strokes = [];
    st.engine.clear(false);
    if (fsTempEngine && selectedStudentId === studentId) fsTempEngine.clear(false);
  });

  socket.on('strokes-updated', ({ strokes }) => {});

  // Focus mode
  socket.on('focus-mode-changed', ({ enabled }) => {
    focusMode = enabled;
    updateFocusBtn(enabled);
  });

  // Emotes
  socket.on('emote-received', ({ emote, from, studentId }) => {
    toast(`${emote} van ${from}`);
    if (studentId) showEmoteOnTile(studentId, emote);
  });

  socket.on('emote-cancelled', ({ studentId }) => {
    const badge = document.getElementById(`emote-${studentId}`);
    if (badge) { badge.classList.add('hidden'); badge.textContent = ''; }
    const st = students.get(studentId);
    if (st) st.activeEmote = null;
  });

  // Alerts
  socket.on('student-tab-hidden', ({ studentId, name, time }) => {
    const st = students.get(studentId);
    if (st) { st.tabAlert = true; updateStudentTileAlert(studentId, true); }
    toast(`${name} heeft het tabblad gewisseld${time ? ` (${time})` : ''}`, 'warn');
  });

  // Library
  socket.on('library-data', (entries) => renderLibraryEntries(entries));
  socket.on('library-saved', ({ id, name, savedAt }) => {
    toast(`"${name}" opgeslagen in bibliotheek`, 'success');
    socket.emit('get-library');
  });
  socket.on('library-entry', (entry) => loadLibraryEntry(entry));
  socket.on('library-deleted', () => socket.emit('get-library'));

  socket.on('teacher-bg-set', ({ bgData }) => {
    teacherEngine.setBackground(bgData);
  });
}

// ── ROOM ─────────────────────────────────────────────────────────────────────
function createOrRejoinRoom() {
  const lastRoom = localStorage.getItem('lastRoom');
  if (lastRoom) {
    // Optimistic UI — roomCode stays null until server confirms
    document.getElementById('roomBadge').textContent = lastRoom;
    document.getElementById('emptyCode').textContent = lastRoom;
    socket.emit('rejoin-as-teacher', { roomCode: lastRoom, teacherId });
  } else {
    socket.emit('create-room', { teacherName, teacherId });
  }
}

function joinAsCoTeacher() {
  const code = ctCode || '';
  const room = roomFromParam || '';
  socket.emit('join-as-co-teacher', { roomCode: room, ctCode: code, name: teacherName });
}

function newRoom() {
  if (!confirm('Nieuwe klas starten? De huidige klas wordt gesloten en alle leerlingen verbroken.')) return;

  // Clear old state
  localStorage.removeItem('lastRoom');
  roomCode = null;
  myCoTeacherCode = null;

  // Reset student list
  students.forEach(st => {
    if (st.engine) st.engine.destroy();
  });
  students.clear();
  document.getElementById('studentGrid').innerHTML = `
    <div id="emptyGrid" style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:60px 24px;">
      Geen leerlingen verbonden.<br>
      <strong id="emptyCode" style="font-size:22px;letter-spacing:2px;color:var(--primary);display:block;margin-top:8px;">—</strong>
      <span style="font-size:13px;">Deel deze code met je klas.</span>
    </div>`;
  document.getElementById('studentList').innerHTML = '';
  updateStudentCount();

  // Reset teacher board
  if (teacherEngine) {
    teacherEngine.clear(false);
    teacherEngine.clearBackground();
    teacherEngine.clearLockedStrokes();
  }
  focusMode = false;
  updateFocusBtn(false);

  // Reset lobby
  pendingMap.clear();
  renderLobby();
  document.getElementById('lobbyCount').classList.add('hidden');

  // Reset header
  document.getElementById('roomBadge').textContent = '—';

  // Request new room from server
  socket.emit('create-room', { teacherName, teacherId });
}

function updateRoomUI(code) {
  document.getElementById('roomBadge').textContent = code;
  document.getElementById('emptyCode').textContent = code;
  document.title = `Docent ${code} – Whiteboard Klas`;
  if (!isCoTeacher) {
    myCoTeacherCode = myCoTeacherCode || `CT-${code}`;
    const link = `${location.origin}/?ctcode=${myCoTeacherCode}&room=${code}`;
    document.getElementById('coTeacherCodeDisplay').textContent = myCoTeacherCode;
    document.getElementById('coTeacherLinkDisplay').value = link;
  }
}

// ── TEACHER CANVAS ────────────────────────────────────────────────────────────
function initTeacherCanvas() {
  const wrap = document.getElementById('teacherCanvasWrap');
  teacherEngine = new CanvasEngine(wrap, {
    onStroke: (stroke) => {
      socket && socket.emit('stroke-commit', stroke);
    },
    onPoints: ({ strokeId, points, color, width, tool }) => {
      if (focusMode) socket && socket.emit('teacher-stroke-points', { strokeId, points, color, width, tool });
    }
  });

  teacherEngine.on('open-math', ({ x, y }) => {
    mathPendingPos = { x, y };
    document.getElementById('mathModal').classList.remove('hidden');
    document.getElementById('mathInput').focus();
  });

  // Sync reordering / moves to server
  teacherEngine.on('strokes-changed', (strokes) => {
    socket && socket.emit('update-teacher-strokes', { strokes });
  });

  // Show/hide context bar on selection change
  teacherEngine.on('selection-changed', (stroke) => {
    const bar = document.getElementById('selectContextBar');
    if (!stroke) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    const isLocked = !!stroke.locked;
    document.getElementById('ctxLock').classList.toggle('hidden', isLocked);
    document.getElementById('ctxUnlock').classList.toggle('hidden', !isLocked);
  });

  // Delete key removes selected object
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && teacherEngine.tool === 'select') {
      if (document.activeElement && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        const removed = teacherEngine.deleteSelected();
        if (removed) socket && socket.emit('update-teacher-strokes', { strokes: teacherEngine.getStrokes() });
      }
    }
    if (e.key === 'Escape' && teacherEngine.tool === 'select') {
      teacherEngine.deselect();
    }
  });
}

// ── TOOLBAR ───────────────────────────────────────────────────────────────────
function initToolbar() {
  // Tool buttons
  document.getElementById('teacherToolbar').querySelectorAll('[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#teacherToolbar [data-tool]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      teacherEngine.setTool(btn.dataset.tool);
    });
  });

  // Fill toggle
  const fillBtn = document.getElementById('filled-toggle');
  fillBtn.addEventListener('click', () => {
    filledMode = !filledMode;
    teacherEngine.setFilled(filledMode);
    fillBtn.style.background = filledMode ? 'var(--blue)' : '';
    fillBtn.style.color = filledMode ? '#fff' : '';
  });

  // Color
  const picker = document.getElementById('colorPicker');
  const swatch = document.getElementById('colorSwatch');
  picker.addEventListener('input', () => {
    teacherEngine.setColor(picker.value);
    swatch.style.background = picker.value;
  });
  swatch.parentElement.addEventListener('click', () => picker.click());

  // Width
  document.getElementById('widthSlider').addEventListener('input', e => {
    teacherEngine.setWidth(parseInt(e.target.value));
  });

  // Math
  document.getElementById('mathBtn').addEventListener('click', () => {
    mathPendingPos = { x: 640, y: 360 };
    document.getElementById('mathModal').classList.remove('hidden');
    document.getElementById('mathInput').focus();
  });

  // Chart
  document.getElementById('chartBtn').addEventListener('click', () => {
    document.getElementById('chartModal').classList.remove('hidden');
    updateChartPreview();
  });

  // Ruler
  document.getElementById('insertRulerBtn').addEventListener('click', () => {
    const src = renderRuler(500, 60, 20);
    teacherEngine.insertImage(src, 100, 300, 500, 60);
    socket && socket.emit('stroke-commit', teacherEngine.getStrokes().at(-1));
    switchTab('whiteboard');
  });

  // Protractor
  document.getElementById('insertProtractorBtn').addEventListener('click', () => {
    const src = renderProtractor(280, 160);
    teacherEngine.insertImage(src, 200, 200, 280, 160);
    socket && socket.emit('stroke-commit', teacherEngine.getStrokes().at(-1));
    switchTab('whiteboard');
  });

  // Angle
  document.getElementById('insertAngleBtn').addEventListener('click', () => {
    document.getElementById('angleModal').classList.remove('hidden');
    updateAnglePreview();
  });

  // Upload image
  document.getElementById('uploadImageBtn').addEventListener('click', () => {
    document.getElementById('imageFileInput').click();
  });

  // Upload PDF
  document.getElementById('uploadPdfBtn').addEventListener('click', () => {
    document.getElementById('pdfFileInput').click();
  });

  // Undo / Redo / Clear
  document.getElementById('undoBtn').addEventListener('click', () => {
    const s = teacherEngine.undo();
    if (s) socket && socket.emit('undo-stroke', {});
  });
  document.getElementById('redoBtn').addEventListener('click', () => {
    const s = teacherEngine.redo();
    if (s) socket && socket.emit('stroke-commit', s);
  });
  document.getElementById('clearTeacherBtn').addEventListener('click', () => {
    if (confirm('Alles op jouw bord wissen?')) {
      teacherEngine.clear();
      socket && socket.emit('clear-canvas', {});
    }
  });

  // Save to library
  document.getElementById('saveLibraryBtn').addEventListener('click', () => {
    document.getElementById('libraryModal').classList.remove('hidden');
    socket && socket.emit('get-library');
  });

  // Room badge copy
  document.getElementById('roomBadge').addEventListener('click', () => copyRoomCode());
  document.getElementById('copyLinkBtn').addEventListener('click', () => {
    const link = `${location.origin}/?room=${roomCode}`;
    navigator.clipboard.writeText(link).then(() => toast('Deelnamelink gekopieerd', 'success'));
  });

  // Co-teacher
  document.getElementById('coTeacherBtn').addEventListener('click', () => {
    document.getElementById('coTeacherModal').classList.remove('hidden');
  });

  // New room
  document.getElementById('newRoomBtn').addEventListener('click', newRoom);

  // Library
  document.getElementById('libraryBtn').addEventListener('click', () => {
    document.getElementById('libraryModal').classList.remove('hidden');
    socket && socket.emit('get-library');
  });

  // Focus mode
  document.getElementById('focusBtn').addEventListener('click', () => {
    focusMode = !focusMode;
    socket && socket.emit('toggle-focus-mode', { enabled: focusMode });
    updateFocusBtn(focusMode);
    toast(focusMode ? 'Focus modus geactiveerd' : 'Focus modus uitgeschakeld', focusMode ? 'success' : '');
  });

  // Angle preview
  document.getElementById('angleDeg').addEventListener('input', updateAnglePreview);

  // Context bar: z-order
  document.getElementById('ctxToFront').addEventListener('click', () => {
    teacherEngine.bringToFront();
    socket && socket.emit('update-teacher-strokes', { strokes: teacherEngine.getStrokes() });
  });
  document.getElementById('ctxFwd').addEventListener('click', () => {
    teacherEngine.bringForward();
    socket && socket.emit('update-teacher-strokes', { strokes: teacherEngine.getStrokes() });
  });
  document.getElementById('ctxBack').addEventListener('click', () => {
    teacherEngine.sendBackward();
    socket && socket.emit('update-teacher-strokes', { strokes: teacherEngine.getStrokes() });
  });
  document.getElementById('ctxToBack').addEventListener('click', () => {
    teacherEngine.sendToBack();
    socket && socket.emit('update-teacher-strokes', { strokes: teacherEngine.getStrokes() });
  });

  // Context bar: lock / unlock / delete
  document.getElementById('ctxLock').addEventListener('click', () => {
    teacherEngine.lockSelected();
    pushLockedLayer();
    const s = teacherEngine.getSelectedStroke();
    if (s) {
      document.getElementById('ctxLock').classList.add('hidden');
      document.getElementById('ctxUnlock').classList.remove('hidden');
    }
  });
  document.getElementById('ctxUnlock').addEventListener('click', () => {
    teacherEngine.unlockSelected();
    pushLockedLayer();
    document.getElementById('ctxLock').classList.remove('hidden');
    document.getElementById('ctxUnlock').classList.add('hidden');
  });
  document.getElementById('ctxDelete').addEventListener('click', () => {
    const removed = teacherEngine.deleteSelected();
    if (removed) socket && socket.emit('update-teacher-strokes', { strokes: teacherEngine.getStrokes() });
  });

  // Toolbar: locked layer
  document.getElementById('pushLockedBtn').addEventListener('click', pushLockedLayer);
  document.getElementById('clearLockedBtn').addEventListener('click', clearLockedLayer);
}

function copyRoomCode() {
  if (!roomCode) return;
  navigator.clipboard.writeText(roomCode).then(() => toast('Klascode gekopieerd', 'success'));
}

function copyCoTeacherLink() {
  const link = document.getElementById('coTeacherLinkDisplay').value;
  navigator.clipboard.writeText(link).then(() => toast('Co-docent link gekopieerd', 'success'));
}

function updateFocusBtn(active) {
  const btn = document.getElementById('focusBtn');
  btn.classList.toggle('active', active);
  btn.textContent = active ? '🎯 Focus: AAN' : '🎯 Focus modus';
}

// ── TABS ─────────────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('tabOverview').classList.toggle('hidden', tab !== 'overview');
  const wb = document.getElementById('tabWhiteboard');
  wb.classList.toggle('hidden', tab !== 'whiteboard');
  wb.style.display = tab === 'whiteboard' ? 'flex' : 'none';
  document.getElementById('tabLobby').classList.toggle('hidden', tab !== 'lobby');

  if (tab === 'whiteboard' && teacherEngine) {
    setTimeout(() => teacherEngine._resize(), 50);
  }
}

// ── EMOTES ────────────────────────────────────────────────────────────────────
function initEmotes() {
  document.querySelectorAll('.app-header .emote-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      socket && socket.emit('emote', { emote: btn.dataset.emote });
    });
  });
}

// ── STUDENT MANAGEMENT ────────────────────────────────────────────────────────
function addStudentToUI(studentId, name, online = true) {
  if (students.has(studentId)) {
    updateStudentStatus(studentId, online);
    return;
  }

  // Create mini canvas engine
  const tile = createStudentTile(studentId, name);
  const wrap = tile.querySelector('.tile-canvas-wrap');
  const previewDiv = document.createElement('div');
  previewDiv.style.cssText = 'width:100%;height:100%;';
  wrap.insertBefore(previewDiv, wrap.querySelector('.tile-overlay'));

  const engine = new CanvasEngine(previewDiv, { readOnly: true });

  students.set(studentId, { name, online, strokes: [], background: null, engine, tile, tabAlert: false });

  document.getElementById('studentGrid').appendChild(tile);
  document.getElementById('emptyGrid').style.display = 'none';

  addToSidebar(studentId, name, online);
  updateStudentCount();
}

function createStudentTile(studentId, name) {
  const tile = document.createElement('div');
  tile.className = 'student-tile';
  tile.id = `tile-${studentId}`;
  tile.innerHTML = `
    <div class="tile-header">
      <span class="online-dot" id="dot-${studentId}"></span>
      <span class="tile-name">${escHtml(name)}</span>
      <button class="tile-emote-badge hidden" id="emote-${studentId}" onclick="dismissEmote('${studentId}')" title="Klik om te bevestigen"></button>
      <div style="flex:1;"></div>
      <button class="btn-icon" onclick="clearStudentCanvas('${studentId}')" title="Wissen">🗑️</button>
      <button class="btn-icon" onclick="undoStudentCanvas('${studentId}')" title="Ongedaan">↩</button>
    </div>
    <div class="tile-canvas-wrap" onclick="openTileFS('${studentId}')">
      <div class="tile-overlay">Klik om te vergroten</div>
    </div>
    <div class="tile-footer">
      <span id="alert-${studentId}" class="alert-badge hidden">Tab gewisseld!</span>
    </div>`;
  return tile;
}

function addToSidebar(studentId, name, online) {
  const item = document.createElement('div');
  item.className = 'student-item' + (online ? '' : ' offline');
  item.id = `sitem-${studentId}`;
  item.innerHTML = `
    <div class="student-avatar ${online ? '' : 'offline'}" id="avt-${studentId}">${escHtml(name[0]||'?').toUpperCase()}</div>
    <div class="student-info">
      <div class="student-name">${escHtml(name)}</div>
      <div class="student-status" id="sstatus-${studentId}">${online ? 'Online' : 'Offline'}</div>
    </div>
    <div class="student-actions">
      <button class="btn-icon" onclick="clearStudentCanvas('${studentId}')" title="Wissen">🗑️</button>
      <button class="btn-icon" onclick="openTileFS('${studentId}')" title="Volledig scherm">🔍</button>
    </div>`;
  item.addEventListener('click', (e) => { if (!e.target.closest('button')) openTileFS(studentId); });
  document.getElementById('studentList').appendChild(item);
}

function updateStudentStatus(studentId, online) {
  const st = students.get(studentId);
  if (!st) return;
  st.online = online;

  const dot = document.getElementById(`dot-${studentId}`);
  if (dot) dot.classList.toggle('offline', !online);

  const avt = document.getElementById(`avt-${studentId}`);
  if (avt) { avt.classList.toggle('offline', !online); }

  const stat = document.getElementById(`sstatus-${studentId}`);
  if (stat) stat.textContent = online ? 'Online' : 'Offline';

  const item = document.getElementById(`sitem-${studentId}`);
  if (item) item.classList.toggle('offline', !online);
}

function updateStudentTileAlert(studentId, show) {
  const badge = document.getElementById(`alert-${studentId}`);
  if (badge) badge.classList.toggle('hidden', !show);
}

function updateStudentCount() {
  document.getElementById('studentCountBadge').textContent = students.size;
}

// ── LOCKED LAYER ──────────────────────────────────────────────────────────────
let _lockedLayerCount = 0;

function updateLockedLayerUI(strokes) {
  _lockedLayerCount = strokes.filter(s => s.locked).length;
  const btn = document.getElementById('pushLockedBtn');
  if (btn) btn.title = _lockedLayerCount
    ? `Stuur ${_lockedLayerCount} vergrendeld object(en) naar leerlingen`
    : 'Vergrendel alles en stuur naar leerlingen';
}

function pushLockedLayer() {
  const all = teacherEngine.getStrokes();
  const locked = all.filter(s => s.locked);
  const toSend = locked.length > 0 ? locked : all.map(s => ({ ...s, locked: true }));
  if (!toSend.length) { toast('Geen objecten om te vergrendelen', 'warn'); return; }
  socket && socket.emit('push-locked-layer', { strokes: toSend });
  toast(`${toSend.length} object(en) vergrendeld voor leerlingen`, 'success');
  _lockedLayerCount = toSend.length;
}

function clearLockedLayer() {
  socket && socket.emit('clear-locked-layer');
  _lockedLayerCount = 0;
  toast('Vergrendeling opgeheven bij leerlingen');
}

function showEmoteOnTile(studentId, emote) {
  const badge = document.getElementById(`emote-${studentId}`);
  if (!badge) return;
  const st = students.get(studentId);
  if (st) st.activeEmote = emote;
  badge.textContent = emote;
  badge.classList.remove('hidden');
}

function dismissEmote(studentId) {
  const badge = document.getElementById(`emote-${studentId}`);
  if (badge) { badge.classList.add('hidden'); badge.textContent = ''; }
  const st = students.get(studentId);
  if (st) st.activeEmote = null;
  socket && socket.emit('emote-dismiss', { studentId });
}
window.dismissEmote = dismissEmote;

// ── CLEAR / UNDO STUDENT ──────────────────────────────────────────────────────
function clearStudentCanvas(studentId) {
  if (!confirm(`Bord van ${students.get(studentId)?.name || 'leerling'} wissen?`)) return;
  socket && socket.emit('clear-canvas', { targetStudentId: studentId });
  const st = students.get(studentId);
  if (st) { st.strokes = []; st.engine.clear(false); }
  if (fsTempEngine && selectedStudentId === studentId) fsTempEngine.clear(false);
}

function undoStudentCanvas(studentId) {
  socket && socket.emit('undo-stroke', { targetStudentId: studentId });
}

// ── FULLSCREEN STUDENT VIEW ────────────────────────────────────────────────────
function openTileFS(studentId) {
  selectedStudentId = studentId;
  const st = students.get(studentId);
  if (!st) return;

  const fs = document.getElementById('tileFS');
  fs.classList.remove('hidden');
  document.getElementById('tileFSName').textContent = st.name;

  const body = document.getElementById('tileFSBody');
  body.innerHTML = '';
  body.style.cssText = 'flex:1;background:#fff;position:relative;';

  if (fsTempEngine) { fsTempEngine.destroy(); fsTempEngine = null; }
  fsTempEngine = new CanvasEngine(body, { readOnly: true });
  fsTempEngine.setStrokes([...st.strokes]);
  if (st.background) fsTempEngine.setBackground(st.background);

  document.getElementById('tileFSClear').onclick = () => clearStudentCanvas(studentId);
  document.getElementById('tileFSDownload').onclick = () => {
    const url = fsTempEngine.toDataURL();
    const a = document.createElement('a'); a.href = url; a.download = `${st.name}-whiteboard.png`; a.click();
  };
}

function closeTileFS() {
  document.getElementById('tileFS').classList.add('hidden');
  if (fsTempEngine) { fsTempEngine.destroy(); fsTempEngine = null; }
  selectedStudentId = null;
}
window.closeTileFS = closeTileFS;

// ── LOBBY ─────────────────────────────────────────────────────────────────────
const pendingMap = new Map(); // socketId -> {socketId, name, studentId}

function addToPendingLobby(socketId, name, studentId) {
  pendingMap.set(socketId, { socketId, name, studentId });
  renderLobby();
  // Show lobby count
  const cnt = document.getElementById('lobbyCount');
  cnt.textContent = pendingMap.size;
  cnt.classList.remove('hidden');
  document.getElementById('lobbyTab').classList.add('pulse');
  toast(`${name} wil deelnemen`, 'warn');
}

function removePending(socketId) {
  pendingMap.delete(socketId);
  renderLobby();
  const cnt = document.getElementById('lobbyCount');
  if (pendingMap.size > 0) { cnt.textContent = pendingMap.size; }
  else { cnt.classList.add('hidden'); }
}

function renderLobby() {
  const list = document.getElementById('lobbyList');
  if (pendingMap.size === 0) {
    list.innerHTML = '<p style="color:var(--text-muted);">Geen leerlingen wachten op toegang.</p>';
    return;
  }
  list.innerHTML = '';
  pendingMap.forEach(({ socketId, name, studentId }) => {
    const card = document.createElement('div');
    card.className = 'lobby-card';
    card.innerHTML = `
      <span class="lobby-name">${escHtml(name)}</span>
      <div class="lobby-actions">
        <button class="btn btn-primary btn-sm" onclick="approveStudent('${socketId}','${studentId}')">Toelaten</button>
        <button class="btn btn-danger btn-sm" onclick="rejectStudent('${socketId}')">Weigeren</button>
      </div>`;
    list.appendChild(card);
  });
}

function approveStudent(socketId, studentId) {
  socket && socket.emit('approve-student', { studentSocketId: socketId, studentId });
  removePending(socketId);
}
function rejectStudent(socketId) {
  socket && socket.emit('reject-student', { studentSocketId: socketId });
  removePending(socketId);
}
window.approveStudent = approveStudent;
window.rejectStudent  = rejectStudent;

// ── MATH EDITOR ───────────────────────────────────────────────────────────────
function buildMathGrid(greekId, opsId, supId, fracId, inputId) {
  const build = (containerId, symbols) => {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '';
    symbols.forEach(sym => {
      const btn = document.createElement('button');
      btn.className = 'math-sym';
      btn.textContent = sym;
      btn.addEventListener('click', () => {
        const inp = document.getElementById(inputId);
        inp.value += sym;
        inp.focus();
      });
      el.appendChild(btn);
    });
  };
  build(greekId, MATH_SYM.greek);
  build(opsId,   MATH_SYM.ops);
  build(supId,   MATH_SYM.sup);
  build(fracId,  MATH_SYM.frac);
}

function closeMathModal() { document.getElementById('mathModal').classList.add('hidden'); }
window.closeMathModal = closeMathModal;

function insertMath() {
  const text = document.getElementById('mathInput').value.trim();
  if (!text) { toast('Voer eerst een formule in', 'warn'); return; }
  const pos = mathPendingPos || { x: 640, y: 360 };
  teacherEngine.insertMathText(text, pos.x, pos.y);
  socket && socket.emit('stroke-commit', teacherEngine.getStrokes().at(-1));
  document.getElementById('mathInput').value = '';
  closeMathModal();
  switchTab('whiteboard');
}
window.insertMath = insertMath;

// ── CHART EDITOR ──────────────────────────────────────────────────────────────
function initChartEditor() {
  // Default rows
  const defaults = [
    { label: 'Categorie A', value: 25 },
    { label: 'Categorie B', value: 40 },
    { label: 'Categorie C', value: 15 },
    { label: 'Categorie D', value: 35 }
  ];
  defaults.forEach(r => addChartRow(r.label, r.value));

  // Chart type buttons
  document.querySelectorAll('.chart-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chart-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentChartType = btn.dataset.chart;
      updateChartPreview();
    });
  });
}

function addChartRow(label = '', value = 0) {
  const tbody = document.getElementById('chartDataBody');
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><input type="text" value="${escHtml(String(label))}" placeholder="Label" oninput="updateChartPreview()"></td>
    <td><input type="number" value="${value}" placeholder="0" style="width:70px" oninput="updateChartPreview()"></td>
    <td><button class="btn-icon" onclick="this.closest('tr').remove();updateChartPreview()">🗑️</button></td>`;
  tbody.appendChild(tr);
  updateChartPreview();
}
window.addChartRow = addChartRow;

function getChartData() {
  const rows = document.querySelectorAll('#chartDataBody tr');
  return Array.from(rows).map(tr => {
    const inputs = tr.querySelectorAll('input');
    return { label: inputs[0].value || '', value: parseFloat(inputs[1].value) || 0 };
  }).filter(r => r.label || r.value);
}

let chartPreviewDebounce = null;
function updateChartPreview() {
  clearTimeout(chartPreviewDebounce);
  chartPreviewDebounce = setTimeout(() => {
    const data = getChartData();
    const title = document.getElementById('chartTitle')?.value || '';
    const xlabel = document.getElementById('chartXLabel')?.value || '';
    const ylabel = document.getElementById('chartYLabel')?.value || '';
    const canvas = document.getElementById('chartPreviewCanvas');
    if (!canvas) return;
    let src;
    switch (currentChartType) {
      case 'bar':   src = renderBarChart(data,  { title, xlabel, ylabel, w:540, h:300 }); break;
      case 'line':  src = renderLineChart(data, { title, xlabel, ylabel, w:540, h:300 }); break;
      case 'pie':   src = renderPieChart(data,  { title, w:540, h:300 }); break;
      case 'donut': src = renderPieChart(data,  { title, w:540, h:300, donut:true }); break;
    }
    const img = new Image(); img.onload = () => { canvas.getContext('2d').clearRect(0,0,540,300); canvas.getContext('2d').drawImage(img,0,0,540,300); }; img.src = src;
  }, 200);
}
window.updateChartPreview = updateChartPreview;

function insertChart() {
  const data = getChartData();
  const title = document.getElementById('chartTitle')?.value || '';
  const xlabel = document.getElementById('chartXLabel')?.value || '';
  const ylabel = document.getElementById('chartYLabel')?.value || '';
  let src;
  switch (currentChartType) {
    case 'bar':   src = renderBarChart(data,  { title, xlabel, ylabel }); break;
    case 'line':  src = renderLineChart(data, { title, xlabel, ylabel }); break;
    case 'pie':   src = renderPieChart(data,  { title }); break;
    case 'donut': src = renderPieChart(data,  { title, donut:true }); break;
  }
  teacherEngine.insertImage(src, 100, 100, 560, 380);
  socket && socket.emit('stroke-commit', teacherEngine.getStrokes().at(-1));
  document.getElementById('chartModal').classList.add('hidden');
  switchTab('whiteboard');
}
window.insertChart = insertChart;

// ── ANGLE ─────────────────────────────────────────────────────────────────────
function updateAnglePreview() {
  const deg = parseInt(document.getElementById('angleDeg')?.value) || 45;
  const canvas = document.getElementById('anglePreview');
  if (!canvas) return;
  const src = renderAngleMarker(deg, 200, 200);
  const img = new Image();
  img.onload = () => { canvas.getContext('2d').clearRect(0,0,200,200); canvas.getContext('2d').drawImage(img,0,0); };
  img.src = src;
}
window.updateAnglePreview = updateAnglePreview;

function insertAngle() {
  const deg = parseInt(document.getElementById('angleDeg')?.value) || 45;
  const src = renderAngleMarker(deg, 200, 200);
  teacherEngine.insertImage(src, 300, 200, 300, 300);
  socket && socket.emit('stroke-commit', teacherEngine.getStrokes().at(-1));
  document.getElementById('angleModal').classList.add('hidden');
  switchTab('whiteboard');
}
window.insertAngle = insertAngle;

// ── FILE HANDLERS ─────────────────────────────────────────────────────────────
function initFileHandlers() {
  document.getElementById('imageFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = await uploadFile(file);
    if (url) {
      teacherEngine.insertImage(url, 50, 50, 600, 400);
      socket && socket.emit('stroke-commit', teacherEngine.getStrokes().at(-1));
      switchTab('whiteboard');
    }
    e.target.value = '';
  });

  document.getElementById('pdfFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    toast('PDF laden…');
    const url = await uploadFile(file);
    if (url) await loadPdf(url);
    e.target.value = '';
  });
}

async function uploadFile(file) {
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const { url } = await res.json();
    return url;
  } catch (err) {
    toast('Upload mislukt', 'error');
    return null;
  }
}

async function loadPdf(url) {
  try {
    pdfDoc = await pdfjsLib.getDocument(url).promise;
    const strip = document.getElementById('pdfPagesStrip');
    strip.innerHTML = '';
    strip.classList.remove('hidden');

    for (let p = 1; p <= pdfDoc.numPages; p++) {
      const page = await pdfDoc.getPage(p);
      const vp = page.getViewport({ scale: 0.15 });
      const thumb = document.createElement('canvas');
      thumb.width  = vp.width;
      thumb.height = vp.height;
      await page.render({ canvasContext: thumb.getContext('2d'), viewport: vp }).promise;
      const wrap = document.createElement('div');
      wrap.className = 'pdf-page-thumb';
      wrap.title = `Pagina ${p}`;
      wrap.appendChild(thumb);
      wrap.addEventListener('click', () => selectPdfPage(p, wrap));
      strip.appendChild(wrap);
    }
    toast(`PDF geladen — ${pdfDoc.numPages} pagina${pdfDoc.numPages === 1 ? '' : "'s"}`, 'success');
    switchTab('whiteboard');
  } catch (err) {
    toast('PDF laden mislukt', 'error');
  }
}

async function selectPdfPage(pageNum, wrap) {
  if (!pdfDoc) return;
  document.querySelectorAll('.pdf-page-thumb').forEach(t => t.classList.remove('active'));
  wrap.classList.add('active');

  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });
  const scale = Math.min(1280 / viewport.width, 720 / viewport.height);
  const scaled = page.getViewport({ scale });

  const oc = document.createElement('canvas');
  oc.width = 1280; oc.height = 720;
  const ctx = oc.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, 1280, 720);
  await page.render({ canvasContext: ctx, viewport: scaled }).promise;
  const dataUrl = oc.toDataURL();
  const bgData = { type: 'pdf', src: dataUrl, page: pageNum };

  teacherEngine.setBackground(bgData);
  socket && socket.emit('set-background', { bgData });

  if (confirm('Achtergrond ook naar alle leerlingen sturen?')) {
    socket && socket.emit('set-background', { bgData, forAll: true });
    toast('Achtergrond verstuurd naar alle leerlingen', 'success');
  }
  toast(`PDF pagina ${pageNum} ingesteld als achtergrond`, 'success');
}

// ── LIBRARY ───────────────────────────────────────────────────────────────────
function saveToLibrary() {
  const name = document.getElementById('libSaveName').value.trim();
  if (!name) { toast('Voer een naam in', 'warn'); return; }
  socket && socket.emit('save-to-library', {
    name,
    strokes: teacherEngine.getStrokes(),
    background: teacherEngine.getBackground()
  });
  document.getElementById('libSaveName').value = '';
}
window.saveToLibrary = saveToLibrary;

function renderLibraryEntries(entries) {
  const grid = document.getElementById('libraryGrid');
  if (!entries.length) { grid.innerHTML = '<p style="color:var(--text-muted);">Bibliotheek is leeg.</p>'; return; }
  grid.innerHTML = '';
  entries.forEach(e => {
    const card = document.createElement('div');
    card.className = 'lib-card';
    card.innerHTML = `
      <div class="lib-card-name">${escHtml(e.name)}</div>
      <div class="lib-card-date">${new Date(e.savedAt).toLocaleString('nl-NL')}</div>
      <div class="lib-card-actions">
        <button class="btn btn-primary btn-sm" onclick="loadLibEntry('${e.id}')">📂 Laden</button>
        <button class="btn btn-danger btn-sm" onclick="deleteLibEntry('${e.id}')">🗑️</button>
      </div>`;
    grid.appendChild(card);
  });
}

function loadLibEntry(id) {
  if (!confirm('Huidig bord vervangen met dit opgeslagen bord?')) return;
  socket && socket.emit('load-from-library', { id });
}
function deleteLibEntry(id) {
  if (!confirm('Dit bord uit de bibliotheek verwijderen?')) return;
  socket && socket.emit('delete-from-library', { id });
}
window.loadLibEntry  = loadLibEntry;
window.deleteLibEntry = deleteLibEntry;

function loadLibraryEntry(entry) {
  teacherEngine.setStrokes(entry.strokes || []);
  if (entry.background) teacherEngine.setBackground(entry.background);
  else teacherEngine.clearBackground();
  document.getElementById('libraryModal').classList.add('hidden');
  switchTab('whiteboard');
  toast(`"${entry.name}" geladen`, 'success');
}

// ── TOAST ─────────────────────────────────────────────────────────────────────
function toast(msg, type = '', duration = 3500) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, duration);
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Expose globals needed by inline onclick handlers
window.clearStudentCanvas = clearStudentCanvas;
window.undoStudentCanvas  = undoStudentCanvas;
window.openTileFS         = openTileFS;
window.copyCoTeacherLink  = copyCoTeacherLink;
