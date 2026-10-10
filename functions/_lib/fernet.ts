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
 * Fernet v1 加解密（与 Flask 端 cryptography.fernet 兼容，用于 Apple Account 密码字段）
 *
 * token 结构：0x80 || timestamp(8B BE) || IV(16B) || ciphertext || HMAC-SHA256(32B)
 * 32 字节 base64url 密钥：前 16 字节为签名密钥，后 16 字节为 AES-128-CBC 加密密钥
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function base64UrlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  // 保留 '=' 填充：与 Python cryptography.fernet 完全互通
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_");
}

function bytesToBigEndian64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  let v = Math.floor(value);
  for (let i = 7; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

function bigEndian64ToNumber(bytes: Uint8Array): number {
  let v = 0;
  for (const b of bytes) v = v * 256 + b;
  return v;
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function importKeys(keyB64Url: string): Promise<{
  sign: CryptoKey;
  crypt: CryptoKey;
}> {
  const raw = base64UrlDecode(keyB64Url);
  if (raw.length !== 32) throw new Error("Fernet key must be 32 bytes (urlsafe base64)");
  const signRaw = raw.slice(0, 16);
  const cryptRaw = raw.slice(16, 32);
  const sign = await crypto.subtle.importKey("raw", signRaw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const crypt = await crypto.subtle.importKey("raw", cryptRaw, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
  return { sign, crypt };
}

export async function fernetDecrypt(token: string, keyB64Url: string): Promise<string> {
  const raw = base64UrlDecode(token);
  if (raw.length < 57) throw new Error("Fernet token too short");
  if (raw[0] !== 0x80) throw new Error("Unsupported Fernet version");

  const body = raw.slice(0, raw.length - 32);
  const mac = raw.slice(raw.length - 32);
  const { sign, crypt } = await importKeys(keyB64Url);

  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", sign, body));
  if (!timingSafeEqualBytes(mac, expected)) throw new Error("Fernet HMAC mismatch");

  const iv = body.slice(9, 25);
  const ciphertext = body.slice(25);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, crypt, ciphertext);
  return dec.decode(plain);
}

export async function fernetEncrypt(plaintext: string, keyB64Url: string): Promise<string> {
  const { sign, crypt } = await importKeys(keyB64Url);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-CBC", iv }, crypt, enc.encode(plaintext)),
  );

  const body = new Uint8Array(1 + 8 + 16 + ciphertext.length);
  body[0] = 0x80;
  body.set(bytesToBigEndian64(Math.floor(Date.now() / 1000)), 1);
  body.set(iv, 9);
  body.set(ciphertext, 25);

  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", sign, body));
  const token = new Uint8Array(body.length + 32);
  token.set(body);
  token.set(mac, body.length);
  return base64UrlEncode(token);
}
