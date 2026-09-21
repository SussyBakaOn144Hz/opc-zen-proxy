const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const UPSTREAM_BASE_URL = 'https://opencode.ai/zen/v1';

// Stable session UUID per proxy instance
const CLIENT_SESSION_ID = crypto.randomUUID();

function getAuthHeader(req) {
  let key = process.env.OPENCODE_API_KEY || req.headers['authorization'] || '';
  key = key.trim();

  // If blank or legacy 'public', pass standard empty Bearer for Zen free tier
  if (!key || key === 'public' || key === 'Bearer public') {
    return 'Bearer ';
  }

  return key.startsWith('Bearer ') ? key : `Bearer ${key}`;
}

app.get('/', (req, res) => res.send('OpenCode Zen Proxy is running.'));

// Models Route
app.get('/v1/models', async (req, res) => {
  try {
    const upstreamResponse = await fetch(`${UPSTREAM_BASE_URL}/models`, {
      method: 'GET',
      headers: {
        'Authorization': getAuthHeader(req),
        'x-session-id': CLIENT_SESSION_ID,
        'User-Agent': 'opencode/latest/cli',
        'x-opencode-client': 'cli'
      }
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

    if (payload.model && payload.model.startsWith('opc/')) {
      payload.model = payload.model.replace('opc/', '');
    }

    const authHeader = getAuthHeader(req);
    console.log(`[Proxy] Model: ${payload.model} | Session: ${CLIENT_SESSION_ID}`);

    const upstreamHeaders = {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      'x-session-id': CLIENT_SESSION_ID,
      'User-Agent': 'opencode/latest/cli',
      'x-opencode-client': 'cli',
      'x-opencode-project': 'global'
    };

    const upstreamResponse = await fetch(`${UPSTREAM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(payload)
    });

    console.log(`[Proxy] Upstream status: ${upstreamResponse.status}`);

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      console.error(`[Proxy Upstream Error]: ${errorText}`);
      return res.status(upstreamResponse.status).send(errorText);
    }

    // SSE Streaming
    if (payload.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = upstreamResponse.body.getReader();

      // Cancel upstream read if client aborts generation
      req.on('close', () => {
        reader.cancel().catch(() => {});
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Pipe raw binary buffers directly to prevent multi-byte UTF-8 corruption
        res.write(value);
      }
      return res.end();
    }

    // Non-streaming JSON
    const data = await upstreamResponse.json();
    return res.json(data);

  } catch (err) {
    console.error('Proxy Error:', err);
    res.status(500).json({ error: 'Proxy request failed', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy listening on port ${PORT}`));
