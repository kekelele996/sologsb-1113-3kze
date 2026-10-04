import {
  NIGHT_HOURS,
  forecastId,
  isBadCloud,
  isClearCloud,
  type DeferralPlan,
  type HourlyForecast,
  type ReconcileAction,
} from '../types/forecast';
import type { ObsSession } from '../types/session';
import { CLOUD_TEXTS, NIGHT_TOTAL_MINUTES } from '../types/night';
import { axisMinutes, durationMinutes, minutesToTime, overlapMinutes } from './astro';

/** 气象值班接口每次新发布的小时数（首次先发布 6 小时，模拟按小时陆续发报） */
const PUBLISH_FIRST_HOURS = 6;
const PUBLISH_STEP_HOURS = 3;

/** 模拟拉取失败率：失败后只重试气象这侧，编排台已改好的段照旧 */
const FETCH_FAILURE_RATE = 0.25;

/** 模拟云量分布权重 */
const CLOUD_WEIGHTS: Array<[string, number]> = [
  ['晴', 0.45],
  ['少云', 0.25],
  ['多云', 0.15],
  ['阴', 0.1],
  ['有雨', 0.05],
];

function hashCode(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** 按站点 + 日期 + 小时确定性生成云量（同一小时重复拉取结果一致） */
export function simulatedCloud(siteName: string, date: string, hour: string): string {
  const roll = (hashCode(`${siteName}|${date}|${hour}`) % 1000) / 1000;
  let acc = 0;
  for (const [cloud, weight] of CLOUD_WEIGHTS) {
    acc += weight;
    if (roll < acc) return cloud;
  }
  return '晴';
}

export interface FetchForecastResult {
  rows: HourlyForecast[];
  /** 本次拉取后累计已发布的小时数 */
  published: number;
}

/**
 * 模拟气象值班分时预报接口：按小时陆续发布（首次 6 小时，之后每次 +3，直至 12 小时）。
 * 约 1/4 概率超时失败；失败时不写任何数据，重试只影响气象侧。
 */
export async function fetchHourlyForecast(siteName: string, date: string, published: number): Promise<FetchForecastResult> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (Math.random() < FETCH_FAILURE_RATE) {
    throw new Error('气象值班接口超时，未获取到分时预报');
  }
  const next = Math.min(NIGHT_HOURS.length, Math.max(published, PUBLISH_FIRST_HOURS) + PUBLISH_STEP_HOURS);
  const batchId = `batch-${Date.now().toString(36)}`;
  const updatedAt = new Date().toISOString();
  const rows = NIGHT_HOURS.slice(0, next).map((hour) => ({
    id: forecastId(siteName, date, hour),
    siteName,
    date,
    hour,
    cloud: simulatedCloud(siteName, date, hour),
    source: 'fetch' as const,
    batchId,
    updatedAt,
  }));
  return { rows, published: next };
}

/** 旧整夜云量文字 → 逐小时云量：恰为已知云量等级才可拆分，否则返回 null 交人认 */
export function splitLegacyCloudText(cloudText: string | undefined): string | null {
  const text = (cloudText ?? '').trim();
  return CLOUD_TEXTS.includes(text) ? text : null;
}

/** 用旧整夜文字回填一整夜的分时预报（每条保留原文对照） */
export function buildLegacyBackfill(night: { id: string; siteName: string; date: string; cloudText: string }, cloud: string, updatedAt: string): HourlyForecast[] {
  return NIGHT_HOURS.map((hour) => ({
    id: forecastId(night.siteName, night.date, hour),
    siteName: night.siteName,
    date: night.date,
    hour,
    cloud,
    source: 'legacy' as const,
    legacyText: night.cloudText,
    batchId: `legacy-${night.id}`,
    updatedAt,
  }));
}

/** 排程段重叠到的夜间整点小时（HH:mm 数组） */
export function sessionHours(session: Pick<ObsSession, 'startTime' | 'endTime'>): string[] {
  return NIGHT_HOURS.filter((hour) => overlapMinutes(session.startTime, session.endTime, hour, minutesToTime(axisMinutes(hour) + 60)) > 0);
}

/** 站点 + 日期 → 小时云量索引（对账与顺延共用） */
export function buildForecastMap(forecasts: HourlyForecast[], siteName: string, date: string): Map<string, HourlyForecast> {
  const map = new Map<string, HourlyForecast>();
  forecasts
    .filter((row) => row.siteName === siteName && row.date === date)
    .forEach((row) => {
      map.set(row.hour, row);
    });
  return map;
}

/** 对账只自动处理这些状态；进行中 / 已完成 / 因云取消 / 待改期 视为编排台已确认或正在处理，不动 */
const AUTO_RECONCILE_STATUSES = ['待执行', '挂起待补'];

/**
 * 按小时对账：
 * - 任一重叠小时预报阴雨 → 退回待改期；
 * - 否则任一小时预报未覆盖 → 挂起等补齐；
 * - 挂起的段预报补齐且晴好 → 恢复待执行。
 */
export function buildReconcileActions(nightSessions: ObsSession[], forecastByHour: Map<string, HourlyForecast>): ReconcileAction[] {
  const actions: ReconcileAction[] = [];
  nightSessions
    .filter((session) => AUTO_RECONCILE_STATUSES.includes(session.status))
    .forEach((session) => {
      const hours = sessionHours(session);
      const badHours = hours.filter((hour) => isBadCloud(forecastByHour.get(hour)?.cloud));
      if (badHours.length > 0) {
        const clouds = Array.from(new Set(badHours.map((hour) => forecastByHour.get(hour)?.cloud ?? ''))).join('、');
        actions.push({ sessionId: session.id, nextStatus: '待改期', reason: `对账退回：${badHours.join('、')} 预报${clouds}` });
        return;
      }
      const missingHours = hours.filter((hour) => !forecastByHour.has(hour));
      if (missingHours.length > 0) {
        actions.push({ sessionId: session.id, nextStatus: '挂起待补', reason: `对账挂起：${missingHours.join('、')} 预报未覆盖，等补齐` });
        return;
      }
      if (session.status === '挂起待补') {
        actions.push({ sessionId: session.id, nextStatus: '待执行', reason: '' });
      }
    });
  return actions;
}

export interface DeferralResult {
  plans: DeferralPlan[];
  /** 晴好时段容量不足、继续排队等待的排程段 id */
  queued: string[];
}

/**
 * 排队顺延：待改期的段按原开始时刻先后排队，顺延到后一个晴好钟点（整点起排）。
 * 容量约束 = 同望远镜时段不得重叠；已确认（非待改期）的段原位保留，顺延不顶掉它们。
 */
export function planDeferrals(nightSessions: ObsSession[], forecastByHour: Map<string, HourlyForecast>): DeferralResult {
  const queue = nightSessions
    .filter((session) => session.status === '待改期')
    .sort((a, b) => axisMinutes(a.startTime) - axisMinutes(b.startTime));
  const occupied = nightSessions.filter((session) => session.status !== '待改期');
  const plans: DeferralPlan[] = [];
  const queued: string[] = [];

  const fitsClearHours = (start: string, end: string): boolean => {
    const hours = sessionHours({ startTime: start, endTime: end });
    return hours.length > 0 && hours.every((hour) => isClearCloud(forecastByHour.get(hour)?.cloud));
  };

  queue.forEach((session) => {
    const duration = durationMinutes(session.startTime, session.endTime);
    const originalStart = axisMinutes(session.startTime);
    const candidate = NIGHT_HOURS.filter((hour) => isClearCloud(forecastByHour.get(hour)?.cloud))
      .map((hour) => ({ hour, axis: axisMinutes(hour) }))
      .filter(({ axis }) => axis > originalStart && axis + duration <= NIGHT_TOTAL_MINUTES)
      .find(({ axis }) => {
        const toStart = minutesToTime(axis);
        const toEnd = minutesToTime(axis + duration);
        if (!fitsClearHours(toStart, toEnd)) return false;
        return !occupied.some(
          (other) => other.telescopeId === session.telescopeId && overlapMinutes(toStart, toEnd, other.startTime, other.endTime) > 0,
        );
      });
    if (!candidate) {
      queued.push(session.id);
      return;
    }
    const toStart = minutesToTime(candidate.axis);
    const toEnd = minutesToTime(candidate.axis + duration);
    plans.push({ sessionId: session.id, fromStart: session.startTime, toStart, toEnd, hour: candidate.hour });
    // 已顺延的段同样占用容量，后续排队者不得与之重叠
    occupied.push({ ...session, startTime: toStart, endTime: toEnd });
  });

  return { plans, queued };
}
