// contracts/ports.d.ts — the SOURCE OF TRUTH for platform ports (ARCHITECTURE §4, Phase B).
//
// Every client (web, iOS, Android) implements these interfaces as thin adapters.
// Adapters hold NO decisions: no thresholds, no rules, no policy — those live in
// core/. TypeScript syntax is used as a precise, language-neutral IDL; the iOS and
// Android adapters mirror these shapes in Swift/Kotlin (bridged through the
// embedded Core), and conformance is enforced by the shared golden fixtures
// (core/fixtures/ + each platform's runner), not by a compiler.
//
// Time convention: all timestamps are PLATFORM-MONOTONIC milliseconds
// (performance.now() on web, CACurrentMediaTime()*1000 on iOS, elapsedRealtime()
// on Android). Never wall-clock inside the pipeline.

// ---------- geometry & detections ----------

/** Axis-aligned box in SOURCE-FRAME pixel coordinates. */
export interface Box { x: number; y: number; w: number; h: number }

export interface FaceDetection extends Box { score: number }
export interface AnimalDetection extends Box { score: number; label: string }

/** Face result. `ok` distinguishes "detector ran, saw nothing" (healthy) from
 *  "detector stalled/errored" — the Core's fail-safe over-blur keys off `ok`. */
export interface FaceResult { boxes: FaceDetection[]; maxScore: number; ok: boolean }

// ---------- capture ----------

export interface CameraInfo { width: number; height: number; hasAudio: boolean; frameRate: number | null }

/** Single camera source — opened ONCE per session (spec §4). */
export interface CameraSource {
  start(audioAllowed: boolean): Promise<CameraInfo>;
  stop(): void;
  /** Platform-opaque frame handle consumed by detectors/blur/recorders. */
  readonly frameSource: unknown;
  readonly audioTrack: unknown | null;
}

// ---------- detection ----------

export interface FaceDetectorPort {
  init(): Promise<void>;
  detect(frame: unknown, tMs: number): FaceResult;
  close(): void;
}

export interface AnimalDetectorPort {
  init(): Promise<void>;
  /** Returns only classes listed in CONFIG.animals.classes, above min confidence. */
  detect(frame: unknown, tMs: number): AnimalDetection[];
  close(): void;
}

// ---------- render & record ----------

export interface BlurRenderer {
  resize(w: number, h: number): void;
  /** Draw frame with face regions obscured per Core config; returns what happened. */
  render(frame: unknown, faces: FaceResult, tMs: number): { overBlurred: boolean; blurredCount: number };
  reset(): void;
}

export interface RecordingResult { /* platform media handle */ mimeType: string }

/** Two instances per session: blurred default + raw sealed (when policy allows). */
export interface VideoRecorder {
  start(audioTrack: unknown | null): void;
  stop(): Promise<RecordingResult | null>;
  readonly isRecording: boolean;
}

// ---------- audio & triggers ----------

/** Aggressive-sound proxy feeding the Core threat scorer (0..1). */
export interface AudioLevelMonitor {
  start(audioTrack: unknown | null): boolean;
  getLevel(tMs: number): number;
  /** Suppress self-triggering right after the deterrent blasts. */
  notifyDeterrent(tMs: number): void;
  stop(): void;
}

export interface SpeechTrigger {
  /** Resolves capability at runtime; web is NOT selfContained (vendor servers). */
  start(word: string, handlers: { onTrigger(): void; onStatus(s: string): void }): boolean;
  stop(): void;
}

/** Accelerometer feed for the Core motion detector (units: m/s^2 incl. gravity). */
export interface MotionSensorPort {
  start(onSample: (ax: number, ay: number, az: number, tMs: number) => void): Promise<boolean>;
  stop(): void;
}

export interface DeterrentSpeaker {
  /** Play the alarm burst per Core config. Cooldown DECISION lives in core
   *  DeterrentPolicy — the speaker only makes noise. */
  play(tMs: number): boolean;
}

// ---------- storage, integrity, lifecycle ----------

/** Hash primitive injected into the Core audit chain. MUST be SHA-256 over UTF-8,
 *  lowercase hex, so chains are byte-identical across platforms (fixture-tested). */
export type HashFn = (utf8: string) => Promise<string>;

/** Session persistence. Web: IndexedDB (declared secureSealing:false). Native:
 *  encrypted files + Keystore/Secure Enclave keys. Record shape is defined by the
 *  Core; segments are ALWAYS persisted sealed (unlock state never survives). */
export interface SecureStore {
  saveSession(record: unknown): Promise<unknown>;
  listSessions(): Promise<unknown[]>;
  getSession(id: unknown): Promise<unknown | null>;
  deleteSession(id: unknown): Promise<void>;
  purgeOlderThan(ms: number): Promise<number>;
}

export interface KeepAwake { acquire(): Promise<boolean>; release(): Promise<void>; readonly held: boolean }

// ---------- capabilities ----------

/** Reported by each adapter at startup; merged by core/capabilities.buildManifest.
 *  selfContained=false means the feature calls out to external servers and must be
 *  surfaced to the user (ARCHITECTURE §0). */
export interface CapabilityReport {
  supported: boolean;
  selfContained?: boolean;
  reason?: string;
}
export type CapabilityManifest = Record<string, Readonly<CapabilityReport>>;
