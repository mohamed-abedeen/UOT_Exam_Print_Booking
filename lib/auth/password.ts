// Password hashing (argon2id, library defaults — same call as db/seed.ts) and the password rules of step 1.2.
import { randomInt } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

/** New passwords: 10 to 128 characters, no other rule (owner, 2026-11-25). */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export function isAcceptablePassword(password: string): boolean {
  return password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false; // a malformed stored hash is a failed login, never a crash
  }
}

// Made when the module loads, so even the first unknown-user login costs one verify and nothing more.
const dummyHash = hash("no-such-account");

/** Spends the time of one verify. Used when there is no account, so the answer time does not reveal which usernames exist. */
export async function burnVerify(password: string): Promise<void> {
  await verifyPassword(await dummyHash, password);
}

// No 0/O, 1/l/I: the admin reads the temporary password out or copies it by hand.
const TEMP_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TEMP_LENGTH = 12;

/** Temporary password made by the server for createUser / resetUserPassword; shown once to the admin. */
export function generateTempPassword(): string {
  let out = "";
  for (let i = 0; i < TEMP_LENGTH; i++) out += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)];
  return out;
}
