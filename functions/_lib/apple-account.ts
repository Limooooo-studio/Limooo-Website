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

/** Apple Account 数据校验与脱敏（Pages 侧） */

import { APPLE_ACCOUNT_DOMAIN } from "./config";

export const MAX_EMAIL_LENGTH = 254;
export const MAX_PASSWORD_LENGTH = 512;
export const MAX_NOTES_LENGTH = 1000;
export const MAX_ORDER_LENGTH = 1000;

const EMAIL_LOCAL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;

export interface CreateAccountInput {
  email: string;
  password: string;
  notes: string;
}

export interface UpdateAccountInput {
  email: string;
  password?: string;
  notes: string;
  passwordChanged: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function validLocalEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > MAX_EMAIL_LENGTH) return null;
  const local = value.split("@", 1)[0];
  if (!local || !EMAIL_LOCAL_RE.test(local)) return null;
  return `${local}${APPLE_ACCOUNT_DOMAIN}`;
}

function validPassword(password: unknown): string | null {
  if (typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    return null;
  }
  return password;
}

function validNotes(notes: unknown): string | null {
  return typeof notes === "string" && notes.length <= MAX_NOTES_LENGTH ? notes : null;
}

export function validateCreatePayload(value: unknown): CreateAccountInput | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["email", "password", "notes"])) return null;
  const email = validLocalEmail(typeof value.email === "string" ? value.email : "");
  const password = validPassword(value.password);
  const notes = validNotes(value.notes);
  if (!email || !password || notes === null) return null;
  return {
    email,
    password,
    notes,
  };
}

export function validateUpdatePayload(value: unknown): UpdateAccountInput | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["email", "password", "notes", "password_changed"])) {
    return null;
  }
  const email = validLocalEmail(typeof value.email === "string" ? value.email : "");
  if (!email) return null;
  if (typeof value.password_changed !== "boolean") return null;
  const passwordChanged = value.password_changed;
  const password = passwordChanged ? (validPassword(value.password) ?? undefined) : undefined;
  const notes = validNotes(value.notes);
  if ((passwordChanged && !password) || notes === null) return null;
  return {
    email,
    password: password ?? undefined,
    notes,
    passwordChanged,
  };
}

export function validateOrder(value: unknown): number[] | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["order"]) || !Array.isArray(value.order)) return null;
  const order = value.order;
  if (order.length === 0 || order.length > MAX_ORDER_LENGTH) return null;
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const raw of order) {
    const id = typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
    if (!id || seen.has(id)) return null;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function parseAccountId(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** 统一掩码；故意固定为 12 个字符，避免泄露真实密码长度。 */
export function maskPassword(_password: string): string {
  return _password ? "·".repeat(12) : "";
}
