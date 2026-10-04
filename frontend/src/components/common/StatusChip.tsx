import Chip from '@mui/material/Chip';
import { STATUS_CHIP_COLOR, type SessionStatus } from '../../types';

export interface StatusChipProps {
  status: SessionStatus;
  size?: 'small' | 'medium';
}

/** 排程段状态徽标（6 种状态配色；待执行 / 挂起待补用描边表示未落定） */
export default function StatusChip({ status, size = 'small' }: StatusChipProps) {
  const outlined = status === '待执行' || status === '挂起待补';
  return <Chip label={status} color={STATUS_CHIP_COLOR[status]} size={size} variant={outlined ? 'outlined' : 'filled'} />;
}
