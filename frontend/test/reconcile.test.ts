/** 对账逻辑快速验证（纯函数，无 DOM） */
import {
  parseCloudText,
  reconcileSessions,
  spannedHours,
  hourToAxis,
  type ReconcileInput,
} from '../src/utils/weather';
import type { HourlyForecast, ObsSession, Telescope } from '../src/types';
import { NIGHT_HOURS } from '../src/types';

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.error('FAIL:', msg);
  }
}

// 1. parseCloudText
assert(parseCloudText('晴') === '晴', '晴 → 晴');
assert(parseCloudText('有雨') === '有雨', '有雨 → 有雨');
assert(parseCloudText('阴') === '阴', '阴 → 阴');
assert(parseCloudText('多云') === '多云', '多云 → 多云');
assert(parseCloudText('少云') === '少云', '少云 → 少云');
assert(parseCloudText('晴间多云') === null, '晴间多云 → null（交人工）');
assert(parseCloudText('多云转晴') === null, '多云转晴 → null（交人工）');
assert(parseCloudText('夜间有雨') === null, '夜间有雨 → null（交人工）');
assert(parseCloudText('局部多云') === null, '局部多云 → null（交人工）');
assert(parseCloudText('') === null, '空文字 → null');

// 2. spannedHours
assert(spannedHours('18:20', '19:20').join(',') === '18,19', '18:20-19:20 跨 18,19 时');
assert(spannedHours('23:30', '01:00').join(',') === '23,0', '23:30-01:00 跨 23,0 时（跨零点）');
assert(spannedHours('20:00', '21:00').join(',') === '20', '20:00-21:00 只跨 20 时');

// 3. hourToAxis
assert(hourToAxis(18) === 0, '18时 axis=0');
assert(hourToAxis(0) === 360, '0时 axis=360');
assert(hourToAxis(5) === 660, '5时 axis=660');

// 构造预报：全部晴
function allClearForecasts(nightId: string, siteName: string): HourlyForecast[] {
  return NIGHT_HOURS.map((hour) => ({
    id: `wf-${nightId}-${hour}`,
    nightId,
    siteName,
    hour,
    condition: '晴',
    source: 'legacy' as const,
    updatedAt: '',
    schemaVersion: 3,
  }));
}

// 构造预报：指定小时阴雨
function rainyForecasts(nightId: string, siteName: string, rainyHours: number[]): HourlyForecast[] {
  return NIGHT_HOURS.map((hour) => ({
    id: `wf-${nightId}-${hour}`,
    nightId,
    siteName,
    hour,
    condition: rainyHours.includes(hour) ? ('有雨' as const) : ('晴' as const),
    source: 'fetch' as const,
    updatedAt: '',
    schemaVersion: 3,
  }));
}

// 构造排程段
function makeSession(over: Partial<ObsSession> & { id: string; startTime: string; endTime: string }): ObsSession {
  return {
    nightId: 'n1',
    targetId: 't1',
    telescopeId: 'tel-001',
    instrumentId: 'ins-001',
    filterSlot: 'L',
    plannedFrames: 10,
    status: '待执行',
    schemaVersion: 3,
    ...over,
  };
}

const telescopes: Telescope[] = [
  { id: 'tel-001', code: 'T-01', apertureMm: 150, focalLengthMm: 900, mount: 'X', terminals: [], maxPayloadKg: 10, status: '可用' },
  { id: 'tel-002', code: 'T-02', apertureMm: 200, focalLengthMm: 1000, mount: 'Y', terminals: [], maxPayloadKg: 10, status: '可用' },
];

// 4. 全部晴 → ready
{
  const sessions = [makeSession({ id: 's1', startTime: '20:00', endTime: '21:00' })];
  const input: ReconcileInput = {
    nightId: 'n1',
    siteName: '兴隆站',
    sessions,
    forecasts: allClearForecasts('n1', '兴隆站'),
    telescopes,
  };
  const r = reconcileSessions(input);
  assert(r.ready.includes('s1'), '全晴 → ready');
  assert(r.returned.length === 0 && r.suspended.length === 0, '全晴 无退回/挂起');
}

// 5. 阴雨小时 + 段 → 退回待改期，且顺延到晴好钟点
{
  const sessions = [makeSession({ id: 's1', startTime: '20:00', endTime: '21:00' })];
  const input: ReconcileInput = {
    nightId: 'n1',
    siteName: '兴隆站',
    sessions,
    forecasts: rainyForecasts('n1', '兴隆站', [20]),
    telescopes,
  };
  const r = reconcileSessions(input);
  assert(r.returned.includes('s1'), '阴雨 → 退回待改期');
  assert(r.placed.some((p) => p.sessionId === 's1'), '阴雨段顺延到晴好钟点');
  const placement = r.placed.find((p) => p.sessionId === 's1');
  assert(placement?.newStartTime === '21:00', `顺延到 21:00（实际 ${placement?.newStartTime}）`);
  assert(r.unplaced.length === 0, '有晴好钟点可排，非 unplaced');
}

// 6. 阴雨且后续全阴雨 → 待改期不顺延
{
  const sessions = [makeSession({ id: 's1', startTime: '20:00', endTime: '21:00' })];
  const input: ReconcileInput = {
    nightId: 'n1',
    siteName: '兴隆站',
    sessions,
    forecasts: rainyForecasts('n1', '兴隆站', NIGHT_HOURS),
    telescopes,
  };
  const r = reconcileSessions(input);
  assert(r.returned.includes('s1'), '全阴雨 → 退回');
  assert(r.unplaced.includes('s1'), '全阴雨 无晴好钟点 → unplaced 待人工改期');
  assert(r.placed.length === 0, '全阴雨 不顺延');
}

// 7. 未覆盖小时 → 已挂起
{
  const sessions = [makeSession({ id: 's1', startTime: '20:00', endTime: '21:00' })];
  const input: ReconcileInput = {
    nightId: 'n1',
    siteName: '兴隆站',
    sessions,
    forecasts: allClearForecasts('n1', '兴隆站').filter((f) => f.hour !== 20),
    telescopes,
  };
  const r = reconcileSessions(input);
  assert(r.suspended.includes('s1'), '未覆盖 → 已挂起');
  assert(r.returned.length === 0, '未覆盖 不退回');
}

// 8. 已确认段不被顶掉：晴好钟点容量被已确认段占满时，阴雨段顺延到更后一个钟点，不挤掉已确认段
{
  // 容量 = 可用望远镜数 = 2。s1/s2 已确认排在 21 点（占满容量）；s3 在 20 点阴雨需顺延。
  const sessions = [
    makeSession({ id: 's1', startTime: '21:00', endTime: '22:00', telescopeId: 'tel-001' }),
    makeSession({ id: 's2', startTime: '21:00', endTime: '22:00', telescopeId: 'tel-002' }),
    makeSession({ id: 's3', startTime: '20:00', endTime: '21:00', telescopeId: 'tel-001' }),
  ];
  const forecasts = rainyForecasts('n1', '兴隆站', [20]);
  const input: ReconcileInput = { nightId: 'n1', siteName: '兴隆站', sessions, forecasts, telescopes };
  const r = reconcileSessions(input);
  assert(r.ready.includes('s1') && r.ready.includes('s2'), '已确认段保持 ready 不被顶掉');
  assert(r.returned.includes('s3'), '阴雨段 s3 退回');
  const p3 = r.placed.find((p) => p.sessionId === 's3');
  assert(p3?.newStartTime === '22:00', `21 点容量已满，s3 顺延到 22:00（实际 ${p3?.newStartTime}）`);
}

// 9. 终结状态不触碰
{
  const sessions = [
    makeSession({ id: 's1', startTime: '20:00', endTime: '21:00', status: '已完成' }),
    makeSession({ id: 's2', startTime: '20:00', endTime: '21:00', status: '因云取消' }),
    makeSession({ id: 's3', startTime: '20:00', endTime: '21:00', status: '进行中' }),
  ];
  const input: ReconcileInput = {
    nightId: 'n1',
    siteName: '兴隆站',
    sessions,
    forecasts: rainyForecasts('n1', '兴隆站', [20]),
    telescopes,
  };
  const r = reconcileSessions(input);
  assert(r.returned.length === 0 && r.suspended.length === 0 && r.ready.length === 0, '终结状态不触碰');
}

// 10. 跨零点阴雨段顺延
{
  const sessions = [makeSession({ id: 's1', startTime: '23:30', endTime: '00:30' })];
  const input: ReconcileInput = {
    nightId: 'n1',
    siteName: '兴隆站',
    sessions,
    forecasts: rainyForecasts('n1', '兴隆站', [23]),
    telescopes,
  };
  const r = reconcileSessions(input);
  assert(r.returned.includes('s1'), '跨零点阴雨段退回');
  const p = r.placed.find((x) => x.sessionId === 's1');
  assert(p?.newStartTime === '00:00', `跨零点段顺延到 00:00（实际 ${p?.newStartTime}）`);
}

console.log(`\n对账逻辑验证：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
