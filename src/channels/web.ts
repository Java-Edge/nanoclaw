import http from 'http';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface WebChannelOpts {
  port?: number;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

const CHAT_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NanoClaw — Chat</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0f1117; --surface: #1a1d27; --border: #2d3148;
    --primary: #5b6ef5; --primary-dark: #4557e8;
    --text: #e2e4f0; --muted: #7b7fa8; --user-bg: #5b6ef5;
    --bot-bg: #252840; --radius: 16px;
  }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--bg); color: var(--text); height: 100dvh;
    display: flex; flex-direction: column; overflow: hidden; }
  header { padding: 14px 20px; background: var(--surface);
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #4ade80; flex-shrink:0; }
  header h1 { font-size: 15px; font-weight: 600; }
  header span { font-size: 12px; color: var(--muted); margin-left: auto; }
  #chat { flex: 1; overflow-y: auto; padding: 20px; display: flex;
    flex-direction: column; gap: 12px; scroll-behavior: smooth; }
  .msg { display: flex; gap: 10px; max-width: 80%; animation: fadein .2s ease; }
  @keyframes fadein { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
  .msg.user { align-self: flex-end; flex-direction: row-reverse; }
  .msg.bot  { align-self: flex-start; }
  .avatar { width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 700; }
  .msg.user .avatar { background: var(--user-bg); color: #fff; }
  .msg.bot  .avatar { background: var(--bot-bg); color: var(--primary); border: 1px solid var(--border); }
  .bubble { padding: 10px 14px; border-radius: var(--radius); line-height: 1.55;
    font-size: 14px; white-space: pre-wrap; word-break: break-word; }
  .msg.user .bubble { background: var(--user-bg); color: #fff; border-bottom-right-radius: 4px; }
  .msg.bot  .bubble { background: var(--bot-bg); border-bottom-left-radius: 4px; border: 1px solid var(--border); }
  .ts { font-size: 11px; color: var(--muted); margin-top: 4px; text-align: right; }
  .msg.bot .ts { text-align: left; }
  .typing { display: flex; gap: 4px; align-items: center; padding: 12px 14px; }
  .typing span { width: 7px; height: 7px; border-radius: 50%; background: var(--muted);
    animation: bounce 1.2s infinite; }
  .typing span:nth-child(2) { animation-delay: .2s; }
  .typing span:nth-child(3) { animation-delay: .4s; }
  @keyframes bounce { 0%,80%,100%{transform:scale(.8);opacity:.4} 40%{transform:scale(1);opacity:1} }
  footer { padding: 12px 16px; background: var(--surface);
    border-top: 1px solid var(--border); flex-shrink: 0; }
  .input-row { display: flex; gap: 8px; align-items: flex-end; }
  textarea { flex: 1; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: 12px; padding: 10px 14px;
    font-size: 14px; line-height: 1.5; resize: none; min-height: 44px;
    max-height: 120px; overflow-y: auto; outline: none;
    transition: border-color .2s; font-family: inherit; }
  textarea:focus { border-color: var(--primary); }
  button { width: 44px; height: 44px; border: none; border-radius: 12px;
    background: var(--primary); color: #fff; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; transition: background .15s, transform .1s; }
  button:hover { background: var(--primary-dark); }
  button:active { transform: scale(.95); }
  button:disabled { opacity: .4; cursor: not-allowed; }
  button svg { width: 18px; height: 18px; }
  #hint { font-size: 11px; color: var(--muted); margin-top: 6px; text-align: center; }
  .empty { flex: 1; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 10px; color: var(--muted); }
  .empty h2 { font-size: 22px; font-weight: 700; color: var(--text); }
  .empty p { font-size: 13px; }
</style>
</head>
<body>
<header>
  <div class="dot" id="statusDot"></div>
  <h1>NanoClaw</h1>
  <span id="model">Connecting…</span>
</header>
<div id="chat">
  <div class="empty" id="empty">
    <h2>👋 你好！</h2>
    <p>有什么我可以帮你的？</p>
  </div>
</div>
<footer>
  <div class="input-row">
    <textarea id="inp" placeholder="输入消息，Enter 发送，Shift+Enter 换行…" rows="1"></textarea>
    <button id="sendBtn" title="发送">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round" stroke-linejoin="round">
        <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
      </svg>
    </button>
  </div>
  <div id="hint">Enter 发送 · Shift+Enter 换行</div>
</footer>
<script>
const chat = document.getElementById('chat');
const inp  = document.getElementById('inp');
const btn  = document.getElementById('sendBtn');
const empty = document.getElementById('empty');
const model = document.getElementById('model');
const dot   = document.getElementById('statusDot');
let thinking = null;
let msgCount = 0;

function now() {
  return new Date().toLocaleTimeString('zh', {hour:'2-digit',minute:'2-digit'});
}

function appendMsg(role, text) {
  if (msgCount === 0) empty.remove();
  msgCount++;
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const av = document.createElement('div');
  av.className = 'avatar';
  av.textContent = role === 'user' ? 'U' : 'AI';
  const bub = document.createElement('div');
  bub.className = 'bubble';
  bub.textContent = text;
  const ts = document.createElement('div');
  ts.className = 'ts';
  ts.textContent = now();
  const inner = document.createElement('div');
  inner.appendChild(bub);
  inner.appendChild(ts);
  wrap.appendChild(av);
  wrap.appendChild(inner);
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return bub;
}

function showThinking() {
  if (thinking) return;
  const wrap = document.createElement('div');
  wrap.className = 'msg bot';
  wrap.id = 'thinking';
  const av = document.createElement('div');
  av.className = 'avatar';
  av.textContent = 'AI';
  const bub = document.createElement('div');
  bub.className = 'bubble typing';
  bub.innerHTML = '<span></span><span></span><span></span>';
  wrap.appendChild(av);
  wrap.appendChild(bub);
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  thinking = wrap;
}

function hideThinking() {
  if (thinking) { thinking.remove(); thinking = null; }
}

async function send() {
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  inp.style.height = 'auto';
  btn.disabled = true;

  appendMsg('user', text);
  showThinking();

  try {
    const r = await fetch('/chat', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({content: text, sender: 'User'})
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch(e) {
    hideThinking();
    appendMsg('bot', '❌ 发送失败：' + e.message);
    btn.disabled = false;
  }
}

// Auto-resize textarea
inp.addEventListener('input', () => {
  inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
});

inp.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

btn.addEventListener('click', send);

// SSE for receiving replies
const es = new EventSource('/events');
es.onopen = () => {
  dot.style.background = '#4ade80';
  model.textContent = document.title;
};
es.onerror = () => {
  dot.style.background = '#f87171';
  model.textContent = '连接断开，刷新重试';
};
es.addEventListener('reply', e => {
  hideThinking();
  btn.disabled = false;
  const d = JSON.parse(e.data);
  appendMsg('bot', d.text);
});
es.addEventListener('model', e => {
  const d = JSON.parse(e.data);
  model.textContent = d.name;
  document.title = 'NanoClaw — ' + d.name;
});
</script>
</body>
</html>`;

/**
 * WebChannel — serves a browser-based chat UI and exposes a JSON API.
 *
 * Endpoints:
 *   GET  /           → Chat UI page (CHAT_HTML)
 *   POST /chat       → { content: string, sender?: string } — inbound message
 *   GET  /events     → SSE stream, receives "reply" and "model" events
 *
 * JID convention: `web:main@web`
 */
export class WebChannel implements Channel {
  name = 'web';

  static readonly GROUP_JID = 'web:main@web';

  private connected = false;
  private server: http.Server | null = null;
  private sseClients: Set<http.ServerResponse> = new Set();
  private opts: WebChannelOpts;
  private port: number;

  constructor(opts: WebChannelOpts) {
    this.opts = opts;
    this.port = opts.port ?? 8080;
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);

      // ── GET / — Chat UI ─────────────────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(CHAT_HTML);
        return;
      }

      // ── GET /events — SSE stream ────────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        res.write(`event: model\ndata: ${JSON.stringify({ name: ASSISTANT_NAME })}\n\n`);
        this.sseClients.add(res);
        req.on('close', () => this.sseClients.delete(res));
        // Keepalive ping every 25 s
        const ping = setInterval(() => {
          if (res.writableEnded) { clearInterval(ping); return; }
          res.write(': ping\n\n');
        }, 25000);
        return;
      }

      // ── POST /chat — Inbound message ────────────────────────────────────────
      if (req.method === 'POST' && url.pathname === '/chat') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { content, sender = 'User' } = JSON.parse(body) as {
              content: string;
              sender?: string;
            };

            if (!content?.trim()) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'content is required' }));
              return;
            }

            const jid = WebChannel.GROUP_JID;
            const timestamp = new Date().toISOString();

            // Trigger pattern enforcement
            let messageContent = content.trim();
            const groups = this.opts.registeredGroups();
            const group = groups[jid];
            if (group && !TRIGGER_PATTERN.test(messageContent)) {
              messageContent = `@${ASSISTANT_NAME} ${messageContent}`;
            }

            this.opts.onChatMetadata(jid, timestamp, 'Web Chat', 'web', false);

            if (group) {
              this.opts.onMessage(jid, {
                id: `web-${Date.now()}`,
                chat_jid: jid,
                sender,
                sender_name: sender,
                content: messageContent,
                timestamp,
                is_from_me: false,
                is_bot_message: false,
              });
              logger.info({ sender }, 'Web chat message stored');
            } else {
              logger.info({ jid }, 'Web chat: group not registered yet');
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            logger.error({ err }, 'Failed to handle web chat POST');
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, () => {
        this.connected = true;
        logger.info({ port: this.port }, 'Web chat UI started');
        console.log(`\n  Web chat UI: http://localhost:${this.port}/\n`);
        resolve();
      });
      this.server!.on('error', (err) => {
        logger.error({ err, port: this.port }, 'Web UI server failed to start');
        reject(err);
      });
    });
  }

  /**
   * Broadcast agent reply to all connected SSE clients.
   * `_jid` is accepted for interface compatibility but ignored.
   */
  async sendMessage(_jid: string, text: string): Promise<void> {
    const payload = `event: reply\ndata: ${JSON.stringify({ text })}\n\n`;
    for (const client of this.sseClients) {
      if (!client.writableEnded) client.write(payload);
    }
    logger.info({ clients: this.sseClients.size, length: text.length }, 'Web reply broadcast');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@web');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const client of this.sseClients) {
      if (!client.writableEnded) client.end();
    }
    this.sseClients.clear();
    return new Promise<void>((resolve) => {
      this.server ? this.server.close(() => resolve()) : resolve();
    });
  }
}
