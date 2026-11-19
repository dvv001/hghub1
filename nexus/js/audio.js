/* ============================================================================
   Layer 4: Web Audio Sci-Fi Sound Engine (Nexus.audio)
   Synthesizes real-time workflow sound effects without external audio assets.
   ============================================================================ */
(function (global) {
  'use strict';

  const Nexus = (global.Nexus = global.Nexus || {});
  const { KEYS } = Nexus.CONST;
  const { ls } = Nexus.store;

  const audioState = {
    enabled: ls.getRaw(KEYS.SFX) !== '0',
    ctx: null,
    lastStreamTickMs: 0,
    lastSpiderStepMs: 0
  };

  function ensureContext() {
    if (!audioState.enabled) return null;
    const AudioCtx = global.AudioContext || global.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!audioState.ctx) {
      try { audioState.ctx = new AudioCtx(); } catch (_) { return null; }
    }
    if (audioState.ctx && audioState.ctx.state === 'suspended') {
      try { audioState.ctx.resume(); } catch (_) {}
    }
    return audioState.ctx;
  }

  function playTone(freq, endFreq, durSec, type = 'sine', gainVal = 0.08, delaySec = 0) {
    const ac = ensureContext();
    if (!ac) return;
    try {
      const t0 = ac.currentTime + delaySec;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (endFreq && endFreq !== freq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t0 + durSec);
      }
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(gainVal, t0 + Math.min(0.015, durSec * 0.25));
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durSec);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(t0);
      osc.stop(t0 + durSec + 0.015);
    } catch (_) {}
  }

  const sfx = {
    uiClick() {
      playTone(960, 1380, 0.045, 'triangle', 0.045, 0);
    },
    missionLaunch() {
      playTone(190, 560, 0.22, 'sawtooth', 0.05, 0);
      playTone(440, 880, 0.16, 'triangle', 0.08, 0.08);
      playTone(660, 1320, 0.24, 'sine', 0.09, 0.16);
    },
    agentStart(idx) {
      const freqs = [523.25, 587.33, 659.25, 783.99, 880.0];
      const f = freqs[idx % freqs.length] || 587.33;
      playTone(f * 0.75, f, 0.09, 'triangle', 0.07, 0);
      playTone(f, f * 1.25, 0.14, 'sine', 0.08, 0.07);
    },
    streamTick() {
      const now = performance.now();
      if (now - audioState.lastStreamTickMs < 92) return;
      audioState.lastStreamTickMs = now;
      const pitch = 1750 + Math.random() * 450;
      playTone(pitch, pitch * 0.85, 0.022, 'sine', 0.024, 0);
    },
    nodeCompleteAndCompact() {
      playTone(659.25, 659.25, 0.09, 'triangle', 0.075, 0);
      playTone(987.77, 1046.5, 0.16, 'sine', 0.085, 0.07);
      playTone(420, 190, 0.12, 'sine', 0.04, 0.12);
    },
    pipelineSuccess() {
      [523.25, 659.25, 783.99, 987.77, 1046.5].forEach((n, i) => {
        playTone(n, n, 0.18, 'triangle', 0.085, i * 0.065);
      });
    },
    parallelFork() {
      playTone(330, 660, 0.12, 'sawtooth', 0.05, 0);
      playTone(495, 990, 0.14, 'triangle', 0.06, 0.05);
      playTone(660, 1320, 0.16, 'sine', 0.07, 0.10);
    },
    autoHealRetry() {
      playTone(440, 330, 0.11, 'sawtooth', 0.06, 0);
      playTone(330, 660, 0.16, 'triangle', 0.075, 0.11);
    },
    errorOrAbort() {
      playTone(195, 135, 0.18, 'sawtooth', 0.085, 0);
      playTone(165, 110, 0.24, 'sawtooth', 0.085, 0.15);
    },
    spiderStep(isPrimary) {
      const topoView = document.getElementById('tabViewTopology');
      if (!topoView || topoView.classList.contains('hidden')) return;
      const now = performance.now();
      if (now - audioState.lastSpiderStepMs < 135) return;
      audioState.lastSpiderStepMs = now;
      const base = isPrimary ? 1180 : 1560;
      playTone(base, base * 0.72, 0.018, 'triangle', 0.018, 0);
    },
    spiderZap() {
      playTone(1480, 420, 0.065, 'sawtooth', 0.04, 0);
    }
  };

  function setEnabled(val) {
    audioState.enabled = Boolean(val);
    ls.setRaw(KEYS.SFX, audioState.enabled ? '1' : '0');
  }

  Nexus.audio = {
    get enabled() { return audioState.enabled; },
    setEnabled,
    ensureContext,
    sfx
  };
})(window);
