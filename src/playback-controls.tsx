import { useEffect, useState, type RefObject } from 'react';
import { Play, Pause, RotateCcw } from 'lucide-react';
import type { AssetViewer } from './viewer.ts';

export function PlaybackControls({
  viewer,
  ready,
}: {
  viewer: RefObject<AssetViewer | null>;
  ready: boolean;
}) {
  const [, refresh] = useState(0),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => refresh((n) => n + 1), 200);
    return () => clearInterval(timer);
  }, []);
  const v = viewer.current,
    p = v?.playback;
  if (!ready || !v || !p || (!v.clips.length && !v.behavior?.presets.length)) return null;
  const selected = p.preset
    ? 'preset:' + p.preset.id
    : p.clip === undefined
      ? ''
      : 'clip:' + p.clip;
  return (
    <div className="playback-controls">
      <label>
        動作
        <select
          aria-label="動作"
          value={selected}
          disabled={busy}
          onChange={async (e) => {
            setError('');
            setBusy(true);
            try {
              const value = e.target.value;
              await v.selectPreset(
                value.startsWith('preset:')
                  ? v.behavior?.presets.find((x) => x.id === value.slice(7))
                  : undefined,
                value.startsWith('clip:') ? Number(value.slice(5)) : undefined,
              );
              refresh((n) => n + 1);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="">基準姿勢</option>
          {!!v.behavior?.presets.length && (
            <optgroup label="動作プリセット">
              {v.behavior.presets.map((p) => (
                <option key={p.id} value={'preset:' + p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
          {!!v.clips.length && (
            <optgroup label="埋め込みクリップ">
              {v.clips.map((c, i) => (
                <option key={i} value={'clip:' + i}>
                  {c.name || `Clip ${i + 1}`}（{c.duration.toFixed(2)}秒）
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <div className="playback-row">
        <button
          aria-label={p.playing ? '動作を一時停止' : '動作を再生'}
          disabled={!selected || busy}
          onClick={() => {
            p.playing = !p.playing;
            refresh((n) => n + 1);
          }}
        >
          {p.playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button
          aria-label="先頭に戻す"
          disabled={!selected || busy}
          onClick={() => {
            p.seek(0);
            refresh((n) => n + 1);
          }}
        >
          <RotateCcw size={15} />
        </button>
        <input
          aria-label="再生位置"
          type="range"
          min={0}
          max={p.duration}
          step={0.001}
          value={p.time}
          disabled={!selected || busy}
          onChange={(e) => {
            p.playing = false;
            p.seek(Number(e.target.value));
            refresh((n) => n + 1);
          }}
        />
        <output aria-label="再生時刻">
          {p.time.toFixed(2)} / {p.duration.toFixed(2)}s
        </output>
      </div>
      <div className="playback-row">
        <label>
          速度{' '}
          <input
            aria-label="再生速度"
            type="number"
            min={0}
            max={20}
            step={0.1}
            value={p.speed}
            onChange={(e) => {
              const speed = Number(e.target.value);
              if (Number.isFinite(speed)) p.speed = Math.max(0, Math.min(20, speed));
              refresh((n) => n + 1);
            }}
          />{' '}
          ×
        </label>
        <label>
          <input
            type="checkbox"
            checked={p.loop}
            onChange={(e) => {
              p.loop = e.target.checked;
              refresh((n) => n + 1);
            }}
          />
          ループ
        </label>
        <button disabled={!selected || busy} onClick={() => v.fitMotion()}>
          動作全体を表示
        </button>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
