import { create } from 'zustand';
import { db, deleteRow, persistRows } from '../hooks/usePersistentStore';
import { NIGHT_HOURS, forecastId, type ForecastReview, type HourlyForecast } from '../types';
import { fetchHourlyForecast } from '../utils/forecast';

/** 气象值班发布进度（已发布小时数）在 meta 表中的 key */
function publishedKey(siteName: string, date: string): string {
  return `forecast-published:${siteName}:${date}`;
}

/** 把新行合并进列表（同 id 覆盖，按站点 + 日期 + 夜间小时轴排序） */
function mergeRows(list: HourlyForecast[], rows: HourlyForecast[]): HourlyForecast[] {
  const byId = new Map(list.map((row) => [row.id, row]));
  rows.forEach((row) => byId.set(row.id, row));
  return [...byId.values()].sort(
    (a, b) =>
      a.siteName.localeCompare(b.siteName) || a.date.localeCompare(b.date) || NIGHT_HOURS.indexOf(a.hour) - NIGHT_HOURS.indexOf(b.hour),
  );
}

interface ForecastState {
  forecasts: HourlyForecast[];
  reviews: ForecastReview[];
  hydrated: boolean;
  /** 是否正在拉取（气象侧） */
  fetching: boolean;
  /** 最近一次拉取失败原因 */
  lastError: string;
  hydrate: () => Promise<void>;
  /**
   * 拉取（或重试）某站点某夜的分时预报：只写 forecasts 表与发布进度，
   * 不触碰编排台的排程段；失败时保留已有预报，返回 false。
   */
  fetchForecast: (siteName: string, date: string) => Promise<boolean>;
  /** 旧数据待确认：人工认定云量等级后按原文回填一整夜分时预报 */
  confirmReview: (reviewId: string, cloud: string) => Promise<void>;
  /** 旧数据待确认：忽略该条（不生成预报，该夜时段对账时按未覆盖挂起） */
  dismissReview: (reviewId: string) => Promise<void>;
}

/** 分时预报（气象侧）与旧数据升级待确认列表 */
export const useForecastStore = create<ForecastState>()((set, get) => ({
  forecasts: [],
  reviews: [],
  hydrated: false,
  fetching: false,
  lastError: '',

  hydrate: async () => {
    const [forecasts, reviews] = await Promise.all([db.forecasts.toArray(), db.forecastReviews.toArray()]);
    set({ forecasts: mergeRows([], forecasts), reviews, hydrated: true });
  },

  fetchForecast: async (siteName, date) => {
    set({ fetching: true, lastError: '' });
    try {
      const publishedRow = await db.meta.get(publishedKey(siteName, date));
      const published = Number(publishedRow?.value) || 0;
      const { rows, published: next } = await fetchHourlyForecast(siteName, date, published);
      // 重新拉取覆盖旧数据回填的行时，保留整夜原文对照
      const existing = new Map(get().forecasts.map((row) => [row.id, row]));
      const merged = rows.map((row) => {
        const legacyText = existing.get(row.id)?.legacyText;
        return legacyText ? { ...row, legacyText } : row;
      });
      await persistRows('forecasts', merged);
      await db.meta.put({ key: publishedKey(siteName, date), value: String(next) });
      set((state) => ({ forecasts: mergeRows(state.forecasts, merged), fetching: false }));
      return true;
    } catch (reason) {
      // 拉取失败：已有分时预报与编排台排程段都保持原样，仅记录错误待重试
      set({ fetching: false, lastError: (reason as Error).message });
      return false;
    }
  },

  confirmReview: async (reviewId, cloud) => {
    const review = get().reviews.find((item) => item.id === reviewId);
    if (!review) return;
    const batchId = `review-${review.id}`;
    const updatedAt = new Date().toISOString();
    const rows: HourlyForecast[] = NIGHT_HOURS.map((hour) => ({
      id: forecastId(review.siteName, review.date, hour),
      siteName: review.siteName,
      date: review.date,
      hour,
      cloud,
      source: 'legacy',
      legacyText: review.legacyText,
      batchId,
      updatedAt,
    }));
    await persistRows('forecasts', rows);
    await db.meta.put({ key: publishedKey(review.siteName, review.date), value: String(NIGHT_HOURS.length) });
    await deleteRow('forecastReviews', reviewId);
    set((state) => ({
      forecasts: mergeRows(state.forecasts, rows),
      reviews: state.reviews.filter((item) => item.id !== reviewId),
    }));
  },

  dismissReview: async (reviewId) => {
    await deleteRow('forecastReviews', reviewId);
    set((state) => ({ reviews: state.reviews.filter((item) => item.id !== reviewId) }));
  },
}));
