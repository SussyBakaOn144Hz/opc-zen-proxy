const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const UPSTREAM_BASE_URL = 'https://opencode.ai/zen/v1';

// Format key safely whether it includes 'Bearer ' or not
function getAuthHeader(req) {
  let key = process.env.OPENCODE_API_KEY || req.headers['authorization'] || 'public';
  key = key.trim();
  return key.startsWith('Bearer ') ? key : `Bearer ${key}`;
}

app.get('/', (req, res) => res.send('OpenCode Zen Proxy is running.'));

// 1. Models Route
app.get('/v1/models', async (req, res) => {
  try {
    const upstreamResponse = await fetch(`${UPSTREAM_BASE_URL}/models`, {
      method: 'GET',
      headers: {
        'Authorization': getAuthHeader(req),
        'User-Agent': 'opencode/1.18.16'
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

// 2. Chat Completions Route
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const payload = { ...req.body };

    // Strip UI prefixes
    if (payload.model && payload.model.startsWith('opc/')) {
      payload.model = payload.model.replace('opc/', '');
    }

    console.log(`[Proxy] Forwarding prompt for model: ${payload.model}`);

    const upstreamHeaders = {
      'Content-Type': 'application/json',
      'Authorization': getAuthHeader(req),
      'User-Agent': 'opencode/1.18.16'
    };

    const upstreamResponse = await fetch(`${UPSTREAM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(payload)
    });

    console.log(`[Proxy] Upstream returned status: ${upstreamResponse.status}`);

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      console.error(`[Proxy Upstream Error]: ${errorText}`);
      return res.status(upstreamResponse.status).send(errorText);
    }

    // Stream responses back to Tavo
    if (payload.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value));
      }
      return res.end();
    }

    const data = await upstreamResponse.json();
    return res.json(data);

  } catch (err) {
    console.error('Proxy Error:', err);
    res.status(500).json({ error: 'Proxy request failed', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy listening on port ${PORT}`));
