import { useCallback, useEffect, useRef, useState } from "react";

const configuredBase = import.meta.env?.BASE_URL ?? "./";
const assetBase = typeof document === "undefined"
  ? configuredBase
  : new URL(configuredBase, document.baseURI).href;

const TRACK_FILES = {
  rain: "rain-bed.m4a",
  ambient: "ambient.m4a",
  investigation: "investigation.m4a",
  confrontation: "confrontation.m4a",
  memory: "memory.m4a",
};

const SFX_FILES = {
  bell: "bell.m4a",
  fact: "fact.m4a",
  impact: "impact.m4a",
  memory: "memory-stinger.m4a",
  static: "static.m4a",
};

const TRACK_LEVELS = {
  ambient: 0.5,
  investigation: 0.52,
  confrontation: 0.5,
  memory: 0.48,
};

const audioUrl = (file) => `${assetBase}assets/audio/${file}`;
const noteFrequency = (midi) => 440 * (2 ** ((midi - 69) / 12));

async function decodeAudio(context, file) {
  const response = await fetch(audioUrl(file));
  if (!response.ok) throw new Error(`Unable to load audio asset: ${file}`);
  return context.decodeAudioData(await response.arrayBuffer());
}

function createGain(context, level = 1) {
  const gain = context.createGain();
  gain.gain.value = level;
  return gain;
}

function fadeParam(param, context, target, seconds) {
  const now = context.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(Math.max(param.value, 0.0001), now);
  param.linearRampToValueAtTime(target, now + seconds);
}

function startLoop(context, destination, buffer, level, fadeSeconds = 0.8) {
  const source = context.createBufferSource();
  const gain = createGain(context, 0.0001);
  source.buffer = buffer;
  source.loop = true;
  source.connect(gain).connect(destination);
  source.start();
  fadeParam(gain.gain, context, level, fadeSeconds);
  return { source, gain };
}

function stopLoop(context, loop, fadeSeconds = 0.8) {
  if (!loop) return;
  const stopAt = context.currentTime + fadeSeconds + 0.05;
  fadeParam(loop.gain.gain, context, 0.0001, fadeSeconds);
  try {
    loop.source.stop(stopAt);
  } catch {
    // The source may have been stopped by browser cleanup already.
  }
}

function scheduleTone(context, destination, frequency, at, options) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const filter = context.createBiquadFilter();
  oscillator.type = options.wave ?? "sine";
  oscillator.frequency.setValueAtTime(frequency, at);
  filter.type = options.filter ?? "lowpass";
  filter.frequency.setValueAtTime(options.cutoff ?? 1400, at);
  filter.Q.setValueAtTime(options.q ?? 0.8, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(Math.max(options.level, 0.0002), at + (options.attack ?? 0.04));
  gain.gain.exponentialRampToValueAtTime(0.0001, at + options.duration);
  oscillator.connect(filter).connect(gain).connect(destination);
  oscillator.start(at);
  oscillator.stop(at + options.duration + 0.08);
}

function startFallbackScore(audio) {
  if (audio.fallbackTimer) return;
  const { context, musicBus } = audio;
  const sequencer = { step: 0, nextAt: context.currentTime + 0.1, mode: audio.scoreMode };
  const patterns = {
    ambient: { tempo: 54, root: 45, motif: [69, null, 72, null, 67, null, 64, null], level: 0.018 },
    investigation: { tempo: 66, root: 38, motif: [62, 65, null, 60, 57, null, 62, null], level: 0.02 },
    confrontation: { tempo: 78, root: 28, motif: [52, null, 53, null, 47, null, 50, null], level: 0.021 },
    memory: { tempo: 58, root: 45, motif: [69, null, 72, null, 76, null, 74, null], level: 0.024 },
  };

  audio.fallbackTimer = window.setInterval(() => {
    if (context.state !== "running") return;
    if (sequencer.mode !== audio.scoreMode) {
      sequencer.mode = audio.scoreMode;
      sequencer.step = 0;
      sequencer.nextAt = context.currentTime + 0.08;
    }
    const pattern = patterns[audio.scoreMode] ?? patterns.ambient;
    const stepDuration = 30 / pattern.tempo;
    while (sequencer.nextAt < context.currentTime + 0.45) {
      if (sequencer.step % pattern.motif.length === 0) {
        [0, 7, 12, 19].forEach((offset, index) => {
          scheduleTone(context, musicBus, noteFrequency(pattern.root + offset), sequencer.nextAt + index * 0.02, {
            attack: 0.48,
            cutoff: 680 + index * 220,
            duration: 7,
            level: 0.018 / (index + 1),
            wave: index % 2 ? "triangle" : "sine",
          });
        });
      }
      const midi = pattern.motif[sequencer.step % pattern.motif.length];
      if (midi) {
        scheduleTone(context, musicBus, noteFrequency(midi), sequencer.nextAt, {
          attack: audio.scoreMode === "confrontation" ? 0.018 : 0.08,
          cutoff: audio.scoreMode === "confrontation" ? 900 : 1650,
          duration: audio.scoreMode === "investigation" ? 1.1 : 1.8,
          level: pattern.level,
          wave: audio.scoreMode === "confrontation" ? "triangle" : "sine",
        });
      }
      sequencer.step += 1;
      sequencer.nextAt += stepDuration;
    }
  }, 90);
}

function playFallbackSfx(audio, kind) {
  const { context, sfxBus } = audio;
  const now = context.currentTime;
  if (kind === "static" || kind === "memory") {
    const buffer = context.createBuffer(1, Math.floor(context.sampleRate * 0.58), context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * ((1 - i / data.length) ** 1.5);
    }
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = buffer;
    filter.type = kind === "memory" ? "bandpass" : "highpass";
    filter.frequency.value = kind === "memory" ? 720 : 2300;
    gain.gain.value = kind === "memory" ? 0.05 : 0.035;
    source.connect(filter).connect(gain).connect(sfxBus);
    source.start(now);
    return;
  }

  const notes = kind === "bell" ? [784, 587, 392] : [kind === "fact" ? 622 : 116];
  notes.forEach((frequency, index) => {
    scheduleTone(context, sfxBus, frequency, now + index * 0.045, {
      attack: 0.012,
      cutoff: kind === "impact" ? 360 : 2000,
      duration: kind === "bell" ? 1.6 : kind === "fact" ? 0.82 : 0.45,
      level: kind === "impact" ? 0.08 : 0.04 / (index + 1),
      wave: kind === "impact" ? "triangle" : "sine",
    });
  });
}

function transitionMusic(audio, mode, fadeSeconds = 1.2) {
  const buffer = audio.buffers[mode];
  if (!buffer) return false;
  if (audio.currentMode === mode && audio.currentMusic) return true;
  stopLoop(audio.context, audio.currentMusic, fadeSeconds);
  audio.currentMusic = startLoop(audio.context, audio.musicBus, buffer, TRACK_LEVELS[mode] ?? 0.48, fadeSeconds);
  audio.currentMode = mode;
  return true;
}

async function loadAssets(audio) {
  const { context } = audio;
  const trackEntries = Object.entries(TRACK_FILES);
  const sfxEntries = Object.entries(SFX_FILES);
  const decoded = await Promise.allSettled([
    ...trackEntries.map(async ([key, file]) => [key, await decodeAudio(context, file)]),
    ...sfxEntries.map(async ([key, file]) => [`sfx:${key}`, await decodeAudio(context, file)]),
  ]);

  decoded.forEach((result) => {
    if (result.status !== "fulfilled") return;
    const [key, buffer] = result.value;
    if (key.startsWith("sfx:")) audio.sfxBuffers[key.slice(4)] = buffer;
    else audio.buffers[key] = buffer;
  });

  if (audio.buffers.rain && !audio.rainLoop) {
    audio.rainLoop = startLoop(context, audio.rainBus, audio.buffers.rain, 0.44, 1.5);
  }
  if (!transitionMusic(audio, audio.scoreMode, 1.2)) startFallbackScore(audio);
}

export function useAmbientAudio(scoreMode = "ambient") {
  const [enabled, setEnabled] = useState(true);
  const audioRef = useRef(null);
  const scoreRef = useRef(scoreMode);

  useEffect(() => {
    scoreRef.current = scoreMode;
    const audio = audioRef.current;
    if (!audio) return;
    audio.scoreMode = scoreMode;
    if (audio.ready) transitionMusic(audio, scoreMode);
  }, [scoreMode]);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.fallbackTimer) window.clearInterval(audio.fallbackTimer);
    stopLoop(audio.context, audio.rainLoop, 0.2);
    stopLoop(audio.context, audio.currentMusic, 0.2);
    void audio.context.close();
    audioRef.current = null;
  }, []);

  const start = useCallback(() => {
    if (audioRef.current) {
      void audioRef.current.context.resume();
      return audioRef.current;
    }

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;

    const context = new AudioContext();
    const master = createGain(context, 0.72);
    const compressor = context.createDynamicsCompressor();
    const rainBus = createGain(context, 0.86);
    const musicBus = createGain(context, 0.86);
    const sfxBus = createGain(context, 0.82);
    const delay = context.createDelay(2.5);
    const delayGain = createGain(context, 0.12);

    musicBus.connect(delay).connect(delayGain).connect(master);
    musicBus.connect(master);
    rainBus.connect(master);
    sfxBus.connect(master);
    master.connect(compressor).connect(context.destination);

    const audio = {
      buffers: {},
      context,
      currentMode: null,
      currentMusic: null,
      fallbackTimer: null,
      musicBus,
      rainBus,
      rainLoop: null,
      ready: false,
      scoreMode: scoreRef.current,
      sfxBuffers: {},
      sfxBus,
    };
    audioRef.current = audio;

    audio.loadPromise = loadAssets(audio)
      .then(() => {
        audio.ready = true;
      })
      .catch(() => {
        audio.ready = true;
        startFallbackScore(audio);
      });

    return audio;
  }, []);

  const toggle = useCallback(() => {
    setEnabled((current) => {
      if (current) stop();
      else start();
      return !current;
    });
  }, [start, stop]);

  const cue = useCallback((kind) => {
    if (!enabled || !kind) return;
    const audio = start();
    if (!audio) return;
    const buffer = audio.sfxBuffers[kind];
    if (!buffer) {
      playFallbackSfx(audio, kind);
      return;
    }
    const source = audio.context.createBufferSource();
    const gain = createGain(audio.context, kind === "impact" ? 0.72 : 0.64);
    source.buffer = buffer;
    source.connect(gain).connect(audio.sfxBus);
    source.start();
  }, [enabled, start]);

  useEffect(() => () => stop(), [stop]);

  return { cue, enabled, start, toggle };
}
