// Canonical coordinate space — all strokes are stored in 1280×720
const CW = 1280, CH = 720;

// Helper: shortest distance from point to line segment (canonical units)
function _distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

class CanvasEngine {
  constructor(container, { readOnly = false, onStroke = null, onPoints = null } = {}) {
    this.container = container;
    this.readOnly  = readOnly;
    this.onStroke  = onStroke;
    this.onPoints  = onPoints;

    this.strokes      = [];
    this.redoStack    = [];
    this.lockedStrokes = [];   // teacher content pushed as read-only layer
    this.background   = null;
    this._handlers    = {};

    // Drawing state
    this.tool       = 'pen';
    this.color      = '#1E293B';
    this.lineWidth  = 3;
    this.filled     = false;
    this.fontSize   = 20;
    this.fontFamily = 'Arial';
    this.opacity    = 1;

    this._isDrawing      = false;
    this._startX         = 0;
    this._startY         = 0;
    this._currentPoints  = [];
    this._activeStrokeId = null;
    this._lastEmit       = 0;
    this._pendingPoints  = [];

    // Select-tool state
    this._selectedIdx        = -1;
    this._isDragging         = false;
    this._dragStartX         = 0;
    this._dragStartY         = 0;
    this._dragStrokeSnapshot = null;

    this._build();
    if (!readOnly) this._bindEvents();
  }

  _build() {
    const c = this.container;
    c.style.position = 'relative';
    c.style.overflow = 'hidden';

    // Layer order (z-index):
    //  1 — background image / PDF
    //  2 — locked strokes from teacher
    //  3 — user's own strokes
    //  4 — in-progress stroke + selection overlay
    this.bgCanvas     = this._makeCanvas(1);
    this.lockedCanvas = this._makeCanvas(2);
    this.mainCanvas   = this._makeCanvas(3);
    this.tempCanvas   = this._makeCanvas(4);

    if (!this.readOnly) {
      this.tempCanvas.style.cursor = 'crosshair';
    } else {
      [this.bgCanvas, this.lockedCanvas, this.mainCanvas, this.tempCanvas]
        .forEach(cv => { cv.style.pointerEvents = 'none'; });
    }

    this.bgCtx     = this.bgCanvas.getContext('2d');
    this.lockedCtx = this.lockedCanvas.getContext('2d');
    this.mainCtx   = this.mainCanvas.getContext('2d');
    this.tempCtx   = this.tempCanvas.getContext('2d');

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
    [this.bgCanvas, this.lockedCanvas, this.mainCanvas, this.tempCanvas].forEach(cv => {
      cv.width  = w;
      cv.height = h;
    });
    this._redrawAll();
    this._redrawLocked();
    if (this.background) this._drawBackground();
    if (this._selectedIdx >= 0) this._redrawSelection();
  }

  get _sx() { return this.mainCanvas.width  / CW; }
  get _sy() { return this.mainCanvas.height / CH; }

  _toC(px, py)   { return { x: px / this._sx, y: py / this._sy }; }
  _fromC(cx, cy) { return { x: cx * this._sx, y: cy * this._sy }; }

  _getPos(e) {
    const r   = this.tempCanvas.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return this._toC(src.clientX - r.left, src.clientY - r.top);
  }

  // ── Events ────────────────────────────────────────────────────────────────
  _bindEvents() {
    const el = this.tempCanvas;
    el.addEventListener('pointerdown',  e => this._onDown(e));
    el.addEventListener('pointermove',  e => this._onMove(e));
    el.addEventListener('pointerup',    e => this._onUp(e));
    el.addEventListener('pointerleave', e => { if (this._isDrawing || this._isDragging) this._onUp(e); });
    el.addEventListener('contextmenu',  e => e.preventDefault());
  }

  _onDown(e) {
    if (this.readOnly) return;
    e.preventDefault();
    const { x, y } = this._getPos(e);

    if (this.tool === 'select') {
      const idx = this._hitTest(x, y);
      this._selectedIdx = idx;
      this.emit('selection-changed', idx >= 0 ? this.strokes[idx] : null);
      this.tempCtx.clearRect(0, 0, this.tempCanvas.width, this.tempCanvas.height);

      if (idx >= 0) {
        const s = this.strokes[idx];
        this._drawSelectionBox(this._getBounds(s), !!s.locked);
        if (!s.locked) {
          this._isDragging         = true;
          this._dragStartX         = x;
          this._dragStartY         = y;
          this._dragStrokeSnapshot = JSON.parse(JSON.stringify(s));
          s._dragging              = true;   // hide original on mainCanvas
          this._redrawAll();
        }
      }
      return;
    }

    this._isDrawing      = true;
    this.redoStack       = [];
    this._startX         = x;
    this._startY         = y;
    this._currentPoints  = [{ x, y }];
    this._activeStrokeId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID() : Math.random().toString(36);
    this._pendingPoints  = [{ x, y }];

    if (this.tool === 'text') { this._isDrawing = false; this._insertText(x, y); }
    if (this.tool === 'math') { this._isDrawing = false; this.emit('open-math', { x, y }); }
  }

  _onMove(e) {
    if (this.readOnly) return;
    e.preventDefault();
    const { x, y } = this._getPos(e);

    if (this.tool === 'select') {
      if (this._isDragging && this._selectedIdx >= 0 && this._dragStrokeSnapshot) {
        const dx    = x - this._dragStartX;
        const dy    = y - this._dragStartY;
        const moved = this._moveStroke(this._dragStrokeSnapshot, dx, dy);
        this.tempCtx.clearRect(0, 0, this.tempCanvas.width, this.tempCanvas.height);
        this._drawStroke(this.tempCtx, moved);
        this._drawSelectionBox(this._getBounds(moved), false);
      }
      return;
    }

    if (!this._isDrawing) return;
    this._currentPoints.push({ x, y });
    this._pendingPoints.push({ x, y });
    this._drawTemp();

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
    if (this.readOnly) return;
    const { x, y } = this._getPos(e);

    if (this.tool === 'select') {
      if (this._isDragging && this._selectedIdx >= 0 && this._dragStrokeSnapshot) {
        const dx = x - this._dragStartX;
        const dy = y - this._dragStartY;
        const s  = this.strokes[this._selectedIdx];
        if (s) delete s._dragging;

        if (Math.hypot(dx, dy) > 2) {
          const moved = this._moveStroke(this._dragStrokeSnapshot, dx, dy);
          this.strokes[this._selectedIdx] = moved;
          this._redrawAll();
          this.tempCtx.clearRect(0, 0, this.tempCanvas.width, this.tempCanvas.height);
          this._drawSelectionBox(this._getBounds(moved), !!moved.locked);
          this.emit('strokes-changed', this.strokes);
        } else {
          // Click without drag: just show selection box
          this._redrawAll();
          const sel = this.strokes[this._selectedIdx];
          if (sel) this._drawSelectionBox(this._getBounds(sel), !!sel.locked);
        }
        this._isDragging         = false;
        this._dragStrokeSnapshot = null;
      }
      return;
    }

    if (!this._isDrawing) return;
    this._isDrawing = false;
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

  // ── Hit testing & bounds ──────────────────────────────────────────────────
  _hitTest(cx, cy) {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      if (this._strokeContains(this.strokes[i], cx, cy)) return i;
    }
    return -1;
  }

  _strokeContains(s, cx, cy) {
    const T = Math.max(10, (s.width || 2) * 0.8);
    switch (s.type) {
      case 'pen':
      case 'eraser': {
        const pts = s.points || [];
        for (let i = 1; i < pts.length; i++) {
          if (_distToSeg(cx, cy, pts[i-1].x, pts[i-1].y, pts[i].x, pts[i].y) < T) return true;
        }
        return pts.length === 1 && Math.hypot(cx - pts[0].x, cy - pts[0].y) < T;
      }
      case 'line':
      case 'arrow':
        return _distToSeg(cx, cy, s.x1, s.y1, s.x2, s.y2) < T;
      case 'rect': {
        const x = Math.min(s.x, s.x + s.w), y = Math.min(s.y, s.y + s.h);
        const w = Math.abs(s.w), h = Math.abs(s.h);
        const inside = cx >= x - T && cx <= x + w + T && cy >= y - T && cy <= y + h + T;
        if (!inside) return false;
        if (s.filled) return true;
        return !(cx > x + T && cx < x + w - T && cy > y + T && cy < y + h - T);
      }
      case 'circle': {
        if (!s.rx || !s.ry) return false;
        const norm = Math.hypot((cx - s.cx) / s.rx, (cy - s.cy) / s.ry);
        return s.filled ? norm <= 1.05 : Math.abs(norm - 1) * Math.min(s.rx, s.ry) < T;
      }
      case 'triangle':
      case 'text':
      case 'image': {
        const b = this._getBounds(s);
        return cx >= b.x - 8 && cx <= b.x + b.w + 8 && cy >= b.y - 8 && cy <= b.y + b.h + 8;
      }
      default: return false;
    }
  }

  _getBounds(s) {
    switch (s.type) {
      case 'pen':
      case 'eraser': {
        const pts = s.points || [];
        if (!pts.length) return { x: 0, y: 0, w: 1, h: 1 };
        let minX = pts[0].x, maxX = pts[0].x, minY = pts[0].y, maxY = pts[0].y;
        pts.forEach(p => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); });
        return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
      }
      case 'line':
      case 'arrow':
        return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.max(1, Math.abs(s.x2 - s.x1)), h: Math.max(1, Math.abs(s.y2 - s.y1)) };
      case 'rect':
        return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.max(1, Math.abs(s.w)), h: Math.max(1, Math.abs(s.h)) };
      case 'circle':
        return { x: s.cx - Math.abs(s.rx), y: s.cy - Math.abs(s.ry), w: Math.abs(s.rx) * 2, h: Math.abs(s.ry) * 2 };
      case 'triangle': {
        const xs = [s.x1, s.x2, s.x3], ys = [s.y1, s.y2, s.y3];
        return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      }
      case 'text': {
        const fh = s.fontSize || 20;
        const lines = (s.text || '').split('\n');
        const approxW = Math.max(...lines.map(l => l.length * fh * 0.6));
        return { x: s.x, y: s.y - fh, w: Math.max(20, approxW), h: fh * lines.length * 1.4 };
      }
      case 'image':
        return { x: s.x, y: s.y, w: s.w || 1, h: s.h || 1 };
      default:
        return { x: 0, y: 0, w: 1, h: 1 };
    }
  }

  _moveStroke(s, dx, dy) {
    const n = JSON.parse(JSON.stringify(s));
    switch (n.type) {
      case 'pen':
      case 'eraser':
        n.points = n.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
        break;
      case 'line':
      case 'arrow':
        n.x1 += dx; n.y1 += dy; n.x2 += dx; n.y2 += dy;
        break;
      case 'rect':
      case 'text':
      case 'image':
        n.x += dx; n.y += dy;
        break;
      case 'circle':
        n.cx += dx; n.cy += dy;
        break;
      case 'triangle':
        n.x1 += dx; n.y1 += dy; n.x2 += dx; n.y2 += dy; n.x3 += dx; n.y3 += dy;
        break;
    }
    return n;
  }

  _drawSelectionBox(bounds, locked = false) {
    const ctx = this.tempCtx;
    const sx  = this.tempCanvas.width  / CW;
    const sy  = this.tempCanvas.height / CH;
    const pad = 8;
    const rx  = (bounds.x - pad) * sx,  ry  = (bounds.y - pad) * sy;
    const rw  = (bounds.w + pad * 2) * sx, rh = (bounds.h + pad * 2) * sy;

    ctx.save();
    ctx.strokeStyle = locked ? '#D97706' : '#2563EB';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.setLineDash([]);

    if (!locked) {
      ctx.fillStyle = '#2563EB';
      const hs = 7;
      [[rx, ry], [rx + rw, ry], [rx, ry + rh], [rx + rw, ry + rh]].forEach(([hx, hy]) => {
        ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
      });
    } else {
      const fs = Math.round(11 * Math.min(sx, sy));
      ctx.font      = `600 ${fs}px "Space Grotesk", sans-serif`;
      ctx.fillStyle = '#D97706';
      ctx.fillText('Vergrendeld', rx + 4, ry - 4);
    }
    ctx.restore();
  }

  _redrawSelection() {
    this.tempCtx.clearRect(0, 0, this.tempCanvas.width, this.tempCanvas.height);
    if (this._selectedIdx >= 0 && this._selectedIdx < this.strokes.length) {
      const s = this.strokes[this._selectedIdx];
      this._drawSelectionBox(this._getBounds(s), !!s.locked);
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  _drawStroke(ctx, s) {
    if (s._dragging) return;          // hidden during drag on tempCanvas
    ctx.save();
    ctx.globalAlpha  = s.opacity != null ? s.opacity : 1;
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
        for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x * sx, s.points[i].y * sy);
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
        const hl    = Math.max(12, W * 3.5);
        const angle = Math.atan2(dy, dx);
        ctx.beginPath(); ctx.moveTo(s.x1*sx, s.y1*sy); ctx.lineTo(s.x2*sx, s.y2*sy); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(s.x2*sx, s.y2*sy);
        ctx.lineTo(s.x2*sx - hl*Math.cos(angle-Math.PI/6), s.y2*sy - hl*Math.sin(angle-Math.PI/6));
        ctx.lineTo(s.x2*sx - hl*Math.cos(angle+Math.PI/6), s.y2*sy - hl*Math.sin(angle+Math.PI/6));
        ctx.closePath(); ctx.fill();
        break;
      }
      case 'rect': {
        if (s.filled) ctx.fillRect(s.x*sx, s.y*sy, s.w*sx, s.h*sy);
        else          ctx.strokeRect(s.x*sx, s.y*sy, s.w*sx, s.h*sy);
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
        ctx.moveTo(s.x1*sx, s.y1*sy); ctx.lineTo(s.x2*sx, s.y2*sy); ctx.lineTo(s.x3*sx, s.y3*sy);
        ctx.closePath();
        if (s.filled) ctx.fill(); else ctx.stroke();
        break;
      }
      case 'text': {
        ctx.font       = `${(s.fontSize||20)*Math.min(sx,sy)}px ${s.fontFamily||'Arial'}`;
        ctx.fillStyle  = s.color;
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

  _redrawLocked() {
    this.lockedCtx.clearRect(0, 0, this.lockedCanvas.width, this.lockedCanvas.height);
    this.lockedStrokes.forEach(s => this._drawStroke(this.lockedCtx, s));
  }

  _drawBackground() {
    const ctx = this.bgCtx;
    ctx.clearRect(0, 0, this.bgCanvas.width, this.bgCanvas.height);
    if (!this.background) return;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, this.bgCanvas.width, this.bgCanvas.height);
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, this.bgCanvas.width, this.bgCanvas.height);
    img.src = this.background.src;
  }

  _drawTemp() {
    const ctx = this.tempCtx;
    ctx.clearRect(0, 0, this.tempCanvas.width, this.tempCanvas.height);
    if (!this._currentPoints.length) return;
    const lx   = this._currentPoints[this._currentPoints.length - 1];
    const base = { color: this.color, width: this.lineWidth, opacity: this.opacity, filled: this.filled };
    let fake;
    switch (this.tool) {
      case 'pen':      fake = { ...base, type: 'pen',      points: this._currentPoints }; break;
      case 'eraser':   fake = { ...base, type: 'eraser',   points: this._currentPoints }; break;
      case 'line':     fake = { ...base, type: 'line',     x1: this._startX, y1: this._startY, x2: lx.x, y2: lx.y }; break;
      case 'arrow':    fake = { ...base, type: 'arrow',    x1: this._startX, y1: this._startY, x2: lx.x, y2: lx.y }; break;
      case 'rect':     fake = { ...base, type: 'rect',     x: this._startX, y: this._startY, w: lx.x - this._startX, h: lx.y - this._startY }; break;
      case 'circle':   fake = { ...base, type: 'circle',   cx: (this._startX+lx.x)/2, cy: (this._startY+lx.y)/2, rx: Math.abs(lx.x-this._startX)/2, ry: Math.abs(lx.y-this._startY)/2 }; break;
      case 'triangle': fake = { ...base, type: 'triangle', x1: this._startX, y1: lx.y, x2: lx.x, y2: lx.y, x3: (this._startX+lx.x)/2, y3: this._startY }; break;
      default: return;
    }
    this._drawStroke(ctx, fake);
  }

  // ── Text insertion ─────────────────────────────────────────────────────────
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
        const stroke = { id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36), type: 'text', x: cx, y: cy, text, color: this.color, fontSize: this.fontSize, fontFamily: this.fontFamily, opacity: this.opacity };
        this.strokes.push(stroke);
        this._drawStroke(this.mainCtx, stroke);
        if (this.onStroke) this.onStroke(stroke);
      }
      inp.remove();
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Escape') { inp.remove(); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
    });
  }

  // ── Public API: Tool settings ──────────────────────────────────────────────
  setTool(t) {
    // Clean up any active selection / drag
    if (this._selectedIdx >= 0 && this.strokes[this._selectedIdx]) {
      delete this.strokes[this._selectedIdx]._dragging;
      this._redrawAll();
    }
    this._selectedIdx        = -1;
    this._isDragging         = false;
    this._dragStrokeSnapshot = null;
    if (this.tempCtx) this.tempCtx.clearRect(0, 0, this.tempCanvas.width, this.tempCanvas.height);
    this.emit('selection-changed', null);

    this.tool = t;
    if (this.tempCanvas) {
      this.tempCanvas.style.cursor =
        t === 'eraser' ? 'cell' :
        t === 'text'   ? 'text' :
        t === 'select' ? 'default' : 'crosshair';
    }
  }
  setColor(c)      { this.color      = c; }
  setWidth(w)      { this.lineWidth  = w; }
  setFilled(f)     { this.filled     = f; }
  setFontSize(s)   { this.fontSize   = s; }
  setFontFamily(f) { this.fontFamily = f; }
  setOpacity(o)    { this.opacity    = o; }
  setReadOnly(v)   {
    this.readOnly = v;
    if (this.tempCanvas) this.tempCanvas.style.pointerEvents = v ? 'none' : 'auto';
  }

  // ── Public API: Strokes ────────────────────────────────────────────────────
  addStroke(stroke) {
    this.strokes.push(stroke);
    this._drawStroke(this.mainCtx, stroke);
  }

  addStreamPoints(strokeId, points, color, width, tool) {
    const ctx = this.tempCtx;
    const sx  = this.tempCanvas.width  / CW;
    const sy  = this.tempCanvas.height / CH;
    const W   = width * Math.min(sx, sy);
    ctx.save();
    ctx.strokeStyle = tool === 'eraser' ? '#FFFFFF' : color;
    ctx.lineWidth   = W;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
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
    this.strokes   = strokes || [];
    this.redoStack = [];
    this._redrawAll();
    if (this._selectedIdx >= 0) this._redrawSelection();
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
    this.strokes      = [];
    this._selectedIdx = -1;
    this._isDragging  = false;
    this.mainCtx.clearRect(0, 0, this.mainCanvas.width, this.mainCanvas.height);
    this.tempCtx.clearRect(0, 0, this.tempCanvas.width, this.tempCanvas.height);
    this.emit('selection-changed', null);
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

  // ── Public API: Select tool ────────────────────────────────────────────────
  deselect() {
    if (this._selectedIdx >= 0 && this.strokes[this._selectedIdx]) {
      delete this.strokes[this._selectedIdx]._dragging;
      this._redrawAll();
    }
    this._selectedIdx        = -1;
    this._isDragging         = false;
    this._dragStrokeSnapshot = null;
    this.tempCtx.clearRect(0, 0, this.tempCanvas.width, this.tempCanvas.height);
    this.emit('selection-changed', null);
  }

  getSelectedStroke() {
    return (this._selectedIdx >= 0 && this._selectedIdx < this.strokes.length)
      ? this.strokes[this._selectedIdx] : null;
  }

  deleteSelected() {
    if (this._selectedIdx < 0) return null;
    if (this.strokes[this._selectedIdx]) delete this.strokes[this._selectedIdx]._dragging;
    const removed = this.strokes.splice(this._selectedIdx, 1)[0];
    this._selectedIdx        = -1;
    this._isDragging         = false;
    this._dragStrokeSnapshot = null;
    this._redrawAll();
    this.tempCtx.clearRect(0, 0, this.tempCanvas.width, this.tempCanvas.height);
    this.emit('strokes-changed', this.strokes);
    this.emit('selection-changed', null);
    return removed;
  }

  // ── Public API: Z-order ────────────────────────────────────────────────────
  bringForward() {
    if (this._selectedIdx < 0 || this._selectedIdx >= this.strokes.length - 1) return;
    const i = this._selectedIdx;
    [this.strokes[i], this.strokes[i+1]] = [this.strokes[i+1], this.strokes[i]];
    this._selectedIdx = i + 1;
    this._redrawAll();
    this._redrawSelection();
    this.emit('strokes-changed', this.strokes);
  }

  sendBackward() {
    if (this._selectedIdx <= 0) return;
    const i = this._selectedIdx;
    [this.strokes[i], this.strokes[i-1]] = [this.strokes[i-1], this.strokes[i]];
    this._selectedIdx = i - 1;
    this._redrawAll();
    this._redrawSelection();
    this.emit('strokes-changed', this.strokes);
  }

  bringToFront() {
    if (this._selectedIdx < 0) return;
    const s = this.strokes.splice(this._selectedIdx, 1)[0];
    this.strokes.push(s);
    this._selectedIdx = this.strokes.length - 1;
    this._redrawAll();
    this._redrawSelection();
    this.emit('strokes-changed', this.strokes);
  }

  sendToBack() {
    if (this._selectedIdx < 0) return;
    const s = this.strokes.splice(this._selectedIdx, 1)[0];
    this.strokes.unshift(s);
    this._selectedIdx = 0;
    this._redrawAll();
    this._redrawSelection();
    this.emit('strokes-changed', this.strokes);
  }

  // ── Public API: Per-item lock (teacher-side marker) ───────────────────────
  lockSelected() {
    if (this._selectedIdx < 0) return;
    this.strokes[this._selectedIdx].locked = true;
    this._redrawSelection();
    this.emit('strokes-changed', this.strokes);
    this.emit('selection-changed', this.strokes[this._selectedIdx]);
  }

  unlockSelected() {
    if (this._selectedIdx < 0) return;
    delete this.strokes[this._selectedIdx].locked;
    this._redrawSelection();
    this.emit('strokes-changed', this.strokes);
    this.emit('selection-changed', this.strokes[this._selectedIdx]);
  }

  lockAll()   { this.strokes.forEach(s => { s.locked = true; });  this._redrawSelection(); this.emit('strokes-changed', this.strokes); }
  unlockAll() { this.strokes.forEach(s => { delete s.locked; });  this._redrawSelection(); this.emit('strokes-changed', this.strokes); }

  // ── Public API: Locked layer (teacher → students) ─────────────────────────
  setLockedStrokes(strokes) {
    this.lockedStrokes = strokes || [];
    this._redrawLocked();
  }

  clearLockedStrokes() {
    this.lockedStrokes = [];
    this.lockedCtx.clearRect(0, 0, this.lockedCanvas.width, this.lockedCanvas.height);
  }

  // ── Public API: Getters ────────────────────────────────────────────────────
  getStrokes()       { return this.strokes; }
  getBackground()    { return this.background; }
  getLockedStrokes() { return this.lockedStrokes; }

  toDataURL() {
    const oc  = document.createElement('canvas');
    oc.width  = CW;
    oc.height = CH;
    const ctx = oc.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, CW, CH);
    if (this.bgCanvas)     ctx.drawImage(this.bgCanvas,     0, 0, CW, CH);
    if (this.lockedCanvas) ctx.drawImage(this.lockedCanvas, 0, 0, CW, CH);
    if (this.mainCanvas)   ctx.drawImage(this.mainCanvas,   0, 0, CW, CH);
    return oc.toDataURL('image/png');
  }

  emit(evt, data) { (this._handlers[evt] || []).forEach(fn => fn(data)); }
  on(evt, fn)     { (this._handlers[evt] = this._handlers[evt] || []).push(fn); }

  destroy() {
    this._ro && this._ro.disconnect();
    [this.bgCanvas, this.lockedCanvas, this.mainCanvas, this.tempCanvas]
      .forEach(cv => cv && cv.remove());
  }
}
