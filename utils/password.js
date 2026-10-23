// Argon2id password hashing (per architecture blueprint).
// Falls back to @node-rs/argon2 (prebuilt binaries) if native `argon2` is unavailable.
let argon2;
try {
  // eslint-disable-next-line global-require
  argon2 = require('argon2');
} catch (e) {
  // eslint-disable-next-line global-require
  argon2 = require('@node-rs/argon2');
}

const OPTIONS = {
  type: argon2.argon2id ?? 2,
  memoryCost: 19456, // 19 MiB (OWASP minimum for argon2id)
  timeCost: 2,
  parallelism: 1
};

async function hashPassword(plain) {
  return argon2.hash(plain, OPTIONS);
}

async function verifyPassword(hash, plain) {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
