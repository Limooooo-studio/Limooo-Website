/**
 * Apple 账号写入的 D1 错误分类（docs/22 W9-6）。
 *
 * 此前 `catch { return 409 该邮箱已存在 }` 把**所有** D1 故障都报成「邮箱已存在」：
 * 写额度耗尽、绑定失效、网络抖动全都显示成同一个无害的业务错误，管理员既看不到
 * 真实故障、也没有任何审计行。只有真正的 UNIQUE 冲突才是 409，其余必须 500 + 审计。
 */

/** D1 / SQLite 的唯一约束冲突文案（含列名，便于区分是哪张表哪个索引）。 */
const UNIQUE_CONFLICT_RE = /unique constraint|constraint failed: .*\.email|sqlite_constraint/i;

/**
 * 判断一个写错误是否真的是唯一约束冲突。
 *
 * 只认错误信息，不认错误类型：D1 通过 `Error` 抛出，没有稳定的错误码字段
 * （`D1_ERROR` 前缀对配额、语法、绑定错误都一样）。
 */
export function isUniqueConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return UNIQUE_CONFLICT_RE.test(message);
}

/** 把错误压成一行、限长后写进审计，避免把整段 D1 回显塞进 events。 */
export function describeWriteError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return message.replace(/\s+/g, " ").slice(0, 200);
}
