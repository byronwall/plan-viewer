const DAY_MS = 24 * 60 * 60 * 1000;

export function parseDateKey(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return dateKey(date) === value ? date : null;
}

export function dateKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function addDays(date, amount) {
  return new Date(date.getTime() + amount * DAY_MS);
}

export function startOfWeek(date) {
  return addDays(date, -date.getUTCDay());
}

export function localTodayKey(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// `new Date(t).toLocaleDateString(locale, options)` builds a formatter on every call, which dominates long lists (the
// Activity page formats thousands of times). This keeps one Intl.DateTimeFormat per locale and option set.
const formatters = new Map();
export function formatDateTime(value, locale, options) {
  const key = `${locale || ""}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) formatters.set(key, (formatter = new Intl.DateTimeFormat(locale, options)));
  return formatter.format(typeof value === "number" || value instanceof Date ? value : new Date(value));
}
