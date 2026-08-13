export type ScheduleKind = 'interval' | 'daily' | 'weekly' | 'cron';

interface ParsedField {
  values: Set<number>;
  wildcard: boolean;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let value = formatterCache.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    });
    // Force timezone validation now instead of during the scheduler tick.
    value.format(new Date());
    formatterCache.set(timezone, value);
  }
  return value;
}

export function isValidTimezone(timezone: string): boolean {
  if (!timezone || timezone.length > 100) return false;
  try {
    formatter(timezone);
    return true;
  } catch {
    return false;
  }
}

function parseClock(value: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('时间格式必须为 HH:mm');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('时间格式必须为 HH:mm');
  return { hour, minute };
}

function expandPart(part: string, min: number, max: number, normalize?: (value: number) => number): number[] {
  const [base, stepRaw] = part.split('/');
  if (!base || part.split('/').length > 2) throw new Error('Cron 字段格式错误');
  const step = stepRaw === undefined ? 1 : Number(stepRaw);
  if (!Number.isInteger(step) || step < 1) throw new Error('Cron 步长必须为正整数');

  let start: number;
  let end: number;
  if (base === '*') {
    start = min;
    end = max;
  } else if (base.includes('-')) {
    const pair = base.split('-').map(Number);
    if (pair.length !== 2 || pair.some((value) => !Number.isInteger(value))) throw new Error('Cron 范围格式错误');
    [start, end] = pair;
  } else {
    start = Number(base);
    end = start;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
    throw new Error(`Cron 字段必须在 ${min}-${max} 之间`);
  }
  const values: number[] = [];
  for (let value = start; value <= end; value += step) values.push(normalize ? normalize(value) : value);
  return values;
}

function parseField(raw: string, min: number, max: number, normalize?: (value: number) => number): ParsedField {
  if (!raw) throw new Error('Cron 字段不能为空');
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    for (const value of expandPart(part, min, max, normalize)) values.add(value);
  }
  if (values.size === 0) throw new Error('Cron 字段不能为空');
  return { values, wildcard: raw === '*' };
}

interface CronSpec {
  minute: ParsedField;
  hour: ParsedField;
  day: ParsedField;
  month: ParsedField;
  weekday: ParsedField;
}

function parseCron(value: string): CronSpec {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron 必须包含 5 个字段：分 时 日 月 星期');
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    day: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    weekday: parseField(fields[4], 0, 7, (day) => day === 7 ? 0 : day),
  };
}

const weekdayNumbers: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function localParts(at: number, timezone: string) {
  const values: Record<string, string> = {};
  for (const part of formatter(timezone).formatToParts(new Date(at))) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return {
    minute: Number(values.minute),
    hour: Number(values.hour),
    day: Number(values.day),
    month: Number(values.month),
    weekday: weekdayNumbers[values.weekday] ?? -1,
  };
}

function findNextMinute(timezone: string, fromMs: number, matches: (parts: ReturnType<typeof localParts>) => boolean): string {
  let candidate = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const maxCandidate = candidate + 370 * 24 * 60 * 60_000;
  while (candidate <= maxCandidate) {
    if (matches(localParts(candidate, timezone))) return new Date(candidate).toISOString();
    candidate += 60_000;
  }
  throw new Error('无法在未来 370 天内找到下一次执行时间');
}

export function validateSchedule(kind: ScheduleKind, value: string, timezone: string): void {
  if (!isValidTimezone(timezone)) throw new Error('无效的时区');
  if (kind === 'interval') {
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525_600) {
      throw new Error('执行间隔必须为 1–525600 分钟');
    }
    return;
  }
  if (kind === 'daily') {
    parseClock(value);
    return;
  }
  if (kind === 'weekly') {
    const match = /^([0-6](?:,[0-6])*)@(\d{2}:\d{2})$/.exec(value);
    if (!match) throw new Error('每周计划格式必须为 星期列表@HH:mm');
    parseClock(match[2]);
    return;
  }
  if (kind === 'cron') {
    parseCron(value);
    return;
  }
  throw new Error('不支持的周期类型');
}

export function nextScheduledAt(kind: ScheduleKind, value: string, timezone: string, fromMs = Date.now()): string {
  validateSchedule(kind, value, timezone);
  if (kind === 'interval') return new Date(fromMs + Number(value) * 60_000).toISOString();

  if (kind === 'daily') {
    const clock = parseClock(value);
    return findNextMinute(timezone, fromMs, (parts) => parts.hour === clock.hour && parts.minute === clock.minute);
  }

  if (kind === 'weekly') {
    const [daysRaw, clockRaw] = value.split('@');
    const days = new Set(daysRaw.split(',').map(Number));
    const clock = parseClock(clockRaw);
    return findNextMinute(timezone, fromMs, (parts) => (
      days.has(parts.weekday) && parts.hour === clock.hour && parts.minute === clock.minute
    ));
  }

  const cron = parseCron(value);
  return findNextMinute(timezone, fromMs, (parts) => {
    const dayMatch = cron.day.values.has(parts.day);
    const weekdayMatch = cron.weekday.values.has(parts.weekday);
    const calendarDayMatch = cron.day.wildcard && cron.weekday.wildcard
      ? true
      : cron.day.wildcard
        ? weekdayMatch
        : cron.weekday.wildcard
          ? dayMatch
          : dayMatch || weekdayMatch;
    return cron.minute.values.has(parts.minute)
      && cron.hour.values.has(parts.hour)
      && cron.month.values.has(parts.month)
      && calendarDayMatch;
  });
}
