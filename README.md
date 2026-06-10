# ZORACHI

Minimal demo of ZORACHI — a learning platform for learners, teachers and parents.

Run locally:

```powershell
npm install
npm start
# open http://localhost:3000
```

Features (demo):
- Role selection: learner, teacher, parent
- Messages: simple messaging between roles
- Assignments: teachers create, learners submit (in-memory)

This is a lightweight scaffold intended as a starting point.

Anthropic / Claude embeddings (optional)

- To enable embedding generation using Anthropic (Claude), set the environment variable `ANTHROPIC_API_KEY` to your API key.
- You can optionally configure `ANTHROPIC_EMBEDDINGS_URL` and `ANTHROPIC_EMBEDDING_MODEL` if you need to customize the endpoint or model name. Defaults to `https://api.anthropic.com/v1/embeddings` and `claude-embed-lite`.
- When enabled, teachers and admins can opt-in to "Index with Claude" when creating messages or assignments. Embeddings are stored locally in `data/embeddings.json`.
- Embedding creation is rate-limited to prevent excessive requests.
- Teachers and admins can search indexed embeddings from the app.

Example (Windows PowerShell):

```powershell
$env:ANTHROPIC_API_KEY = 'sk-...'
npm start
```
