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
 * Worker 侧运行时类型（status-worker / d1-archive / sync-worker）。
 *
 * 为什么不用 @cloudflare/workers-types：与 functions/types.d.ts、
 * functions/_lib/d1.ts 同源——本项目一直用**手写的最小类型**代替那个类型包，
 * 免得每个 package.json / tsconfig 都挂一份会随 Cloudflare 发版的类型依赖。
 * 本文件只声明 `ops/**` 三个 Worker 真正用到的部分（D1、Durable Object、
 * cron、cloudflare:sockets）；改 Worker 用到新 API 时在这里补，不要用 any 兜。
 *
 * 之前 status-worker 不在 tsconfig.json 的 include 里，所以这些类型缺失
 * 一直没被发现（docs/22 W6-4）。
 */

/** Cloudflare D1（与 functions/_lib/d1.ts 的同名结构保持兼容）。 */
declare interface D1Meta {
  changes?: number;
  duration?: number;
  last_row_id?: number;
  rows_read?: number;
  rows_written?: number;
}

declare interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta?: D1Meta;
}

declare interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

declare interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  /** D1 的 batch 一定存在；Worker 侧直接 `await env.DB.batch([...])`。 */
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  exec?(sql: string): Promise<unknown>;
}

/** Durable Object。 */
declare interface DurableObjectId {
  toString(): string;
}

declare interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  getAlarm(): Promise<number | null>;
}

declare interface DurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

declare interface DurableObjectStub {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

declare interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  idFromString(id: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

/** Durable Object 类要实现的接口；只有 fetch 是必需的。 */
declare interface DurableObject {
  fetch(request: Request): Promise<Response>;
}

/** Cron Trigger 的 scheduled() 入参。 */
declare interface ScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
  readonly type?: string;
}

/** cloudflare:sockets —— 只声明本项目用到的部分（隐式 TLS SMTP）。 */
declare module "cloudflare:sockets" {
  interface SocketOptions {
    secureTransport?: "off" | "on" | "starttls";
    allowHalfOpen?: boolean;
  }

  interface Socket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly opened: Promise<Socket>;
    readonly closed: Promise<void>;
    startTls(): Socket;
    close(): Promise<void>;
  }

  function connect(
    address: { hostname: string; port: number } | string,
    options?: SocketOptions,
  ): Socket;
}
