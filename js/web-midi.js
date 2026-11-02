/* Browser MIDI input and lossless raw event recording; no microphone/model needed. */
function setupWebMidi() {
  "use strict";
  let access = null,
    port = null,
    timer = null,
    pressed = new Set(),
    latched = new Set(),
    pedal = new Set(),
    recording = false,
    events = [],
    started = 0;
  const keys = () => {
    const a = new Float32Array(128);
    for (const id of new Set([...pressed, ...latched]))
      a[+id.split(":")[1]] = 1;
    return a;
  };
  const observe = (attack = null) => {
    const pitches = keys();
    const names = [
      "C",
      "C♯",
      "D",
      "D♯",
      "E",
      "F",
      "F♯",
      "G",
      "G♯",
      "A",
      "A♯",
      "B",
    ];
    const label = document.getElementById("midi-notes");
    if (label)
      label.textContent =
        Array.from(pitches.keys())
          .filter((i) => pitches[i] > 0)
          .map((i) => names[i % 12] + (Math.floor(i / 12) - 1))
          .join(" ") || "等待琴键";
    window.dispatchEvent(
      new CustomEvent("psf-midi-observation", {
        detail: {
          timeMs: performance.now(),
          pitches,
          attacks: attack || new Float32Array(128),
          isAttack: !!attack,
          active: pitches.some((x) => x > 0),
          exact: true,
          analysisLatencyMs: 0,
        },
      }),
    );
  };
  function message(event) {
    const bytes = Array.from(event.data),
      status = bytes[0] & 240,
      ch = bytes[0] & 15,
      n = bytes[1],
      v = bytes[2],
      id = ch + ":" + n;
    if (recording) {
      if (events.length >= 500000 || performance.now() - started > 3600000) {
        recording = false;
        document.getElementById("midi-record").textContent = "录制 MIDI";
        alert("录制已达到上限，请保存已有数据");
      } else events.push({ time: performance.now() - started, bytes });
    }
    if (status === 144 && v > 0) {
      pressed.add(id);
      latched.delete(id);
      const attack = new Float32Array(128);
      attack[n] = v / 127;
      observe(attack);
    } else if (status === 128 || (status === 144 && v === 0)) {
      pressed.delete(id);
      if (pedal.has(ch)) latched.add(id);
      else latched.delete(id);
      observe();
    } else if (status === 176 && n === 64) {
      if (v >= 64) pedal.add(ch);
      else {
        pedal.delete(ch);
        for (const key of [...latched])
          if (key.startsWith(ch + ":")) latched.delete(key);
      }
      observe();
    } else if (status === 176 && (n === 120 || n === 123)) {
      for (const key of [...pressed, ...latched])
        if (key.startsWith(ch + ":")) {
          pressed.delete(key);
          latched.delete(key);
        }
      observe();
    }
  }
  function connect() {
    const select = document.getElementById("midi-ports"),
      previous = select.value;
    select.replaceChildren();
    for (const input of access.inputs.values()) {
      const option = new Option(input.name || input.id, input.id);
      select.add(option);
    }
    if ([...select.options].some((o) => o.value === previous))
      select.value = previous;
    if (port && port.state === "disconnected") {
      port = null;
      recording = false;
      document.getElementById("midi-record").textContent = "录制 MIDI";
      document.getElementById("midi-record").disabled = true;
      clearInterval(timer);
      pressed.clear();
      latched.clear();
      pedal.clear();
      window.dispatchEvent(new Event("psf-midi-disconnected"));
    }
  }
  async function enable() {
    try {
      if (!navigator.requestMIDIAccess)
        throw Error("当前浏览器不支持 Web MIDI，请使用桌面 Chrome / Edge");
      access = await navigator.requestMIDIAccess({ sysex: false });
      connect();
      access.onstatechange = connect;
      if (!access.inputs.size)
        throw Error("尚未发现 MIDI 输入，请连接键盘后重试");
      const id = document.getElementById("midi-ports").value;
      if (port) port.onmidimessage = null;
      pressed.clear();
      latched.clear();
      pedal.clear();
      port = access.inputs.get(id);
      await port.open();
      port.onmidimessage = message;
      document.getElementById("midi-record").disabled = false;
      window.dispatchEvent(new Event("psf-midi-follow"));
    } catch (e) {
      alert(e.message);
    }
  }
  function download() {
    if (!events.length) {
      alert("没有可导出的录制");
      return;
    }
    const blob = new Blob(
        [
          PianoRecording.encode(events, {
            bpm: Number(document.getElementById("midi-bpm").value) || 120,
          }),
        ],
        {
          type: "audio/midi",
        },
      ),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "钢琴录制.mid";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const root = document.createElement("div");
  root.className = "midi-controls";
  root.innerHTML =
    '<label>录制速度 <input id="midi-bpm" type="number" min="30" max="300" value="120" style="width:64px"> BPM</label><select id="midi-ports" aria-label="MIDI 输入端口"><option>USB MIDI</option></select><button id="midi-connect">连接 MIDI 跟谱</button><button id="midi-record">录制 MIDI</button><button id="midi-save">保存到曲库</button><button id="midi-download">导出 MIDI</button><output id="midi-notes" aria-live="polite">等待琴键</output>';
  document.getElementById("mic-panel-body").prepend(root);
  document.getElementById("midi-connect").onclick = enable;
  document.getElementById("midi-record").disabled = true;
  document.getElementById("midi-record").onclick = () => {
    recording = !recording;
    if (recording) {
      events = [];
      started = performance.now();
    }
    document.getElementById("midi-record").textContent = recording
      ? "停止录制"
      : "录制 MIDI";
  };
  document.getElementById("midi-download").onclick = download;
  document.getElementById("midi-save").onclick = () => {
    if (recording || !events.length) {
      alert("请先完成录制");
      return;
    }
    window.dispatchEvent(
      new CustomEvent("psf-recording-save", {
        detail: PianoRecording.encode(events, {
          bpm: Number(document.getElementById("midi-bpm").value) || 120,
        }),
      }),
    );
  };
  const openRecording = document.createElement("button");
  openRecording.className = "icon-btn";
  openRecording.type = "button";
  openRecording.textContent = "MIDI";
  openRecording.title = "USB MIDI 与录制";
  openRecording.setAttribute("aria-label", "USB MIDI 与录制");
  openRecording.onclick = () => {
    const panel = document.getElementById("mic-panel");
    panel.dataset.open = "true";
    panel.setAttribute("aria-hidden", "false");
  };
  document
    .querySelector("#screen-score .topbar__actions")
    .prepend(openRecording);
  window.addEventListener("psf-microphone-start", () => {
    clearInterval(timer);
    timer = null;
    if (port) port.onmidimessage = null;
    recording = false;
    document.getElementById("midi-record").textContent = "录制 MIDI";
    document.getElementById("midi-record").disabled = true;
  });
  window.addEventListener("psf-midi-follow-ready", () => {
    clearInterval(timer);
    timer = setInterval(() => observe(), 25);
  });
  window.addEventListener("pagehide", () => {
    clearInterval(timer);
    if (port) port.onmidimessage = null;
  });
}
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", setupWebMidi);
else setupWebMidi();
