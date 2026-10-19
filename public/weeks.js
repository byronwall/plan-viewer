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

export function buildWeeks(centerDate, weekCount = 5) {
  const count = Math.max(1, weekCount);
  const firstWeek = addDays(startOfWeek(centerDate), -Math.floor(count / 2) * 7);
  return Array.from({ length: count }, (_, weekIndex) =>
    Array.from({ length: 7 }, (_, dayIndex) => addDays(firstWeek, weekIndex * 7 + dayIndex)),
  );
}

export function localTodayKey(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
