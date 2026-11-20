const argon2 = require('argon2');
const { generatePassword } = require('../utils/crypto');

const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

async function hashPassword(password) {
  return argon2.hash(password, ARGON_OPTIONS);
}

async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch (_err) {
    return false;
  }
}

function createGeneratedPassword() {
  // 24 chars from a 68-char alphabet => strong entropy for broadcast credentials.
  return generatePassword(24);
}

module.exports = {
  hashPassword,
  verifyPassword,
  createGeneratedPassword,
};
