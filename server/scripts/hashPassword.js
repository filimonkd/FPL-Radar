// npm run auth:hash — prints a bcrypt hash for ADMIN_PASSWORD_HASH.
// Reads the password from stdin (so it never lands in shell history or `ps`).
// Usage:  npm run auth:hash            (type the password, then Enter)
//         printf '%s' "$PW" | npm run auth:hash
import bcrypt from 'bcryptjs';

const COST = 12;
let input = '';
process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) process.stderr.write('Admin password: ');
for await (const chunk of process.stdin) {
  input += chunk;
  if (process.stdin.isTTY && input.includes('\n')) break;
}
const password = input.replace(/\r?\n$/, '');
if (password.length < 12) {
  console.error('Use a password of at least 12 characters.');
  process.exit(1);
}
console.log(await bcrypt.hash(password, COST));
