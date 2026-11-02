/* Raw timing at PPQ 480 / 120 BPM. Velocity, channel and pedal are retained. */
(function (g) {
  function variable(n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xfffffff)
      throw Error("MIDI duration out of range");
    const a = [n & 127];
    while ((n >>= 7) > 0) a.unshift((n & 127) | 128);
    return a;
  }
  function encode(events, options = {}) {
    const bpm = Math.max(30, Math.min(300, Number(options.bpm) || 120));
    const micros = Math.round(60000000 / bpm);
    const track = [
      0,
      255,
      81,
      3,
      (micros >>> 16) & 255,
      (micros >>> 8) & 255,
      micros & 255,
      0,
      255,
      88,
      4,
      4,
      2,
      24,
      8,
      0,
      255,
      89,
      2,
      0,
      0,
    ];
    let previous = 0;
    for (const e of events) {
      const bytes = e.bytes;
      if (!bytes.length || bytes[0] < 128 || bytes[0] >= 240) continue;
      const tick = Math.round((e.time * 480000) / micros);
      track.push(...variable(Math.max(0, tick - previous)), ...bytes);
      previous = tick;
    }
    track.push(0, 255, 47, 0);
    const head = [
        77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, 1, 224, 77, 84, 114, 107,
      ],
      n = track.length;
    head.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    const result = new Uint8Array(head.length + track.length);
    result.set(head);
    result.set(track, head.length);
    return result;
  }
  g.PianoRecording = { encode };
  if (typeof module !== "undefined") module.exports = g.PianoRecording;
})(globalThis);
