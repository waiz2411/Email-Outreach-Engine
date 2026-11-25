export interface SendingScheduleConfig {
  scheduleStartTime: string; // HH:mm
  scheduleEndTime: string;   // HH:mm
  timezone: string;          // IANA timezone, e.g. "America/New_York"
  allowedWeekdays: number[]; // 0=Sunday .. 6=Saturday
  minDelayMinutes: number;
  maxDelayMinutes: number;
}

export interface LocalTimeParts {
  dateKey: string; // YYYY-MM-DD in target timezone
  weekday: number; // 0=Sunday .. 6=Saturday
  minutesSinceMidnight: number; // 0 .. 1439
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Extracts DST-accurate local calendar date, weekday, and minutes since midnight using Intl.DateTimeFormat.
 */
export function getLocalTimeParts(date: Date, timezone: string): LocalTimeParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = part.value;
    }
  }

  const year = lookup.year ?? '1970';
  const month = lookup.month ?? '01';
  const day = lookup.day ?? '01';
  const hourNum = Number(lookup.hour ?? '0') % 24;
  const minuteNum = Number(lookup.minute ?? '0');
  const weekday = WEEKDAY_MAP[lookup.weekday ?? 'Sun'] ?? 0;

  return {
    dateKey: `${year}-${month}-${day}`,
    weekday,
    minutesSinceMidnight: hourNum * 60 + minuteNum,
  };
}

export function parseHhMmToMinutes(hhmm: string): number {
  const [hStr, mStr] = hhmm.split(':');
  return Number(hStr ?? 0) * 60 + Number(mStr ?? 0);
}

/**
 * Checks if `now` falls inside the configured weekday + HH:mm sending window in the target IANA timezone.
 */
export function isWithinSendingSchedule(
  now: Date,
  config: Pick<SendingScheduleConfig, 'scheduleStartTime' | 'scheduleEndTime' | 'timezone' | 'allowedWeekdays'>,
  campaignStartDate?: Date | null,
  campaignEndDate?: Date | null,
): { allowed: boolean; reason?: string; localParts: LocalTimeParts } {
  if (campaignStartDate && now < campaignStartDate) {
    return {
      allowed: false,
      reason: 'Before campaign start date',
      localParts: getLocalTimeParts(now, config.timezone),
    };
  }
  if (campaignEndDate && now > campaignEndDate) {
    return {
      allowed: false,
      reason: 'Past campaign end date',
      localParts: getLocalTimeParts(now, config.timezone),
    };
  }

  const localParts = getLocalTimeParts(now, config.timezone);
  const startMinutes = parseHhMmToMinutes(config.scheduleStartTime);
  const endMinutes = parseHhMmToMinutes(config.scheduleEndTime);

  if (startMinutes < endMinutes) {
    // Standard same-day window, e.g. 09:00 -> 17:00
    if (!config.allowedWeekdays.includes(localParts.weekday)) {
      return { allowed: false, reason: 'Outside allowed weekdays', localParts };
    }
    if (localParts.minutesSinceMidnight < startMinutes || localParts.minutesSinceMidnight >= endMinutes) {
      return { allowed: false, reason: 'Outside configured daily sending hours', localParts };
    }
    return { allowed: true, localParts };
  } else {
    // Overnight window, e.g. 21:00 -> 05:00
    const inLateSegment = localParts.minutesSinceMidnight >= startMinutes;
    const inEarlySegment = localParts.minutesSinceMidnight < endMinutes;
    if (!inLateSegment && !inEarlySegment) {
      return { allowed: false, reason: 'Outside configured daily sending hours', localParts };
    }
    const relevantWeekday = inEarlySegment ? (localParts.weekday + 6) % 7 : localParts.weekday;
    if (!config.allowedWeekdays.includes(relevantWeekday)) {
      return { allowed: false, reason: 'Outside allowed weekdays', localParts };
    }
    return { allowed: true, localParts };
  }
}

/**
 * Generates an integer delay in minutes uniformly sampled inside [minDelayMinutes, maxDelayMinutes].
 */
export function generateDelayMinutes(
  minDelayMinutes: number,
  maxDelayMinutes: number,
  randomFn: () => number = Math.random,
): number {
  const min = Math.max(1, Math.floor(minDelayMinutes));
  const max = Math.max(min, Math.floor(maxDelayMinutes));
  const r = Math.min(0.999999999, Math.max(0, randomFn()));
  return Math.floor(r * (max - min + 1)) + min;
}

/**
 * Computes the next eligible UTC Date after applying the configured random delay.
 */
export function computeNextEligibleSendAt(
  fromDate: Date,
  minDelayMinutes: number,
  maxDelayMinutes: number,
  randomFn: () => number = Math.random,
): { nextEligibleAt: Date; delayMinutes: number } {
  const delayMinutes = generateDelayMinutes(minDelayMinutes, maxDelayMinutes, randomFn);
  const nextEligibleAt = new Date(fromDate.getTime() + delayMinutes * 60_000);
  return { nextEligibleAt, delayMinutes };
}

/**
 * Computes exponential backoff with full jitter for transient Graph/network errors.
 */
export function computeRetryBackoffMs(
  attempt: number,
  retryAfterSeconds?: number | null,
  randomFn: () => number = Math.random,
): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000 + Math.floor(randomFn() * 2000);
  }
  const baseMs = 30_000;
  const maxMs = 30 * 60_000;
  const exp = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  return Math.floor(exp * (0.75 + randomFn() * 0.5));
}
