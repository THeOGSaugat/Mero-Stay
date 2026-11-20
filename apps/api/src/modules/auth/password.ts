import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with Argon2id from Node's built-in crypto module (no native npm dependency).
 * Parameters follow the OWASP Password Storage Cheat Sheet minimum for Argon2id:
 * 19 MiB memory, 2 iterations, parallelism 1 (ADR 0006). They are stored inside each hash
 * (PHC string format), so they can be raised later without breaking existing hashes.
 */
export const PASSWORD_HASH_PARAMS = {
  memoryKiB: 19_456,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
  saltLength: 16,
} as const;

/** Upper bounds when reading parameters back from a stored hash (defence against bad data). */
const MAX_MEMORY_KIB = 1_048_576;
const MAX_PASSES = 10;
const MAX_PARALLELISM = 16;

function argon2id(
  password: string,
  salt: Buffer,
  params: { memoryKiB: number; passes: number; parallelism: number; tagLength: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      "argon2id",
      {
        // NFC so the same password typed on different keyboards/OSes hashes identically.
        message: password.normalize("NFC"),
        nonce: salt,
        memory: params.memoryKiB,
        passes: params.passes,
        parallelism: params.parallelism,
        tagLength: params.tagLength,
      },
      (err, derivedKey) => (err ? reject(err) : resolve(derivedKey)),
    );
  });
}

const b64 = (buffer: Buffer) => buffer.toString("base64").replace(/=+$/, "");

/** Returns a PHC string: $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash> */
export async function hashPassword(password: string): Promise<string> {
  const { memoryKiB, passes, parallelism, tagLength, saltLength } = PASSWORD_HASH_PARAMS;
  const salt = randomBytes(saltLength);
  const tag = await argon2id(password, salt, { memoryKiB, passes, parallelism, tagLength });
  return `$argon2id$v=19$m=${memoryKiB},t=${passes},p=${parallelism}$${b64(salt)}$${b64(tag)}`;
}

interface ParsedHash {
  memoryKiB: number;
  passes: number;
  parallelism: number;
  salt: Buffer;
  tag: Buffer;
}

function parseHash(phc: string): ParsedHash | null {
  const parts = phc.split("$");
  // ["", "argon2id", "v=19", "m=..,t=..,p=..", salt, hash]
  if (parts.length !== 6 || parts[1] !== "argon2id" || parts[2] !== "v=19") return null;
  const params = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(parts[3] ?? "");
  if (!params) return null;
  const [memoryKiB, passes, parallelism] = [params[1], params[2], params[3]].map(Number) as [
    number,
    number,
    number,
  ];
  if (
    memoryKiB < 8 * parallelism ||
    memoryKiB > MAX_MEMORY_KIB ||
    passes < 1 ||
    passes > MAX_PASSES ||
    parallelism < 1 ||
    parallelism > MAX_PARALLELISM
  ) {
    return null;
  }
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const tag = Buffer.from(parts[5] ?? "", "base64");
  if (salt.length < 8 || tag.length < 16) return null;
  return { memoryKiB, passes, parallelism, salt, tag };
}

/** Constant-time check of a password against a stored PHC hash. Malformed hashes never match. */
export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const parsed = parseHash(phc);
  if (!parsed) return false;
  const candidate = await argon2id(password, parsed.salt, {
    memoryKiB: parsed.memoryKiB,
    passes: parsed.passes,
    parallelism: parsed.parallelism,
    tagLength: parsed.tag.length,
  });
  return timingSafeEqual(candidate, parsed.tag);
}

let dummyHash: Promise<string> | undefined;

/**
 * A real hash of a random secret, used when the email is unknown (or the account has no
 * password) so a failed login takes as long as a wrong password for a real account:
 * response time does not reveal whether an account exists.
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString("base64"));
  return dummyHash;
}
