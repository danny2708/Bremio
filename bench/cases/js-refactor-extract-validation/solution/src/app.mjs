import { isEmail, isNonEmpty } from "./validate.mjs";

/** Register a user; returns { ok, errors }. */
export function register(user) {
  const errors = [];
  if (!isNonEmpty(user.name)) errors.push("name is required");
  if (!isEmail(user.email)) errors.push("email is invalid");
  return { ok: errors.length === 0, errors };
}
