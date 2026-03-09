import crypto from 'crypto';
import http from 'http';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/** DingTalk 群机器人 inbound callback payload */
interface DingTalkInboundPayload {
  msgtype: string;
  text?: { content: string };
  markdown?: { title: string; text: string };
  msgId: string;
  senderNick: string;
  /** Unique ID for the conversation (group or DM) */
  conversationId: string;
  conversationTitle?: string;
  /** '1' = private chat, '2' = group chat */
  conversationType: string;
  /** Dynamic reply webhook, valid for 1 hour */
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
  chatbotUserId?: string;
}

export interface DingTalkChannelOpts {
  /** Outbound webhook URL (includes access_token) */
  webhookUrl: string;
  /** HMAC-SHA256 signing secret (SEC...) */
  secret: string;
  /** Port to listen for inbound DingTalk callbacks. Default: 3000 */
  listenPort?: number;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * DingTalk 群机器人 channel.
 *
 * Outbound: signs requests with HMAC-SHA256 and POSTs to the webhook URL.
 * Inbound:  starts an HTTP server to receive DingTalk callback POSTs.
 *
 * JID convention: `dt:main@dingtalk`  (one webhook = one group)
 *
 * To receive messages, configure the DingTalk robot "消息接收地址" to:
 *   http://<your-public-ip>:<listenPort>/
 */
export class DingTalkChannel implements Channel {
  name = 'dingtalk';

  /** Fixed JID representing the single DingTalk group tied to this webhook */
  static readonly GROUP_JID = 'dt:main@dingtalk';

  private connected = false;
  private server: http.Server | null = null;
  private opts: DingTalkChannelOpts;

  constructor(opts: DingTalkChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const port = this.opts.listenPort ?? 3000;

    this.server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }

      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          // Verify inbound signature (DingTalk signs callbacks with the same secret)
          const timestamp = req.headers['timestamp'] as string | undefined;
          const sign = req.headers['sign'] as string | undefined;
          if (timestamp && sign) {
            if (!this.verifySignature(timestamp, sign)) {
              logger.warn({ timestamp }, 'DingTalk inbound signature mismatch — request rejected');
              res.writeHead(401);
              res.end();
              return;
            }
          }

          const payload = JSON.parse(body) as DingTalkInboundPayload;
          this.handleInbound(payload);

          // DingTalk expects a valid JSON response; empty message type acks receipt
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ msgtype: 'empty' }));
        } catch (err) {
          logger.error({ err }, 'Failed to handle DingTalk inbound webhook');
          res.writeHead(400);
          res.end();
        }
      });
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(port, () => {
        this.connected = true;
        logger.info({ port }, 'DingTalk channel connected, listening for callbacks');
        console.log(`\n  DingTalk channel active`);
        console.log(`  Inbound callback listening on port ${port}`);
        console.log(`  Configure DingTalk robot "消息接收地址": http://<your-public-ip>:${port}/`);
        console.log(`  Group JID for registration: ${DingTalkChannel.GROUP_JID}\n`);
        resolve();
      });
      this.server!.on('error', (err) => {
        logger.error({ err, port }, 'DingTalk HTTP server failed to start');
        reject(err);
      });
    });
  }

  private handleInbound(payload: DingTalkInboundPayload): void {
    let rawContent: string | undefined;

    if (payload.msgtype === 'text') {
      rawContent = payload.text?.content?.trim();
    } else if (payload.msgtype === 'markdown') {
      rawContent = payload.markdown?.text?.trim();
    }

    if (!rawContent) {
      logger.debug({ msgtype: payload.msgtype }, 'Non-text DingTalk message, ignoring');
      return;
    }

    const jid = DingTalkChannel.GROUP_JID;
    const timestamp = new Date().toISOString();
    const isGroup = payload.conversationType === '2';
    const chatName = payload.conversationTitle || 'DingTalk';

    // Notify routing layer about this chat
    this.opts.onChatMetadata(jid, timestamp, chatName, 'dingtalk', isGroup);

    // Only deliver message if group is registered
    const groups = this.opts.registeredGroups();
    if (!groups[jid]) {
      logger.info(
        { jid, chatName, sender: payload.senderNick },
        'DingTalk message from unregistered group — register this JID to enable responses',
      );
      return;
    }

    // Ensure content matches the TRIGGER_PATTERN so the message loop picks it up.
    // DingTalk users @mention the bot which sends the raw "@BotName content" text.
    // Strip any leading "@BotName" and re-prefix with the canonical trigger.
    let content = rawContent.replace(/^@\S+\s*/, '').trim();
    if (!TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    this.opts.onMessage(jid, {
      id: payload.msgId,
      chat_jid: jid,
      sender: payload.senderNick,
      sender_name: payload.senderNick,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });

    logger.info({ jid, sender: payload.senderNick }, 'DingTalk message stored');
  }

  /**
   * Send a text message to DingTalk via the outbound webhook.
   * The `jid` parameter is accepted to satisfy the Channel interface
   * but is ignored — this webhook always sends to its configured group.
   */
  async sendMessage(_jid: string, text: string): Promise<void> {
    const timestamp = Date.now().toString();
    const sign = this.computeSign(timestamp);
    const url = `${this.opts.webhookUrl}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;

    const body = JSON.stringify({
      msgtype: 'text',
      text: { content: `${ASSISTANT_NAME}: ${text}` },
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!response.ok) {
      throw new Error(`DingTalk webhook HTTP ${response.status}: ${response.statusText}`);
    }

    const result = (await response.json()) as { errcode: number; errmsg: string };
    if (result.errcode !== 0) {
      throw new Error(`DingTalk API error ${result.errcode}: ${result.errmsg}`);
    }

    logger.info({ length: text.length }, 'DingTalk message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@dingtalk');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    return new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  // ── Signing ──────────────────────────────────────────────────────────────

  /**
   * DingTalk HMAC-SHA256 signing algorithm (used for both outbound and inbound verification).
   * stringToSign = timestamp + "\n" + secret
   */
  private computeSign(timestamp: string): string {
    const stringToSign = `${timestamp}\n${this.opts.secret}`;
    return crypto
      .createHmac('sha256', this.opts.secret)
      .update(stringToSign)
      .digest('base64');
  }

  private verifySignature(timestamp: string, sign: string): boolean {
    const expected = this.computeSign(timestamp);
    return expected === sign;
  }
}
