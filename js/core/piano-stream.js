/* Same weights, 16 kHz resampling, past window and frame range as Android. */
(function (g) {
  "use strict";
  const f = Math.fround,
    sigmoid = (x) => 1 / (1 + Math.exp(-x));
  class PianoStream {
    constructor(model, rate, tuning = 0) {
      this.model = model;
      this.rate = rate;
      this.step = (rate / 16000) * Math.pow(2, -tuning / 1200);
      this.clockRate = 16000 * Math.pow(2, tuning / 1200);
      this.sourceIndex = -1;
      this.next = 0;
      this.previousSample = 0;
      this.window = new Float32Array(17920);
      this.block = new Float32Array(2048);
      this.filled = 0;
      this.samples = 0;
      this.previousOnset = new Float32Array(88);
    }
    accept(pcm) {
      const frames = [];
      for (const x of pcm) {
        this.sourceIndex++;
        while (this.next <= this.sourceIndex) {
          const fraction = f(this.next - Math.max(0, this.sourceIndex - 1)),
            sample =
              this.sourceIndex === 0
                ? x
                : f(
                    this.previousSample +
                      f(f(x - this.previousSample) * fraction),
                  );
          this.next += this.step;
          this.block[this.filled++] = sample;
          if (this.filled < 2048) continue;
          this.filled = 0;
          this.samples += 2048;
          this.window.copyWithin(0, 2048);
          this.window.set(this.block, 17920 - 2048);
          const input = tf.tensor1d(this.window);
          let output;
          try {
            output = this.model.predict(input);
            const tensors = Array.isArray(output)
                ? output
                : Object.values(output),
              values = tensors.map((t) => t.dataSync());
            const sounding = values[0],
              onset = values[1],
              velocity = values[3];
            for (let frame = 26; frame < 30; frame++) {
              const at = this.samples - 17920 + frame * 512;
              if (at < 0) continue;
              const pitches = new Float32Array(128),
                attacks = new Float32Array(128),
                velocities = new Float32Array(128);
              for (let n = 0; n < 88; n++) {
                let i = frame * 88 + n;
                pitches[n + 21] = sigmoid(sounding[i]);
                if (onset[i] > 0 && this.previousOnset[n] <= 0)
                  attacks[n + 21] = sigmoid(onset[i]);
                velocities[n + 21] = Math.max(0, Math.min(1, velocity[i]));
                this.previousOnset[n] = onset[i];
              }
              frames.push({
                onsetTimeMs: Math.trunc((at * 1000) / this.clockRate),
                availableTimeMs: Math.trunc(
                  (this.samples * 1000) / this.clockRate,
                ),
                pitches,
                attacks,
                velocities,
              });
            }
          } finally {
            input.dispose();
            if (output)
              (Array.isArray(output) ? output : Object.values(output)).forEach(
                (t) => t.dispose(),
              );
          }
        }
        this.previousSample = x;
      }
      return frames;
    }
  }
  g.ScoreFollowCore.PianoStream = PianoStream;
})(globalThis);
