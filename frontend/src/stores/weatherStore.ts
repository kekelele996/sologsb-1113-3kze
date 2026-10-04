import { create } from 'zustand';
import { db, persistRow, persistRows, SCHEMA_VERSION } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import {
  conditionAt,
  failedBatch,
  mergeForecastRows,
  reconcileSessions,
  simulateFetch,
  successBatch,
  type ReconcileResult,
} from '../utils/weather';
import type { HourlyForecast, LegacyReview, WeatherCondition, WeatherFetchBatch } from '../types';
import { NIGHT_HOURS } from '../types';

interface WeatherState {
  forecasts: HourlyForecast[];
  batches: WeatherFetchBatch[];
  reviews: LegacyReview[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** 某夜某站的分时预报（按小时） */
  forecastsFor: (nightId: string, siteName: string) => HourlyForecast[];
  /** 拉取气象预报（模拟）：只写气象侧数据，不动编排台已改的段 */
  fetchForecast: (nightId: string, siteName: string) => Promise<WeatherFetchBatch>;
  /** 失败重试：只重试气象这侧，编排台已改的段照旧 */
  retryFetch: (batchId: string) => Promise<WeatherFetchBatch>;
  /** 编排台按小时对账：阴雨退回待改期、未覆盖挂起、晴好容量排队顺延 */
  reconcileNight: (nightId: string) => Promise<ReconcileResult>;
  /** 人工补录某小时天气 */
  setManualForecast: (nightId: string, siteName: string, hour: number, condition: WeatherCondition) => Promise<void>;
  /** 旧整夜文字待人工确认：标记已处理 */
  resolveReview: (id: string) => Promise<void>;
}

/** 气象预报（按小时 + 站点）与拉取批次、旧文字人工确认 */
export const useWeatherStore = create<WeatherState>()((set, get) => ({
  forecasts: [],
  batches: [],
  reviews: [],
  hydrated: false,

  hydrate: async () => {
    const [forecasts, batches, reviews] = await Promise.all([
      db.hourlyForecasts.toArray(),
      db.weatherBatches.orderBy('fetchedAt').toArray(),
      db.legacyReviews.toArray(),
    ]);
    set({ forecasts, batches, reviews, hydrated: true });
  },

  forecastsFor: (nightId, siteName) =>
    get()
      .forecasts.filter((item) => item.nightId === nightId && item.siteName === siteName)
      .sort((a, b) => NIGHT_HOURS.indexOf(a.hour) - NIGHT_HOURS.indexOf(b.hour)),

  fetchForecast: async (nightId, siteName) => {
    const batch: WeatherFetchBatch = {
      id: uid('wfb'),
      nightId,
      siteName,
      status: 'pending',
      retries: 0,
      schemaVersion: SCHEMA_VERSION,
    };
    await persistRow('weatherBatches', batch);
    set({ batches: [...get().batches, batch] });
    try {
      const conditions = await simulateFetch(nightId, siteName, 0);
      const now = new Date().toISOString();
      const rows = mergeForecastRows(get().forecasts, nightId, siteName, conditions, batch.id, now, SCHEMA_VERSION);
      await persistRows('hourlyForecasts', rows);
      const ok = successBatch(batch, now);
      await persistRow('weatherBatches', ok);
      set({
        forecasts: get().forecasts.filter((item) => !(item.nightId === nightId && item.siteName === siteName)).concat(rows),
        batches: get().batches.map((item) => (item.id === batch.id ? ok : item)),
      });
      return ok;
    } catch (error) {
      const fail = failedBatch(batch, (error as Error).message);
      await persistRow('weatherBatches', fail);
      set({ batches: get().batches.map((item) => (item.id === batch.id ? fail : item)) });
      return fail;
    }
  },

  retryFetch: async (batchId) => {
    const batch = get().batches.find((item) => item.id === batchId);
    if (!batch) throw new Error('气象拉取批次不存在');
    const retries = batch.retries + 1;
    const pending: WeatherFetchBatch = { ...batch, status: 'pending', retries, error: undefined };
    await persistRow('weatherBatches', pending);
    set({ batches: get().batches.map((item) => (item.id === batchId ? pending : item)) });
    try {
      const conditions = await simulateFetch(batch.nightId, batch.siteName, retries);
      const now = new Date().toISOString();
      const rows = mergeForecastRows(get().forecasts, batch.nightId, batch.siteName, conditions, batch.id, now, SCHEMA_VERSION);
      await persistRows('hourlyForecasts', rows);
      const ok = successBatch(pending, now);
      await persistRow('weatherBatches', ok);
      set({
        forecasts: get().forecasts
          .filter((item) => !(item.nightId === batch.nightId && item.siteName === batch.siteName))
          .concat(rows),
        batches: get().batches.map((item) => (item.id === batch.id ? ok : item)),
      });
      return ok;
    } catch (error) {
      const fail = failedBatch(pending, (error as Error).message);
      await persistRow('weatherBatches', fail);
      set({ batches: get().batches.map((item) => (item.id === batch.id ? fail : item)) });
      return fail;
    }
  },

  reconcileNight: async (nightId) => {
    // 动态 import 规避 store 间循环依赖
    const [{ useSessionStore }, { useNightStore }, { useEquipmentStore }] = await Promise.all([
      import('./sessionStore'),
      import('./nightStore'),
      import('./equipmentStore'),
    ]);
    const night = useNightStore.getState().nights.find((item) => item.id === nightId);
    if (!night) throw new Error('观测夜不存在');
    const siteName = night.siteName;
    const sessionStore = useSessionStore.getState();
    const result = reconcileSessions({
      nightId,
      siteName,
      sessions: sessionStore.sessions,
      forecasts: get().forecasts,
      telescopes: useEquipmentStore.getState().telescopes,
    });

    // 未覆盖 → 已挂起
    for (const id of result.suspended) {
      await sessionStore.updateSession(id, { status: '已挂起', rescheduleReason: '该时段无分时预报，先挂起等补齐' });
    }
    // 全部晴好且原属天气相关状态 → 待执行
    for (const id of result.ready) {
      const session = sessionStore.sessions.find((item) => item.id === id);
      if (session && (session.status === '已挂起' || session.status === '待改期')) {
        await sessionStore.updateSession(id, { status: '待执行', rescheduleReason: undefined });
      }
    }
    // 阴雨退回：已顺延 → 待执行（保留顺延记录）；未顺延 → 待改期
    for (const id of result.returned) {
      const placement = result.placed.find((item) => item.sessionId === id);
      if (placement) {
        await sessionStore.updateSession(id, {
          status: '待执行',
          startTime: placement.newStartTime,
          endTime: placement.newEndTime,
          rescheduleReason: `阴雨顺延 ${placement.from}→${placement.to}`,
        });
      } else {
        await sessionStore.updateSession(id, {
          status: '待改期',
          rescheduleReason: '预报阴雨，退回待改期；晴好时段排不下，待人工改期',
        });
      }
    }
    return result;
  },

  setManualForecast: async (nightId, siteName, hour, condition) => {
    const now = new Date().toISOString();
    const prev = get().forecasts.find((item) => item.nightId === nightId && item.siteName === siteName && item.hour === hour);
    const row: HourlyForecast = {
      id: prev?.id ?? uid('wf'),
      nightId,
      siteName,
      hour,
      condition,
      rawText: prev?.rawText,
      source: 'manual',
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION,
    };
    await persistRow('hourlyForecasts', row);
    set({
      forecasts: get().forecasts
        .filter((item) => !(item.nightId === nightId && item.siteName === siteName && item.hour === hour))
        .concat(row),
    });
  },

  resolveReview: async (id) => {
    const review = get().reviews.find((item) => item.id === id);
    if (!review) return;
    const next: LegacyReview = { ...review, resolved: true, resolvedAt: new Date().toISOString() };
    await persistRow('legacyReviews', next);
    set({ reviews: get().reviews.map((item) => (item.id === id ? next : item)) });
  },
}));

/** 取某夜某站某小时的天气状况（未覆盖返回 undefined） */
export function weatherAt(nightId: string, siteName: string, hour: number): WeatherCondition | undefined {
  return conditionAt(useWeatherStore.getState().forecasts, nightId, siteName, hour);
}
