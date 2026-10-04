import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import StatusChip from '../components/common/StatusChip';
import { usePersistentStore } from '../hooks/usePersistentStore';
import { useForecastStore } from '../stores/forecastStore';
import { useNightStore } from '../stores/nightStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTargetStore } from '../stores/targetStore';
import { useEquipmentStore } from '../stores/equipmentStore';
import { CLOUD_TEXTS, NIGHT_HOURS, isBadCloud, type HourlyForecast } from '../types';
import { axisMinutes, minutesToTime } from '../utils/astro';
import { buildForecastMap, buildReconcileActions, planDeferrals, sessionHours } from '../utils/forecast';

/** 云量徽标配色（未覆盖单独灰色描边） */
const CLOUD_CHIP_COLOR: Record<string, 'default' | 'success' | 'warning' | 'error'> = {
  晴: 'success',
  少云: 'success',
  多云: 'default',
  阴: 'warning',
  有雨: 'error',
};

function CloudChip({ cloud }: { cloud: string | undefined }) {
  if (!cloud) return <Chip size="small" variant="outlined" label="未覆盖" />;
  return <Chip size="small" color={CLOUD_CHIP_COLOR[cloud] ?? 'default'} variant={cloud === '少云' || cloud === '多云' ? 'outlined' : 'filled'} label={cloud} />;
}

function hourRange(hour: string): string {
  return `${hour}–${minutesToTime(axisMinutes(hour) + 60)}`;
}

/** 气象对账：气象侧分时预报（按站点 + 小时存）与编排侧按小时对账、退回 / 挂起 / 顺延 */
export default function WeatherPage() {
  usePersistentStore();
  const nights = useNightStore((s) => s.nights);
  const currentNightId = useNightStore((s) => s.currentNightId);
  const sessions = useSessionStore((s) => s.sessions);
  const applyReconcile = useSessionStore((s) => s.applyReconcile);
  const applyDeferrals = useSessionStore((s) => s.applyDeferrals);
  const targets = useTargetStore((s) => s.targets);
  const telescopes = useEquipmentStore((s) => s.telescopes);
  const forecasts = useForecastStore((s) => s.forecasts);
  const reviews = useForecastStore((s) => s.reviews);
  const fetching = useForecastStore((s) => s.fetching);
  const lastError = useForecastStore((s) => s.lastError);
  const fetchForecast = useForecastStore((s) => s.fetchForecast);
  const confirmReview = useForecastStore((s) => s.confirmReview);
  const dismissReview = useForecastStore((s) => s.dismissReview);

  const [nightId, setNightId] = useState('');
  const [notice, setNotice] = useState('');
  const [reviewCloud, setReviewCloud] = useState<Record<string, string>>({});

  const night = nights.find((item) => item.id === (nightId || currentNightId)) ?? nights[0];
  const nightSessions = useMemo(() => sessions.filter((session) => session.nightId === night?.id), [sessions, night?.id]);
  const forecastByHour = useMemo(
    () => buildForecastMap(forecasts, night?.siteName ?? '', night?.date ?? ''),
    [forecasts, night?.siteName, night?.date],
  );
  const coveredCount = forecastByHour.size;
  const pendingCount = useMemo(() => nightSessions.filter((session) => session.status === '待改期').length, [nightSessions]);
  const usableTelescopes = useMemo(() => telescopes.filter((item) => item.status === '可用').length, [telescopes]);

  const targetById = (id: string) => targets.find((target) => target.id === id);
  const sessionsOfHour = (hour: string) =>
    nightSessions
      .filter((session) => sessionHours(session).includes(hour))
      .sort((a, b) => axisMinutes(a.startTime) - axisMinutes(b.startTime));

  async function runFetch() {
    if (!night) return;
    const ok = await fetchForecast(night.siteName, night.date);
    if (ok) setNotice(`已拉取 ${night.siteName} ${night.date} 的分时预报（仅更新气象侧，编排台已调整的排程段保持不变）`);
  }

  async function runReconcile() {
    if (!night) return;
    const actions = buildReconcileActions(nightSessions, forecastByHour);
    await applyReconcile(actions);
    const returned = actions.filter((action) => action.nextStatus === '待改期').length;
    const suspended = actions.filter((action) => action.nextStatus === '挂起待补').length;
    const restored = actions.filter((action) => action.nextStatus === '待执行').length;
    const untouched = nightSessions.length - actions.length;
    setNotice(`对账完成：退回待改期 ${returned} 段 · 挂起等补齐 ${suspended} 段 · 恢复待执行 ${restored} 段 · 已确认未触及 ${untouched} 段`);
  }

  async function runDeferral() {
    if (!night) return;
    const { plans, queued } = planDeferrals(nightSessions, forecastByHour);
    await applyDeferrals(plans);
    const placed = plans.map((plan) => `${plan.sessionId}→${plan.toStart}`).join('、');
    setNotice(
      `顺延完成：${plans.length} 段落位晴好钟点${placed ? `（${placed}）` : ''}` +
        (queued.length > 0 ? `；${queued.length} 段晴好容量不足，继续排队（${queued.join('、')}）` : ''),
    );
  }

  if (!night) {
    return <Alert severity="info">暂无观测夜数据</Alert>;
  }

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        气象对账
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        气象值班按小时发布预报，按站点与小时分开存；编排台按小时对账：阴雨小时的排程段退回待改期，未覆盖时段挂起等补齐，待改期的段排队顺延到后一个晴好钟点，不顶掉已确认的段。
      </Typography>

      {notice ? (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      ) : null}

      <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap' }} alignItems="center">
        <TextField select size="small" label="观测夜" value={night.id} onChange={(event) => setNightId(event.target.value)} sx={{ minWidth: 260 }}>
          {nights.map((item) => (
            <MenuItem key={item.id} value={item.id}>
              {`${item.date} · ${item.siteName} · 整夜云量「${item.cloudText}」${item.primary ? '（主夜）' : item.backup ? '（备用夜）' : ''}`}
            </MenuItem>
          ))}
        </TextField>
        <Chip size="small" color={coveredCount === NIGHT_HOURS.length ? 'success' : 'warning'} variant="outlined" label={`分时预报已覆盖 ${coveredCount}/${NIGHT_HOURS.length} 小时`} />
        <Chip size="small" variant="outlined" label={`待改期 ${pendingCount} 段`} />
      </Stack>

      {/* 气象侧：拉取 / 重试分时预报 */}
      <Typography variant="subtitle1" sx={{ mb: 1 }}>
        气象侧 · 分时预报
      </Typography>
      {lastError ? (
        <Alert
          severity="warning"
          sx={{ mb: 1.5 }}
          action={
            <Button color="inherit" size="small" disabled={fetching} onClick={() => void runFetch()}>
              重试
            </Button>
          }
        >
          预报拉取失败：{lastError}。只重试气象这侧，编排台已改好的段照旧。
        </Alert>
      ) : null}
      <Stack direction="row" spacing={2} sx={{ mb: 1.5 }} alignItems="center">
        <Button variant="contained" disabled={fetching} onClick={() => void runFetch()}>
          {fetching ? '拉取中…' : coveredCount === 0 ? '拉取分时预报' : coveredCount < NIGHT_HOURS.length ? '继续拉取（补齐未覆盖小时）' : '重新拉取'}
        </Button>
        <Typography variant="caption" color="text.secondary">
          气象值班按小时陆续发报，首次拉取未必覆盖整夜；失败可重试，重试只影响气象侧
        </Typography>
      </Stack>
      <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>时段</TableCell>
              <TableCell>云量</TableCell>
              <TableCell>来源</TableCell>
              <TableCell>整夜原文对照</TableCell>
              <TableCell>写入时间</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {NIGHT_HOURS.map((hour) => {
              const row = forecastByHour.get(hour);
              return (
                <TableRow key={hour} hover>
                  <TableCell>{hourRange(hour)}</TableCell>
                  <TableCell>
                    <CloudChip cloud={row?.cloud} />
                  </TableCell>
                  <TableCell>
                    {row ? (
                      <Chip size="small" variant="outlined" label={row.source === 'fetch' ? '气象值班拉取' : '旧数据回填'} />
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        待发布
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" color={row?.legacyText ? 'text.primary' : 'text.secondary'}>
                      {row?.legacyText ? `「${row.legacyText}」` : '-'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary">
                      {row ? new Date(row.updatedAt).toLocaleString('zh-CN') : '-'}
                    </Typography>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      {/* 编排侧：按小时对账 + 排队顺延 */}
      <Typography variant="subtitle1" sx={{ mb: 1 }}>
        编排侧 · 按小时对账
      </Typography>
      <Stack direction="row" spacing={2} sx={{ mb: 1.5 }} alignItems="center">
        <Button variant="contained" color="warning" onClick={() => void runReconcile()}>
          按小时对账
        </Button>
        <Button variant="outlined" color="warning" disabled={pendingCount === 0} onClick={() => void runDeferral()}>
          排队顺延（待改期 {pendingCount} 段）
        </Button>
        <Typography variant="caption" color="text.secondary">
          对账只动待执行 / 挂起待补的段；进行中、已完成、因云取消与已退回待改期的段保持原样
        </Typography>
      </Stack>
      <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>时段</TableCell>
              <TableCell>预报云量</TableCell>
              <TableCell>该小时排程段</TableCell>
              <TableCell>容量（段 / 可用望远镜）</TableCell>
              <TableCell>对账结论</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {NIGHT_HOURS.map((hour) => {
              const row = forecastByHour.get(hour);
              const hourSessions = sessionsOfHour(hour);
              const verdict = hourVerdict(row, hourSessions.length);
              return (
                <TableRow key={hour} hover>
                  <TableCell>{hourRange(hour)}</TableCell>
                  <TableCell>
                    <CloudChip cloud={row?.cloud} />
                  </TableCell>
                  <TableCell>
                    {hourSessions.length === 0 ? (
                      <Typography variant="caption" color="text.secondary">
                        -
                      </Typography>
                    ) : (
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        {hourSessions.map((session) => (
                          <Chip
                            key={session.id}
                            size="small"
                            variant="outlined"
                            label={`${session.id} ${targetById(session.targetId)?.name ?? '未知目标'} ${session.startTime}-${session.endTime}`}
                          />
                        ))}
                      </Stack>
                    )}
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" color={hourSessions.length > usableTelescopes ? 'error' : 'text.secondary'}>
                      {hourSessions.length} 段 / {usableTelescopes} 台
                    </Typography>
                  </TableCell>
                  <TableCell>{verdict}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      {/* 旧数据升级：整夜云量文字拆不出小时的，列出来交人认 */}
      {reviews.length > 0 ? (
        <Box>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            旧数据升级 · 待人工确认（{reviews.length}）
          </Typography>
          <Alert severity="info" sx={{ mb: 1.5 }}>
            <AlertTitle>以下观测夜的整夜云量文字无法拆分为逐小时预报</AlertTitle>
            请人工认定一个云量等级后按原文回填一整夜分时预报（保留原文对照）；认定前这些夜的排程段对账时按「未覆盖」挂起。
          </Alert>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>观测夜</TableCell>
                  <TableCell>站点</TableCell>
                  <TableCell>整夜云量原文</TableCell>
                  <TableCell>认定为</TableCell>
                  <TableCell align="right">操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {reviews.map((review) => (
                  <TableRow key={review.id} hover>
                    <TableCell>{review.date}</TableCell>
                    <TableCell>{review.siteName}</TableCell>
                    <TableCell>
                      <Typography variant="caption">「{review.legacyText || '（空）'}」</Typography>
                    </TableCell>
                    <TableCell>
                      <TextField
                        select
                        size="small"
                        value={reviewCloud[review.id] ?? '晴'}
                        onChange={(event) => setReviewCloud((prev) => ({ ...prev, [review.id]: event.target.value }))}
                        sx={{ minWidth: 120 }}
                      >
                        {CLOUD_TEXTS.map((cloud) => (
                          <MenuItem key={cloud} value={cloud}>
                            {cloud}
                          </MenuItem>
                        ))}
                      </TextField>
                    </TableCell>
                    <TableCell align="right">
                      <Button size="small" variant="contained" onClick={() => void confirmReview(review.id, reviewCloud[review.id] ?? '晴')}>
                        确认回填
                      </Button>
                      <Button size="small" color="inherit" onClick={() => void dismissReview(review.id)}>
                        忽略
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      ) : null}
    </Box>
  );
}

/** 单小时对账结论 */
function hourVerdict(row: HourlyForecast | undefined, sessionCount: number) {
  if (sessionCount === 0) {
    return (
      <Typography variant="caption" color="text.secondary">
        无排程
      </Typography>
    );
  }
  if (isBadCloud(row?.cloud)) {
    return <Chip size="small" color="warning" label={`阴雨（${row?.cloud}）：退回待改期`} />;
  }
  if (!row) {
    return <Chip size="small" color="default" variant="outlined" label="预报未覆盖：挂起等补齐" />;
  }
  return <Chip size="small" color="success" variant="outlined" label="晴好" />;
}
