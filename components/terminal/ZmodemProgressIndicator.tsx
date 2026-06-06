import { ArrowDownToLine, ArrowUpFromLine, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

interface ZmodemProgressIndicatorProps {
  transferType: 'upload' | 'download' | null;
  filename: string | null;
  transferred: number;
  total: number;
  fileIndex: number;
  fileCount: number;
  finalizing: boolean;
  onCancel: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 0) return '0 B';
  if (bytes < 1) return `${bytes.toFixed(1)} B`;
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  const val = bytes / Math.pow(k, i);
  // Use 1 decimal for KB+, 0 for bytes
  const decimals = i === 0 ? 0 : 1;
  return `${val.toFixed(decimals)} ${sizes[i]}`;
}

function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '--';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export const ZmodemProgressIndicator: React.FC<ZmodemProgressIndicatorProps> = ({
  transferType,
  filename,
  transferred,
  total,
  fileIndex,
  fileCount,
  finalizing,
  onCancel,
}) => {
  const { t } = useI18n();
  const percent = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
  const Icon = transferType === 'upload' ? ArrowUpFromLine : ArrowDownToLine;
  const label = finalizing
    ? t('zmodem.waitingForRemote')
    : transferType === 'upload'
      ? t('zmodem.uploading')
      : t('zmodem.downloading');
  const fileInfo = fileCount > 1 ? ` (${fileIndex + 1}/${fileCount})` : '';

  // Speed calculation via sampled snapshots
  const [speed, setSpeed] = useState(0);
  const lastSampleRef = useRef<{ transferred: number; time: number } | null>(null);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  useEffect(() => {
    const now = Date.now();
    const prev = lastSampleRef.current;
    if (prev && prev.time > 0) {
      const dt = (now - prev.time) / 1000;
      if (dt >= 0.2) {
        const db = transferred - prev.transferred;
        const raw = db / Math.max(dt, 0.05);
        // Smooth: 70% previous, 30% new sample
        const smoothed = prev.transferred === 0 ? raw : speedRef.current * 0.7 + raw * 0.3;
        setSpeed(Math.max(0, smoothed));
        lastSampleRef.current = { transferred, time: now };
        return;
      }
    }
    if (!prev || transferred > (prev.transferred || 0)) {
      lastSampleRef.current = { transferred, time: now };
    }
  }, [transferred]);

  // Reset speed tracking when file changes
  const prevFileRef = useRef(fileIndex);
  useEffect(() => {
    if (fileIndex !== prevFileRef.current) {
      setSpeed(0);
      lastSampleRef.current = null;
      prevFileRef.current = fileIndex;
    }
  }, [fileIndex]);

  // ETA
  const eta = total > 0 && speed > 0 && !finalizing
    ? (total - transferred) / speed
    : 0;

  const progressColor = transferType === 'upload' ? '#3b82f6' : '#22c55e';

  return (
    <div
      className="flex items-center gap-2.5 px-3 py-2 rounded-lg shadow-lg backdrop-blur-sm min-w-[260px] max-w-[380px]"
      style={{
        backgroundColor: 'color-mix(in srgb, var(--terminal-ui-bg, #000000) 90%, transparent)',
        border: '1px solid color-mix(in srgb, var(--terminal-ui-fg, #ffffff) 15%, var(--terminal-ui-bg, #000000))',
        color: 'var(--terminal-ui-fg, #ffffff)',
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Icon className="h-4 w-4 flex-shrink-0 opacity-60" />
      <div className="flex-1 min-w-0">
        {/* Header row: filename + percentage */}
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-xs font-medium truncate">
            {filename || label}{fileInfo}
          </span>
          <span className="text-[11px] font-semibold tabular-nums flex-shrink-0">
            {percent}%
          </span>
        </div>

        {/* Progress bar with shimmer */}
        <div
          className="w-full h-1.5 rounded-full overflow-hidden relative"
          style={{ backgroundColor: 'color-mix(in srgb, var(--terminal-ui-fg, #ffffff) 10%, transparent)' }}
        >
          <div
            className="h-full rounded-full transition-all duration-150 relative overflow-hidden"
            style={{
              width: `${percent}%`,
              backgroundColor: progressColor,
            }}
          >
            {/* Shimmer / gloss effect — outer div applies the skew so the
                inner animation (translateX) doesn't override it. */}
            {!finalizing && percent > 0 && percent < 100 && (
              <div
                className="absolute inset-0 overflow-hidden"
                style={{ transform: 'skewX(-20deg)' }}
              >
                <div
                  className="absolute inset-0"
                  style={{
                    background: `linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.25) 50%, transparent 100%)`,
                    animation: 'shimmer 1.5s ease-in-out infinite',
                    width: '200%',
                    left: '-50%',
                  }}
                />
              </div>
            )}
          </div>
        </div>

        {/* Stats row: speed, ETA, bytes */}
        <div className="flex items-center justify-between text-[10px] opacity-50 mt-1 gap-2">
          <span className="tabular-nums whitespace-nowrap">
            {formatBytes(transferred)} / {formatBytes(total)}
          </span>
          <span className="flex items-center gap-3 flex-shrink-0">
            {!finalizing && speed > 0 && (
              <span className="tabular-nums">{formatSpeed(speed)}</span>
            )}
            {!finalizing && eta > 0 && (
              <span className="tabular-nums">{t('zmodem.eta', { time: formatDuration(eta) })}</span>
            )}
          </span>
        </div>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onCancel}
            className="flex-shrink-0 p-1 rounded transition-colors hover:bg-white/10"
          >
            <X className="h-3.5 w-3.5 opacity-60" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('zmodem.cancelTransfer')}</TooltipContent>
      </Tooltip>
    </div>
  );
};
