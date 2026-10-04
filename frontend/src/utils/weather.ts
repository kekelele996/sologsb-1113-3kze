/** 分时气象预报与对账的纯逻辑工具（无 React / Dexie 依赖，便于测试与复用） */
import type { HourlyForecast, LegacyReview, ObsSession, Telescope, WeatherCondition, WeatherFetchBatch } from '../types';
import { MIN_HOURLY_CAPACITY, NIGHT_HOURS, RAINY_CONDITIONS } from '../types';
import { axisMinutes, durationMinutes, minutesToTime } from './astro';

const NIGHT_START_HOUR = 18;
/** 夜间时间轴总分钟（18:00 → 次日 06:00） */
const NIGHT_SPAN_MINUTES = 12 * 60;

/* ------------------------------- 小时换算 ------------------------------- */

/** 小时 → 夜间时间轴刻度（18:00 起算分钟） */
export function hourToAxis(hour: number): number {
  return ((hour - NIGHT_START_HOUR + 24) % 24) * 60;
}

/** 夜间时间轴刻度 → 小时 */
export function axisToHour(axis: number): number {
  return (Math.floor(axis / 60) + NIGHT_START_HOUR) % 24;
}

/** 排程段跨越的小时列表（跨零点安全） */
export function spannedHours(startTime: string, endTime: string): number[] {
  const start = axisMinutes(startTime);
  let end = axisMinutes(endTime);
  if (end <= start) end += 1440;
  const hours: number[] = [];
  for (let axis = 0; axis < NIGHT_SPAN_MINUTES; axis += 60) {
    if (axis < end && axis + 60 > start) hours.push(axisToHour(axis));
  }
  return hours;
}

/** 从预报列表取某夜某站某小时的状况（无预报返回 undefined，即未覆盖） */
export function conditionAt(
  forecasts: HourlyForecast[],
  nightId: string,
  siteName: string,
  hour: number,
): WeatherCondition | undefined {
  return forecasts.find((item) => item.nightId === nightId && item.siteName === siteName && item.hour === hour)?.condition;
}

/** 该小时是否阴雨 */
export function isRainy(condition: WeatherCondition | undefined): boolean {
  return condition !== undefined && RAINY_CONDITIONS.includes(condition);
}

/* --------------------------- 整夜文字拆分时 --------------------------- */

/** 含转折 / 间歇 / 时段描述的文字无法拆到具体小时，交人工确认 */
const TRANSITION_MARKERS = ['转', '间', '局部', '有时', '傍晚', '夜间', '凌晨', '前半夜', '后半夜', '多时段', '短时', '阵'];

/**
 * 整夜云量文字 → 单一天气状况。
 * 拆不出小时（含转折 / 间歇 / 时段描述或未知文字）时返回 null，列入人工确认。
 */
export function parseCloudText(text: string): WeatherCondition | null {
  const value = (text ?? '').trim();
  if (!value) return null;
  if (TRANSITION_MARKERS.some((marker) => value.includes(marker))) return null;
  if (value.includes('雨')) return '有雨';
  if (value.includes('阴')) return '阴';
  if (value.includes('多云')) return '多云';
  if (value.includes('少云')) return '少云';
  if (value.includes('晴')) return '晴';
  return null;
}

/** 判断整夜云量文字是否可拆到小时（可回填分时预报） */
export function canSplitToHours(text: string): boolean {
  return parseCloudText(text) !== null;
}

/** 由整夜云量文字生成分时预报行（不可拆时返回空数组） */
export function forecastsFromLegacy(
  nightId: string,
  siteName: string,
  cloudText: string,
  nowIso: string,
  schemaVersion: number,
): HourlyForecast[] {
  const condition = parseCloudText(cloudText);
  if (!condition) return [];
  return NIGHT_HOURS.map((hour) => ({
    id: `wf-${nightId}-${hour}`,
    nightId,
    siteName,
    hour,
    condition,
    rawText: cloudText,
    source: 'legacy' as const,
    updatedAt: nowIso,
    schemaVersion,
  }));
}

/** 由整夜云量文字生成待人工确认记录（可拆时返回 null） */
export function reviewFromLegacy(
  nightId: string,
  siteName: string,
  cloudText: string,
  schemaVersion: number,
): LegacyReview | null {
  if (parseCloudText(cloudText) !== null) return null;
  return {
    id: `lrev-${nightId}`,
    nightId,
    siteName,
    cloudText: cloudText?.trim() || '（空）',
    reason: '整夜云量文字含转折 / 间歇 / 时段描述，无法拆到具体小时，需人工确认分时状况',
    resolved: false,
    schemaVersion,
  };
}

/* ------------------------------- 气象拉取模拟 ------------------------------- */

const FETCH_DELAY_MS = 600;
/** 首次拉取失败概率（演示用）；重试一律成功，体现「只重试气象这侧」 */
const FIRST_ATTACK_FAILURE_RATE = 0.5;

const RANDOM_CONDITIONS: WeatherCondition[] = ['晴', '晴', '晴', '少云', '少云', '多云', '阴', '有雨'];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 模拟气象拉取（纯前端无后端）：返回按小时的天气状况。
 * 首次拉取按概率失败，重试（retries > 0）一律成功——失败只重试气象这侧。
 */
export async function simulateFetch(_nightId: string, _siteName: string, retries: number): Promise<Record<number, WeatherCondition>> {
  await delay(FETCH_DELAY_MS + Math.random() * 600);
  if (retries === 0 && Math.random() < FIRST_ATTACK_FAILURE_RATE) {
    throw new Error('气象数据拉取失败（模拟）：气象接口超时，请重试');
  }
  const map: Record<number, WeatherCondition> = {};
  NIGHT_HOURS.forEach((hour) => {
    map[hour] = RANDOM_CONDITIONS[Math.floor(Math.random() * RANDOM_CONDITIONS.length)];
  });
  return map;
}

/* ------------------------------- 按小时对账 ------------------------------- */

export interface ReconcileInput {
  nightId: string;
  siteName: string;
  sessions: ObsSession[];
  forecasts: HourlyForecast[];
  telescopes: Telescope[];
}

export interface Placement {
  sessionId: string;
  /** 原开始时刻 HH:mm */
  from: string;
  /** 顺延到的开始时刻 HH:mm */
  to: string;
  newStartTime: string;
  newEndTime: string;
}

export interface ReconcileResult {
  /** 无分时预报覆盖 → 已挂起 */
  suspended: string[];
  /** 预报阴雨 → 退回待改期 */
  returned: string[];
  /** 全部覆盖且无阴雨 → 待执行 */
  ready: string[];
  /** 阴雨退回但已顺延到晴好钟点（状态恢复待执行） */
  placed: Placement[];
  /** 阴雨退回且无晴好钟点可排（保持待改期，待人工改期） */
  unplaced: string[];
}

/** 终结状态：对账不触碰 */
const TERMINAL_STATUSES = new Set(['已完成', '因云取消', '进行中']);

/** 某小时内已确认（待执行）的排程段数（占用容量，不被顶掉） */
function confirmedCountInHour(
  hourAxis: number,
  duration: number,
  sessions: ObsSession[],
  excludeId: string,
): number {
  return sessions.filter((session) => {
    if (session.id === excludeId) return false;
    const start = axisMinutes(session.startTime);
    let end = axisMinutes(session.endTime);
    if (end <= start) end += 1440;
    return hourAxis < end && hourAxis + 60 > start;
  }).length;
}

/** 顺延到后一个晴好钟点：从当前小时向后找最早的晴好、有容量且望远镜空闲的整点 */
function findClearPlacement(
  session: ObsSession,
  forecasts: HourlyForecast[],
  nightId: string,
  siteName: string,
  capacity: number,
  confirmed: ObsSession[],
): Placement | null {
  const duration = durationMinutes(session.startTime, session.endTime);
  const currentHour = axisToHour(Math.floor(axisMinutes(session.startTime) / 60) * 60);
  const startIdx = NIGHT_HOURS.indexOf(currentHour);
  if (startIdx < 0) return null;

  for (let i = startIdx; i < NIGHT_HOURS.length; i += 1) {
    const hour = NIGHT_HOURS[i];
    const newStartAxis = hourToAxis(hour);
    const newEndAxis = newStartAxis + duration;
    if (newEndAxis > NIGHT_SPAN_MINUTES) continue;

    const candidateHours = spannedHoursAt(newStartAxis, duration);
    // 全部晴好且有预报
    const allClear = candidateHours.every((h) => {
      const condition = conditionAt(forecasts, nightId, siteName, h);
      return condition !== undefined && !isRainy(condition);
    });
    if (!allClear) continue;

    // 容量：每个跨越小时内已确认段数 < 容量（不顶掉已确认的段）
    const capacityOk = candidateHours.every((h) => {
      const hAxis = hourToAxis(h);
      return confirmedCountInHour(hAxis, duration, confirmed, session.id) < capacity;
    });
    if (!capacityOk) continue;

    // 望远镜不冲突
    const telescopeOk = confirmed.every((other) => {
      if (other.id === session.id || other.telescopeId !== session.telescopeId) return true;
      const start = axisMinutes(other.startTime);
      let end = axisMinutes(other.endTime);
      if (end <= start) end += 1440;
      return Math.min(newEndAxis, end) - Math.max(newStartAxis, start) <= 0;
    });
    if (!telescopeOk) continue;

    return {
      sessionId: session.id,
      from: session.startTime,
      to: minutesToTime(newStartAxis),
      newStartTime: minutesToTime(newStartAxis),
      newEndTime: minutesToTime(newEndAxis),
    };
  }
  return null;
}

/** 某区间（起始刻度 + 时长）跨越的小时列表 */
function spannedHoursAt(startAxis: number, duration: number): number[] {
  const endAxis = startAxis + duration;
  const hours: number[] = [];
  for (let axis = 0; axis < NIGHT_SPAN_MINUTES; axis += 60) {
    if (axis < endAxis && axis + 60 > startAxis) hours.push(axisToHour(axis));
  }
  return hours;
}

/**
 * 编排台按小时对账：
 * - 无分时预报覆盖 → 已挂起（等补齐）
 * - 预报阴雨 → 退回待改期；晴好钟点有容量则顺延（不顶掉已确认的段）
 * - 全部覆盖且无阴雨 → 待执行
 * 终结状态（已完成 / 因云取消 / 进行中）不触碰。
 */
export function reconcileSessions(input: ReconcileInput): ReconcileResult {
  const { nightId, siteName, forecasts, telescopes } = input;
  const sessions = input.sessions.filter((session) => session.nightId === nightId);
  const capacity = Math.max(MIN_HOURLY_CAPACITY, telescopes.filter((telescope) => telescope.status === '可用').length);

  const result: ReconcileResult = { suspended: [], returned: [], ready: [], placed: [], unplaced: [] };

  // 第一遍：分类。已确认（待执行）的段占用容量，不被顶掉。
  const decisions = new Map<string, 'ready' | 'rainy' | 'uncovered'>();
  sessions.forEach((session) => {
    if (TERMINAL_STATUSES.has(session.status)) return;
    const hours = spannedHours(session.startTime, session.endTime);
    const conditions = hours.map((hour) => conditionAt(forecasts, nightId, siteName, hour));
    if (conditions.some((condition) => condition === undefined)) {
      decisions.set(session.id, 'uncovered');
    } else if (conditions.some((condition) => isRainy(condition))) {
      decisions.set(session.id, 'rainy');
    } else {
      decisions.set(session.id, 'ready');
    }
  });

  const confirmed = sessions.filter((session) => decisions.get(session.id) === 'ready');

  // 第二遍：阴雨退回的段尝试顺延到晴好钟点
  sessions.forEach((session) => {
    const decision = decisions.get(session.id);
    if (!decision) return;
    if (decision === 'uncovered') {
      result.suspended.push(session.id);
      return;
    }
    if (decision === 'ready') {
      result.ready.push(session.id);
      return;
    }
    // rainy
    result.returned.push(session.id);
    const placement = findClearPlacement(session, forecasts, nightId, siteName, capacity, confirmed);
    if (placement) {
      result.placed.push(placement);
    } else {
      result.unplaced.push(session.id);
    }
  });

  return result;
}

/** 拉取成功后按小时 + 站点写入分时预报（保留旧原文对照） */
export function mergeForecastRows(
  existing: HourlyForecast[],
  nightId: string,
  siteName: string,
  conditions: Record<number, WeatherCondition>,
  batchId: string,
  nowIso: string,
  schemaVersion: number,
): HourlyForecast[] {
  return NIGHT_HOURS.map((hour) => {
    const prev = existing.find((item) => item.nightId === nightId && item.siteName === siteName && item.hour === hour);
    return {
      id: prev?.id ?? `wf-${nightId}-${hour}`,
      nightId,
      siteName,
      hour,
      condition: conditions[hour],
      rawText: prev?.rawText,
      source: 'fetch' as const,
      fetchBatchId: batchId,
      updatedAt: nowIso,
      schemaVersion,
    };
  });
}

/** 批次成功行 */
export function successBatch(batch: WeatherFetchBatch, nowIso: string): WeatherFetchBatch {
  return { ...batch, status: 'success', fetchedAt: nowIso, error: undefined };
}

/** 批次失败行 */
export function failedBatch(batch: WeatherFetchBatch, error: string): WeatherFetchBatch {
  return { ...batch, status: 'failed', error };
}
