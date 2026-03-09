import { Pane } from 'tweakpane';

export interface Params {
  // Rewind
  mouthOpenThreshold: number;
  rewindInterval: number;
  rewindAmount: number;
  rewindDelay: number;

  // Playback
  playbackRate: number;

  // Loop
  loopStart: number;
  loopEnd: number;
  loopEnabled: boolean;

  // Display
  showWebcam: boolean;
  webcamSize: number;
  showMouthMeter: boolean;
  detectionEnabled: boolean;

  // Monitor (read-only)
  jawOpenValue: number;
  currentState: string;
}

export const params: Params = {
  mouthOpenThreshold: 0.3,
  rewindInterval: 500,
  rewindAmount: 1.0,
  rewindDelay: 250,
  playbackRate: 1.0,
  loopStart: -1,
  loopEnd: -1,
  loopEnabled: false,
  showWebcam: true,
  webcamSize: 160,
  showMouthMeter: true,
  detectionEnabled: true,
  jawOpenValue: 0,
  currentState: 'idle',
};

let pane: Pane | null = null;

function formatTime(s: number): string {
  if (s < 0) return '--:--';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function setupControls(): Pane {
  pane = new Pane({ title: 'Settings', expanded: true });

  // ── Rewind ──
  const rewind = pane.addFolder({ title: 'Rewind' });
  rewind.addBinding(params, 'mouthOpenThreshold', {
    min: 0.05, max: 0.8, step: 0.01, label: 'Mouth Threshold',
  });
  rewind.addBinding(params, 'rewindAmount', {
    min: 0.25, max: 5.0, step: 0.25, label: 'Rewind (sec)',
  });
  rewind.addBinding(params, 'rewindInterval', {
    min: 100, max: 2000, step: 50, label: 'Interval (ms)',
  });
  rewind.addBinding(params, 'rewindDelay', {
    min: 0, max: 1000, step: 50, label: 'Delay (ms)',
  });

  // ── Playback ──
  const playback = pane.addFolder({ title: 'Playback' });
  playback.addBinding(params, 'playbackRate', {
    min: 0.25, max: 2.0, step: 0.05, label: 'Speed',
  });

  // ── Loop ──
  const loop = pane.addFolder({ title: 'Loop (I/O/L/Esc)' });
  loop.addBinding(params, 'loopEnabled', { label: 'Enabled' });
  loop.addBinding(params, 'loopStart', {
    readonly: true, label: 'Start',
    format: formatTime,
  });
  loop.addBinding(params, 'loopEnd', {
    readonly: true, label: 'End',
    format: formatTime,
  });

  // ── Display ──
  const display = pane.addFolder({ title: 'Display' });
  display.addBinding(params, 'showWebcam', { label: 'Show Webcam' });
  display.addBinding(params, 'webcamSize', {
    min: 80, max: 400, step: 10, label: 'Webcam Size',
  });
  display.addBinding(params, 'showMouthMeter', { label: 'Mouth Meter' });
  display.addBinding(params, 'detectionEnabled', { label: 'Detection On' });

  // ── Monitor ──
  const monitor = pane.addFolder({ title: 'Monitor' });
  monitor.addBinding(params, 'jawOpenValue', {
    readonly: true, label: 'Jaw Open',
    format: (v: number) => v.toFixed(3),
  });
  monitor.addBinding(params, 'currentState', {
    readonly: true, label: 'State',
  });

  return pane;
}

export function toggleControls(): void {
  if (!pane) return;
  const el = pane.element;
  el.style.display = el.style.display === 'none' ? '' : 'none';
}
