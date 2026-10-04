/** 分时气象预报与气象对账相关类型 */

/** 天气状况（与整夜云量文字对齐） */
export type WeatherCondition = '晴' | '少云' | '多云' | '阴' | '有雨';

/** 预报来源：气象拉取 / 旧整夜文字回填 / 人工补录 */
export type ForecastSource = 'fetch' | 'legacy' | 'manual';

/** 分时气象预报：按小时 + 站点分开存储 */
export interface HourlyForecast {
  id: string;
  /** 所属观测夜 ID */
  nightId: string;
  /** 站点名（与 ObsNight.siteName 对齐） */
  siteName: string;
  /** 小时（0~23，该小时起始时刻，如 20 表示 20:00-21:00） */
  hour: number;
  /** 天气状况 */
  condition: WeatherCondition;
  /** 原始云量文字（旧整夜文字升级时留原文对照） */
  rawText?: string;
  /** 数据来源 */
  source: ForecastSource;
  /** 拉取批次 ID（失败只重试气象侧） */
  fetchBatchId?: string;
  /** 更新时间 ISO */
  updatedAt: string;
  /** 数据结构版本 */
  schemaVersion: number;
}

/** 气象拉取批次：失败只重试气象这侧，编排台已改的段不受影响 */
export interface WeatherFetchBatch {
  id: string;
  nightId: string;
  siteName: string;
  /** pending=拉取中，success=成功，failed=失败待重试 */
  status: 'pending' | 'success' | 'failed';
  /** 失败原因 */
  error?: string;
  /** 拉取成功时间 */
  fetchedAt?: string;
  /** 已重试次数 */
  retries: number;
  /** 数据结构版本 */
  schemaVersion: number;
}

/** 旧整夜云量文字待人工确认记录（拆不出小时的列出来交人认） */
export interface LegacyReview {
  id: string;
  /** 所属观测夜 ID */
  nightId: string;
  /** 站点名 */
  siteName: string;
  /** 原始整夜云量文字（留原文对照） */
  cloudText: string;
  /** 拆不出小时的原因 */
  reason: string;
  /** 是否已人工处理 */
  resolved: boolean;
  /** 处理时间 */
  resolvedAt?: string;
  /** 数据结构版本 */
  schemaVersion: number;
}

export const WEATHER_CONDITIONS: WeatherCondition[] = ['晴', '少云', '多云', '阴', '有雨'];

/** 阴雨状况：对账时触发「退回待改期」 */
export const RAINY_CONDITIONS: WeatherCondition[] = ['阴', '有雨'];

/** 夜间小时（18:00 → 次日 06:00，共 12 个小时） */
export const NIGHT_HOURS: number[] = [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5];

/** 每小时容量基准（晴好时段容量有限）：默认按可用望远镜数，至少 1 */
export const MIN_HOURLY_CAPACITY = 1;

/** 天气状况配色（时间轴与预报条带用） */
export const CONDITION_COLOR: Record<WeatherCondition, string> = {
  晴: '#ffd54f',
  少云: '#fff59d',
  多云: '#b0bec5',
  阴: '#78909c',
  有雨: '#5c6bc0',
};
