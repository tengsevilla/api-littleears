import bcrypt from "bcryptjs";

const COST = 12;

// Compared against when the email is unknown, so both failure paths cost one bcrypt compare.
const DUMMY_HASH = bcrypt.hashSync("littleears-timing-equalizer", COST);

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST);
}

export function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  return bcrypt.compare(password, hash ?? DUMMY_HASH);
}
