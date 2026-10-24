/* eslint-disable no-console */
// Usage:
//   tsx scripts/reset-user-password.ts <email> <newPassword>
// Example:
//   tsx scripts/reset-user-password.ts yazan@gmail.com yazan1234
import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { KewyIdentityClient } from "../src/kewy-identity/kewy-identity.client";
import { KewyIdentitySync } from "../src/kewy-identity/kewy-identity.sync";

const [, , rawEmail, newPassword] = process.argv;

if (!rawEmail || !newPassword) {
  console.error("Usage: tsx scripts/reset-user-password.ts <email> <newPassword>");
  process.exit(1);
}

const email = rawEmail.toLowerCase().trim();

const p = new PrismaClient();
(async () => {
  const user = await p.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`No user with email '${email}'.`);
    process.exit(2);
  }
  const hashed = await bcrypt.hash(newPassword, 10);
  // Same dual-write policy as the API (AUTH_SOURCE); an operator reset is
  // crm-only in Kewy, like a workspace-admin reset.
  await new KewyIdentitySync(new KewyIdentityClient()).passwordReset(user, hashed);
  await p.user.update({ where: { id: user.id }, data: { password: hashed } });
  console.log(`Reset password for ${email} (id=${user.id}).`);
  await p.$disconnect();
})();
