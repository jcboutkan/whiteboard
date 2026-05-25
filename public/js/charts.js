// Chart rendering utilities — all return a data URL string

const CHART_COLORS = ['#2563EB','#10B981','#F59E0B','#EF4444','#8B5CF6','#EC4899','#06B6D4','#F97316'];

function renderBarChart(data, { title = '', xlabel = '', ylabel = '', w = 560, h = 380 } = {}) {
  const oc = document.createElement('canvas');
  oc.width = w; oc.height = h;
  const ctx = oc.getContext('2d');
  const pad = { top: 40, right: 20, bottom: 60, left: 60 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);

  const maxVal = Math.max(...data.map(d => d.value), 0) * 1.1 || 1;
  const barW = cw / data.length * 0.65;
  const gap  = cw / data.length;

  // Axes
  ctx.strokeStyle = '#CBD5E1'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, pad.top + ch); ctx.lineTo(pad.left + cw, pad.top + ch); ctx.stroke();

  // Grid lines
  const ticks = 5;
  ctx.strokeStyle = '#F1F5F9'; ctx.fillStyle = '#64748B'; ctx.font = '11px system-ui';
  ctx.textAlign = 'right';
  for (let i = 0; i <= ticks; i++) {
    const v = maxVal * i / ticks;
    const y = pad.top + ch - (ch * i / ticks);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke();
    ctx.fillText(Math.round(v), pad.left - 6, y + 4);
  }

  // Bars
  data.forEach((d, i) => {
    const x = pad.left + gap * i + (gap - barW) / 2;
    const barH = ch * (d.value / maxVal);
    const y = pad.top + ch - barH;
    ctx.fillStyle = d.color || CHART_COLORS[i % CHART_COLORS.length];
    ctx.fillRect(x, y, barW, barH);
    // Label
    ctx.fillStyle = '#1E293B'; ctx.textAlign = 'center'; ctx.font = '11px system-ui';
    const label = String(d.label || '');
    ctx.fillText(label.length > 8 ? label.slice(0,8)+'…' : label, x + barW / 2, pad.top + ch + 18);
    // Value on bar
    ctx.fillStyle = '#475569'; ctx.font = '10px system-ui';
    ctx.fillText(d.value, x + barW / 2, y - 4);
  });

  // Title
  if (title) { ctx.fillStyle = '#1E293B'; ctx.font = 'bold 14px system-ui'; ctx.textAlign = 'center'; ctx.fillText(title, w/2, 22); }
  // Axis labels
  if (xlabel) { ctx.fillStyle = '#64748B'; ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.fillText(xlabel, w/2, h - 6); }
  if (ylabel) { ctx.save(); ctx.translate(14, h/2); ctx.rotate(-Math.PI/2); ctx.textAlign = 'center'; ctx.fillText(ylabel, 0, 0); ctx.restore(); }

  return oc.toDataURL();
}

function renderLineChart(data, { title = '', xlabel = '', ylabel = '', w = 560, h = 380 } = {}) {
  const oc = document.createElement('canvas');
  oc.width = w; oc.height = h;
  const ctx = oc.getContext('2d');
  const pad = { top: 40, right: 20, bottom: 60, left: 60 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);

  const maxVal = Math.max(...data.map(d => d.value), 0) * 1.1 || 1;
  const ticks = 5;

  // Grid & axes
  ctx.strokeStyle = '#CBD5E1'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, pad.top + ch); ctx.lineTo(pad.left + cw, pad.top + ch); ctx.stroke();

  ctx.strokeStyle = '#F1F5F9';
  ctx.fillStyle = '#64748B'; ctx.font = '11px system-ui'; ctx.textAlign = 'right';
  for (let i = 0; i <= ticks; i++) {
    const v = maxVal * i / ticks;
    const y = pad.top + ch - (ch * i / ticks);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke();
    ctx.fillText(Math.round(v), pad.left - 6, y + 4);
  }

  // Line
  if (data.length > 0) {
    const stepX = cw / (data.length - 1 || 1);
    ctx.strokeStyle = CHART_COLORS[0]; ctx.lineWidth = 2.5;
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = pad.left + stepX * i;
      const y = pad.top + ch - (ch * d.value / maxVal);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Points + labels
    data.forEach((d, i) => {
      const x = pad.left + stepX * i;
      const y = pad.top + ch - (ch * d.value / maxVal);
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI*2); ctx.fillStyle = CHART_COLORS[0]; ctx.fill();
      ctx.fillStyle = '#1E293B'; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
      const label = String(d.label || '');
      ctx.fillText(label.length > 8 ? label.slice(0,8)+'…' : label, x, pad.top + ch + 18);
    });
  }

  if (title) { ctx.fillStyle = '#1E293B'; ctx.font = 'bold 14px system-ui'; ctx.textAlign = 'center'; ctx.fillText(title, w/2, 22); }
  if (xlabel) { ctx.fillStyle = '#64748B'; ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.fillText(xlabel, w/2, h - 6); }
  if (ylabel) { ctx.save(); ctx.translate(14, h/2); ctx.rotate(-Math.PI/2); ctx.textAlign = 'center'; ctx.fillText(ylabel, 0, 0); ctx.restore(); }

  return oc.toDataURL();
}

function renderPieChart(data, { title = '', w = 420, h = 360, donut = false } = {}) {
  const oc = document.createElement('canvas');
  oc.width = w; oc.height = h;
  const ctx = oc.getContext('2d');
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, w, h);

  const total = data.reduce((s, d) => s + Math.abs(d.value), 0) || 1;
  const cx = w * 0.42, cy = h / 2;
  const r  = Math.min(cx, cy) - 20;
  let startAngle = -Math.PI / 2;

  data.forEach((d, i) => {
    const slice = (Math.abs(d.value) / total) * Math.PI * 2;
    const color = d.color || CHART_COLORS[i % CHART_COLORS.length];
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, startAngle + slice);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 1.5;
    ctx.stroke();

    // Percentage label
    const midAngle = startAngle + slice / 2;
    const lx = cx + Math.cos(midAngle) * r * 0.65;
    const ly = cy + Math.sin(midAngle) * r * 0.65;
    const pct = Math.round(d.value / total * 100);
    if (pct > 5) {
      ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(pct + '%', lx, ly + 4);
    }
    startAngle += slice;
  });

  if (donut) {
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.5, 0, Math.PI*2);
    ctx.fillStyle = '#FFFFFF'; ctx.fill();
  }

  // Legend
  const legX = w * 0.82;
  let legY = 40;
  data.forEach((d, i) => {
    const color = d.color || CHART_COLORS[i % CHART_COLORS.length];
    ctx.fillStyle = color;
    ctx.fillRect(legX - 30, legY - 10, 14, 14);
    ctx.fillStyle = '#1E293B'; ctx.font = '11px system-ui'; ctx.textAlign = 'left';
    const label = String(d.label || '');
    ctx.fillText(label.length > 10 ? label.slice(0,10)+'…' : label, legX - 12, legY + 2);
    legY += 22;
  });

  if (title) { ctx.fillStyle = '#1E293B'; ctx.font = 'bold 14px system-ui'; ctx.textAlign = 'center'; ctx.fillText(title, w/2, 18); }

  return oc.toDataURL();
}

function renderProtractor(w = 280, h = 160) {
  const oc = document.createElement('canvas');
  oc.width = w; oc.height = h + 20;
  const ctx = oc.getContext('2d');
  ctx.fillStyle = 'rgba(254,243,199,.9)';
  ctx.fillRect(0, 0, oc.width, oc.height);

  const cx = w / 2, cy = h + 10, r = h;
  ctx.strokeStyle = '#92400E'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI, 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.stroke();

  ctx.font = '9px system-ui'; ctx.fillStyle = '#92400E'; ctx.textAlign = 'center';
  for (let deg = 0; deg <= 180; deg += 10) {
    const rad = (deg - 0) * Math.PI / 180;
    const sin = Math.sin(Math.PI - rad), cos = Math.cos(Math.PI - rad);
    const x1 = cx + (r - (deg%30===0?12:6)) * cos;
    const y1 = cy - (r - (deg%30===0?12:6)) * sin;
    const x2 = cx + r * cos, y2 = cy - r * sin;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    if (deg % 30 === 0) ctx.fillText(deg, cx + (r-22)*cos, cy - (r-22)*sin + 3);
  }
  // Center dot
  ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI*2); ctx.fillStyle = '#92400E'; ctx.fill();
  return oc.toDataURL();
}

function renderRuler(w = 500, h = 60, cm = 20) {
  const oc = document.createElement('canvas');
  oc.width = w; oc.height = h;
  const ctx = oc.getContext('2d');
  ctx.fillStyle = 'rgba(254,243,199,.95)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#92400E'; ctx.lineWidth = 1.5;
  ctx.strokeRect(0.75, 0.75, w-1.5, h-1.5);

  const pxPerCm = (w - 20) / cm;
  ctx.fillStyle = '#92400E'; ctx.font = '10px system-ui'; ctx.textAlign = 'center';
  for (let i = 0; i <= cm * 10; i++) {
    const x = 10 + i * pxPerCm / 10;
    const isMm = i % 10;
    const isCm = i % 10 === 0;
    const tickH = isCm ? 20 : (isMm % 5 === 0 ? 12 : 6);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, tickH); ctx.stroke();
    if (isCm && i > 0) ctx.fillText(i/10, x, tickH + 12);
  }
  ctx.fillText('cm', w - 8, h - 4);
  return oc.toDataURL();
}

function renderAngleMarker(angleDeg = 45, w = 200, h = 200) {
  const oc = document.createElement('canvas');
  oc.width = w; oc.height = h;
  const ctx = oc.getContext('2d');
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, w, h);

  const cx = w * 0.2, cy = h * 0.8, r = Math.min(w, h) * 0.6;
  const rad = angleDeg * Math.PI / 180;

  ctx.strokeStyle = '#2563EB'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + r, cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + r * Math.cos(-rad), cy + r * Math.sin(-rad)); ctx.stroke();

  ctx.strokeStyle = '#EF4444'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.3, -rad, 0); ctx.stroke();

  ctx.fillStyle = '#EF4444'; ctx.font = 'bold 14px system-ui'; ctx.textAlign = 'center';
  ctx.fillText(angleDeg + '°', cx + r * 0.38 * Math.cos(-rad/2), cy + r * 0.38 * Math.sin(-rad/2) - 6);

  return oc.toDataURL();
}
