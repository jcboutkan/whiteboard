// Canonical coordinate space — all strokes are stored in 1280×720
const CW = 1280, CH = 720;

class CanvasEngine {
  constructor(container, { readOnly = false, onStroke = null, onPoints = null } = {}) {
    this.container = container;
    this.readOnly = readOnly;
    this.onStroke = onStroke;   // called with complete stroke
    this.onPoints = onPoints;   // called with streaming pen points

    this.strokes = [];
    this.redoStack = [];
    this.background = null;     // {type:'image'|'pdf', src, page}
    this._handlers = {};

    // Active drawing state
    this.tool = 'pen';
    this.color = '#1E293B';
    this.lineWidth = 3;
    this.filled = false;
    this.fontSize = 20;
    this.fontFamily = 'Arial';
    this.opacity = 1;

    this._isDrawing = false;
    this._startX = 0;
    this._startY = 0;
    this._currentPoints = [];
    this._activeStrokeId = null;
    this._lastEmit = 0;
    this._pendingPoints = [];

    this._build();
    if (!readOnly) this._bindEvents();
  }

  _build() {
    const c = this.container;
    c.style.position = 'relative';
    c.style.overflow = 'hidden';

    this.bgCanvas   = this._makeCanvas(1);
    this.mainCanvas = this._makeCanvas(2);
    this.tempCanvas = this._makeCanvas(3);

    if (!this.readOnly) {
      this.tempCanvas.style.cursor = 'crosshair';
    } else {
      this.tempCanvas.style.pointerEvents = 'none';
      this.mainCanvas.style.pointerEvents = 'none';
      this.bgCanvas.style.pointerEvents   = 'none';
    }

    this.bgCtx   = this.bgCanvas.getContext('2d');
    this.mainCtx = this.mainCanvas.getContext('2d');
    this.tempCtx = this.tempCanvas.getContext('2d');

    this._resize();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(c);
  }

  _makeCanvas(z) {
    const el = document.createElement('canvas');
    el.style.cssText = `position:absolute;top:0;left:0;z-index:${z};`;
    this.container.appendChild(el);
    return el;
  }

  _resize() {
    const w = this.container.clientWidth  || 640;
    const h = this.container.clientHeight || 360;
    [this.bgCanvas, this.mainCanvas, this.tempCanvas].forEach(c => {
      c.width  = w;
      c.height = h;
    });
    this._redrawAll();
    if (this.background) this._drawBackground();
  }

  get _sx() { return this.mainCanvas.width  / CW; }
  get _sy() { return this.mainCanvas.height / CH; }

  // Convert canvas pixel coords to canonical
  _toC(px, py) { return { x: px / this._sx, y: py / this._sy }; }
  _fromC(cx, cy) { return { x: cx * this._sx, y: cy * this._sy }; }

  _getPos(e) {
    const r = this.tempCanvas.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return this._toC(src.clientX - r.left, src.clientY - r.top);
  }

  // ── Events ──────────────────────────────────────────────────────────────
  _bindEvents() {
    const el = this.tempCanvas;
    el.addEventListener('pointerdown', e => this._onDown(e));
    el.addEventListener('pointermove', e => this._onMove(e));
    el.addEventListener('pointerup',   e => this._onUp(e));
    el.addEventListener('pointerleave',e => { if (this._isDrawing) this._onUp(e); });
    el.addEventListener('contextmenu', e => e.preventDefault());
  }

  _onDown(e) {
    if (this.readOnly) return;
    e.preventDefault();
    this._isDrawing = true;
    this.redoStack = [];
    const { x, y } = this._getPos(e);
    this._startX = x; this._startY = y;
    this._currentPoints = [{ x, y }];
    this._activeStrokeId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36);
    this._pendingPoints = [{ x, y }];

    if (this.tool === 'text') { this._isDrawing = false; this._insertText(x, y); }
    if (this.tool === 'math') { this._isDrawing = false; this.emit('open-math', { x, y }); }
  }

  _onMove(e) {
    if (!this._isDrawing || this.readOnly) return;
    e.preventDefault();
    const { x, y } = this._getPos(e);
    this._currentPoints.push({ x, y });
    this._pendingPoints.push({ x, y });
    this._drawTemp();

    // Stream pen points every 80ms
    if ((this.tool === 'pen' || this.tool === 'eraser') && this.onPoints) {
      const now = Date.now();
      if (now - this._lastEmit > 80) {
        this._lastEmit = now;
        this.onPoints({ strokeId: this._activeStrokeId, points: [...this._pendingPoints], color: this.color, width: this.lineWidth, tool: this.tool });
        this._pendingPoints = [{ x, y }];
      }
    }
  }

  _onUp(e) {
    if (!this._isDrawing || this.readOnly) return;
    this._isDrawing = false;
    const { x, y } = this._getPos(e);
    this._currentPoints.push({ x, y });

    const stroke = this._buildStroke(x, y);
    if (stroke) {
      this.strokes.push(stroke);
      this._drawStroke(this.mainCtx, stroke);
      this.tempCtx.clearRect(0, 0, this.tempCanvas.width, this.tempCanvas.height);
      if (this.onStroke) this.onStroke(stroke);
    }
    this._currentPoints = [];
    this._pendingPoints = [];
  }

  _buildStroke(ex, ey) {
    const base = { id: this._activeStrokeId, color: this.color, width: this.lineWidth, opacity: this.opacity };
    switch (this.tool) {
      case 'pen':
      case 'eraser':
        if (this._currentPoints.length < 2) return null;
        return { ...base, type: this.tool === 'eraser' ? 'eraser' : 'pen', points: [...this._currentPoints] };
      case 'line':
        return { ...base, type: 'line', x1: this._startX, y1: this._startY, x2: ex, y2: ey };
      case 'arrow':
        return { ...base, type: 'arrow', x1: this._startX, y1: this._startY, x2: ex, y2: ey };
      case 'rect':
        return { ...base, type: 'rect', x: this._startX, y: this._startY, w: ex - this._startX, h: ey - this._startY, filled: this.filled };
      case 'circle':
        return { ...base, type: 'circle', cx: (this._startX+ex)/2, cy: (this._startY+ey)/2, rx: Math.abs(ex-this._startX)/2, ry: Math.abs(ey-this._startY)/2, filled: this.filled };
      case 'triangle':
        return { ...base, type: 'triangle', x1: this._startX, y1: ey, x2: ex, y2: ey, x3: (this._startX+ex)/2, y3: this._startY, filled: this.filled };
      default:
        return null;
    }
  }

  _drawTemp() {
    const ctx = this.tempCtx;
    ctx.clearRect(0, 0, this.tempCanvas.width, this.tempCanvas.height);
    if (!this._currentPoints.length) return;
    const lx = this._currentPoints[this._currentPoints.length - 1];
    const base = { color: this.color, width: this.lineWidth, opacity: this.opacity, filled: this.filled };
    let fake;
    switch (this.tool) {
      case 'pen':    fake = { ...base, type: 'pen',      points: this._currentPoints }; break;
      case 'eraser': fake = { ...base, type: 'eraser',   points: this._currentPoints }; break;
      case 'line':   fake = { ...base, type: 'line',     x1: this._startX, y1: this._startY, x2: lx.x, y2: lx.y }; break;
      case 'arrow':  fake = { ...base, type: 'arrow',    x1: this._startX, y1: this._startY, x2: lx.x, y2: lx.y }; break;
      case 'rect':   fake = { ...base, type: 'rect',     x: this._startX, y: this._startY, w: lx.x - this._startX, h: lx.y - this._startY }; break;
      case 'circle': fake = { ...base, type: 'circle',   cx: (this._startX+lx.x)/2, cy: (this._startY+lx.y)/2, rx: Math.abs(lx.x-this._startX)/2, ry: Math.abs(lx.y-this._startY)/2 }; break;
      case 'triangle': fake = { ...base, type: 'triangle', x1: this._startX, y1: lx.y, x2: lx.x, y2: lx.y, x3: (this._startX+lx.x)/2, y3: this._startY }; break;
      default: return;
    }
    this._drawStroke(ctx, fake);
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  _drawStroke(ctx, s) {
    ctx.save();
    ctx.globalAlpha = s.opacity != null ? s.opacity : 1;
    const sx = ctx.canvas.width  / CW;
    const sy = ctx.canvas.height / CH;
    const W  = (s.width || 2) * Math.min(sx, sy);

    ctx.lineWidth   = W;
    ctx.strokeStyle = s.type === 'eraser' ? '#FFFFFF' : s.color;
    ctx.fillStyle   = s.color;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    if (s.type === 'eraser') ctx.globalCompositeOperation = 'destination-out';

    switch (s.type) {
      case 'pen':
      case 'eraser': {
        if (!s.points || s.points.length < 2) { ctx.restore(); return; }
        ctx.beginPath();
        ctx.moveTo(s.points[0].x * sx, s.points[0].y * sy);
        for (let i = 1; i < s.points.length; i++) {
          ctx.lineTo(s.points[i].x * sx, s.points[i].y * sy);
        }
        ctx.stroke();
        break;
      }
      case 'line': {
        ctx.beginPath();
        ctx.moveTo(s.x1*sx, s.y1*sy);
        ctx.lineTo(s.x2*sx, s.y2*sy);
        ctx.stroke();
        break;
      }
      case 'arrow': {
        const dx = (s.x2-s.x1)*sx, dy = (s.y2-s.y1)*sy;
        const len = Math.hypot(dx, dy);
        if (len < 2) break;
        const hl = Math.max(12, W * 3.5);
        const angle = Math.atan2(dy, dx);
        ctx.beginPath();
        ctx.moveTo(s.x1*sx, s.y1*sy);
        ctx.lineTo(s.x2*sx, s.y2*sy);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(s.x2*sx, s.y2*sy);
        ctx.lineTo(s.x2*sx - hl*Math.cos(angle-Math.PI/6), s.y2*sy - hl*Math.sin(angle-Math.PI/6));
        ctx.lineTo(s.x2*sx - hl*Math.cos(angle+Math.PI/6), s.y2*sy - hl*Math.sin(angle+Math.PI/6));
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'rect': {
        if (s.filled) ctx.fillRect(s.x*sx, s.y*sy, s.w*sx, s.h*sy);
        else ctx.strokeRect(s.x*sx, s.y*sy, s.w*sx, s.h*sy);
        break;
      }
      case 'circle': {
        ctx.beginPath();
        ctx.ellipse(s.cx*sx, s.cy*sy, Math.abs(s.rx*sx), Math.abs(s.ry*sy), 0, 0, Math.PI*2);
        if (s.filled) ctx.fill(); else ctx.stroke();
        break;
      }
      case 'triangle': {
        ctx.beginPath();
        ctx.moveTo(s.x1*sx, s.y1*sy);
        ctx.lineTo(s.x2*sx, s.y2*sy);
        ctx.lineTo(s.x3*sx, s.y3*sy);
        ctx.closePath();
        if (s.filled) ctx.fill(); else ctx.stroke();
        break;
      }
      case 'text': {
        ctx.font = `${(s.fontSize||20)*Math.min(sx,sy)}px ${s.fontFamily||'Arial'}`;
        ctx.fillStyle = s.color;
        ctx.globalAlpha = s.opacity != null ? s.opacity : 1;
        const lines = (s.text||'').split('\n');
        lines.forEach((line, i) => ctx.fillText(line, s.x*sx, s.y*sy + i*(s.fontSize||20)*Math.min(sx,sy)*1.3));
        break;
      }
      case 'image': {
        const img = new Image();
        img.onload = () => ctx.drawImage(img, s.x*sx, s.y*sy, s.w*sx, s.h*sy);
        img.src = s.src;
        break;
      }
    }
    ctx.restore();
  }

  _redrawAll() {
    this.mainCtx.clearRect(0, 0, this.mainCanvas.width, this.mainCanvas.height);
    this.strokes.forEach(s => this._drawStroke(this.mainCtx, s));
  }

  _drawBackground() {
    const ctx = this.bgCtx;
    ctx.clearRect(0, 0, this.bgCanvas.width, this.bgCanvas.height);
    if (!this.background) return;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, this.bgCanvas.width, this.bgCanvas.height);
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, this.bgCanvas.width, this.bgCanvas.height);
    };
    img.src = this.background.src;
  }

  // ── Text insertion ────────────────────────────────────────────────────────
  _insertText(cx, cy) {
    const px = cx * this._sx, py = cy * this._sy;
    const inp = document.createElement('textarea');
    inp.style.cssText = `position:absolute;left:${px}px;top:${py}px;z-index:10;background:rgba(255,255,255,.85);
      border:1.5px dashed #2563EB;outline:none;resize:none;overflow:hidden;
      font-size:${this.fontSize * Math.min(this._sx, this._sy)}px;
      font-family:${this.fontFamily};color:${this.color};min-width:120px;min-height:30px;padding:2px 4px;border-radius:2px;`;
    this.container.appendChild(inp);
    inp.focus();

    const commit = () => {
      const text = inp.value.trim();
      if (text) {
        const stroke = { id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36), type: 'text', x: cx, y: cy, text, color: this.color, fontSize: this.fontSize, fontFamily: this.fontFamily, opacity: this.opacity };
        this.strokes.push(stroke);
        this._drawStroke(this.mainCtx, stroke);
        if (this.onStroke) this.onStroke(stroke);
      }
      inp.remove();
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') { inp.remove(); } if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); } });
  }

  // ── Public API ────────────────────────────────────────────────────────────
  setTool(t) { this.tool = t; if (this.tempCanvas) this.tempCanvas.style.cursor = t === 'eraser' ? 'cell' : t === 'text' ? 'text' : 'crosshair'; }
  setColor(c) { this.color = c; }
  setWidth(w) { this.lineWidth = w; }
  setFilled(f) { this.filled = f; }
  setFontSize(s) { this.fontSize = s; }
  setFontFamily(f) { this.fontFamily = f; }
  setOpacity(o) { this.opacity = o; }
  setReadOnly(v) { this.readOnly = v; if (this.tempCanvas) this.tempCanvas.style.pointerEvents = v ? 'none' : 'auto'; }

  addStroke(stroke) {
    this.strokes.push(stroke);
    this._drawStroke(this.mainCtx, stroke);
  }

  // Add partial points from streaming (for live preview only — do not store)
  addStreamPoints(strokeId, points, color, width, tool) {
    const ctx = this.tempCtx;
    const sx = this.tempCanvas.width  / CW;
    const sy = this.tempCanvas.height / CH;
    const W  = width * Math.min(sx, sy);
    ctx.save();
    ctx.strokeStyle = tool === 'eraser' ? '#FFFFFF' : color;
    ctx.lineWidth   = W;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (tool === 'eraser') ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    if (points.length > 0) {
      ctx.moveTo(points[0].x * sx, points[0].y * sy);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x * sx, points[i].y * sy);
      ctx.stroke();
    }
    ctx.restore();
  }

  setStrokes(strokes) {
    this.strokes = strokes || [];
    this.redoStack = [];
    this._redrawAll();
  }

  setBackground(bgData) {
    this.background = bgData;
    this._drawBackground();
  }

  clearBackground() {
    this.background = null;
    this.bgCtx.clearRect(0, 0, this.bgCanvas.width, this.bgCanvas.height);
  }

  clear(emitUndo = true) {
    if (emitUndo) this.redoStack = [...this.strokes];
    this.strokes = [];
    this.mainCtx.clearRect(0, 0, this.mainCanvas.width, this.mainCanvas.height);
    this.tempCtx.clearRect(0, 0, this.tempCanvas.width, this.tempCanvas.height);
  }

  undo() {
    if (!this.strokes.length) return null;
    const removed = this.strokes.pop();
    this.redoStack.push(removed);
    this._redrawAll();
    return removed;
  }

  redo() {
    if (!this.redoStack.length) return null;
    const stroke = this.redoStack.pop();
    this.strokes.push(stroke);
    this._drawStroke(this.mainCtx, stroke);
    return stroke;
  }

  insertImage(src, x = CW * 0.1, y = CH * 0.1, w = CW * 0.4, h = CH * 0.4) {
    const stroke = { id: Math.random().toString(36), type: 'image', src, x, y, w, h, opacity: 1 };
    this.strokes.push(stroke);
    this._drawStroke(this.mainCtx, stroke);
    if (this.onStroke) this.onStroke(stroke);
  }

  insertMathText(text, x, y) {
    const stroke = { id: Math.random().toString(36), type: 'text', x, y, text, color: this.color, fontSize: this.fontSize, fontFamily: this.fontFamily, opacity: this.opacity };
    this.strokes.push(stroke);
    this._drawStroke(this.mainCtx, stroke);
    if (this.onStroke) this.onStroke(stroke);
  }

  clearTemp() {
    this.tempCtx.clearRect(0, 0, this.tempCanvas.width, this.tempCanvas.height);
  }

  getStrokes() { return this.strokes; }
  getBackground() { return this.background; }

  toDataURL() {
    // Composite bg + main onto offscreen canvas
    const oc = document.createElement('canvas');
    oc.width  = CW;
    oc.height = CH;
    const ctx = oc.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, CW, CH);
    if (this.bgCanvas) ctx.drawImage(this.bgCanvas, 0, 0, CW, CH);
    if (this.mainCanvas) ctx.drawImage(this.mainCanvas, 0, 0, CW, CH);
    return oc.toDataURL('image/png');
  }

  // Simple event emitter
  emit(evt, data) { (this._handlers[evt] || []).forEach(fn => fn(data)); }
  on(evt, fn) { (this._handlers[evt] = this._handlers[evt] || []).push(fn); }

  destroy() {
    this._ro && this._ro.disconnect();
    [this.bgCanvas, this.mainCanvas, this.tempCanvas].forEach(c => c.remove());
  }
}
