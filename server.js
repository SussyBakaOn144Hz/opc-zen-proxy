const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const UPSTREAM_BASE_URL = 'https://opencode.ai/zen/v1';
const OPENCODE_API_KEY = process.env.OPENCODE_API_KEY || 'public';

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const payload = { ...req.body };

    // Strip UI prefixes
    if (payload.model.startsWith('opc/')) {
      payload.model = payload.model.replace('opc/', '');
    }

    // Dynamic IDs to simulate active CLI sessions
    const randomHex = () => crypto.randomBytes(12).toString('hex');
    const sessionId = `ses_${randomHex()}`;
    const requestId = `msg_${randomHex()}`;

    const upstreamHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENCODE_API_KEY}`,
      'User-Agent': 'opencode/1.15.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13',
      'x-opencode-client': 'cli',
      'x-opencode-project': 'global',
      'x-opencode-session': sessionId,
      'x-opencode-request': requestId
    };

    const upstreamResponse = await fetch(`${UPSTREAM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(payload)
    });

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      return res.status(upstreamResponse.status).send(errorText);
    }

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
