/**
 * NSE / BSE India Market Session Helpers + Holiday Calendar.
 *
 * All inputs are UNIX timestamps in SECONDS (matching the columnar bar shape
 * used by the rest of the engine: `bars.times[i]` is Unix seconds).
 *
 * The IST timezone is fixed at UTC+5:30 (India does not observe DST). Rather
 * than relying on Intl APIs (which are slow and locale-dependent), we add a
 * fixed offset and read UTC fields — this is exact and portable.
 *
 * Trading hours (NSE & BSE):
 *   • Pre-open:    09:00 – 09:15 IST  (no continuous trading)
 *   • Continuous:  09:15 – 15:30 IST  ← the main session
 *   • Closing:     15:30 – 16:00 IST  (block deals only, ignored here)
 *
 * Default entry window  09:30 – 14:30 IST  (skip first 15 min of volatile
 *                                            opening + last 60 min of close noise)
 * Default exit window   15:00 – 15:30 IST  (force-flat by close)
 */

const IST_OFFSET_SECONDS = 5 * 3600 + 30 * 60; // UTC+5:30

/**
 * Convert Unix seconds to an "IST clock" object: { y, m, d, h, min, dow }.
 * dow follows JS convention: 0=Sunday, 1=Monday, ..., 4=Thursday, 5=Friday.
 */
export function istClock(unixSec) {
  if (!unixSec || unixSec <= 0) return null;
  const istEpoch = (unixSec + IST_OFFSET_SECONDS) * 1000;
  const d = new Date(istEpoch);
  return {
    y:   d.getUTCFullYear(),
    m:   d.getUTCMonth() + 1,
    d:   d.getUTCDate(),
    h:   d.getUTCHours(),
    min: d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}

/** Format a Unix-second timestamp as "YYYY-MM-DD" in IST. */
export function istDateKey(unixSec) {
  const c = istClock(unixSec);
  if (!c) return null;
  return `${c.y}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
}

/** Convert an IST HH:MM string to a minutes-of-day integer (e.g., "09:30" → 570). */
function hhmmToMin(s) {
  if (!s || typeof s !== 'string') return null;
  const [h, m] = s.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/** True if Unix-second timestamp falls inside the NSE continuous session (09:15-15:30 IST, Mon-Fri). */
export function isNseSessionBar(unixSec) {
  const c = istClock(unixSec);
  if (!c) return false;
  if (c.dow === 0 || c.dow === 6) return false;        // weekend
  if (NSE_HOLIDAYS_2024_2026.has(istDateKey(unixSec))) return false;
  const mod = c.h * 60 + c.min;
  return mod >= 9 * 60 + 15 && mod < 15 * 60 + 30;
}

/**
 * True if bar is within an entry window like "0930-1430" (IST, inclusive start, exclusive end).
 * Use this to gate entries away from the volatile open / closing-noise window.
 */
export function isInIstWindow(unixSec, windowStr) {
  const c = istClock(unixSec);
  if (!c) return false;
  if (!windowStr || typeof windowStr !== 'string') return true;
  // parse "HHMM-HHMM"
  const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(windowStr);
  if (!m) return true;
  const startMin = Number(m[1]) * 60 + Number(m[2]);
  const endMin   = Number(m[3]) * 60 + Number(m[4]);
  const mod      = c.h * 60 + c.min;
  return mod >= startMin && mod < endMin;
}

export function isThursday(unixSec) {
  const c = istClock(unixSec);
  return c?.dow === 4;
}

export function isFriday(unixSec) {
  const c = istClock(unixSec);
  return c?.dow === 5;
}

/**
 * NSE holiday calendar (trading holidays) for 2024-2026. These dates have
 * NO continuous trading session. Source: NSE official holiday calendars.
 *
 * Format: "YYYY-MM-DD" strings in a Set for O(1) lookup.
 *
 * NOTE: Only NSE-recognised trading holidays. Saturdays/Sundays are handled
 * separately. Some "muhurat" specials (Diwali evening session) are ignored
 * — backtests will still treat them as missing bars.
 */
export const NSE_HOLIDAYS_2024_2026 = new Set([
  // 2024
  '2024-01-22', // Ram Mandir inauguration (special)
  '2024-01-26', // Republic Day
  '2024-03-08', // Mahashivratri
  '2024-03-25', // Holi
  '2024-03-29', // Good Friday
  '2024-04-11', // Eid-ul-Fitr (Ramzan Id)
  '2024-04-17', // Ram Navami
  '2024-05-01', // Maharashtra Day
  '2024-05-20', // Lok Sabha Election (Mumbai)
  '2024-06-17', // Bakri Id
  '2024-07-17', // Muharram
  '2024-08-15', // Independence Day
  '2024-10-02', // Mahatma Gandhi Jayanti
  '2024-11-01', // Diwali (Laxmi Pujan — special muhurat trading evening; daily session closed)
  '2024-11-15', // Guru Nanak Jayanti
  '2024-12-25', // Christmas

  // 2025
  '2025-02-26', // Mahashivratri
  '2025-03-14', // Holi
  '2025-03-31', // Eid-ul-Fitr (Ramzan Id)
  '2025-04-10', // Mahavir Jayanti
  '2025-04-14', // Dr. B. R. Ambedkar Jayanti
  '2025-04-18', // Good Friday
  '2025-05-01', // Maharashtra Day
  '2025-08-15', // Independence Day / Parsi New Year
  '2025-08-27', // Ganesh Chaturthi
  '2025-10-02', // Mahatma Gandhi Jayanti / Dussehra
  '2025-10-21', // Diwali (Laxmi Pujan — daily session closed)
  '2025-10-22', // Balipratipada
  '2025-11-05', // Guru Nanak Jayanti
  '2025-12-25', // Christmas

  // 2026 (subset — calendar published Q4 2025)
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi (tentative)
  '2026-04-03', // Good Friday (tentative)
  '2026-05-01', // Maharashtra Day
  '2026-08-15', // Independence Day (Saturday — likely no trading anyway)
  '2026-10-02', // Gandhi Jayanti
  '2026-12-25', // Christmas
]);

/** Check if a Unix-second timestamp falls on an NSE trading holiday. */
export function isNseHoliday(unixSec) {
  const key = istDateKey(unixSec);
  return key !== null && NSE_HOLIDAYS_2024_2026.has(key);
}

/**
 * True if the previous valid trading bar is more than `gapDays` calendar days back
 * (e.g., Friday → Monday = 3 calendar days). Useful to detect post-weekend / post-holiday
 * gaps that should be filtered out of mean-reversion entries.
 */
export function isPostGapBar(times, i, gapDays = 2) {
  if (!times || i < 1 || !times[i] || !times[i - 1]) return false;
  const deltaSec = times[i] - times[i - 1];
  return deltaSec > gapDays * 86400;
}

/**
 * isIntradayTimeframe — quick check used by strategies to decide whether to
 * enforce session windows. Daily bars (1D, 1W) don't need session filters.
 */
export function isIntradayTimeframe(tf) {
  if (!tf) return false;
  const s = String(tf).toLowerCase();
  return /^(1|3|5|15|30|60)m?$/.test(s) || /^(1|2|4)h$/.test(s) || s === '60';
}

/** Default windows used by India intraday strategies (override per-strategy if needed). */
export const NSE_DEFAULTS = Object.freeze({
  ENTRY_WINDOW: '0930-1430',
  EXIT_WINDOW:  '1500-1530',
  SESSION_OPEN_HHMM:  '0915',
  SESSION_CLOSE_HHMM: '1530',
});

// ── F&O EXPIRY CALENDAR ─────────────────────────────────────────────────
//
// NSE monthly index F&O contracts (NIFTY, BANKNIFTY, etc.) and stock futures
// expire on the LAST THURSDAY of each calendar month. If that Thursday is a
// trading holiday, the expiry is rolled BACKWARDS to the previous trading day
// (typically Wednesday).
//
// Note (Apr 2025+): NSE migrated weekly expiries — Nifty weekly is now Tuesday
// and Bank Nifty weekly retired. Monthly contracts still expire LAST THURSDAY.
//
// We model only the MONTHLY expiry here (most relevant for swing strategies).
// Weekly expiry handling can be added if needed for intraday F&O strategies.

/**
 * getNseMonthlyExpiry — returns the Date of the monthly F&O expiry for a
 * given (year, month). 1-indexed month (1=Jan, ..., 12=Dec).
 *
 * Algorithm:
 *   1. Find the last Thursday of the month.
 *   2. If that Thursday is an NSE holiday, roll back day-by-day until a
 *      non-holiday weekday is found.
 */
export function getNseMonthlyExpiry(year, month) {
  // Last day of month
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let day = lastDay;
  // Walk back until Thursday (dow=4)
  while (true) {
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (dow === 4) break;
    day--;
    if (day < 1) return null; // pathological
  }
  // Roll back through holidays
  while (day >= 1) {
    const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!NSE_HOLIDAYS_2024_2026.has(key)) {
      return { y: year, m: month, d: day, key };
    }
    day--;
  }
  return null;
}

/**
 * isFnoExpiryDay — true if the bar's IST date is the monthly F&O expiry.
 *
 * Used by swing strategies to skip short entries on expiry day (gamma squeeze
 * + pin risk near round strikes).
 */
export function isFnoExpiryDay(unixSec) {
  const c = istClock(unixSec);
  if (!c) return false;
  const exp = getNseMonthlyExpiry(c.y, c.m);
  return exp && exp.d === c.d;
}

/**
 * isPreFnoExpiryDay — true if the bar is the trading day BEFORE monthly
 * expiry. Many short strategies underperform here due to short-squeeze
 * positioning; some authors recommend skipping shorts on this day.
 */
export function isPreFnoExpiryDay(unixSec) {
  const c = istClock(unixSec);
  if (!c) return false;
  const exp = getNseMonthlyExpiry(c.y, c.m);
  if (!exp) return false;
  // Compute the previous trading day before expiry
  let prevDay = exp.d - 1;
  while (prevDay >= 1) {
    const probeKey = `${exp.y}-${String(exp.m).padStart(2, '0')}-${String(prevDay).padStart(2, '0')}`;
    const probeDow = new Date(Date.UTC(exp.y, exp.m - 1, prevDay)).getUTCDay();
    if (probeDow !== 0 && probeDow !== 6 && !NSE_HOLIDAYS_2024_2026.has(probeKey)) {
      return prevDay === c.d;
    }
    prevDay--;
  }
  return false;
}

/**
 * isShortAllowed — composite gate for short-side entries on Indian markets.
 *
 *   options.style  - 'intraday' | 'swing' | 'positional'
 *   options.skipExpiry  - true to block expiry day & pre-expiry day
 *
 * Returns { allowed, reason }. Use this from strategy build() to filter
 * short signals before they're emitted.
 */
export function isShortAllowed(unixSec, options = {}) {
  const { style = 'swing', skipExpiry = true } = options;
  if (skipExpiry) {
    if (isFnoExpiryDay(unixSec))    return { allowed: false, reason: 'fno_expiry_day' };
    if (isPreFnoExpiryDay(unixSec)) return { allowed: false, reason: 'pre_expiry_day' };
  }
  // Intraday cash MIS: allowed if within session
  // Swing/positional: cash short not allowed in India (only via futures)
  // We don't enforce cash-vs-futures here (engine simulates % returns regardless),
  // but flag policy intent for future enforcement.
  if (style === 'swing' || style === 'positional') {
    return { allowed: true, reason: 'futures_required' };
  }
  return { allowed: true, reason: 'cash_mis_ok' };
}
