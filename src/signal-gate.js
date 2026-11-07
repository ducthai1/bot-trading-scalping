// Kỷ luật "1 kèo 1 lúc": sau khi phát 1 tín hiệu, khoá mọi tín hiệu mới (mọi khung, mọi chiều)
// trong cooldownMin phút — tránh 3m và 5m cùng bắn cho 1 nhịp giá, và tránh vào lại ngay sau khi dính SL.
export class SignalGate {
  constructor(cfg) {
    this.ms = (cfg.cooldownMin || 0) * 60e3;
    this.last = -Infinity;
  }

  // Returns remaining cooldown in ms (0 = allowed). Records the signal when allowed.
  check(now = Date.now()) {
    const left = this.last + this.ms - now;
    if (left > 0) return left;
    this.last = now;
    return 0;
  }

  allow(signal, now = Date.now()) {
    return this.check(now) === 0;
  }
}
