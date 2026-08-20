/**
 * Notification sound.
 *
 * Synthesized with the Web Audio API rather than shipping an audio file: no
 * asset to serve, nothing to 404, and it plays while the tab is in the
 * background (browsers throttle timers there, not audio).
 *
 * Browsers refuse to start audio until the user has interacted with the page,
 * so an AudioContext created on load lands in "suspended" state. We install a
 * one-shot gesture listener that resumes it — logging in is a click, so by the
 * time messages arrive the context is live.
 */

const PREF_KEY = "aram.notificationSound";

let ctx: AudioContext | null = null;
let unlockBound = false;

type AudioCtor = typeof AudioContext;

function audioCtor(): AudioCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = audioCtor();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

/** Resume the audio context on the first user gesture. Safe to call repeatedly. */
export function armNotificationSound(): void {
  if (unlockBound || typeof window === "undefined") return;
  unlockBound = true;
  const resume = () => {
    const c = context();
    if (c && c.state === "suspended") void c.resume();
  };
  window.addEventListener("pointerdown", resume, { once: true, passive: true });
  window.addEventListener("keydown", resume, { once: true });
}

export function isNotificationSoundOn(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(PREF_KEY) !== "off";
}

export function setNotificationSoundOn(on: boolean): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PREF_KEY, on ? "on" : "off");
}

/** A soft two-note chime. Never throws — a missing/blocked audio device must
 *  not break the notification path that calls this. */
export function playNotificationChime(): void {
  if (!isNotificationSoundOn()) return;
  const c = context();
  if (!c) return;
  // A gesture may not have happened yet (or the tab was restored); asking for
  // a resume here is harmless when it's already running.
  if (c.state === "suspended") void c.resume();
  try {
    const master = c.createGain();
    master.gain.value = 0.16;
    master.connect(c.destination);

    // Two rising notes — E6 then A6 — 90ms each, second offset by 110ms.
    const notes: Array<{ freq: number; at: number }> = [
      { freq: 1318.5, at: 0 },
      { freq: 1760, at: 0.11 },
    ];
    for (const { freq, at } of notes) {
      const start = c.currentTime + at;
      const osc = c.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      // Per-note envelope: quick attack, exponential tail, so it reads as a
      // chime instead of a click or a beep.
      const env = c.createGain();
      env.gain.setValueAtTime(0.0001, start);
      env.gain.exponentialRampToValueAtTime(1, start + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
      osc.connect(env);
      env.connect(master);
      osc.start(start);
      osc.stop(start + 0.3);
    }
  } catch {
    // Audio unavailable — notifications still show, just silently.
  }
}
