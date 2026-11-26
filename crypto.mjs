// Спільне шифрування для dashboard-даних і результатів перевірки ТДС.
// AES-GCM + PBKDF2 → base64(salt|iv|ciphertext). Розшифровує браузер (crypto.subtle).
// Один формат на два джерела: template.html вміє читати і window.KT_ENC, і window.KT_TDS.
import { webcrypto as wc } from "node:crypto";

export const KDF_ITER = 200000;

export async function encryptData(jsonStr, password) {
  const encText = new TextEncoder();
  const salt = wc.getRandomValues(new Uint8Array(16));
  const iv   = wc.getRandomValues(new Uint8Array(12));
  const iter = KDF_ITER;
  const keyMat = await wc.subtle.importKey("raw", encText.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await wc.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
    keyMat, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = new Uint8Array(await wc.subtle.encrypt({ name: "AES-GCM", iv }, key, encText.encode(jsonStr)));
  const out = new Uint8Array(salt.length + iv.length + ct.length);
  out.set(salt, 0); out.set(iv, salt.length); out.set(ct, salt.length + iv.length);
  return { b64: Buffer.from(out).toString("base64"), iter };
}

// Зворотне перетворення: потрібне перевірці ТДС, щоб підхопити минулий
// результат і дописати історію, не втрачаючи того, що було до неї.
export async function decryptData(b64, password) {
  const raw = Buffer.from(String(b64).trim(), "base64");
  const salt = raw.subarray(0, 16), iv = raw.subarray(16, 28), ct = raw.subarray(28);
  const keyMat = await wc.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await wc.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: KDF_ITER, hash: "SHA-256" },
    keyMat, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await wc.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(plain));
}
