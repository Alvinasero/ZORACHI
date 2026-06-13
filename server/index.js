const path = require('path');
const fs = require('fs');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer'); // Import multer
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'zorachi-secret-key';

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const dataDir = path.join(__dirname, '..', 'data');
// Ensure the data directory and uploads subdirectory exist
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const uploadDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });
const dbPath = path.join(dataDir, 'db.json');

function ensureDb() {
  if (!fs.existsSync(dbPath)) {
    const init = { users: [], messages: [], assignments: [], attendance: {}, cats: [] };
    fs.writeFileSync(dbPath, JSON.stringify(init, null, 2));
  }
}

function readDb() {
  ensureDb();
  try {
    const data = fs.readFileSync(dbPath, 'utf8');
    const db = JSON.parse(data || '{}');
    // Ensure mandatory structures exist
    db.users = Array.isArray(db.users) ? db.users : [];
    db.messages = Array.isArray(db.messages) ? db.messages : [];
    db.assignments = Array.isArray(db.assignments) ? db.assignments : [];
    db.attendance = (db.attendance && typeof db.attendance === 'object') ? db.attendance : {};
    db.cats = Array.isArray(db.cats) ? db.cats : [];
    return db;
  } catch (err) {
    console.error('Database read error:', err);
    return { users: [], messages: [], assignments: [], attendance: {}, cats: [] };
  }
}

function writeDb(db) {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('Database write error:', err);
  }
}

const now = () => new Date().toISOString();
const { createEmbedding, storeEmbedding, listEmbeddings, searchEmbeddings } = require('./claude');

const embeddingRateLimits = new Map();
const EMBEDDING_RATE_LIMIT = 5; // requests per minute per user
const EMBEDDING_RATE_WINDOW_MS = 60_000;
const sseClients = new Set();

function broadcastChatMessage(msg) {
  const payload = JSON.stringify(msg);
  for (const res of sseClients) {
    try {
      res.write(`event: message\nid: ${msg.id}\ndata: ${payload}\n\n`);
    } catch (err) {
      sseClients.delete(res);
    }
  }
}

function nextId(arr) {
  let max = 0;
  for (const x of arr) if (x.id && x.id > max) max = x.id;
  return max + 1;
}

function findUserByEmail(email) {
  const db = readDb();
  return (db.users || []).find(user => user.email.toLowerCase() === email.toLowerCase());
}

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role, firstName: user.firstName, lastName: user.lastName, otherName: user.otherName }, JWT_SECRET, { expiresIn: '8h' });
}

function authenticateToken(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Authorization required' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(403).json({ error: 'Access denied for your role' });
    if (Array.isArray(role)) {
      if (!role.includes(req.user.role)) return res.status(403).json({ error: 'Access denied for your role' });
    } else {
      if (req.user.role !== role) return res.status(403).json({ error: 'Access denied for your role' });
    }
    next();
  };
}

function canIndexEmbeddings(req, res, next) {
  const allowedRoles = ['teacher', 'admin'];
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Only teachers or admins can create embeddings' });
  }

  const key = req.user.email.toLowerCase();
  const nowMs = Date.now();
  const state = embeddingRateLimits.get(key) || { count: 0, windowStart: nowMs };
  if (nowMs - state.windowStart > EMBEDDING_RATE_WINDOW_MS) {
    state.count = 0;
    state.windowStart = nowMs;
  }
  state.count += 1;
  if (state.count > EMBEDDING_RATE_LIMIT) {
    embeddingRateLimits.set(key, state);
    return res.status(429).json({ error: `Rate limit exceeded. Try again in ${Math.ceil((EMBEDDING_RATE_WINDOW_MS - (nowMs - state.windowStart)) / 1000)} seconds.` });
  }
  embeddingRateLimits.set(key, state);
  next();
}

app.post('/api/signup', async (req, res) => {
  const { email, password, role, firstName, lastName, otherName } = req.body;
  if (!email || !password || !role || !firstName || !lastName) return res.status(400).json({ error: 'Email, password, role, first name, and last name are required' });
  const db = readDb();
  db.users = db.users || [];
  if (findUserByEmail(email)) return res.status(400).json({ error: 'Email already exists' });
  const hashed = await bcrypt.hash(password, 10);
  const name = `${firstName} ${otherName ? otherName + ' ' : ''}${lastName}`.trim();
  const newUser = { id: nextId(db.users), email, password: hashed, role, firstName, lastName, otherName: otherName || null, name };
  db.users.push(newUser);
  writeDb(db);
  const token = signToken(newUser); // Token now includes firstName, lastName, otherName
  res.json({ token, name: newUser.name, role: newUser.role, email: newUser.email, firstName: newUser.firstName, lastName: newUser.lastName, otherName: newUser.otherName });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const user = findUserByEmail(email);
  if (!user) return res.status(400).json({ error: 'Invalid email or password' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).json({ error: 'Invalid email or password' });
  const token = signToken(user);
  res.json({ token, name: user.name, role: user.role, email: user.email, firstName: user.firstName, lastName: user.lastName, otherName: user.otherName });
});

app.post('/api/forgot-password', async (req, res) => {
  const { email, password, role, firstName, lastName } = req.body;
  if (!email || !password || !role || !firstName || !lastName) return res.status(400).json({ error: 'Email, role, first name, last name, and new password are required' });
  const db = readDb();
  db.users = db.users || [];
  const user = db.users.find(item => 
    item.email.toLowerCase() === email.toLowerCase() && 
    item.role === role && 
    (item.firstName || '').toLowerCase() === firstName.toLowerCase() && 
    (item.lastName || '').toLowerCase() === lastName.toLowerCase()
  );
  if (!user) return res.status(404).json({ error: 'No account found for that email and role' });
  user.password = await bcrypt.hash(password, 10);
  writeDb(db);
  res.json({ message: 'Password reset successfully' });
});

app.get('/api/profile', authenticateToken, (req, res) => {
  res.json({ name: req.user.name, email: req.user.email, role: req.user.role, firstName: req.user.firstName, lastName: req.user.lastName, otherName: req.user.otherName });
});

app.get('/api/messages', authenticateToken, (req, res) => {
  const db = readDb();
  res.json(db.messages || []);
});

app.post('/api/messages', authenticateToken, (req, res) => {
  const { to, text, parentId } = req.body;
  if (!text) return res.status(400).json({ error: 'Message text is required' });
  const db = readDb();
  db.messages = db.messages || [];
  const msg = {
    id: nextId(db.messages),
    from: req.user.name,
    role: req.user.role,
    to: to || null,
    parentId: parentId || null,
    text,
    time: now(),
    resolved: false,
    resolvedBy: null,
    resolvedAt: null
  };
  db.messages.push(msg);
  writeDb(db);
  broadcastChatMessage(msg);
  res.json(msg);
});

app.post('/api/messages/:id/resolve', authenticateToken, requireRole(['teacher', 'admin']), (req, res) => {
  const id = Number(req.params.id);
  const { resolved } = req.body;
  const db = readDb();
  db.messages = db.messages || [];
  const msg = db.messages.find(m => m.id === id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  msg.resolved = resolved !== false;
  msg.resolvedBy = msg.resolved ? req.user.name : null;
  msg.resolvedAt = msg.resolved ? now() : null;
  writeDb(db);
  broadcastChatMessage(msg);
  res.json(msg);
});

app.get('/api/assignments', authenticateToken, (req, res) => {
  const db = readDb();
  db.assignments = db.assignments || [];
  db.assignments = db.assignments.map(a => ({ ...a, submissions: Array.isArray(a.submissions) ? a.submissions : [] }));
  res.json(db.assignments);
});

app.get('/api/learners', authenticateToken, requireRole(['teacher', 'admin']), (req, res) => {
  try {
    const db = readDb();
    const assignments = db.assignments || [];
    const allUsers = db.users;
    
    const activeLearnerNames = new Set();
    assignments.forEach(a => {
      (a.submissions || []).forEach(s => {
        if (s && typeof s.learner === 'string' && s.learner.trim()) {
          activeLearnerNames.add(s.learner.trim());
        }
      });
    });

    const learnersForAttendance = [];
    const processedNames = new Set();
    const normalizedActiveNames = new Set([...activeLearnerNames].map(n => n.toLowerCase()));

    // Match against registered users to get emails
    allUsers.forEach(u => {
      if (!u || u.role !== 'learner' || !u.name) return;
      
      const lowerName = u.name.toLowerCase();
      if (normalizedActiveNames.has(lowerName)) {
        learnersForAttendance.push({ name: u.name, email: u.email || null });
        processedNames.add(lowerName);
      }
    });

    // Add learners who submitted but don't have a direct account
    activeLearnerNames.forEach(learnerName => {
      const lowerName = learnerName.toLowerCase();
      if (!processedNames.has(lowerName)) {
        learnersForAttendance.push({ name: learnerName, email: 'No direct account' });
        processedNames.add(lowerName);
      }
    });

    learnersForAttendance.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.json(learnersForAttendance);
  } catch (err) {
    console.error('Detailed server error in /api/learners:', err);
    res.status(500).json({ error: 'Server error retrieving learners: ' + err.message });
  }
});

app.get('/api/gradebook', authenticateToken, requireRole(['teacher', 'admin']), (req, res) => {
  const db = readDb();
  const report = (db.assignments || []).map(a => ({
    id: a.id,
    title: a.title,
    grades: (a.submissions || []).map(s => ({ learner: s.learner, grade: s.grade || 'N/A' }))
  }));
  res.json(report);
});

app.post('/api/assignments', authenticateToken, requireRole(['teacher', 'admin']), (req, res) => {
  const { title, description, target } = req.body;
  if (!title) return res.status(400).json({ error: 'Assignment title is required' });
  const db = readDb();
  db.assignments = db.assignments || [];
  const assignment = { 
    id: nextId(db.assignments), 
    title, 
    description: description || '', 
    target: target || 'All Learners',
    teacher: req.user.name, 
    createdAt: now(), 
    submissions: [] 
  };
  db.assignments.push(assignment);
  writeDb(db);
  res.json(assignment);
});

app.post('/api/assignments/:id/submit', authenticateToken, upload.single('fileUpload'), (req, res) => {
  const id = Number(req.params.id);
  // When using multer, text fields are in req.body, file info in req.file
  const { learner, content } = req.body;
  const attachment = req.file ? req.file.filename : null; // Store the unique filename

  const db = readDb();
  db.assignments = db.assignments || [];
  const assignment = db.assignments.find(x => x.id === id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  if (req.user.role === 'learner') {
    // Content is optional if only an attachment is submitted, but let's keep it required for now
    if (!content && !attachment) return res.status(400).json({ error: 'Content or attachment is required' });
    assignment.submissions = assignment.submissions || [];
    const submission = { id: nextId(assignment.submissions), learner: req.user.name, parent: null, content, attachment, time: now() };
    assignment.submissions.push(submission);
    writeDb(db);
    return res.json(submission);
  }

  if (req.user.role === 'parent') {
    if (!learner) return res.status(400).json({ error: 'Learner name is required for parent submissions' });
    if (!content && !attachment) return res.status(400).json({ error: 'Content or attachment is required' });
    assignment.submissions = assignment.submissions || [];
    const submission = { id: nextId(assignment.submissions), learner, parent: req.user.name, content, attachment, time: now() };
    assignment.submissions.push(submission);
    writeDb(db);
    return res.json(submission);
  }

  return res.status(403).json({ error: 'Only learners and parents can submit work' });
});

app.put('/api/assignments/:assignmentId/submissions/:submissionId', authenticateToken, (req, res) => {
  const assignmentId = Number(req.params.assignmentId);
  const submissionId = Number(req.params.submissionId);
  const { content } = req.body;

  const db = readDb();
  const assignment = db.assignments.find(a => a.id === assignmentId);
  if (!assignment) {
    return res.status(404).json({ error: 'Assignment not found' });
  }

  const submission = assignment.submissions.find(s => s.id === submissionId);
  if (!submission) {
    return res.status(404).json({ error: 'Submission not found' });
  }

  // Authorization: Only the learner or parent who submitted can edit
  const isAuthorized = (req.user.role === 'learner' && submission.learner === req.user.name) ||
                       (req.user.role === 'parent' && submission.parent === req.user.name);

  if (!isAuthorized) {
    return res.status(403).json({ error: 'You are not authorized to edit this submission' });
  }

  // Update content and timestamp
  submission.content = content || '';
  submission.updatedAt = now();
  writeDb(db);
  res.json(submission);
});

app.delete('/api/assignments/:assignmentId/submissions/:submissionId/attachment', authenticateToken, async (req, res) => {
  const assignmentId = Number(req.params.assignmentId);
  const submissionId = Number(req.params.submissionId);

  const db = readDb();
  const assignment = db.assignments.find(a => a.id === assignmentId);
  if (!assignment) {
    return res.status(404).json({ error: 'Assignment not found' });
  }

  const submission = assignment.submissions.find(s => s.id === submissionId);
  if (!submission) {
    return res.status(404).json({ error: 'Submission not found' });
  }

  // Authorization: Only the learner or parent who submitted can delete their attachment
  const isAuthorized = (req.user.role === 'learner' && submission.learner === req.user.name) ||
                       (req.user.role === 'parent' && submission.parent === req.user.name);

  if (!isAuthorized) {
    return res.status(403).json({ error: 'You are not authorized to delete this attachment' });
  }

  if (!submission.attachment) {
    return res.status(404).json({ error: 'No attachment found for this submission' });
  }

  const filePath = path.join(uploadDir, submission.attachment);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath); // Delete the physical file
    submission.attachment = null; // Remove reference from db
    writeDb(db);
    res.json({ message: 'Attachment deleted successfully' });
  } catch (err) {
    console.error(`Error deleting file ${filePath}:`, err);
    res.status(500).json({ error: 'Failed to delete attachment' });
  }
});

app.delete('/api/assignments/:assignmentId/submissions/:submissionId', authenticateToken, async (req, res) => {
  const assignmentId = Number(req.params.assignmentId);
  const submissionId = Number(req.params.submissionId);

  const db = readDb();
  const assignment = db.assignments.find(a => a.id === assignmentId);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const subIndex = assignment.submissions.findIndex(s => s.id === submissionId);
  if (subIndex === -1) return res.status(404).json({ error: 'Submission not found' });

  const submission = assignment.submissions[subIndex];

  // Authorization: Only the learner or parent who submitted can delete their work
  const isAuthorized = (req.user.role === 'learner' && submission.learner === req.user.name) ||
                       (req.user.role === 'parent' && submission.parent === req.user.name);

  if (!isAuthorized) {
    return res.status(403).json({ error: 'You are not authorized to delete this submission' });
  }

  // Clean up physical file if it exists
  if (submission.attachment) {
    const filePath = path.join(uploadDir, submission.attachment);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (err) { console.error('File cleanup failed:', err); }
  }

  assignment.submissions.splice(subIndex, 1);
  writeDb(db);
  res.json({ message: 'Submission deleted successfully' });
});

app.put('/api/assignments/:assignmentId/submissions/:submissionId/grade', authenticateToken, requireRole(['teacher', 'admin']), (req, res) => {
  const assignmentId = Number(req.params.assignmentId);
  const submissionId = Number(req.params.submissionId);
  const { grade, recommendation } = req.body;

  const db = readDb();
  const assignment = db.assignments.find(a => a.id === assignmentId);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const submission = assignment.submissions.find(s => s.id === submissionId);
  if (!submission) return res.status(404).json({ error: 'Submission not found' });

  submission.grade = grade;
  submission.recommendation = recommendation || null;
  submission.gradedAt = now();
  submission.gradedBy = req.user.name;

  writeDb(db);
  res.json(submission);
});

app.post('/api/assignments/:id/bulk-grade', authenticateToken, requireRole(['teacher', 'admin']), (req, res) => {
  const id = Number(req.params.id);
  const { results } = req.body; // Array of { submissionId, grade, recommendation }
  if (!Array.isArray(results)) return res.status(400).json({ error: 'Results array required' });

  const db = readDb();
  const assignment = db.assignments.find(a => a.id === id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  results.forEach(r => {
    const sub = assignment.submissions.find(s => s.id === r.submissionId);
    if (sub) {
      sub.grade = r.grade;
      sub.recommendation = r.recommendation || null;
      sub.gradedAt = now();
      sub.gradedBy = req.user.name;
    }
  });

  writeDb(db);
  res.json({ success: true });
});

app.get('/api/attendance/:date', authenticateToken, requireRole(['teacher', 'admin']), (req, res) => {
  try {
    const db = readDb();
    const attendance = db.attendance || {};
    res.json(attendance[req.params.date] || {});
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch attendance records' });
  }
});

app.post('/api/attendance', authenticateToken, requireRole(['teacher', 'admin']), (req, res) => {
  const { date, records } = req.body; // records: { "Learner Name": "present"|"absent" }
  if (!date || !records || typeof records !== 'object') {
    return res.status(400).json({ error: 'Valid date and attendance records are required' });
  }
  const db = readDb();
  db.attendance = db.attendance || {};
  db.attendance[date] = records;
  writeDb(db);
  res.json({ success: true });
});

app.get('/api/cats', authenticateToken, (req, res) => {
  const db = readDb();
  res.json(db.cats || []);
});

app.post('/api/cats', authenticateToken, requireRole(['teacher', 'admin']), (req, res) => {
  const { title, description, startTime, endTime } = req.body;
  if (!title || !startTime || !endTime) return res.status(400).json({ error: 'Title, start time, and end time are required' });
  const db = readDb();
  const cat = { 
    id: nextId(db.cats), 
    title, 
    description: description || '', 
    teacher: req.user.name, 
    startTime, 
    endTime, 
    createdAt: now(), 
    submissions: [] 
  };
  db.cats.push(cat);
  writeDb(db);
  res.json(cat);
});

app.post('/api/cats/:id/submit', authenticateToken, requireRole('learner'), (req, res) => {
  const id = Number(req.params.id);
  const { content } = req.body;
  const db = readDb();
  const cat = db.cats.find(x => x.id === id);
  if (!cat) return res.status(404).json({ error: 'CAT not found' });
  const currentTime = now();
  if (currentTime < cat.startTime || currentTime > cat.endTime) return res.status(403).json({ error: 'CAT is not available at this time' });
  if (cat.submissions.some(s => s.learner === req.user.name)) return res.status(400).json({ error: 'You have already attempted this CAT' });
  const sub = { id: nextId(cat.submissions), learner: req.user.name, content, time: currentTime };
  cat.submissions.push(sub);
  writeDb(db);
  res.json(sub);
});

app.put('/api/cats/:catId/submissions/:submissionId/grade', authenticateToken, requireRole(['teacher', 'admin']), (req, res) => {
  const catId = Number(req.params.catId);
  const submissionId = Number(req.params.submissionId);
  const { grade, recommendation } = req.body;

  const db = readDb();
  const cat = db.cats.find(c => c.id === catId);
  if (!cat) return res.status(404).json({ error: 'CAT not found' });

  const submission = cat.submissions.find(s => s.id === submissionId);
  if (!submission) return res.status(404).json({ error: 'Submission not found' });

  submission.grade = grade;
  submission.recommendation = recommendation || null;
  submission.gradedAt = now();
  submission.gradedBy = req.user.name;

  writeDb(db);
  res.json(submission);
});


// Standard way to serve the uploaded files directory
app.use('/uploads', express.static(uploadDir));

// Embedding endpoints
app.get('/api/events', authenticateToken, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();
  sseClients.add(res);
  res.write('retry: 10000\n\n');
  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.post('/api/embeddings', authenticateToken, canIndexEmbeddings, async (req, res) => {
  const { text, sourceType, sourceId } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const emb = await createEmbedding(text);
    const stored = storeEmbedding({ text, embedding: emb, sourceType: sourceType || null, sourceId: sourceId || null, owner: req.user.email });
    res.json(stored);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/embeddings/search', authenticateToken, requireRole(['teacher', 'admin']), async (req, res) => {
  const { q, topK } = req.body;
  if (!q) return res.status(400).json({ error: 'query text is required' });
  try {
    const results = await searchEmbeddings(q, Number(topK) || 5);
    res.json(results.map(item => ({ id: item.id, sourceType: item.sourceType, sourceId: item.sourceId, text: item.text, owner: item.owner, createdAt: item.createdAt, score: item.score })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/embeddings', authenticateToken, requireRole(['teacher', 'admin']), (req, res) => {
  const items = listEmbeddings();
  res.json(items);
});

app.get('/api/admin/summary', authenticateToken, requireRole(['teacher', 'admin']), (req, res) => {
  const db = readDb();
  const users = db.users || [];
  const messages = db.messages || [];
  const assignments = db.assignments || [];
  const usersByRole = users.reduce((acc, user) => {
    acc[user.role] = (acc[user.role] || 0) + 1;
    return acc;
  }, {});
  res.json({
    totalUsers: users.length,
    usersByRole,
    totalMessages: messages.length,
    totalAssignments: assignments.length
  });
});

app.get('/api/admin/users', authenticateToken, requireRole(['teacher', 'admin']), (req, res) => {
  const db = readDb();
  const users = (db.users || []).map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role, firstName: u.firstName, lastName: u.lastName, otherName: u.otherName }));
  res.json(users);
});

app.listen(PORT, () => {
  console.log(`ZORACHI server running on http://localhost:${PORT}`);
});
