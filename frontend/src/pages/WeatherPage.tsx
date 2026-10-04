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
import { usePersistentStore } from '../hooks/usePersistentStore';
import { useWeatherStore } from '../stores/weatherStore';
import { useNightStore } from '../stores/nightStore';
import { useSessionStore } from '../stores/sessionStore';
import { CONDITION_COLOR, NIGHT_HOURS, WEATHER_CONDITIONS, type WeatherCondition } from '../types';
import { hourToAxis } from '../utils/weather';
import { minutesToTime } from '../utils/astro';

const SOURCE_LABEL: Record<string, string> = { fetch: '气象拉取', legacy: '旧文回填', manual: '人工补录' };
const SOURCE_COLOR: Record<string, 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'info'> = {
  fetch: 'primary',
  legacy: 'default',
  manual: 'secondary',
};

/** 气象预报：按小时 + 站点存储，按小时对账，失败只重试气象侧 */
export default function WeatherPage() {
  usePersistentStore();
  const nights = useNightStore((s) => s.nights);
  const currentNightId = useNightStore((s) => s.currentNightId);
  const forecasts = useWeatherStore((s) => s.forecasts);
  const batches = useWeatherStore((s) => s.batches);
  const reviews = useWeatherStore((s) => s.reviews);
  const fetchForecast = useWeatherStore((s) => s.fetchForecast);
  const retryFetch = useWeatherStore((s) => s.retryFetch);
  const reconcileNight = useWeatherStore((s) => s.reconcileNight);
  const setManualForecast = useWeatherStore((s) => s.setManualForecast);
  const resolveReview = useWeatherStore((s) => s.resolveReview);
  const sessions = useSessionStore((s) => s.sessions);

  const [nightId, setNightId] = useState(currentNightId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reconcileInfo, setReconcileInfo] = useState('');

  const night = nights.find((item) => item.id === nightId);
  const siteName = night?.siteName ?? '';

  const nightForecasts = useMemo(
    () =>
      NIGHT_HOURS.map((hour) => ({
        hour,
        forecast: forecasts.find((item) => item.nightId === nightId && item.siteName === siteName && item.hour === hour),
      })),
    [forecasts, nightId, siteName],
  );
  const nightBatches = useMemo(
    () =>
      batches
        .filter((item) => item.nightId === nightId && item.siteName === siteName)
        .sort((a, b) => (b.fetchedAt ?? '').localeCompare(a.fetchedAt ?? '')),
    [batches, nightId, siteName],
  );
  const nightReviews = useMemo(
    () => reviews.filter((item) => item.nightId === nightId && !item.resolved),
    [reviews, nightId],
  );
  const nightSessions = useMemo(() => sessions.filter((item) => item.nightId === nightId), [sessions, nightId]);

  const coveredCount = nightForecasts.filter((item) => item.forecast).length;

  async function handleFetch() {
    if (!night) return;
    setBusy(true);
    setError('');
    setNotice('');
    setReconcileInfo('');
    try {
      const batch = await fetchForecast(night.id, night.siteName);
      if (batch.status === 'success') {
        setNotice(`气象预报拉取成功，已按 ${NIGHT_HOURS.length} 个小时（${night.siteName}）分开存储`);
      } else {
        setError(`气象拉取失败：${batch.error}。可点击「重试气象拉取」——只重试气象这侧，编排台已改的段不受影响。`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRetry(batchId: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const batch = await retryFetch(batchId);
      if (batch.status === 'success') {
        setNotice('气象重试成功，已更新分时预报');
      } else {
        setError(`气象重试仍失败：${batch.error}。可再次重试（仅气象侧）。`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleReconcile() {
    if (!night) return;
    setBusy(true);
    setError('');
    setNotice('');
    setReconcileInfo('');
    try {
      const result = await reconcileNight(night.id);
      setReconcileInfo(
        `对账完成：挂起等补齐 ${result.suspended.length} 段；阴雨退回待改期 ${result.returned.length} 段（已顺延到晴好钟点 ${result.placed.length} 段，待人工改期 ${result.unplaced.length} 段）；晴好待执行 ${result.ready.length} 段。`,
      );
    } catch (e) {
      setError(`对账失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function cycleCondition(hour: number, current: WeatherCondition | undefined) {
    if (!night) return;
    const idx = current ? WEATHER_CONDITIONS.indexOf(current) : -1;
    const next = WEATHER_CONDITIONS[(idx + 1) % WEATHER_CONDITIONS.length];
    await setManualForecast(night.id, night.siteName, hour, next);
  }

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        气象预报（按小时与站点）
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        气象预报按小时 + 站点分开存储；编排台按小时对账：阴雨小时仍排着段就退回待改期，预报没覆盖的时段先挂起等补齐，
        晴好时段容量有限、排不下的排队顺延到后一个晴好钟点，不顶掉已确认的段。拉取失败只重试气象这侧，编排台改好的段照旧。
      </Typography>

      {notice ? (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      ) : null}
      {error ? (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      ) : null}
      {reconcileInfo ? (
        <Alert severity="info" sx={{ mb: 2 }} onClose={() => setReconcileInfo('')}>
          <AlertTitle>对账结果</AlertTitle>
          {reconcileInfo}
        </Alert>
      ) : null}

      <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap' }} alignItems="center">
        <TextField select size="small" label="观测夜" value={nightId} onChange={(event) => setNightId(event.target.value)} sx={{ minWidth: 260 }}>
          {nights.map((item) => (
            <MenuItem key={item.id} value={item.id}>
              {`${item.date} · ${item.siteName}${item.primary ? '（主夜）' : item.backup ? '（备用夜）' : ''}`}
            </MenuItem>
          ))}
        </TextField>
        <Chip size="small" label={`站点 ${siteName || '-'}`} />
        <Chip size="small" variant="outlined" label={`已覆盖 ${coveredCount} / ${NIGHT_HOURS.length} 小时`} />
        <Chip size="small" variant="outlined" label={`本夜排程段 ${nightSessions.length}`} />
        <Button variant="contained" onClick={() => void handleFetch()} disabled={busy || !night}>
          拉取气象预报
        </Button>
        <Button variant="outlined" color="primary" onClick={() => void handleReconcile()} disabled={busy || !night}>
          按小时对账
        </Button>
      </Stack>

      {/* 分时预报条带 */}
      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          分时预报（点击格子可循环切换天气，人工补录）
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 0.5 }}>
          {nightForecasts.map(({ hour, forecast }) => {
            const condition = forecast?.condition;
            return (
              <Box
                key={hour}
                onClick={() => void cycleCondition(hour, condition)}
                sx={{
                  cursor: 'pointer',
                  borderRadius: 1,
                  p: 0.75,
                  textAlign: 'center',
                  bgcolor: condition ? CONDITION_COLOR[condition] : 'action.disabledBackground',
                  color: condition ? '#1c2333' : 'text.disabled',
                  border: '1px solid',
                  borderColor: 'divider',
                  minHeight: 64,
                }}
                title={`${hour}:00${condition ? ` · ${condition}` : ' · 未覆盖'}（点击切换）`}
              >
                <Typography variant="caption" sx={{ display: 'block', fontWeight: 600 }}>
                  {hour}时
                </Typography>
                <Typography variant="caption" sx={{ display: 'block' }}>
                  {condition ?? '未覆盖'}
                </Typography>
                {forecast ? (
                  <Chip
                    size="small"
                    label={SOURCE_LABEL[forecast.source]}
                    color={SOURCE_COLOR[forecast.source]}
                    sx={{ height: 16, fontSize: 10, mt: 0.25 }}
                  />
                ) : null}
              </Box>
            );
          })}
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          时间轴 {minutesToTime(hourToAxis(NIGHT_HOURS[0]))} → {minutesToTime(hourToAxis(NIGHT_HOURS[NIGHT_HOURS.length - 1]) + 60)}
          ；阴雨（阴 / 有雨）小时在对账时触发退回待改期。
        </Typography>
      </Paper>

      {/* 拉取批次 */}
      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          气象拉取批次（失败只重试气象这侧）
        </Typography>
        {nightBatches.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            暂无拉取批次，点击「拉取气象预报」开始。
          </Typography>
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>批次</TableCell>
                  <TableCell>状态</TableCell>
                  <TableCell>重试次数</TableCell>
                  <TableCell>时间</TableCell>
                  <TableCell>失败原因</TableCell>
                  <TableCell align="right">操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {nightBatches.map((batch) => (
                  <TableRow key={batch.id}>
                    <TableCell>{batch.id}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={batch.status === 'success' ? '成功' : batch.status === 'failed' ? '失败' : '拉取中'}
                        color={batch.status === 'success' ? 'success' : batch.status === 'failed' ? 'error' : 'default'}
                      />
                    </TableCell>
                    <TableCell>{batch.retries}</TableCell>
                    <TableCell>{batch.fetchedAt ? new Date(batch.fetchedAt).toLocaleString('zh-CN') : '-'}</TableCell>
                    <TableCell>
                      <Typography variant="caption" color="error">
                        {batch.error ?? '-'}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      {batch.status === 'failed' ? (
                        <Button size="small" color="warning" onClick={() => void handleRetry(batch.id)} disabled={busy}>
                          重试气象拉取
                        </Button>
                      ) : (
                        '-'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      {/* 旧整夜文字待人工确认 */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          旧整夜云量文字待人工确认（拆不出小时）
        </Typography>
        {nightReviews.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            本夜旧云量文字均可拆到小时，已回填分时预报并留原文对照。
          </Typography>
        ) : (
          <Stack spacing={1}>
            {nightReviews.map((review) => (
              <Alert
                key={review.id}
                severity="warning"
                action={
                  <Button size="small" color="inherit" onClick={() => void resolveReview(review.id)}>
                    已人工处理
                  </Button>
                }
              >
                <AlertTitle>观测夜 {review.nightId}</AlertTitle>
                原始文字：<strong>「{review.cloudText}」</strong>
                <br />
                原因：{review.reason}
              </Alert>
            ))}
          </Stack>
        )}
      </Paper>
    </Box>
  );
}
