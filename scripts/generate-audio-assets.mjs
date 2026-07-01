import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const outputDir = path.resolve("public/assets/audio");
const sampleRate = 22050;
const channels = 2;

fs.mkdirSync(outputDir, { recursive: true });

function createRng(seed) {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return ((value >>> 0) / 4294967296);
  };
}

function midiToFrequency(midi) {
  return 440 * (2 ** ((midi - 69) / 12));
}

function createBuffer(seconds) {
  const length = Math.floor(seconds * sampleRate);
  return [new Float32Array(length), new Float32Array(length)];
}

function envelope(position, total, attack = 0.08, release = 0.2) {
  const attackSamples = Math.max(1, attack * sampleRate);
  const releaseSamples = Math.max(1, release * sampleRate);
  if (position < attackSamples) return position / attackSamples;
  if (position > total - releaseSamples) return Math.max(0, (total - position) / releaseSamples);
  return 1;
}

function addSample(buffer, index, value, pan = 0) {
  if (index < 0 || index >= buffer[0].length) return;
  const left = Math.cos((pan + 1) * Math.PI * 0.25);
  const right = Math.sin((pan + 1) * Math.PI * 0.25);
  buffer[0][index] += value * left;
  buffer[1][index] += value * right;
}

function waveValue(type, phase) {
  if (type === "triangle") return (2 / Math.PI) * Math.asin(Math.sin(phase));
  if (type === "soft-square") return Math.tanh(Math.sin(phase) * 2.2);
  return Math.sin(phase);
}

function addTone(buffer, startSeconds, durationSeconds, frequency, gain, options = {}) {
  const start = Math.floor(startSeconds * sampleRate);
  const total = Math.floor(durationSeconds * sampleRate);
  const pan = options.pan ?? 0;
  const wave = options.wave ?? "sine";
  const detune = options.detune ?? 0;
  const vibratoDepth = options.vibratoDepth ?? 0;
  const vibratoRate = options.vibratoRate ?? 5.2;
  const attack = options.attack ?? 0.08;
  const release = options.release ?? 0.2;
  let phase = options.phase ?? 0;
  const detuned = frequency * (2 ** (detune / 1200));

  for (let i = 0; i < total; i += 1) {
    const time = i / sampleRate;
    const vibrato = 1 + Math.sin(time * Math.PI * 2 * vibratoRate) * vibratoDepth;
    phase += (Math.PI * 2 * detuned * vibrato) / sampleRate;
    const body = waveValue(wave, phase);
    const harmonic = Math.sin(phase * 2.01) * (options.harmonic ?? 0);
    const value = (body + harmonic) * gain * envelope(i, total, attack, release);
    addSample(buffer, start + i, value, pan);
  }
}

function addPadChord(buffer, start, duration, chord, gain, options = {}) {
  chord.forEach((midi, index) => {
    const pan = ((index / Math.max(1, chord.length - 1)) - 0.5) * 0.9;
    addTone(buffer, start + index * 0.03, duration + index * 0.18, midiToFrequency(midi), gain / (1.1 + index * 0.18), {
      attack: options.attack ?? 1.2,
      release: options.release ?? 1.8,
      detune: (index - 1.5) * 3,
      harmonic: 0.18,
      pan,
      vibratoDepth: 0.0015,
      wave: index % 2 ? "triangle" : "sine",
    });
  });
}

function addPluck(buffer, start, midi, gain, options = {}) {
  addTone(buffer, start, options.duration ?? 2.1, midiToFrequency(midi), gain, {
    attack: 0.012,
    release: options.release ?? 1.7,
    harmonic: 0.28,
    pan: options.pan ?? 0,
    wave: options.wave ?? "sine",
  });
}

function addNoiseBurst(buffer, startSeconds, durationSeconds, gain, options = {}) {
  const rng = options.rng ?? Math.random;
  const start = Math.floor(startSeconds * sampleRate);
  const total = Math.floor(durationSeconds * sampleRate);
  let low = 0;
  let band = 0;
  for (let i = 0; i < total; i += 1) {
    const white = rng() * 2 - 1;
    low = low * (options.smoothing ?? 0.92) + white * (1 - (options.smoothing ?? 0.92));
    band = band * 0.72 + (white - low) * 0.28;
    const source = options.high ? band : low;
    const value = source * gain * envelope(i, total, options.attack ?? 0.006, options.release ?? 0.15);
    addSample(buffer, start + i, value, options.pan ?? 0);
  }
}

function addRain(buffer, gain, seed) {
  const rng = createRng(seed);
  let leftLow = 0;
  let rightLow = 0;
  for (let i = 0; i < buffer[0].length; i += 1) {
    const whiteLeft = rng() * 2 - 1;
    const whiteRight = rng() * 2 - 1;
    leftLow = leftLow * 0.965 + whiteLeft * 0.035;
    rightLow = rightLow * 0.96 + whiteRight * 0.04;
    buffer[0][i] += leftLow * gain;
    buffer[1][i] += rightLow * gain;
  }

  const seconds = buffer[0].length / sampleRate;
  for (let t = 0.25; t < seconds; t += 0.18 + rng() * 0.62) {
    addNoiseBurst(buffer, t, 0.08 + rng() * 0.16, gain * (0.6 + rng() * 0.9), {
      high: true,
      pan: rng() * 1.8 - 0.9,
      rng,
      smoothing: 0.58,
    });
  }
}

function applyDelay(buffer, seconds, feedback, wet) {
  const delay = Math.floor(seconds * sampleRate);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer[channel];
    for (let i = delay; i < data.length; i += 1) {
      data[i] += data[i - delay] * feedback * wet;
    }
  }
}

function crossfadeLoop(buffer, seconds) {
  const fade = Math.floor(seconds * sampleRate);
  const length = buffer[0].length;
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer[channel];
    for (let i = 0; i < fade; i += 1) {
      const mix = i / fade;
      const endIndex = length - fade + i;
      data[endIndex] = data[endIndex] * (1 - mix) + data[i] * mix;
    }
  }
}

function normalize(buffer, peak = 0.82) {
  let max = 0;
  for (const channel of buffer) {
    for (const value of channel) max = Math.max(max, Math.abs(value));
  }
  const scale = max > 0 ? peak / max : 1;
  for (const channel of buffer) {
    for (let i = 0; i < channel.length; i += 1) {
      channel[i] = Math.tanh(channel[i] * scale * 1.08) / Math.tanh(1.08);
    }
  }
}

function writeWav(fileName, buffer) {
  const frames = buffer[0].length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const file = Buffer.alloc(44 + dataSize);
  file.write("RIFF", 0);
  file.writeUInt32LE(36 + dataSize, 4);
  file.write("WAVE", 8);
  file.write("fmt ", 12);
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(channels, 22);
  file.writeUInt32LE(sampleRate, 24);
  file.writeUInt32LE(sampleRate * blockAlign, 28);
  file.writeUInt16LE(blockAlign, 32);
  file.writeUInt16LE(bytesPerSample * 8, 34);
  file.write("data", 36);
  file.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, buffer[channel][i]));
      file.writeInt16LE(Math.round(sample * 32767), offset);
      offset += 2;
    }
  }
  fs.writeFileSync(path.join(outputDir, fileName), file);
}

function convertWavsToM4a() {
  const wavFiles = fs.readdirSync(outputDir).filter((file) => file.endsWith(".wav"));
  for (const file of wavFiles) {
    const source = path.join(outputDir, file);
    const target = path.join(outputDir, file.replace(/\.wav$/, ".m4a"));
    const result = spawnSync("afconvert", [source, target, "-f", "m4af", "-d", "aac", "-b", "128000"], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`afconvert failed for ${file}: ${result.stderr || result.stdout}`);
    }
    fs.unlinkSync(source);
  }
}

function buildRainBed() {
  const buffer = createBuffer(42);
  addRain(buffer, 0.32, 0x61616);
  applyDelay(buffer, 0.38, 0.22, 0.32);
  crossfadeLoop(buffer, 2.5);
  normalize(buffer, 0.62);
  writeWav("rain-bed.wav", buffer);
}

function buildTrack(fileName, config) {
  const buffer = createBuffer(48);
  const rng = createRng(config.seed);
  addRain(buffer, config.rain ?? 0.025, config.seed ^ 0x99);

  for (let bar = 0; bar < 8; bar += 1) {
    const chord = config.chords[bar % config.chords.length];
    addPadChord(buffer, bar * 6, 7.6, chord, config.pad, {
      attack: config.attack ?? 1.2,
      release: config.release ?? 1.9,
    });
  }

  config.motif.forEach((midi, index) => {
    if (!midi) return;
    const at = 1.2 + index * config.step + (rng() - 0.5) * 0.05;
    addPluck(buffer, at, midi, config.pluck * (0.75 + rng() * 0.4), {
      duration: config.pluckDuration ?? 2.2,
      pan: Math.sin(index * 1.7) * 0.45,
      release: config.pluckRelease ?? 1.4,
      wave: config.pluckWave ?? "sine",
    });
  });

  if (config.pulse) {
    for (let t = 0; t < 48; t += config.pulse.every) {
      addTone(buffer, t, config.pulse.duration, midiToFrequency(config.pulse.midi), config.pulse.gain, {
        attack: 0.025,
        release: config.pulse.duration * 0.8,
        pan: 0,
        wave: "sine",
      });
    }
  }

  if (config.noiseBursts) {
    for (let i = 0; i < config.noiseBursts; i += 1) {
      addNoiseBurst(buffer, rng() * 46, 0.12 + rng() * 0.28, config.burstGain ?? 0.018, {
        high: true,
        pan: rng() * 1.6 - 0.8,
        rng,
        smoothing: 0.7,
      });
    }
  }

  applyDelay(buffer, config.delay ?? 0.42, 0.34, 0.5);
  crossfadeLoop(buffer, 3);
  normalize(buffer, config.peak ?? 0.74);
  writeWav(fileName, buffer);
}

function buildSfx() {
  let buffer = createBuffer(2.2);
  addTone(buffer, 0, 1.7, 784, 0.42, { attack: 0.004, release: 1.6, harmonic: 0.1, pan: -0.1 });
  addTone(buffer, 0.08, 1.6, 587, 0.22, { attack: 0.004, release: 1.45, harmonic: 0.08, pan: 0.12 });
  addTone(buffer, 0.16, 1.4, 392, 0.14, { attack: 0.004, release: 1.2, pan: 0 });
  applyDelay(buffer, 0.18, 0.22, 0.24);
  normalize(buffer, 0.72);
  writeWav("bell.wav", buffer);

  buffer = createBuffer(1.35);
  addTone(buffer, 0, 0.9, 622, 0.28, { attack: 0.018, release: 0.75, harmonic: 0.3, pan: -0.12 });
  addTone(buffer, 0.05, 0.86, 932, 0.18, { attack: 0.02, release: 0.7, pan: 0.16 });
  addTone(buffer, 0.18, 0.7, 1244, 0.12, { attack: 0.02, release: 0.55, pan: 0 });
  normalize(buffer, 0.68);
  writeWav("fact.wav", buffer);

  buffer = createBuffer(0.85);
  addNoiseBurst(buffer, 0, 0.62, 0.66, { high: true, rng: createRng(0x516), smoothing: 0.48 });
  addTone(buffer, 0.04, 0.42, 118, 0.18, { attack: 0.01, release: 0.32, wave: "triangle" });
  normalize(buffer, 0.62);
  writeWav("static.wav", buffer);

  buffer = createBuffer(0.7);
  addTone(buffer, 0, 0.42, 94, 0.5, { attack: 0.004, release: 0.34, wave: "triangle" });
  addNoiseBurst(buffer, 0, 0.2, 0.3, { rng: createRng(0x1816), smoothing: 0.7 });
  normalize(buffer, 0.72);
  writeWav("impact.wav", buffer);

  buffer = createBuffer(2.6);
  addNoiseBurst(buffer, 0, 0.72, 0.16, { high: true, rng: createRng(0x6), smoothing: 0.65 });
  addTone(buffer, 0.08, 2.0, 523.25, 0.16, { attack: 0.14, release: 1.6, harmonic: 0.16, pan: -0.2 });
  addTone(buffer, 0.28, 2.0, 659.25, 0.13, { attack: 0.18, release: 1.7, harmonic: 0.12, pan: 0.22 });
  addTone(buffer, 0.52, 1.6, 783.99, 0.1, { attack: 0.2, release: 1.2, pan: 0 });
  applyDelay(buffer, 0.33, 0.3, 0.44);
  normalize(buffer, 0.64);
  writeWav("memory-stinger.wav", buffer);
}

buildRainBed();
buildTrack("ambient.wav", {
  seed: 0x616100,
  chords: [[45, 52, 57, 64], [41, 48, 55, 60], [43, 50, 55, 62], [40, 47, 52, 59]],
  motif: [69, null, 72, null, 67, null, 64, null, 69, null, 62, null, 64, null, 67, null],
  step: 2.6,
  pad: 0.05,
  pluck: 0.024,
  rain: 0.018,
  delay: 0.48,
});
buildTrack("investigation.wav", {
  seed: 0x616101,
  chords: [[38, 45, 50, 57], [41, 48, 53, 60], [37, 44, 50, 55], [43, 50, 55, 62]],
  motif: [62, 65, null, 60, 57, null, 62, 65, null, 67, 62, null, 60, null, 57, null],
  step: 2.35,
  pad: 0.04,
  pluck: 0.03,
  pluckDuration: 1.5,
  pluckRelease: 1.0,
  rain: 0.02,
  pulse: { midi: 26, every: 3, duration: 1.5, gain: 0.06 },
  noiseBursts: 18,
  burstGain: 0.012,
  delay: 0.36,
});
buildTrack("confrontation.wav", {
  seed: 0x616102,
  chords: [[28, 35, 40, 47], [31, 38, 43, 50], [27, 34, 40, 45], [30, 37, 42, 48]],
  motif: [52, null, 53, null, 47, null, 50, null, 45, null, 43, null, 47, null, 40, null],
  step: 2.1,
  pad: 0.048,
  pluck: 0.026,
  pluckWave: "triangle",
  pluckDuration: 1.25,
  pluckRelease: 0.75,
  rain: 0.025,
  pulse: { midi: 23, every: 1.5, duration: 0.9, gain: 0.08 },
  noiseBursts: 34,
  burstGain: 0.018,
  delay: 0.28,
  peak: 0.78,
});
buildTrack("memory.wav", {
  seed: 0x616103,
  chords: [[45, 52, 57, 64], [48, 55, 60, 67], [41, 48, 55, 64], [43, 50, 57, 65]],
  motif: [69, null, 72, null, 76, null, 74, null, 72, null, 69, null, 65, null, 67, null],
  step: 2.45,
  pad: 0.058,
  pluck: 0.034,
  pluckDuration: 2.4,
  pluckRelease: 1.7,
  rain: 0.012,
  delay: 0.54,
  peak: 0.7,
});
buildSfx();
convertWavsToM4a();

console.log(`Generated audio assets in ${outputDir}`);
