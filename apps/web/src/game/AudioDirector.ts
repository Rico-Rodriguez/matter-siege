import type { ElementId, SimEvent } from "@matter-siege/shared";

export class AudioDirector {
  private context?: AudioContext;
  private master?: GainNode;
  private muted = false;

  async unlock(): Promise<void> {
    this.context ??= new AudioContext();
    if (!this.master) {
      this.master = this.context.createGain();
      this.master.gain.value = 0.32;
      this.master.connect(this.context.destination);
    }
    await this.context.resume();
  }

  toggle(): boolean {
    this.muted = !this.muted;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.32, this.context.currentTime, 0.02);
    }
    return !this.muted;
  }

  ui(frequency = 520): void {
    this.tone(frequency, 0.035, "sine", 0.045, frequency * 1.12);
  }

  phase(): void {
    this.tone(290, 0.12, "sine", 0.06, 430);
    window.setTimeout(() => this.tone(435, 0.11, "sine", 0.045, 570), 55);
  }

  launch(element: ElementId): void {
    const pitch: Record<ElementId, number> = { fire: 130, water: 180, ice: 330, acid: 105, lightning: 440 };
    this.noise(0.22, 0.1, 800);
    this.tone(pitch[element], 0.28, "sawtooth", 0.09, pitch[element] * 0.45);
  }

  event(event: SimEvent): void {
    if (event.type === "impact") {
      const pitch: Record<ElementId, number> = { fire: 90, water: 155, ice: 370, acid: 115, lightning: 510 };
      this.noise(0.16, Math.min(0.18, event.impulse / 260), event.element === "ice" ? 3100 : 1100);
      this.tone(pitch[event.element], 0.18, event.element === "lightning" ? "square" : "sine", 0.08, pitch[event.element] * 0.58);
    } else if (event.type === "break") {
      this.noise(0.3, 0.17, event.material === "glass" || event.material === "ice" ? 4200 : 850);
      this.tone(event.material === "metal" ? 210 : 72, 0.28, "triangle", 0.075, 42);
    } else if (event.type === "arc") {
      this.tone(720, 0.1, "square", 0.035, 180);
    } else if (event.type === "win") {
      [220, 330, 440, 660].forEach((frequency, index) => window.setTimeout(() => this.tone(frequency, 0.5, "sine", 0.07, frequency * 1.04), index * 130));
    }
  }

  private tone(frequency: number, duration: number, type: OscillatorType, volume: number, endFrequency: number): void {
    if (!this.context || !this.master || this.muted) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), now + duration);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  private noise(duration: number, volume: number, cutoff: number): void {
    if (!this.context || !this.master || this.muted) return;
    const frameCount = Math.floor(this.context.sampleRate * duration);
    const buffer = this.context.createBuffer(1, frameCount, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < frameCount; index += 1) data[index] = Math.random() * 2 - 1;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    filter.type = "lowpass";
    filter.frequency.value = cutoff;
    gain.gain.setValueAtTime(volume, this.context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, this.context.currentTime + duration);
    source.buffer = buffer;
    source.connect(filter).connect(gain).connect(this.master);
    source.start();
  }
}

