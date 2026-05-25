const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 20e6
});

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.static('public'));
app.use(express.json({ limit: '5mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));

// In-memory store
const rooms = new Map();      // roomCode -> room
const libraries = new Map();  // teacherId -> [{id, name, strokes, background, savedAt}]

function generateCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function makeRoom(teacherSocketId, teacherName, teacherId) {
  let code;
  do { code = generateCode(); } while (rooms.has(code));
  const room = {
    code,
    teacherSocketId,
    teacherName,
    teacherId,
    coTeachers: [],
    students: new Map(),       // studentId -> {socketId, name, studentId, online}
    pending: new Map(),        // socketId -> {socketId, name, studentId}
    whiteboards: new Map(),    // studentId -> stroke[]
    backgrounds: new Map(),    // studentId -> bgData
    teacherStrokes: [],
    teacherBackground: null,
    focusMode: false,
    createdAt: Date.now()
  };
  rooms.set(code, room);
  return room;
}

// --- REST endpoints ---

// Docent route — separate from student index
app.get('/docent', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'docent.html'));
});

// Teacher PIN config
app.get('/api/teacher-config', (req, res) => {
  res.json({ hasPin: !!process.env.TEACHER_PIN });
});

app.post('/api/verify-teacher', (req, res) => {
  if (!process.env.TEACHER_PIN) return res.json({ ok: true });
  res.json({ ok: req.body.pin === process.env.TEACHER_PIN });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Geen bestand' });
  res.json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname });
});

app.get('/api/room/:code/exists', (req, res) => {
  res.json({ exists: rooms.has(req.params.code.toUpperCase()) });
});

// --- Socket.io ---

io.on('connection', (socket) => {

  // Teacher creates a room
  socket.on('create-room', ({ teacherName, teacherId }) => {
    const tid = teacherId || uuidv4();
    const room = makeRoom(socket.id, teacherName, tid);
    socket.join(room.code);
    socket.data = { role: 'teacher', roomCode: room.code, teacherName, teacherId: tid };
    socket.emit('room-created', {
      code: room.code,
      teacherId: tid,
      coTeacherCode: `CT-${room.code}`
    });
  });

  // Teacher reconnects to existing room
  socket.on('rejoin-as-teacher', ({ roomCode, teacherId }) => {
    const room = rooms.get(roomCode);
    if (!room || room.teacherId !== teacherId) {
      socket.emit('rejoin-error', { message: 'Kamer niet gevonden of ongeldige docent-ID' });
      return;
    }
    room.teacherSocketId = socket.id;
    socket.join(roomCode);
    socket.data = { role: 'teacher', roomCode, teacherName: room.teacherName, teacherId };
    const students = Array.from(room.students.values()).map(s => ({
      studentId: s.studentId,
      name: s.name,
      online: s.online,
      strokes: room.whiteboards.get(s.studentId) || [],
      background: room.backgrounds.get(s.studentId) || null
    }));
    socket.emit('room-rejoined', {
      code: roomCode,
      teacherStrokes: room.teacherStrokes,
      teacherBackground: room.teacherBackground,
      focusMode: room.focusMode,
      students
    });
    io.to(roomCode).emit('teacher-reconnected');
  });

  // Student requests to join
  socket.on('request-join', ({ roomCode, studentName, studentId }) => {
    const room = rooms.get(roomCode.toUpperCase());
    if (!room) {
      socket.emit('join-error', { message: 'Kamer niet gevonden. Controleer de code.' });
      return;
    }
    const code = roomCode.toUpperCase();

    // Returning student
    if (studentId && room.students.has(studentId)) {
      const student = room.students.get(studentId);
      student.socketId = socket.id;
      student.online = true;
      socket.join(code);
      socket.data = { role: 'student', roomCode: code, studentId, studentName: student.name };
      socket.emit('join-approved', {
        studentId,
        name: student.name,
        strokes: room.whiteboards.get(studentId) || [],
        background: room.backgrounds.get(studentId) || null,
        focusMode: room.focusMode,
        teacherStrokes: room.focusMode ? room.teacherStrokes : null,
        teacherBackground: room.focusMode ? room.teacherBackground : null
      });
      io.to(room.teacherSocketId).emit('student-reconnected', { studentId, name: student.name });
      room.coTeachers.forEach(ct => io.to(ct.socketId).emit('student-reconnected', { studentId, name: student.name }));
      return;
    }

    // New student -> pending lobby
    const newId = studentId || uuidv4();
    room.pending.set(socket.id, { socketId: socket.id, name: studentName, studentId: newId });
    socket.data = { role: 'pending', roomCode: code, studentName, pendingId: newId };
    io.to(room.teacherSocketId).emit('student-waiting', {
      socketId: socket.id,
      name: studentName,
      studentId: newId
    });
    socket.emit('waiting-for-approval');
  });

  // Teacher approves student
  socket.on('approve-student', ({ studentSocketId, studentId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const pending = room.pending.get(studentSocketId);
    if (!pending) return;
    room.pending.delete(studentSocketId);

    const sid = studentId || pending.studentId;
    room.students.set(sid, { socketId: studentSocketId, name: pending.name, studentId: sid, online: true });
    room.whiteboards.set(sid, []);

    const s = io.sockets.sockets.get(studentSocketId);
    if (s) {
      s.join(socket.data.roomCode);
      s.data = { role: 'student', roomCode: socket.data.roomCode, studentId: sid, studentName: pending.name };
      s.emit('join-approved', {
        studentId: sid,
        name: pending.name,
        strokes: [],
        background: null,
        focusMode: room.focusMode,
        teacherStrokes: room.focusMode ? room.teacherStrokes : null,
        teacherBackground: room.focusMode ? room.teacherBackground : null
      });
    }
    io.to(room.teacherSocketId).emit('student-joined', { studentId: sid, name: pending.name });
    room.coTeachers.forEach(ct => io.to(ct.socketId).emit('student-joined', { studentId: sid, name: pending.name }));
  });

  socket.on('reject-student', ({ studentSocketId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    room.pending.delete(studentSocketId);
    const s = io.sockets.sockets.get(studentSocketId);
    if (s) s.emit('join-rejected');
  });

  // Drawing: pen streaming (batched points during drag)
  socket.on('stroke-points', ({ points, strokeId, color, width, tool }) => {
    const { roomCode, role, studentId } = socket.data;
    const room = rooms.get(roomCode);
    if (!room || role !== 'student') return;

    // Relay to teacher & co-teachers for live preview
    const data = { studentId, points, strokeId, color, width, tool };
    io.to(room.teacherSocketId).emit('student-stroke-points', data);
    room.coTeachers.forEach(ct => io.to(ct.socketId).emit('student-stroke-points', data));
  });

  // Drawing: complete stroke committed
  socket.on('stroke-commit', (stroke) => {
    const { roomCode, role, studentId } = socket.data;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (role === 'student') {
      const strokes = room.whiteboards.get(studentId) || [];
      strokes.push(stroke);
      room.whiteboards.set(studentId, strokes);
      const data = { studentId, stroke };
      io.to(room.teacherSocketId).emit('student-stroke-commit', data);
      room.coTeachers.forEach(ct => io.to(ct.socketId).emit('student-stroke-commit', data));
    } else if (role === 'teacher' || role === 'co-teacher') {
      room.teacherStrokes.push(stroke);
      if (room.focusMode) {
        io.to(roomCode).emit('teacher-stroke-commit', stroke);
      }
    }
  });

  // Teacher broadcasts points in focus mode
  socket.on('teacher-stroke-points', (data) => {
    const { roomCode, role } = socket.data;
    const room = rooms.get(roomCode);
    if (!room || (role !== 'teacher' && role !== 'co-teacher')) return;
    if (room.focusMode) io.to(roomCode).emit('teacher-stroke-points', data);
  });

  socket.on('clear-canvas', ({ targetStudentId } = {}) => {
    const { roomCode, role, studentId } = socket.data;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (role === 'student') {
      room.whiteboards.set(studentId, []);
    } else if (targetStudentId) {
      room.whiteboards.set(targetStudentId, []);
      const st = room.students.get(targetStudentId);
      if (st) io.to(st.socketId).emit('canvas-cleared');
      io.to(room.teacherSocketId).emit('student-canvas-cleared', { studentId: targetStudentId });
    } else {
      room.teacherStrokes = [];
    }
  });

  socket.on('undo-stroke', ({ targetStudentId } = {}) => {
    const { roomCode, role, studentId } = socket.data;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (role === 'student') {
      const strokes = room.whiteboards.get(studentId) || [];
      const removed = strokes.pop();
      if (removed) {
        io.to(room.teacherSocketId).emit('student-undo', { studentId, strokes });
        room.coTeachers.forEach(ct => io.to(ct.socketId).emit('student-undo', { studentId, strokes }));
      }
    } else if (targetStudentId) {
      const strokes = room.whiteboards.get(targetStudentId) || [];
      strokes.pop();
      room.whiteboards.set(targetStudentId, strokes);
      const st = room.students.get(targetStudentId);
      if (st) io.to(st.socketId).emit('strokes-updated', { strokes });
    } else {
      room.teacherStrokes.pop();
    }
  });

  // Focus mode
  socket.on('toggle-focus-mode', ({ enabled }) => {
    const { roomCode, role } = socket.data;
    const room = rooms.get(roomCode);
    if (!room || (role !== 'teacher' && role !== 'co-teacher')) return;
    room.focusMode = enabled;
    io.to(roomCode).emit('focus-mode-changed', {
      enabled,
      teacherStrokes: enabled ? room.teacherStrokes : null,
      teacherBackground: enabled ? room.teacherBackground : null
    });
  });

  // Emote
  socket.on('emote', ({ emote }) => {
    const { roomCode, role, studentId, studentName, teacherName } = socket.data;
    const room = rooms.get(roomCode);
    if (!room) return;
    const from = role === 'teacher' ? (teacherName || 'Docent') : studentName;
    const data = { emote, from, studentId: role === 'student' ? studentId : null, role };

    if (role === 'student') {
      io.to(room.teacherSocketId).emit('emote-received', data);
      room.coTeachers.forEach(ct => io.to(ct.socketId).emit('emote-received', data));
    } else {
      io.to(roomCode).emit('emote-received', data);
    }
  });

  // Student cancels their own active emote
  socket.on('emote-cancel', () => {
    const { roomCode, role, studentId } = socket.data;
    const room = rooms.get(roomCode);
    if (!room || role !== 'student') return;
    io.to(room.teacherSocketId).emit('emote-cancelled', { studentId });
    room.coTeachers.forEach(ct => io.to(ct.socketId).emit('emote-cancelled', { studentId }));
  });

  // Teacher dismisses a student emote (sends acknowledgement to student)
  socket.on('emote-dismiss', ({ studentId }) => {
    const { roomCode } = socket.data;
    const room = rooms.get(roomCode);
    if (!room) return;
    const st = room.students.get(studentId);
    if (st) io.to(st.socketId).emit('emote-dismissed');
    room.coTeachers.forEach(ct => io.to(ct.socketId).emit('emote-cancelled', { studentId }));
  });

  // Tab switch detection
  socket.on('tab-hidden', () => {
    const { roomCode, role, studentId, studentName } = socket.data;
    const room = rooms.get(roomCode);
    if (!room || role !== 'student') return;
    io.to(room.teacherSocketId).emit('student-tab-hidden', { studentId, name: studentName, time: new Date().toLocaleTimeString('nl-NL') });
    room.coTeachers.forEach(ct => io.to(ct.socketId).emit('student-tab-hidden', { studentId, name: studentName }));
  });

  // Background (image, PDF page)
  socket.on('set-background', ({ bgData, targetStudentId, forAll }) => {
    const { roomCode, role, studentId } = socket.data;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (role === 'teacher' || role === 'co-teacher') {
      if (forAll) {
        room.students.forEach((st) => {
          room.backgrounds.set(st.studentId, bgData);
          io.to(st.socketId).emit('background-set', { bgData });
        });
        room.teacherBackground = bgData;
        io.to(room.teacherSocketId).emit('teacher-bg-set', { bgData });
      } else if (targetStudentId) {
        room.backgrounds.set(targetStudentId, bgData);
        const st = room.students.get(targetStudentId);
        if (st) io.to(st.socketId).emit('background-set', { bgData });
        io.to(room.teacherSocketId).emit('student-bg-updated', { studentId: targetStudentId });
      } else {
        room.teacherBackground = bgData;
      }
    } else {
      room.backgrounds.set(studentId, bgData);
    }
  });

  // Co-teacher join
  socket.on('join-as-co-teacher', ({ roomCode, ctCode, name }) => {
    const code = roomCode.toUpperCase();
    const room = rooms.get(code);
    if (!room || ctCode !== `CT-${code}`) {
      socket.emit('join-error', { message: 'Ongeldige co-docent code' });
      return;
    }
    const ctId = uuidv4();
    room.coTeachers.push({ socketId: socket.id, name, ctId });
    socket.join(code);
    socket.data = { role: 'co-teacher', roomCode: code, teacherName: name };
    const students = Array.from(room.students.values()).map(s => ({
      studentId: s.studentId,
      name: s.name,
      online: s.online,
      strokes: room.whiteboards.get(s.studentId) || [],
      background: room.backgrounds.get(s.studentId) || null
    }));
    socket.emit('co-teacher-approved', {
      code,
      teacherStrokes: room.teacherStrokes,
      teacherBackground: room.teacherBackground,
      focusMode: room.focusMode,
      students
    });
    io.to(room.teacherSocketId).emit('co-teacher-joined', { name, ctId });
  });

  // Whiteboard library
  socket.on('save-to-library', ({ name, strokes, background }) => {
    const { teacherId } = socket.data;
    if (!teacherId) return;
    if (!libraries.has(teacherId)) libraries.set(teacherId, []);
    const lib = libraries.get(teacherId);
    const entry = { id: uuidv4(), name, strokes: strokes || [], background: background || null, savedAt: new Date().toISOString() };
    lib.push(entry);
    socket.emit('library-saved', { id: entry.id, name: entry.name, savedAt: entry.savedAt });
  });

  socket.on('get-library', () => {
    const { teacherId } = socket.data;
    if (!teacherId) { socket.emit('library-data', []); return; }
    const lib = libraries.get(teacherId) || [];
    socket.emit('library-data', lib.map(e => ({ id: e.id, name: e.name, savedAt: e.savedAt })));
  });

  socket.on('load-from-library', ({ id }) => {
    const { teacherId } = socket.data;
    if (!teacherId) return;
    const lib = libraries.get(teacherId) || [];
    const entry = lib.find(e => e.id === id);
    if (entry) socket.emit('library-entry', entry);
  });

  socket.on('delete-from-library', ({ id }) => {
    const { teacherId } = socket.data;
    if (!teacherId) return;
    if (libraries.has(teacherId)) {
      libraries.set(teacherId, libraries.get(teacherId).filter(e => e.id !== id));
    }
    socket.emit('library-deleted', { id });
  });

  socket.on('request-sync', ({ studentId: reqId }) => {
    const { roomCode } = socket.data;
    const room = rooms.get(roomCode);
    if (!room) return;
    const targetId = reqId || socket.data.studentId;
    const strokes = room.whiteboards.get(targetId) || [];
    const background = room.backgrounds.get(targetId) || null;
    socket.emit('sync-data', { studentId: targetId, strokes, background });
  });

  socket.on('disconnect', () => {
    const { roomCode, role, studentId } = socket.data || {};
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (role === 'student' && studentId) {
      const st = room.students.get(studentId);
      if (st) {
        st.online = false;
        io.to(room.teacherSocketId).emit('student-offline', { studentId });
        room.coTeachers.forEach(ct => io.to(ct.socketId).emit('student-offline', { studentId }));
      }
    } else if (role === 'teacher') {
      io.to(roomCode).emit('teacher-disconnected');
    } else if (role === 'co-teacher') {
      room.coTeachers = room.coTeachers.filter(ct => ct.socketId !== socket.id);
    } else if (role === 'pending') {
      room.pending.delete(socket.id);
      io.to(room.teacherSocketId).emit('pending-cancelled', { socketId: socket.id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Whiteboard server actief op poort ${PORT}`));
