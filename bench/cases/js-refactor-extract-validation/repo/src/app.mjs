function isEmail(value) {
  return typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

function isNonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** Register a user; returns { ok, errors }. */
export function register(user) {
  const errors = [];
  if (!isNonEmpty(user.name)) errors.push("name is required");
  if (!isEmail(user.email)) errors.push("email is invalid");
  return { ok: errors.length === 0, errors };
}
