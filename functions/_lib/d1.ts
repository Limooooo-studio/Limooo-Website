/** 极简 D1 类型与封装（避免依赖 @cloudflare/workers-types 类型包） */

export interface D1Result<T> {
  results: T[];
  success: boolean;
  meta?: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<{ success: boolean; meta?: Record<string, unknown> }>;
}

export interface D1BatchResult {
  success: boolean;
  meta?: Record<string, unknown>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch?(statements: D1PreparedStatement[]): Promise<D1BatchResult[]>;
}

export async function queryAll<T>(
  db: D1Database | undefined,
  sql: string,
  ...values: unknown[]
): Promise<T[]> {
  if (!db) return [];
  const stmt = db.prepare(sql);
  const res = values.length ? stmt.bind(...values).all<T>() : stmt.all<T>();
  return (await res).results ?? [];
}

/**
 * 执行一条写语句，返回「是否真的改动了行」。
 *
 * 不能只看 `success`：D1 的 `run()` 对「0 行受影响」的 UPDATE/DELETE
 * 依然报 `success: true`，于是
 *   - `PUT /api/apple-account/accounts/<不存在的 id>` 带新密码会返回 200 ok
 *     （密码被静默丢弃）；
 *   - `revokeAuthSession` 对不存在的 sid 回答「已撤销」。
 * `meta.changes` 明确为 0 时算失败。部分驱动/桩不返回 `meta`，此时保持兼容
 * 按成功处理（拿不到变更数就不敢判定失败，否则会把正常写判成故障）。
 */
export async function execute(
  db: D1Database | undefined,
  sql: string,
  ...values: unknown[]
): Promise<boolean> {
  if (!db) return false;
  const stmt = db.prepare(sql);
  const res = values.length ? stmt.bind(...values).run() : stmt.run();
  const result = await res;
  if (result.success !== true) return false;
  const changes = result.meta?.changes;
  if (typeof changes === "number") return changes > 0;
  return true;
}

/** 在单个 D1 事务中执行多条语句；任一失败则整体失败（D1 batch 语义）。 */
export async function executeBatch(
  db: D1Database | undefined,
  statements: D1PreparedStatement[],
): Promise<boolean> {
  if (!db?.batch || statements.length === 0) return false;
  try {
    const results = await db.batch(statements);
    return results.length === statements.length && results.every((r) => r.success);
  } catch {
    return false;
  }
}
