const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;

/**
 * One-line local clock injected into executor prompts. Agents otherwise
 * guess "today" from model priors or try to read a clock they may not have.
 */
export function localTimeLine(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHour = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
  const offsetMinute = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
  return `当前本地时间：${year}年${month}月${day}日 星期${WEEKDAYS[now.getDay()]} ${hour}:${minute}（UTC${sign}${offsetHour}:${offsetMinute}）。遇到“今天、本周、最新”等相对时间，以这个时间为准。`;
}
