'use strict';

/**
 * The voice pool `pickVoice` (see voiceHash.js) hashes agents into. Synthesis
 * itself runs in the backend (Python, kokoro-onnx — see backend/main.py's
 * "local text-to-speech" section and main.js's synthesizeSpeech()); this is
 * just the list of voice ids it accepts, plus the `lang` kokoro-onnx expects
 * for each (its phonemizer needs the language explicitly, it isn't inferred
 * from the voice id).
 *
 * English + Spanish only for now — the only locales any agent in this
 * society actually uses (see CLAUDE.md's voice table). kokoro-onnx ships 54
 * voices across 9 languages; the rest (French, Hindi, Italian, Japanese,
 * Portuguese, Chinese) can be added here later if an agent ever needs one —
 * no other code changes required, pickVoice already treats this as a plain
 * data list.
 */
const KOKORO_VOICES = Object.freeze([
  { name: 'af_heart', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'af_alloy', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'af_aoede', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'af_bella', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'af_jessica', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'af_kore', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'af_nicole', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'af_nova', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'af_river', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'af_sarah', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'af_sky', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'am_adam', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'am_echo', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'am_eric', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'am_fenrir', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'am_liam', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'am_michael', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'am_onyx', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'am_puck', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'am_santa', lang: 'en-US', kokoroLang: 'en-us' },
  { name: 'bf_emma', lang: 'en-GB', kokoroLang: 'en-gb' },
  { name: 'bf_isabella', lang: 'en-GB', kokoroLang: 'en-gb' },
  { name: 'bf_alice', lang: 'en-GB', kokoroLang: 'en-gb' },
  { name: 'bf_lily', lang: 'en-GB', kokoroLang: 'en-gb' },
  { name: 'bm_george', lang: 'en-GB', kokoroLang: 'en-gb' },
  { name: 'bm_lewis', lang: 'en-GB', kokoroLang: 'en-gb' },
  { name: 'bm_daniel', lang: 'en-GB', kokoroLang: 'en-gb' },
  { name: 'bm_fable', lang: 'en-GB', kokoroLang: 'en-gb' },
  { name: 'ef_dora', lang: 'es-ES', kokoroLang: 'es' },
  { name: 'em_alex', lang: 'es-ES', kokoroLang: 'es' },
  { name: 'em_santa', lang: 'es-ES', kokoroLang: 'es' },
  // Kokoro has only three Spanish voices; "a+b" is an equal-weight blend of
  // their style vectors (backend kokoro_voice_style), a distinct voice of its own.
  { name: 'ef_dora+em_alex', lang: 'es-ES', kokoroLang: 'es' },
  { name: 'ef_dora+em_santa', lang: 'es-ES', kokoroLang: 'es' },
  { name: 'em_alex+em_santa', lang: 'es-ES', kokoroLang: 'es' },
  { name: 'ef_dora+em_alex+em_santa', lang: 'es-ES', kokoroLang: 'es' },
  { name: 'ef_dora+ef_dora+em_alex', lang: 'es-ES', kokoroLang: 'es' },
  { name: 'ef_dora+ef_dora+em_santa', lang: 'es-ES', kokoroLang: 'es' },
]);

module.exports = { KOKORO_VOICES };
