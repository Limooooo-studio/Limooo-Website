/**
 * Limooo - serverless personal website and admin system
 *
 * Copyright (C) 2026 Limooo <https://limooo.cn/>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Worker 侧 SMTP 发信（docs/17 阶段 3，用户选择：走邮箱服务商 SMTP）
 *
 * Workers 没有 nodemailer，用 `cloudflare:sockets` 自己实现最小 SMTP：
 * 隐式 TLS（465）→ EHLO → AUTH LOGIN → MAIL FROM → RCPT TO → DATA → QUIT。
 *
 * 遵守 AGENTS.md：只通过邮箱服务商的 SMTP 发件，不用本机 MTA、不直连 25 端口。
 * 任何一步失败都返回 {sent:false, reason}，绝不抛出。
 */

import { connect } from "cloudflare:sockets";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

export interface SmtpMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const CRLF = "\r\n";
const TIMEOUT_MS = 15_000;

function b64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** SMTP 头字段值不能含 CR/LF（防注入）。 */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function buildMime(cfg: SmtpConfig, msg: SmtpMessage): string {
  const boundary = `limooo-${crypto.randomUUID().replace(/-/g, "")}`;
  const headers = [
    `From: ${headerSafe(cfg.from)}`,
    `To: ${headerSafe(msg.to)}`,
    `Subject: =?UTF-8?B?${b64(headerSafe(msg.subject))}?=`,
    "MIME-Version: 1.0",
  ];

  if (!msg.html) {
    return (
      headers.join(CRLF) +
      CRLF +
      'Content-Type: text/plain; charset="utf-8"' +
      CRLF +
      "Content-Transfer-Encoding: base64" +
      CRLF +
      CRLF +
      wrap76(b64(msg.text)) +
      CRLF
    );
  }

  return (
    headers.join(CRLF) +
    CRLF +
    `Content-Type: multipart/alternative; boundary="${boundary}"` +
    CRLF +
    CRLF +
    `--${boundary}${CRLF}Content-Type: text/plain; charset="utf-8"${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}${wrap76(b64(msg.text))}${CRLF}` +
    `--${boundary}${CRLF}Content-Type: text/html; charset="utf-8"${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}${wrap76(b64(msg.html))}${CRLF}` +
    `--${boundary}--${CRLF}`
  );
}

/** base64 正文按 76 列折行（RFC 2045）。 */
function wrap76(value: string): string {
  const lines: string[] = [];
  for (let i = 0; i < value.length; i += 76) lines.push(value.slice(i, i + 76));
  return lines.join(CRLF);
}

class SmtpSession {
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";
  private readonly decoder = new TextDecoder();

  constructor(socket: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  /** 读一条 SMTP 响应（处理 250- 多行续行）。 */
  async readReply(): Promise<string> {
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const nl = this.buffer.indexOf(CRLF);
      if (nl >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + CRLF.length);
        // 多行响应：第 4 个字符是 '-' 表示还有后续
        if (line.length > 3 && line[3] === "-") continue;
        return line;
      }
      if (Date.now() > deadline) throw new Error("smtp_timeout");
      const { value, done } = await this.reader.read();
      if (done) throw new Error("smtp_closed");
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  async send(line: string): Promise<void> {
    await this.writer.write(new TextEncoder().encode(line + CRLF));
  }

  async cmd(line: string, expect: string): Promise<string> {
    await this.send(line);
    const reply = await this.readReply();
    if (!reply.startsWith(expect)) {
      throw new Error(`smtp_unexpected: ${reply.slice(0, 80)}`);
    }
    return reply;
  }

  async close(): Promise<void> {
    try {
      await this.writer.close();
    } catch {
      // 忽略关闭异常
    }
  }
}

export async function sendViaSmtp(
  cfg: SmtpConfig,
  msg: SmtpMessage,
): Promise<{ sent: boolean; reason?: string }> {
  if (!cfg.host || !cfg.user || !cfg.pass || !cfg.from || !msg.to) {
    return { sent: false, reason: "smtp_config_incomplete" };
  }

  let session: SmtpSession | null = null;
  let socket: ReturnType<typeof connect> | null = null;
  try {
    socket = connect(
      { hostname: cfg.host, port: cfg.port },
      { secureTransport: "on" },
    );
    session = new SmtpSession(socket);

    const greeting = await session.readReply();
    if (!greeting.startsWith("220")) return { sent: false, reason: `smtp_greeting: ${greeting.slice(0, 60)}` };

    await session.cmd(`EHLO limooo.cn`, "250");
    await session.cmd("AUTH LOGIN", "334");
    await session.cmd(b64(cfg.user), "334");
    const auth = await session.cmd(b64(cfg.pass), "235");
    void auth;

    await session.cmd(`MAIL FROM:<${cfg.from}>`, "250");
    await session.cmd(`RCPT TO:<${msg.to}>`, "250");
    await session.cmd("DATA", "354");

    const mime = buildMime(cfg, msg);
    // 正文中的孤立 "." 需要转义（CRLF.CRLF 才是结束符）
    const body = mime.replace(/\r\n\./g, `${CRLF}..`);
    await session.send(body.endsWith(CRLF) ? body + "." : body + CRLF + ".");
    const accepted = await session.readReply();
    if (!accepted.startsWith("250")) {
      return { sent: false, reason: `smtp_data: ${accepted.slice(0, 80)}` };
    }

    await session.send("QUIT").catch(() => undefined);
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: `smtp_error: ${String(err).slice(0, 160)}` };
  } finally {
    if (session) await session.close();
    if (socket) await socket.close().catch(() => undefined);
  }
}
