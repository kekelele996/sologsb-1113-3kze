import type { SessionStatus } from './session';

/** 分时预报来源：气象值班拉取 / 旧数据（整夜文字）回填 */
export type ForecastSource = 'fetch' | 'legacy';

/** 小时级分时预报：按站点 + 日期 + 小时分开存，与编排台的排程段各记各的表 */
export interface HourlyForecast {
  /** 稳定 id：fc|站点|日期|小时，重复拉取覆盖同一行 */
  id: string;
  /** 站点名（与观测夜 siteName 对应） */
  siteName: string;
  /** 所属观测夜日期 YYYY-MM-DD */
  date: string;
  /** 小时起点 HH:mm（整点，夜间轴 18:00 → 次日 05:00） */
  hour: string;
  /** 该小时云量（晴 / 少云 / 多云 / 阴 / 有雨） */
  cloud: string;
  /** 来源 */
  source: ForecastSource;
  /** 旧数据整夜云量原文（回填时保留对照） */
  legacyText?: string;
  /** 拉取批次号（重试只重写气象侧，不影响编排台） */
  batchId: string;
  /** 写入时间 ISO */
  updatedAt: string;
}

/** 旧数据升级待人工确认：整夜云量文字拆不出逐小时预报的观测夜 */
export interface ForecastReview {
  id: string;
  /** 观测夜 ID */
  nightId: string;
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 站点名 */
  siteName: string;
  /** 整夜云量原文 */
  legacyText: string;
  /** 待确认原因 */
  reason: string;
}

/** 夜间逐小时刻度（18:00 → 次日 05:00，共 12 个整点小时） */
export const NIGHT_HOURS: string[] = ['18:00', '19:00', '20:00', '21:00', '22:00', '23:00', '00:00', '01:00', '02:00', '03:00', '04:00', '05:00'];

/** 阴雨云量：落在这些小时的排程段退回待改期 */
export const BAD_CLOUDS: string[] = ['阴', '有雨'];

/** 晴好云量：可承接顺延排程的时段（多云仍可观测，仅阴雨退回） */
export const CLEAR_CLOUDS: string[] = ['晴', '少云', '多云'];

export function isBadCloud(cloud: string | undefined): boolean {
  return Boolean(cloud) && BAD_CLOUDS.includes(cloud as string);
}

export function isClearCloud(cloud: string | undefined): boolean {
  return Boolean(cloud) && CLEAR_CLOUDS.includes(cloud as string);
}

/** 分时预报 id（站点 + 日期 + 小时唯一） */
export function forecastId(siteName: string, date: string, hour: string): string {
  return `fc|${siteName}|${date}|${hour}`;
}

/** 一条对账动作：只改动列出的排程段，编排台已确认 / 已改好的段不在其列 */
export interface ReconcileAction {
  sessionId: string;
  nextStatus: SessionStatus;
  /** 写入改期原因；空串表示清除（对账恢复时清掉自动原因） */
  reason: string;
}

/** 一条顺延方案：待改期的段顺延到后一个晴好钟点 */
export interface DeferralPlan {
  sessionId: string;
  /** 原开始时刻 HH:mm */
  fromStart: string;
  /** 新时段 */
  toStart: string;
  toEnd: string;
  /** 顺延落入的晴好钟点 */
  hour: string;
}
