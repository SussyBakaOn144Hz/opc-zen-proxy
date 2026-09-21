const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const UPSTREAM_BASE_URL = 'https://opencode.ai/zen/v1';

// Stable UUID per server instance for session continuity
const SESSION_UUID = crypto.randomUUID();

function getAuthHeader(req) {
  let key = process.env.OPENCODE_API_KEY || req.headers['authorization'] || '';
  key = key.trim();

  // Strip dummy keys (frontends often send 'Bearer default', 'Bearer none', etc.)
  if (
    !key ||
    key === 'public' ||
    key === 'Bearer public' ||
    key === 'Bearer default' ||
    key === 'Bearer sk-none'
  ) {
    return 'Bearer ';
  }

  return key.startsWith('Bearer ') ? key : `Bearer ${key}`;
}

app.get('/', (req, res) => res.send('OpenCode Zen Proxy is running.'));

// Build identical header signature matching official CLI
function buildUpstreamHeaders(req) {
  const reqId = `msg_${crypto.randomBytes(12).toString('hex')}`;
  return {
    'Content-Type': 'application/json',
    'Authorization': getAuthHeader(req),
    'User-Agent': 'opencode/latest/cli',
    'x-opencode-client': 'cli',
    'x-opencode-project': 'global',
    // Both session headers are required to satisfy all gateway checks
    'x-session-id': SESSION_UUID,
    'x-opencode-session': SESSION_UUID,
    'x-opencode-request': reqId,
  };
}

// Models Route
app.get('/v1/models', async (req, res) => {
  try {
    const upstreamResponse = await fetch(`${UPSTREAM_BASE_URL}/models`, {
      method: 'GET',
      headers: buildUpstreamHeaders(req),
    });

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      return res.status(upstreamResponse.status).send(errorText);
    }

    const data = await upstreamResponse.json();
    return res.json(data);
  } catch (err) {
    console.error('Models Proxy Error:', err);
    res.status(500).json({ error: 'Failed to fetch models', details: err.message });
  }
});

// Completions Route
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const payload = { ...req.body };

    // Clean common model prefix
    if (payload.model && payload.model.startsWith('opc/')) {
      payload.model = payload.model.replace('opc/', '');
    }

    console.log(`[Proxy] Dispatching model: "${payload.model}" | Session: ${SESSION_UUID}`);

    const upstreamResponse = await fetch(`${UPSTREAM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: buildUpstreamHeaders(req),
      body: JSON.stringify(payload),
    });

    console.log(`[Proxy] Upstream response: ${upstreamResponse.status}`);

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      console.error(`[Proxy Upstream Error]: ${errorText}`);
      return res.status(upstreamResponse.status).send(errorText);
    }

    // SSE Stream
    if (payload.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = upstreamResponse.body.getReader();

      req.on('close', () => {
        reader.cancel().catch(() => {});
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      return res.end();
    }

    // Standard JSON response
    const data = await upstreamResponse.json();
    return res.json(data);
  } catch (err) {
    console.error('Proxy Error:', err);
    res.status(500).json({ error: 'Proxy request failed', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy listening on port ${PORT}`));

