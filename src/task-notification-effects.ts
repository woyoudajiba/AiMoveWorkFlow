import type { TaskNotification } from './task-notification-types';

type SoundCategory = TaskNotification['category'];

const patterns: Record<SoundCategory, Array<{ frequency: number; duration: number; gap?: number; type?: OscillatorType }>> = {
  failure: [
    { frequency: 180, duration: 0.16, type: 'sawtooth' },
    { frequency: 120, duration: 0.24, gap: 0.04, type: 'sawtooth' },
  ],
  stuck: [
    { frequency: 430, duration: 0.14, type: 'triangle' },
    { frequency: 300, duration: 0.14, gap: 0.05, type: 'triangle' },
    { frequency: 430, duration: 0.14, gap: 0.05, type: 'triangle' },
  ],
  completed: [
    { frequency: 523.25, duration: 0.12, type: 'sine' },
    { frequency: 659.25, duration: 0.12, gap: 0.04, type: 'sine' },
    { frequency: 783.99, duration: 0.22, gap: 0.04, type: 'sine' },
  ],
};

let audioContext: AudioContext | null = null;
let permissionRequested = false;
let audioUnlockInstalled = false;

function context() {
  if (typeof window === 'undefined') return null;
  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return null;
  audioContext ||= new AudioContextCtor();
  return audioContext;
}

function unlockAudio() {
  const audio = context();
  if (!audio) return;
  void audio.resume().catch(() => undefined);
}

function installAudioUnlock() {
  if (typeof window === 'undefined' || audioUnlockInstalled) return;
  audioUnlockInstalled = true;
  const handler = () => {
    unlockAudio();
    window.removeEventListener('pointerdown', handler);
    window.removeEventListener('keydown', handler);
    window.removeEventListener('touchstart', handler);
  };
  window.addEventListener('pointerdown', handler, { once: true, passive: true });
  window.addEventListener('keydown', handler, { once: true });
  window.addEventListener('touchstart', handler, { once: true, passive: true });
}

installAudioUnlock();

export function playTaskNotificationSound(category: SoundCategory) {
  installAudioUnlock();
  const audio = context();
  if (!audio) return;
  void audio.resume().catch(() => undefined);
  const start = audio.currentTime + 0.01;
  let offset = 0;
  for (const tone of patterns[category]) {
    offset += tone.gap || 0;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = tone.type || 'sine';
    oscillator.frequency.setValueAtTime(tone.frequency, start + offset);
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.08, start + offset + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + tone.duration);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + tone.duration + 0.02);
    offset += tone.duration;
  }
}

async function browserNotification(event: TaskNotification) {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission === 'default' && !permissionRequested) {
    permissionRequested = true;
    await Notification.requestPermission().catch(() => 'denied');
  }
  if (Notification.permission === 'granted') {
    new Notification(event.title, { body: event.body, tag: event.key });
  }
}

export async function sendTaskNotification(event: TaskNotification) {
  playTaskNotificationSound(event.category);
  const desktop = typeof window !== 'undefined' ? window.aiframeDesktop : undefined;
  if (desktop?.showNotification) {
    await desktop.showNotification({ title: event.title, body: event.body, tag: event.key }).catch(() => undefined);
    return;
  }
  await browserNotification(event);
}
