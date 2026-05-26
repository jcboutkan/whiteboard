// ── Params ────────────────────────────────────────────────────────────────────
const params     = new URLSearchParams(location.search);
const roomCode   = (params.get('room') || '').toUpperCase();
const studentName = decodeURIComponent(params.get('name') || '');
const studentId  = params.get('sid') || localStorage.getItem(`sid_${roomCode}`) || crypto.randomUUID();

// Persist student ID
if (roomCode) localStorage.setItem(`sid_${roomCode}`, studentId);

let socket;
let engine = null;
let inFocusMode  = false;
let focusEngine  = null;   // teacher's canvas replayed for focus mode
let approved     = false;
let mathPendingPos = null;
let filledMode = false;
let activeEmoteBtn = null; // currently highlighted emote button

// ── MATH SYMBOLS ──────────────────────────────────────────────────────────────
const MATH_SYM = {
  greek: 'α β γ δ ε ζ η θ ι κ λ μ ν ξ π ρ σ τ υ φ χ ψ ω Γ Δ Θ Λ Ξ Π Σ Φ Ψ Ω'.split(' '),
  ops:   '+ − × ÷ = ≠ < > ≤ ≥ ≈ ± √ ∛ ∞ ∑ ∏ ∫ ∂ ∇ ∈ ∉ ⊂ ⊃ ∪ ∩ → ← ↔ ∀ ∃ ∅ ∥ ⊥'.split(' '),
  sup:   '⁰ ¹ ² ³ ⁴ ⁵ ⁶ ⁷ ⁸ ⁹ ⁺ ⁻ ⁼ ⁽ ⁾ ₀ ₁ ₂ ₃ ₄ ₅ ₆ ₇ ₈ ₉ ₊ ₋ ₌'.split(' '),
  frac:  '½ ⅓ ¼ ¾ ⅔ ⅛ ⅜ ⅝ ⅞ ⅙ ⅚ ‰ %'.split(' ')
};

// ── INIT ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (!roomCode || !studentName) {
    location.href = '/';
    return;
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();
  document.getElementById('studentNameBadge').textContent = studentName;
  document.getElementById('studentRoomCode').textContent  = roomCode;
  document.title = `${studentName} – Whiteboard Klas`;

  buildMathGrid();
  initSocket();
  initTabDetection();
  initEmotes();
  initAccessLink();

  // Show pending screen immediately
  showScreen('pending');
  document.getElementById('pendingRoomInfo').textContent = `Kamer: ${roomCode}`;
});

// ── SOCKET ────────────────────────────────────────────────────────────────────
function initSocket() {
  socket = io();

  socket.on('connect', () => {
    socket.emit('request-join', { roomCode, studentName, studentId });
  });

  socket.on('connect_error', () => toast('Verbinding mislukt. Opnieuw proberen…', 'error'));

  socket.on('waiting-for-approval', () => showScreen('pending'));

  socket.on('join-approved', ({ studentId: sid, name, strokes, background, lockedLayer, focusMode, teacherStrokes, teacherBackground }) => {
    approved = true;
    showScreen('app');
    initCanvas();

    if (strokes?.length) engine.setStrokes(strokes);
    if (background) engine.setBackground(background);
    if (lockedLayer?.length) engine.setLockedStrokes(lockedLayer);

    if (focusMode) {
      enterFocusMode(teacherStrokes || [], teacherBackground);
    }
  });

  // Locked layer from teacher
  socket.on('locked-layer-set', ({ strokes }) => {
    if (engine) engine.setLockedStrokes(strokes || []);
    toast('Docent heeft inhoud vastgezet op jouw bord');
  });

  socket.on('locked-layer-cleared', () => {
    if (engine) engine.clearLockedStrokes();
  });

  // Teacher strokes updated (reorder/move in focus mode)
  socket.on('teacher-strokes-updated', ({ strokes }) => {
    if (focusEngine) focusEngine.setStrokes(strokes || []);
  });

  socket.on('join-rejected', () => showScreen('rejected'));
  socket.on('join-error', ({ message }) => { toast(message, 'error'); showScreen('pending'); });

  socket.on('teacher-disconnected', () => toast('Docent is tijdelijk verbroken. Even wachten…', 'warn'));
  socket.on('teacher-reconnected',  () => toast('Docent is terug verbonden', 'success'));

  // Teacher's drawing streamed in focus mode
  socket.on('teacher-stroke-points', ({ strokeId, points, color, width, tool }) => {
    if (focusEngine) focusEngine.addStreamPoints(strokeId, points, color, width, tool);
  });

  socket.on('teacher-stroke-commit', (stroke) => {
    if (focusEngine) { focusEngine.addStroke(stroke); focusEngine.clearTemp(); }
  });

  socket.on('focus-mode-changed', ({ enabled, teacherStrokes, teacherBackground }) => {
    if (enabled) {
      enterFocusMode(teacherStrokes || [], teacherBackground);
    } else {
      exitFocusMode();
    }
  });

  // Background pushed by teacher
  socket.on('background-set', ({ bgData }) => {
    if (engine) engine.setBackground(bgData);
  });

  // Canvas cleared by teacher
  socket.on('canvas-cleared', () => {
    if (engine) engine.clear(false);
  });

  // Strokes replaced (undo from teacher)
  socket.on('strokes-updated', ({ strokes }) => {
    if (engine) engine.setStrokes(strokes || []);
  });

  // Emote from teacher
  socket.on('emote-received', ({ emote, from }) => {
    showTeacherEmote(emote, from);
    toast(`${emote} van ${from}`);
  });

  // Teacher has acknowledged the student's emote
  socket.on('emote-dismissed', () => {
    clearActiveEmote();
    toast('Docent heeft je reactie gezien');
  });
}

// ── SCREENS ───────────────────────────────────────────────────────────────────
function showScreen(name) {
  document.getElementById('pendingScreen').classList.toggle('hidden', name !== 'pending');
  document.getElementById('rejectedScreen').classList.toggle('hidden', name !== 'rejected');
  document.getElementById('teacherGoneScreen').classList.toggle('hidden', name !== 'teachergone');
  document.getElementById('studentApp').classList.toggle('hidden', name !== 'app');
}

// ── CANVAS SETUP ──────────────────────────────────────────────────────────────
function initCanvas() {
  const wrap = document.getElementById('studentCanvasWrap');
  engine = new CanvasEngine(wrap, {
    onStroke: (stroke) => {
      socket && socket.emit('stroke-commit', stroke);
    },
    onPoints: ({ strokeId, points, color, width, tool }) => {
      socket && socket.emit('stroke-points', { strokeId, points, color, width, tool });
    }
  });

  engine.on('open-math', ({ x, y }) => {
    mathPendingPos = { x, y };
    document.getElementById('studentMathModal').classList.remove('hidden');
    document.getElementById('sMathInput').focus();
  });

  initStudentToolbar();
}

// ── STUDENT TOOLBAR ───────────────────────────────────────────────────────────
function initStudentToolbar() {
  document.getElementById('studentToolbar').querySelectorAll('[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#studentToolbar [data-tool]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      engine.setTool(btn.dataset.tool);
    });
  });

  const fillBtn = document.getElementById('studentFilledToggle');
  fillBtn.addEventListener('click', () => {
    filledMode = !filledMode;
    engine.setFilled(filledMode);
    fillBtn.style.background = filledMode ? 'var(--blue)' : '';
    fillBtn.style.color = filledMode ? '#fff' : '';
  });

  const picker = document.getElementById('studentColorPicker');
  const swatch = document.getElementById('studentColorSwatch');
  picker.addEventListener('input', () => {
    engine.setColor(picker.value);
    swatch.style.background = picker.value;
  });
  swatch.parentElement.addEventListener('click', () => picker.click());

  document.getElementById('studentWidthSlider').addEventListener('input', e => {
    engine.setWidth(parseInt(e.target.value));
  });

  document.getElementById('studentMathBtn').addEventListener('click', () => {
    mathPendingPos = { x: 640, y: 360 };
    document.getElementById('studentMathModal').classList.remove('hidden');
    document.getElementById('sMathInput').focus();
  });

  document.getElementById('studentUndoBtn').addEventListener('click', () => {
    const s = engine.undo();
    if (s) socket && socket.emit('undo-stroke', {});
  });

  document.getElementById('studentRedoBtn').addEventListener('click', () => {
    const s = engine.redo();
    if (s) socket && socket.emit('stroke-commit', s);
  });

  document.getElementById('studentClearBtn').addEventListener('click', () => {
    if (confirm('Jouw whiteboard wissen?')) {
      engine.clear();
      socket && socket.emit('clear-canvas', {});
    }
  });
}

// ── FOCUS MODE ────────────────────────────────────────────────────────────────
function enterFocusMode(teacherStrokes, teacherBackground) {
  inFocusMode = true;

  // Lock student's drawing
  if (engine) engine.setReadOnly(true);

  // Show focus UI
  document.getElementById('focusBanner').classList.remove('hidden');
  document.getElementById('focusOverlay').classList.remove('hidden');
  document.getElementById('studentToolbar').style.opacity = '0.3';
  document.getElementById('studentToolbar').style.pointerEvents = 'none';

  // Create overlay canvas showing teacher's board
  const wrap = document.getElementById('studentCanvasWrap');
  const focusWrap = document.createElement('div');
  focusWrap.id = 'focusCanvasWrap';
  focusWrap.style.cssText = 'position:absolute;inset:0;z-index:50;background:#fff;';
  wrap.appendChild(focusWrap);

  focusEngine = new CanvasEngine(focusWrap, { readOnly: true });
  focusEngine.setStrokes(teacherStrokes || []);
  if (teacherBackground) focusEngine.setBackground(teacherBackground);
}

function exitFocusMode() {
  inFocusMode = false;

  if (engine) engine.setReadOnly(false);
  document.getElementById('focusBanner').classList.add('hidden');
  document.getElementById('focusOverlay').classList.add('hidden');
  document.getElementById('studentToolbar').style.opacity = '';
  document.getElementById('studentToolbar').style.pointerEvents = '';

  const focusWrap = document.getElementById('focusCanvasWrap');
  if (focusWrap) {
    if (focusEngine) { focusEngine.destroy(); focusEngine = null; }
    focusWrap.remove();
  }
  toast('Focus modus gestopt – je kunt weer tekenen');
}

// ── EMOTES ────────────────────────────────────────────────────────────────────
function initEmotes() {
  document.querySelectorAll('.student-header .emote-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (activeEmoteBtn === btn) {
        // Zelfde knop: annuleer de actieve emote
        btn.classList.remove('emote-active');
        activeEmoteBtn = null;
        socket && socket.emit('emote-cancel');
        return;
      }
      // Nieuwe emote: eventuele vorige wissen
      if (activeEmoteBtn) activeEmoteBtn.classList.remove('emote-active');
      btn.classList.add('emote-active');
      activeEmoteBtn = btn;
      socket && socket.emit('emote', { emote: btn.dataset.emote });
    });
  });
}

function clearActiveEmote() {
  if (activeEmoteBtn) {
    activeEmoteBtn.classList.remove('emote-active');
    activeEmoteBtn = null;
  }
}

function showTeacherEmote(emote, from) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);font-size:48px;z-index:9999;pointer-events:none;animation:emote-float 2s forwards;';
  el.textContent = emote;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// ── TAB SWITCH DETECTION ──────────────────────────────────────────────────────
function initTabDetection() {
  document.addEventListener('visibilitychange', () => {
    if (!approved || !socket) return;
    if (document.hidden) {
      socket.emit('tab-hidden');
    }
  });
}

// ── MATH EDITOR ───────────────────────────────────────────────────────────────
function buildMathGrid() {
  const pairs = [
    ['sMathGridGreek', MATH_SYM.greek, 'sMathInput'],
    ['sMathGridOps',   MATH_SYM.ops,   'sMathInput'],
    ['sMathGridSup',   MATH_SYM.sup,   'sMathInput'],
    ['sMathGridFrac',  MATH_SYM.frac,  'sMathInput']
  ];
  pairs.forEach(([containerId, symbols, inputId]) => {
    const el = document.getElementById(containerId);
    if (!el) return;
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
  });
}

function insertStudentMath() {
  const text = document.getElementById('sMathInput').value.trim();
  if (!text) { toast('Voer eerst een formule in', 'warn'); return; }
  const pos = mathPendingPos || { x: 640, y: 360 };
  engine.insertMathText(text, pos.x, pos.y);
  socket && socket.emit('stroke-commit', engine.getStrokes().at(-1));
  document.getElementById('sMathInput').value = '';
  document.getElementById('studentMathModal').classList.add('hidden');
}
window.insertStudentMath = insertStudentMath;

// ── ACCESS LINK ───────────────────────────────────────────────────────────────
function initAccessLink() {
  document.getElementById('getLinkBtn').addEventListener('click', () => {
    const link = `${location.origin}/?room=${roomCode}&name=${encodeURIComponent(studentName)}&sid=${studentId}`;
    document.getElementById('myAccessLink').value = link;
    document.getElementById('linkModal').classList.remove('hidden');
  });
}

function copyMyLink() {
  const inp = document.getElementById('myAccessLink');
  navigator.clipboard.writeText(inp.value).then(() => toast('🔗 Link gekopieerd!', 'success'));
}
window.copyMyLink = copyMyLink;

// ── TOAST ─────────────────────────────────────────────────────────────────────
function toast(msg, type = '', duration = 3000) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, duration);
}
