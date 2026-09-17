const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const UPSTREAM_BASE_URL = 'https://opencode.ai/zen/v1';

function getAuthHeader(req) {
  let key = process.env.OPENCODE_API_KEY || req.headers['authorization'] || 'public';
  key = key.trim();
  return key.startsWith('Bearer ') ? key : `Bearer ${key}`;
}

function isAnthropicModel(model) {
  return (model || '').toLowerCase().includes('union');
}

// Formats Tavern history into strict Anthropic structure
function toAnthropicPayload(payload) {
  let systemPrompt = '';
  const rawMessages = [];

  for (const msg of payload.messages || []) {
    if (msg.role === 'system') {
      systemPrompt += (systemPrompt ? '\n\n' : '') + (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
    } else {
      rawMessages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content || ''
      });
    }
  }

  // Merge consecutive messages of the same role
  const merged = [];
  for (const msg of rawMessages) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      merged[merged.length - 1].content += '\n\n' + msg.content;
    } else {
      merged.push({ ...msg });
    }
  }

  // Anthropic strictly requires the first message to be from 'user'
  if (merged.length === 0) {
    merged.push({ role: 'user', content: 'Hello' });
  } else if (merged[0].role === 'assistant') {
    merged.unshift({ role: 'user', content: '...' });
  }

  return {
    model: payload.model,
    system: systemPrompt || undefined,
    messages: merged,
    max_tokens: payload.max_tokens || 4096,
    temperature: payload.temperature ?? 0.7,
    stream: payload.stream ?? true
  };
}

function makeOpenAIChunk(textDelta, modelName, finishReason = null) {
  const chunk = {
    id: `chatcmpl-${crypto.randomBytes(8).toString('hex')}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        delta: textDelta ? { content: textDelta } : {},
        finish_reason: finishReason
      }
    ]
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

app.get('/', (req, res) => res.send('OpenCode Zen Proxy is running.'));

// Models Route
app.get('/v1/models', async (req, res) => {
  try {
    const upstreamResponse = await fetch(`${UPSTREAM_BASE_URL}/models`, {
      method: 'GET',
      headers: {
        'Authorization': getAuthHeader(req),
        'User-Agent': 'opencode/latest/1.18.18/cli',
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
    let payload = { ...req.body };

    if (payload.model && payload.model.startsWith('opc/')) {
      payload.model = payload.model.replace('opc/', '');
    }

    const authHeader = getAuthHeader(req);
    const maskedKey = authHeader.length > 15 
      ? `${authHeader.slice(0, 11)}...${authHeader.slice(-4)}` 
      : authHeader;

    console.log(`[Proxy] Model: ${payload.model} | Auth: ${maskedKey}`);

    const randomHex = () => crypto.randomBytes(12).toString('hex');
    const useAnthropic = isAnthropicModel(payload.model);

    const upstreamHeaders = {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      'User-Agent': 'opencode/latest/1.18.18/cli',
      'x-opencode-client': 'cli',
      'x-opencode-project': 'global',
      'x-opencode-session': `ses_${randomHex()}`,
      'x-opencode-request': `msg_${randomHex()}`
    };

    if (useAnthropic) {
      upstreamHeaders['anthropic-version'] = '2023-06-01';
    }

    const targetEndpoint = useAnthropic 
      ? `${UPSTREAM_BASE_URL}/messages` 
      : `${UPSTREAM_BASE_URL}/chat/completions`;

    const requestBody = useAnthropic ? toAnthropicPayload(payload) : payload;

    const upstreamResponse = await fetch(targetEndpoint, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(requestBody)
    });

    console.log(`[Proxy] Upstream status: ${upstreamResponse.status} from ${targetEndpoint}`);

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      console.error(`[Proxy Upstream Error]: ${errorText}`);
      return res.status(upstreamResponse.status).send(errorText);
    }

    // Streaming
    if (payload.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder();

      if (!useAnthropic) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value));
        }
        return res.end();
      }

      let buffer = '';
      let sentDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          const rawData = trimmed.replace(/^data:\s*/, '');
          if (rawData === '[DONE]') {
            if (!sentDone) {
              res.write('data: [DONE]\n\n');
              sentDone = true;
            }
            continue;
          }

          try {
            const parsed = JSON.parse(rawData);

            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              res.write(makeOpenAIChunk(parsed.delta.text, payload.model));
            }

            if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) {
              res.write(makeOpenAIChunk('', payload.model, 'stop'));
            }

            if (parsed.type === 'message_stop' && !sentDone) {
              res.write('data: [DONE]\n\n');
              sentDone = true;
            }
          } catch (e) {
            // Ignore keep-alives or non-JSON lines
          }
        }
      }

      if (!sentDone) {
        res.write('data: [DONE]\n\n');
      }
      return res.end();
    }

    // Non-Streaming
    const data = await upstreamResponse.json();

    if (useAnthropic) {
      const fullText = (data.content || [])
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('');

      return res.json({
        id: data.id || `chatcmpl-${randomHex()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: payload.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: fullText },
            finish_reason: data.stop_reason || 'stop'
          }
        ],
        usage: data.usage || {}
      });
    }

    return res.json(data);

  } catch (err) {
    console.error('Proxy Error:', err);
    res.status(500).json({ error: 'Proxy request failed', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy listening on port ${PORT}`));
