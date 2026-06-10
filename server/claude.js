const fetch = global.fetch || require('node-fetch');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const EMB_PATH = path.join(DATA_DIR, 'embeddings.json');

function ensureEmb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(EMB_PATH)) fs.writeFileSync(EMB_PATH, JSON.stringify({ items: [] }, null, 2));
}

function readEmb() {
  ensureEmb();
  try {
    const content = fs.readFileSync(EMB_PATH, 'utf8');
    return JSON.parse(content || '{"items":[]}');
  } catch (err) {
    console.error("Failed to read embeddings file.", err.message);
    return { items: [] };
  }
}

function writeEmb(db) {
  fs.writeFileSync(EMB_PATH, JSON.stringify(db, null, 2));
}

async function createEmbedding(text) {
  const key = process.env.ANTHROPIC_API_KEY;
  const url = process.env.ANTHROPIC_EMBEDDINGS_URL || 'https://api.anthropic.com/v1/embeddings';
  const model = process.env.ANTHROPIC_EMBEDDING_MODEL || 'claude-embed-lite';
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({ model, input: text })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding request failed: ${res.status} ${body}`);
  }

  const data = await res.json();

  // Support different response shapes
  let embedding = null;
  if (data && Array.isArray(data.data) && data.data[0] && data.data[0].embedding) {
    embedding = data.data[0].embedding;
  } else if (data && data.embedding) {
    embedding = data.embedding;
  } else if (data && Array.isArray(data.embeddings) && data.embeddings[0]) {
    embedding = data.embeddings[0];
  }

  if (!embedding) throw new Error('No embedding in Anthropic response');
  return embedding;
}

function storeEmbedding(item) {
  ensureEmb();
  const db = readEmb();
  db.items = db.items || [];
  const id = (db.items.reduce((m, it) => Math.max(m, it.id || 0), 0) || 0) + 1;
  const record = { id, ...item, createdAt: new Date().toISOString() };
  db.items.push(record);
  writeEmb(db);
  return record;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function searchEmbeddings(query, topK = 5) {
  const queryVec = await createEmbedding(query);
  const db = readEmb();
  const items = (db.items || []).map(item => {
    const score = Array.isArray(item.embedding) ? cosineSimilarity(queryVec, item.embedding) : 0;
    return { ...item, score };
  });
  return items
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function listEmbeddings() {
  ensureEmb();
  return readEmb().items || [];
}

module.exports = { createEmbedding, storeEmbedding, listEmbeddings, searchEmbeddings };
