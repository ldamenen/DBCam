// motionSensor.js
// Thin web adapter for the MotionSensorPort (contracts/ports.d.ts): forwards
// raw accelerometer samples (INCLUDING gravity, m/s^2) to the Core motion
// detector. No thresholds, no rules — decisions live in core/motion.js.
//
// Honest limits:
//   - iOS 13+ requires DeviceMotionEvent.requestPermission(), which only
//     resolves 'granted' when called during a user gesture — main.js calls
//     start() inside the Start-button handler for exactly this reason.
//   - Some devices/browsers fire 'devicemotion' with null acceleration values
//     (no IMU, or sensors blocked); those samples are dropped.

export class MotionSensor {
  constructor() {
    this._handler = null;
  }

  static isSupported() {
    return typeof window !== 'undefined' && 'DeviceMotionEvent' in window;
  }

  /**
   * Subscribe to device motion. Resolves false when unsupported or permission
   * was refused. MUST be called from a user gesture on iOS 13+.
   * @param {(ax:number, ay:number, az:number, tMs:number)=>void} onSample
   * @returns {Promise<boolean>}
   */
  async start(onSample) {
    if (!MotionSensor.isSupported()) return false;
    this.stop();

    // iOS 13+ explicit permission gate; elsewhere the API has no such method.
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      let state = 'denied';
      try { state = await DeviceMotionEvent.requestPermission(); } catch (_e) {}
      if (state !== 'granted') return false;
    }

    this._handler = (e) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return; // no IMU data
      onSample(a.x, a.y, a.z, performance.now());
    };
    window.addEventListener('devicemotion', this._handler);
    return true;
  }

  stop() {
    if (this._handler) {
      window.removeEventListener('devicemotion', this._handler);
      this._handler = null;
    }
  }
}
