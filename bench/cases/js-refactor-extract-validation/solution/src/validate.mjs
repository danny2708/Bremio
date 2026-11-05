export function isEmail(value) {
  return typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

export function isNonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
