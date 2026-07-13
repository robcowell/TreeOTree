/* =========================================================================
   TreeBirth-338  —  a ReBirth-style acid/drum machine
   Two TB-303 bassline synths + a TR-909 and TR-808, all synthesized live
   with the Web Audio API. No samples, no dependencies.
   ========================================================================= */

'use strict';

/* ----------------------------------------------------------------------- */
/*  Audio context & master chain                                           */
/* ----------------------------------------------------------------------- */

let AC = null;               // AudioContext (created on first play — needs a gesture)
let master = null;           // master bus nodes
let delayBus = null;         // shared echo send for the 303s
let reverbBus = null;        // shared reverb send for the 303s

function makeNoiseBuffer(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// A plate-ish reverb impulse: exponentially-decaying, gently low-passed noise
// (warmer than raw white), decorrelated per channel for a stereo tail.
function makeReverbIR(ctx, seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      lp = lp * 0.6 + (Math.random() * 2 - 1) * 0.4;   // one-pole LP -> warmer tail
      d[i] = lp * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

// A gentle soft-clip curve for analog-ish drive/saturation.
function makeDriveCurve(amount) {
  const n = 1024, curve = new Float32Array(n), k = amount * 40 + 1;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

// The OVERDRIVE curve, as a DRY↔DISTORTED blend driven by the knob. This is the
// key to a knob that keeps doing something across its whole travel: the curve is
// a linear mix (1-drive)*clean + drive*grit, so the amount of added harmonics is
// proportional to `drive` from 0 to 100% — no saturation plateau. The grit path
// is a hard clipper (odd harmonics = buzz) with a touch of asymmetry (even
// harmonics = the "metal" bite of Josh Wink's distortion).
function make303Curve(drive) {
  const n = 2048, curve = new Float32Array(n);
  const G = 4.5;                          // hard-clip gain for the wet path
  const asym = 0.12;                      // slight even-harmonic bite
  const dcOff = Math.max(-1, Math.min(1, asym * G));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    let grit = Math.max(-1, Math.min(1, (x + asym) * G)) - dcOff;  // hard clip, DC-removed
    if (grit > 1) grit = 1; else if (grit < -1) grit = -1;
    curve[i] = (1 - drive) * x + drive * grit;
  }
  return curve;
}
// DRIVE knob -> input gain into the clipper. Modest: enough to engage the clip
// as drive rises, but never so hard it clamps the clean (dry) component away.
function overdriveGain(drive) { return 0.9 + drive * 0.9; }

function buildAudioGraph() {
  AC = new (window.AudioContext || window.webkitAudioContext)();

  // Master: sum -> soft limiter/compressor -> output
  const sum = AC.createGain();
  sum.gain.value = 0.9;

  const comp = AC.createDynamicsCompressor();
  comp.threshold.value = -8;
  comp.knee.value = 6;
  comp.ratio.value = 6;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;

  const out = AC.createGain();
  out.gain.value = state.masterVol;

  sum.connect(comp).connect(out).connect(AC.destination);

  // Shared feedback delay (stereo bounce) used by the 303 sends.
  const dInput = AC.createGain();
  const dL = AC.createDelay(1.5);
  const dR = AC.createDelay(1.5);
  const fbL = AC.createGain();
  const fbR = AC.createGain();
  const wet = AC.createGain();
  wet.gain.value = 0.85;
  const stepTime = 60 / state.bpm / 2; // dotted-ish eighth feel; retimed on tempo change
  dL.delayTime.value = stepTime;
  dR.delayTime.value = stepTime * 1.5;
  fbL.gain.value = 0.38;
  fbR.gain.value = 0.38;

  // ping-pong: L -> R feedback -> L ...
  dInput.connect(dL);
  dL.connect(fbR).connect(dR);
  dR.connect(fbL).connect(dL);
  dL.connect(wet);
  dR.connect(wet);
  wet.connect(sum);

  master = { sum, comp, out };
  delayBus = { input: dInput, dL, dR };

  // Shared reverb send (plate-ish) used by the 303s for that HSOC space.
  const rInput = AC.createGain();
  const conv = AC.createConvolver();
  conv.buffer = makeReverbIR(AC, 2.2, 2.6);
  const rWet = AC.createGain();
  rWet.gain.value = 0.9;
  rInput.connect(conv); conv.connect(rWet); rWet.connect(sum);
  reverbBus = { input: rInput };

  // Per-instrument channels ---------------------------------------------
  // Signal: voices -> gain (volume/level knobs write this) -> mute -> sum.
  // The dedicated mute node lets the power switch cut a module instantly
  // without disturbing its volume setting.
  channels = {};
  for (const id of ['b1', 'b2', 'd909', 'd808']) {
    const g = AC.createGain();
    g.gain.value = state[id].volume != null ? state[id].volume : 0.9;
    const m = AC.createGain();
    // 303s are muted at their per-voice gate (so sends cut too); drums here.
    m.gain.value = (id === 'b1' || id === 'b2') ? 1 : (moduleAudible(id) ? 1 : 0);
    g.connect(m); m.connect(sum);
    channels[id] = { gain: g, mute: m };
  }

  sharedNoise = makeNoiseBuffer(AC, 2);
}

let channels = {};
let sharedNoise = null;

/* ----------------------------------------------------------------------- */
/*  Musical helpers                                                        */
/* ----------------------------------------------------------------------- */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// note index 0 == C2 (~65.4 Hz) for a proper acid-bass register.
const BASE_MIDI = 36; // C2

function noteToFreq(semi, octave, tune) {
  const midi = BASE_MIDI + semi + octave * 12 + tune;
  return 440 * Math.pow(2, (midi - 69) / 12);
}
function noteLabel(semi) {
  return NOTE_NAMES[((semi % 12) + 12) % 12];
}

/* ----------------------------------------------------------------------- */
/*  TB-303 voice — a1k0n's measured diode-ladder model (AudioWorklet)      */
/* ----------------------------------------------------------------------- */
// Filter is ported from https://github.com/a1k0n/303 : five poles + one zero,
// with pole locations fit to actual current measured across the x0xb0x filter.
// Pole 0 is the ~100 Hz high-pass INSIDE the resonance feedback loop — that
// bass-loss is exactly what stops a 303 sounding like a fat lowpass and makes
// it thin, nasal and squelchy. filterpoles[coef][resoIdx] = constant/slope
// pairs, linearly interpolated against the (angular) cutoff frequency w.
const FILTERPOLES = [[-0.0142475857,-0.0110558351,-0.00958097367,-0.00863568249,-0.00794942757,-0.0074157056,-0.00698187179,-0.00661819537,-0.00630631927,-0.00603415378,-0.00579333654,-0.00557785533,-0.00538325013,-0.00520612558,-0.00504383985,-0.00489429884,-0.00475581571,-0.00462701254,-0.00450674977,-0.0043940746,-0.00428818259,-0.00418838855,-0.00409410427,-0.00400482112,-0.00392009643,-0.00383954259,-0.00376281836,-0.00368962181,-0.00361968451,-0.00355276681,-0.00348865386,-0.00342715236,-0.00336808777,-0.00331130196,-0.00325665127,-0.00320400476,-0.00315324279,-0.00310425577,-0.00305694308,-0.00301121207,-0.00296697733,-0.00292415989,-0.00288268665,-0.00284248977,-0.00280350622,-0.00276567732,-0.00272894836,-0.00269326825,-0.00265858922,-0.00262486654,-0.00259205824,-0.00256012496,-0.00252902967,-0.00249873752,-0.0024692157,-0.00244043324,-0.00241236091,-0.00238497108,-0.00235823762,-0.00233213577,-0.00230664208,-0.0022817343,-0.0022573913,-0.00223359302],
[1.6332367e-16,-0.0161447133,-0.019993207,-0.0209872,-0.0209377795,-0.020447015,-0.0197637613,-0.0190036975,-0.0182242987,-0.0174550383,-0.0167110053,-0.0159995606,-0.0153237941,-0.0146844019,-0.0140807436,-0.0135114504,-0.0129747831,-0.0124688429,-0.0119916965,-0.0115414484,-0.0111162818,-0.0107144801,-0.0103344362,-0.00997465446,-0.00963374867,-0.00931043725,-0.0090035371,-0.00871195702,-0.00843469084,-0.00817081077,-0.00791946102,-0.00767985179,-0.00745125367,-0.00723299254,-0.00702444481,-0.00682503313,-0.00663422244,-0.0064515164,-0.00627645413,-0.00610860728,-0.0059475773,-0.00579299303,-0.00564450848,-0.00550180082,-0.00536456851,-0.0052325297,-0.00510542063,-0.00498299431,-0.00486501921,-0.00475127814,-0.00464156716,-0.00453569463,-0.00443348032,-0.00433475462,-0.00423935774,-0.00414713908,-0.00405795659,-0.00397167614,-0.00388817107,-0.00380732162,-0.00372901453,-0.00365314257,-0.0035796042,-0.00350830319],
[-0.00000183545593,-0.00135008051,-0.00151527847,-0.00161437715,-0.00168536679,-0.00174064961,-0.00178587681,-0.00182410854,-0.00185719118,-0.00188632533,-0.00191233586,-0.00193581405,-0.00195719818,-0.00197682215,-0.00199494618,-0.002011777,-0.00202748155,-0.00204219657,-0.00205603546,-0.00206909331,-0.00208145062,-0.00209317612,-0.00210432901,-0.00211496056,-0.00212511553,-0.00213483321,-0.00214414822,-0.00215309131,-0.00216168985,-0.0021699683,-0.00217794867,-0.00218565078,-0.00219309254,-0.00220029023,-0.00220725864,-0.0022140113,-0.00222056055,-0.00222691775,-0.00223309332,-0.00223909688,-0.0022449373,-0.0022506228,-0.00225616099,-0.00226155896,-0.00226682328,-0.0022719601,-0.00227697514,-0.00228187376,-0.00228666097,-0.00229134148,-0.0022959197,-0.00230039977,-0.00230478562,-0.00230908091,-0.00231328911,-0.00231741351,-0.00232145721,-0.00232542313,-0.00232931406,-0.00233313263,-0.00233688133,-0.00234056255,-0.00234417854,-0.00234773145],
[-0.00000296292613,0.000675138822,0.00069658105,0.000704457808,0.000707837502,0.000709169651,0.00070941548,0.000709031433,0.000708261454,0.000707246872,0.000706074484,0.000704799978,0.000703460301,0.000702080606,0.000700678368,0.000699265907,0.000697852005,0.000696442963,0.000695043317,0.000693656323,0.000692284301,0.000690928882,0.000689591181,0.000688271928,0.000686971561,0.0006856903,0.000684428197,0.000683185182,0.000681961088,0.00068075568,0.000679568668,0.000678399727,0.000677248505,0.000676114631,0.000674997722,0.000673897392,0.000672813249,0.000671744904,0.000670691972,0.000669654071,0.000668630828,0.000667621875,0.000666626854,0.000665645417,0.000664677222,0.00066372194,0.000662779248,0.000661848835,0.000660930398,0.000660023644,0.00065912829,0.000658244058,0.000657370684,0.000656507909,0.000655655483,0.000654813164,0.000653980718,0.000653157918,0.000652344545,0.000651540387,0.000650745236,0.000649958895,0.000649181169,0.000648411873],
[-1.00014774,-1.35336624,-1.42048887,-1.46551548,-1.50035433,-1.52916086,-1.55392254,-1.57575858,-1.59536715,-1.61321568,-1.62963377,-1.64486333,-1.6590876,-1.67244897,-1.68506052,-1.69701363,-1.70838333,-1.71923202,-1.72961221,-1.73956855,-1.74913935,-1.75835773,-1.76725258,-1.77584919,-1.7841699,-1.79223453,-1.80006075,-1.80766437,-1.81505964,-1.8222594,-1.8292753,-1.83611794,-1.84279698,-1.84932127,-1.85569892,-1.8619374,-1.8680436,-1.87402388,-1.87988413,-1.88562983,-1.89126607,-1.8967976,-1.90222885,-1.90756395,-1.91280679,-1.91796101,-1.92303002,-1.92801704,-1.93292509,-1.93775705,-1.94251559,-1.94720328,-1.95182252,-1.95637561,-1.96086471,-1.96529188,-1.96965908,-1.97396817,-1.97822093,-1.98241904,-1.98656411,-1.99065768,-1.99470122,-1.99869613],
[0.000130592376,0.354780202,0.422050344,0.467149412,0.502032084,0.530867858,0.55565017,0.577501296,0.597121154,0.614978238,0.631402872,0.64663744,0.660865515,0.674229755,0.686843408,0.698798009,0.710168688,0.721017938,0.731398341,0.741354603,0.750925074,0.760142923,0.769037045,0.777632782,0.785952492,0.794016007,0.801841009,0.809443333,0.816837226,0.824035549,0.831049962,0.837891065,0.844568531,0.851091211,0.857467223,0.86370404,0.869808551,0.875787123,0.881645657,0.887389629,0.893024133,0.898553916,0.903983409,0.909316756,0.914557836,0.919710291,0.92477754,0.9297628,0.934669099,0.939499296,0.94425609,0.94894203,0.953559531,0.958110882,0.96259825,0.967023698,0.971389181,0.975696562,0.979947614,0.984144025,0.988287408,0.992379299,0.996421168,1.00041442],
[-0.00000296209812,-0.000245794824,-0.000818027564,-0.00119157447,-0.00146371229,-0.00167529045,-0.00184698016,-0.00199058664,-0.00211344205,-0.00222039065,-0.00231478873,-0.00239905115,-0.00247496962,-0.00254390793,-0.00260692676,-0.00266486645,-0.00271840346,-0.00276809003,-0.00281438252,-0.00285766225,-0.00289825096,-0.00293642247,-0.00297241172,-0.00300642174,-0.00303862912,-0.00306918837,-0.00309823546,-0.00312589065,-0.00315226077,-0.00317744116,-0.00320151726,-0.00322456591,-0.00324665644,-0.00326785166,-0.00328820859,-0.00330777919,-0.00332661092,-0.00334474723,-0.003362228,-0.00337908995,-0.0033953669,-0.00341109012,-0.00342628855,-0.00344098902,-0.00345521647,-0.0034689941,-0.00348234354,-0.00349528498,-0.00350783728,-0.00352001812,-0.00353184405,-0.00354333061,-0.00355449241,-0.0035653432,-0.0035758959,-0.00358616273,-0.0035961552,-0.00360588419,-0.00361536,-0.00362459235,-0.00363359049,-0.00364236316,-0.00365091867,-0.00365926491],
[-0.0000077589475,0.00311294169,0.00341779455,0.00352160375,0.00355957019,0.00356903631,0.00356431495,0.0035519457,0.00353526954,0.00351613008,0.00349560287,0.00347434152,0.00345275527,0.00343110577,0.00340956242,0.0033882354,0.00336719598,0.00334648945,0.00332614343,0.00330617351,0.00328658692,0.00326738515,0.00324856568,0.0032301233,0.00321205091,0.00319434023,0.00317698219,0.00315996727,0.00314328577,0.00312692791,0.003110884,0.00309514449,0.00307970007,0.00306454165,0.00304966043,0.0030350479,0.00302069585,0.00300659636,0.0029927418,0.00297912486,0.00296573849,0.0029525759,0.00293963061,0.00292689635,0.00291436713,0.00290203718,0.00288990095,0.00287795312,0.00286618855,0.00285460234,0.00284318974,0.00283194618,0.00282086729,0.00280994883,0.00279918673,0.00278857707,0.00277811607,0.00276780009,0.00275762559,0.00274758919,0.00273768761,0.00272791768,0.00271827634,0.00270876064],
[-0.999869423,-0.638561407,-0.56951453,-0.523990915,-0.48917678,-0.460615628,-0.436195579,-0.414739573,-0.395520699,-0.378056805,-0.362010728,-0.347136887,-0.333250504,-0.320208824,-0.307899106,-0.296230641,-0.285129278,-0.274533563,-0.264391946,-0.254660728,-0.245302512,-0.236285026,-0.227580207,-0.219163487,-0.211013226,-0.203110249,-0.195437482,-0.187979648,-0.180723016,-0.173655197,-0.166764971,-0.160042136,-0.153477393,-0.147062234,-0.140788856,-0.13465008,-0.128639289,-0.122750366,-0.116977645,-0.111315866,-0.105760138,-0.1003059,-0.094948896,-0.0896851464,-0.0845109223,-0.079422726,-0.0744172709,-0.0694914651,-0.0646423954,-0.0598673139,-0.055163625,-0.0505288741,-0.0459607376,-0.0414570134,-0.0370156122,-0.0326345497,-0.0283119399,-0.024045988,-0.0198349851,-0.0156773019,-0.0115713843,-0.00751574873,-0.00350897732,0.000450285508],
[0.000113389002,0.350509549,0.419971782,0.46683576,0.50305379,0.532907131,0.558475931,0.580942937,0.601050219,0.619296203,0.636032925,0.651518847,0.665949666,0.67947733,0.692222311,0.704281836,0.715735567,0.726649641,0.737079603,0.747072578,0.756668915,0.765903438,0.774806427,0.783404383,0.791720644,0.799775871,0.80758845,0.815174821,0.822549745,0.829726527,0.836717208,0.84353272,0.850183021,0.856677208,0.863023619,0.869229911,0.875303138,0.881249811,0.887075954,0.892787154,0.8983886,0.903885123,0.909281227,0.914581119,0.919788738,0.924907772,0.929941684,0.934893728,0.939766966,0.944564285,0.949288407,0.953941905,0.958527211,0.96304663,0.967502344,0.971896424,0.976230838,0.980507456,0.984728057,0.988894335,0.993007906,0.99707031,1.00108302,1.00504744]];

// a1k0n's diode-ladder 303 as a plain per-sample engine. It runs inside a
// ScriptProcessorNode (see create303VoiceScript) rather than an AudioWorklet,
// because AudioWorklet modules can't load from a file:// page — and "just open
// index.html" is a hard requirement here. This is exactly how a1k0n's original
// shipped. Knobs (k_cut/k_res/k_env/k_dec) are 0..1; notes arrive as frame-
// stamped events so slides/accents land sample-accurately.
const ENV_INC_303 = 64;
class TB303Engine {
  constructor(sr, fp) {
    this.sr = sr;
    this.fp = fp;
    this.k_cut = 0.5; this.k_res = 0.7; this.k_env = 0.4; this.k_dec = 0.1;
    this.wave = 0; this.accentAmt = 0.5;
    this.phase = 0; this.period = sr / 55; this.targetPeriod = this.period;
    this.glideSamp = 0;
    this.e0 = 0; this.e1 = 0; this.envdecay = 0; this.c0 = 0; this.envpos = ENV_INC_303;
    this.f0b = [0, 0]; this.f0a = [0, 0]; this.f0s = 0;
    this.f1a = [1, 0, 0]; this.f1b = 1; this.f1s = [0, 0];
    this.f2a = [1, 0, 0]; this.f2b = 1; this.f2s = [0, 0];
    this.vca_mode = 2; this.vca_a = 0; this.vca_a0 = 0.5;
    this.vca_attack = 1.0 - 0.94406088; this.vca_decay = 0.99897516;
    // Accent "sweep" circuit: an accent charges this accumulator; it bleeds off
    // with a ~180 ms time constant, so a run of accented notes stacks up and
    // pushes the filter progressively brighter — the pump/breath of real acid.
    this.accEnv = 0;
    this.accScale = 0.065;                                   // how much it opens the filter
    this.accDecayBlock = Math.exp(-ENV_INC_303 / (0.18 * sr));
    // Slow filter SWEEP LFO: opens the cutoff over several bars for the HSOC
    // "higher state" rise/fall. swRate is set from tempo; swDepth is the knob.
    this.swDepth = 0; this.swRate = 0.06; this.swPhase = 0; this.swScale = 0.5;
    this.events = [];
    this.recalc();
  }
  // main-thread message: same shape the worklet used, so callers are unchanged
  send(m) {
    if (m.t === 'p') {
      if (m.cut != null) this.k_cut = m.cut;
      if (m.res != null) this.k_res = m.res;
      if (m.env != null) this.k_env = m.env;
      if (m.dec != null) this.k_dec = m.dec;
      if (m.wave != null) this.wave = m.wave;
      if (m.acc != null) this.accentAmt = m.acc;
      if (m.swDepth != null) this.swDepth = m.swDepth;
      if (m.swRate != null) this.swRate = m.swRate;
      this.recalc();
    } else if (m.t === 'clr') {
      this.events.length = 0;
      this.vca_mode = 1;
      this.accEnv = 0;
    } else {
      const a = this.events; let i = a.length;
      while (i > 0 && a[i - 1].f > m.f) i--;
      a.splice(i, 0, m);
    }
  }
  recalc() {
    const d = (0.1 + this.k_dec) * this.sr;
    this.envdecay = Math.pow(0.1, 1.0 / d * ENV_INC_303);
    // exp fits from measuring cutoff current vs. knobs on a real x0xb0x
    let e1 = Math.exp(5.55921003 + 2.17788267 * this.k_cut + 1.99224351 * this.k_env) + 103;
    let e0 = Math.exp(5.22617147 + 1.70418937 * this.k_cut - 0.68382928 * this.k_env) + 103;
    e0 *= 2 * Math.PI / this.sr;
    e1 *= 2 * Math.PI / this.sr;
    e1 -= e0;
    this.e0 = e0; this.e1 = e1;
  }
  noteOn(ev) {
    this.targetPeriod = this.sr / ev.hz;
    if (ev.acc) this.accEnv = Math.min(3.0, this.accEnv + this.accentAmt);   // charge the accent cap
    if (ev.legato) {
      this.glideSamp = Math.max(1, (ev.glide || 0.06) * this.sr);
      this.vca_mode = 0;
      if (ev.acc) this.vca_a0 = 0.5 * (1 + this.accentAmt * 0.8);
    } else {
      this.period = this.targetPeriod;
      this.glideSamp = 0;
      this.vca_mode = 0;
      this.vca_a0 = ev.acc ? 0.5 * (1 + this.accentAmt * 0.8) : 0.42;
      this.c0 = this.e1 * (ev.acc ? (1 + this.accentAmt * 1.3) : 1);
      this.envpos = ENV_INC_303;
    }
  }
  // fill `out` with `out.length` samples starting at absolute frame `base`
  render(out, base) {
    const n = out.length, fp = this.fp;
    for (let i = 0; i < n; i++) {
      const gf = base + i;
      while (this.events.length && this.events[0].f <= gf) {
        const ev = this.events.shift();
        if (ev.t === 'off') this.vca_mode = 1; else this.noteOn(ev);
      }
      if (this.glideSamp > 0) {
        this.period += (this.targetPeriod - this.period) / this.glideSamp;
        this.glideSamp--;
        if (this.glideSamp <= 0) this.period = this.targetPeriod;
      }
      if (this.envpos >= ENV_INC_303) {
        this.swPhase += this.swRate * ENV_INC_303 / this.sr;
        if (this.swPhase >= 1) this.swPhase -= 1;
        const swVal = this.swScale * this.swDepth * (0.5 - 0.5 * Math.cos(2 * Math.PI * this.swPhase));
        const w = this.e0 + this.c0 + this.accEnv * this.accScale + swVal;
        this.c0 *= this.envdecay;
        this.accEnv *= this.accDecayBlock;
        const ri = 0 | (this.k_res * 60);
        const reso_k = this.k_res * 4.0;
        let p0 = fp[0][ri] + w * fp[1][ri];
        const p1r = fp[2][ri] + w * fp[4][ri];
        const p1i = fp[3][ri] + w * fp[5][ri];
        const p2r = fp[6][ri] + w * fp[8][ri];
        const p2i = fp[7][ri] + w * fp[9][ri];
        const z0 = 1;
        p0 = Math.exp(p0);
        const targetgain = 2 / (1 + reso_k) + 0.5 * this.k_res;
        this.f0b[0] = 1; this.f0b[1] = -z0;
        this.f0a[1] = -p0;
        this.f0b[0] *= targetgain * (-1 - p0) / (-1 - z0);
        this.f0b[1] *= targetgain * (-1 - p0) / (-1 - z0);
        const ep1 = Math.exp(p1r);
        this.f1a[1] = -2 * ep1 * Math.cos(p1i);
        this.f1a[2] = ep1 * ep1;
        this.f1b = 1 + this.f1a[1] + this.f1a[2];
        const ep2 = Math.exp(p2r);
        this.f2a[1] = -2 * ep2 * Math.cos(p2i);
        this.f2a[2] = ep2 * ep2;
        this.f2b = 1 + this.f2a[1] + this.f2a[2];
        this.envpos = 0;
      }
      this.phase += 1 / this.period;
      if (this.phase >= 1) this.phase -= 1;
      let x = this.wave ? (this.phase < 0.5 ? -0.5 : 0.5) : (this.phase - 0.5);
      let y = this.f0b[0] * x + this.f0s;
      this.f0s = this.f0b[1] * x - this.f0a[1] * y;
      x = y; y = this.f1b * x + this.f1s[0];
      this.f1s[0] = this.f1s[1] - this.f1a[1] * y;
      this.f1s[1] = -this.f1a[2] * y;
      x = y; y = this.f2b * x + this.f2s[0];
      this.f2s[0] = this.f2s[1] - this.f2a[1] * y;
      this.f2s[1] = -this.f2a[2] * y;
      out[i] = this.vca_a * y;
      this.envpos++;
      if (this.vca_mode === 0) this.vca_a += (this.vca_a0 - this.vca_a) * this.vca_attack;
      else if (this.vca_mode === 1) this.vca_a *= this.vca_decay;
    }
  }
}

// wave name -> engine flag
function waveFlag(w) { return w === 'square' ? 1 : 0; }
// SWEEP LFO rate in Hz — one full open/close cycle every 8 bars at the current tempo
function sweepRateHz(bpm) { return bpm / 1920; }
function updateSweepRates() {
  const r = sweepRateHz(state.bpm);
  ['b1', 'b2'].forEach(id => { const v = voice303[id]; if (v && v.script) v.eng.send({ t: 'p', swRate: r }); });
}

// tiny on-panel readout so we know which DSP is actually sounding
let engine303Name = '';
let engineBadges = [];
function updateEngineBadges() {
  const ok = engine303Name === 'script';
  const txt = ok ? 'ENGINE: DIODE-LADDER ✓' : (engine303Name === 'biquad' ? 'ENGINE: biquad fallback' : 'ENGINE: press ▶ to init');
  for (const b of engineBadges) {
    b.textContent = txt;
    b.classList.toggle('ok', ok);
    b.classList.toggle('fallback', engine303Name === 'biquad');
  }
}


// All 303 knobs are now normalized 0..1 (like the real box / ReBirth), except
// tune (semitones), octave, wave, drive, delay, reverb, sweep, volume. The engine
// interprets cutoff/reso/envmod/decay through a1k0n's measured exp curves; the
// biquad fallback below reuses the same curves so both engines respond identically.

function create303Voice(cfg) {
  if (AC.createScriptProcessor) return create303VoiceScript(cfg);
  return create303VoiceBiquad(cfg);   // ancient-browser safety net only
}

function create303VoiceScript(cfg) {
  engine303Name = 'script';
  const p = cfg.params;
  const eng = new TB303Engine(AC.sampleRate, FILTERPOLES);
  eng.send({ t: 'p', cut: p.cutoff, res: p.reso, env: p.envmod, dec: p.decay, wave: waveFlag(p.wave), acc: p.accentAmt, swDepth: p.sweep != null ? p.sweep : 0, swRate: sweepRateHz(state.bpm) });

  // 512-sample block ≈ 12 ms latency — low, and fine for a mono bassline
  const node = AC.createScriptProcessor(512, 0, 1);
  node.onaudioprocess = (e) => {
    const out = e.outputBuffer.getChannelData(0);
    // playbackTime shares the AudioContext clock the scheduler stamps events with
    const base = Math.round((e.playbackTime || AC.currentTime) * AC.sampleRate);
    eng.render(out, base);
  };

  // OVERDRIVE stage: drive-gain pushes the engine output into the metal-style
  // shaper like a pedal, then makeup restores level. Clean at drive 0.
  const odGain = AC.createGain();
  odGain.gain.value = overdriveGain(p.drive);
  const shaper = AC.createWaveShaper();
  shaper.curve = make303Curve(p.drive);
  shaper.oversample = '4x';
  const makeup = AC.createGain();
  makeup.gain.value = 0.9;                  // trims the louder, fatter high-drive output
  // Per-voice mute GATE: BOTH the dry channel path and the reverb/delay sends
  // pass through it, so muting/soloing kills the wet tail too (not just the dry).
  const gate = AC.createGain();
  gate.gain.value = moduleAudible(cfg.id) ? 1 : 0;
  const level = AC.createGain();
  level.gain.value = p.volume;
  const send = AC.createGain();
  send.gain.value = p.delay;
  const revSend = AC.createGain();
  revSend.gain.value = p.reverb != null ? p.reverb : 0;

  node.connect(odGain); odGain.connect(shaper); shaper.connect(makeup); makeup.connect(gate);
  gate.connect(level); level.connect(channels[cfg.id].gain);
  gate.connect(send).connect(delayBus.input);
  gate.connect(revSend).connect(reverbBus.input);

  return { script: true, node, eng, odGain, shaper, level, send, revSend, gate, prevOn: false, prevSlide: false };
}

// --- shared knob interpretation: a1k0n's measured cutoff exp fits (in Hz) ---
function env303Hz(p, accent) {
  const em = accent ? Math.min(1, p.envmod + p.accentAmt * 0.3) : p.envmod;
  const e1 = Math.exp(5.55921003 + 2.17788267 * p.cutoff + 1.99224351 * em) + 103;
  const e0 = Math.exp(5.22617147 + 1.70418937 * p.cutoff - 0.68382928 * em) + 103;
  return { base: Math.min(e0, 15000), peak: Math.min(e1, 18000) };
}
function reso303Q(reso) { return 0.7 + reso * 24; }

function create303VoiceBiquad(cfg) {
  engine303Name = 'biquad';
  const osc = AC.createOscillator();
  osc.type = cfg.params.wave;
  osc.frequency.value = 55;

  const filter = AC.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 300;
  filter.Q.value = reso303Q(cfg.params.reso);

  const filter2 = AC.createBiquadFilter();
  filter2.type = 'lowpass';
  filter2.frequency.value = 300;
  filter2.Q.value = 0.5;

  // the 303 loses low end between filter and amp — a gentle post highpass fakes it
  const hp = AC.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 120;
  hp.Q.value = 0.7;

  const preGain = AC.createGain();
  preGain.gain.value = 1.15;

  const shaper = AC.createWaveShaper();
  shaper.curve = make303Curve(cfg.params.drive);
  shaper.oversample = '4x';

  const vca = AC.createGain();
  vca.gain.value = 0.0001;
  const gate = AC.createGain();                 // per-voice mute gate (dry + send)
  gate.gain.value = moduleAudible(cfg.id) ? 1 : 0;
  const level = AC.createGain();
  level.gain.value = cfg.params.volume;
  const send = AC.createGain();
  send.gain.value = cfg.params.delay;

  osc.connect(filter); filter.connect(filter2); filter2.connect(hp); hp.connect(preGain);
  preGain.connect(shaper); shaper.connect(vca); vca.connect(gate);
  gate.connect(level); level.connect(channels[cfg.id].gain);
  gate.connect(send).connect(delayBus.input);
  osc.start();

  return { osc, filter, filter2, hp, preGain, shaper, vca, gate, level, send, prevOn: false, prevSlide: false };
}

function play303(cfg, voice, step, prevStep, time, stepDur) {
  if (voice.script) return play303Script(cfg, voice, step, prevStep, time, stepDur);
  return play303Biquad(cfg, voice, step, prevStep, time, stepDur);
}

function play303Script(cfg, voice, step, prevStep, time, stepDur) {
  const p = cfg.params;
  const sr = AC.sampleRate;
  if (!step.on) {
    voice.eng.send({ t: 'off', f: Math.round(time * sr) });
    voice.prevOn = false; voice.prevSlide = false;
    return;
  }
  const hz = noteToFreq(step.note, p.octave, p.tune);
  const legato = !!(prevStep && prevStep.on && prevStep.slide);
  voice.eng.send({ t: 'on', f: Math.round(time * sr), hz, acc: step.accent ? 1 : 0, legato, glide: 0.055 });
  // a note that does NOT slide closes its gate for a staccato gap; a sliding
  // note is held so the next note-on glides in legato.
  if (!step.slide) {
    voice.eng.send({ t: 'off', f: Math.round((time + stepDur * 0.72) * sr) });
  }
  voice.prevOn = true; voice.prevSlide = step.slide;
}

function play303Biquad(cfg, voice, step, prevStep, time, stepDur) {
  const p = cfg.params;
  const g = voice.vca.gain;
  const fc = voice.filter.frequency;
  const fc2 = voice.filter2.frequency;

  if (!step.on) {
    g.cancelScheduledValues(time);
    g.setTargetAtTime(0.0001, time, 0.012);
    voice.prevOn = false; voice.prevSlide = false;
    return;
  }

  const freq = noteToFreq(step.note, p.octave, p.tune);
  const tiedFromPrev = prevStep && prevStep.on && prevStep.slide;
  const accent = step.accent;

  voice.osc.frequency.cancelScheduledValues(time);
  if (tiedFromPrev) voice.osc.frequency.exponentialRampToValueAtTime(freq, time + 0.06);
  else voice.osc.frequency.setValueAtTime(freq, time);

  const { base, peak } = env303Hz(p, accent);
  const dt = 0.05 + p.decay * 0.8;                 // DECAY knob -> sweep fall time
  for (const f of [fc, fc2]) {
    f.cancelScheduledValues(time);
    f.setValueAtTime(Math.max(base, 40), time);
    f.exponentialRampToValueAtTime(Math.max(peak, 60), time + 0.006);
    f.exponentialRampToValueAtTime(Math.max(base, 40), time + 0.006 + dt);
  }

  voice.preGain.gain.setValueAtTime(accent ? 2.4 : 1.15, time);

  const baseQ = reso303Q(p.reso);
  voice.filter.Q.cancelScheduledValues(time);
  voice.filter.Q.setValueAtTime(baseQ + (accent ? 4 : 0), time);
  voice.filter.Q.exponentialRampToValueAtTime(Math.max(baseQ, 0.5), time + dt + 0.02);

  const amp = (accent ? 1.0 : 0.72) * (0.6 + p.accentAmt * 0.6);
  g.cancelScheduledValues(time);
  if (!tiedFromPrev) {
    g.setValueAtTime(0.0001, time);
    g.exponentialRampToValueAtTime(amp, time + 0.004);
  } else {
    g.setTargetAtTime(amp, time, 0.02);
  }
  const gate = step.slide ? stepDur * 1.02 : stepDur * 0.72;
  const floor = step.slide ? amp * 0.9 : 0.0001;
  g.setTargetAtTime(floor, time + gate * 0.5, gate * 0.5);
  if (!step.slide) g.setTargetAtTime(0.0001, time + gate, 0.02);

  voice.prevOn = true;
  voice.prevSlide = step.slide;
}

/* ----------------------------------------------------------------------- */
/*  Drum voices (909 + 808), fully synthesized                             */
/* ----------------------------------------------------------------------- */

function env(node, time, peak, decay, attack) {
  attack = attack || 0.001;
  node.gain.cancelScheduledValues(time);
  node.gain.setValueAtTime(0.0001, time);
  node.gain.exponentialRampToValueAtTime(peak, time + attack);
  node.gain.exponentialRampToValueAtTime(0.0001, time + attack + decay);
}
function noise(dest) {
  const n = AC.createBufferSource();
  n.buffer = sharedNoise;
  n.loop = true;
  n.playbackRate.value = 0.7 + Math.random() * 0.6;
  return n;
}
function amp(v) { const g = AC.createGain(); g.gain.value = 0.0001; return g; }

// velocity: 1 = normal, 2 = accent
function vel(velocity, base) { return base * (velocity === 2 ? 1.5 : 1); }

// --- TR-909 per-instrument control helpers (all knob params are 0..1) ---
// Output level from a voice's LEVEL knob, plus the global ACCENT amount on accented steps.
function g909(p, v, acc, base) {
  const level = (p && p.level != null) ? p.level : 0.7;
  const a = v === 2 ? 1 + (acc != null ? acc : 0.6) * 0.7 : 1;
  return base * (0.4 + level * 1.3) * a;
}
// TUNE knob -> frequency multiplier (±`semis` semitones around centre 0.5)
function tuneMul(tune, semis) { return Math.pow(2, ((tune != null ? tune : 0.5) - 0.5) * 2 * semis / 12); }
// DECAY knob -> scaled decay time around a per-voice base
function decS(dec, base) { return base * (0.35 + (dec != null ? dec : 0.5) * 1.35); }
// The 808's per-voice controls use the same LEVEL + global ACCENT maths.
function g808(p, v, acc, base) { return g909(p, v, acc, base); }

/* -- small node helpers -- */
function hp(f, q) { const b = AC.createBiquadFilter(); b.type = 'highpass'; b.frequency.value = f; if (q) b.Q.value = q; return b; }
function bp(f, q) { const b = AC.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = f; b.Q.value = q || 1; return b; }
function lp(f, q) { const b = AC.createBiquadFilter(); b.type = 'lowpass'; b.frequency.value = f; if (q) b.Q.value = q; return b; }
function osc(type, f) { const o = AC.createOscillator(); o.type = type; o.frequency.value = f; return o; }

// The six inharmonic square-wave oscillators shared by the 808 hi-hats and
// cymbal — this specific frequency set is what gives the 808 its metallic ring.
const METAL_808 = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];
function metalBank(t, stop, dest) {
  return METAL_808.map(f => { const o = osc('square', f); o.connect(dest); o.start(t); o.stop(stop); return o; });
}

// Open-hat choke: a closed hat (or a new open hat) silences the ringing open hat,
// exactly like the shared circuit on the real machines. Keyed per drum machine.
const openHatVoice = { d909: null, d808: null };
function chokeHat(grp, t) {
  const prev = openHatVoice[grp];
  if (prev) { try { prev.gain.cancelScheduledValues(t); prev.gain.setTargetAtTime(0.0001, t, 0.006); } catch (e) {} openHatVoice[grp] = null; }
}

const DRUMS = {
  /* ============================ TR-909 ============================ */
  // Every 909 voice reads its real hardware knobs from `p`: TUNE, ATTACK,
  // DECAY, TONE, SNAPPY, LEVEL (all 0..1), plus the global ACCENT amount `acc`.
  '909kick'(t, v, dest, grp, p, acc) {
    p = p || {};
    const dk = decS(p.decay, 0.32);            // DECAY
    const tm = tuneMul(p.tune, 6);             // TUNE
    const atk = p.attack != null ? p.attack : 0.5; // ATTACK -> click amount
    const o = osc('sine', 52 * tm);
    const g = amp(); o.connect(g).connect(dest);
    o.frequency.setValueAtTime(210 * tm, t);
    o.frequency.exponentialRampToValueAtTime(52 * tm, t + 0.028);
    env(g, t, g909(p, v, acc, 1.15), dk, 0.002);
    const click = 0.3 + atk * 1.1;
    const cO = osc('triangle', 2600); const cg = amp(); cO.connect(cg).connect(dest);
    cg.gain.setValueAtTime(g909(p, v, acc, 0.6) * click, t); cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.006 + atk * 0.006);
    cO.start(t); cO.stop(t + 0.02);
    const n = noise(); const ng = amp(); n.connect(hp(3500)).connect(ng).connect(dest);
    env(ng, t, 0.32 * click, 0.006); n.start(t); n.stop(t + 0.02);
    o.start(t); o.stop(t + dk + 0.1);
  },
  '909snare'(t, v, dest, grp, p, acc) {
    p = p || {};
    const tm = tuneMul(p.tune, 4);                       // TUNE
    const tone = p.tone != null ? p.tone : 0.5;          // TONE  -> shell body/brightness
    const snap = p.snappy != null ? p.snappy : 0.5;      // SNAPPY -> noise amount + length
    const o1 = osc('triangle', 185 * tm), o2 = osc('triangle', 330 * tm);
    const tg = amp(); o1.connect(tg); o2.connect(tg); tg.connect(dest);
    env(tg, t, g909(p, v, acc, 0.3 + tone * 0.5), 0.09);
    const n = noise(); const ng = amp();
    n.connect(hp(1400 + tone * 1600)).connect(bp(3200, 0.5)).connect(ng).connect(dest);
    env(ng, t, g909(p, v, acc, 0.3 + snap * 0.9), 0.05 + snap * 0.16);
    o1.start(t); o2.start(t); n.start(t); o1.stop(t + 0.12); o2.stop(t + 0.12); n.stop(t + 0.28);
  },
  '909clap'(t, v, dest, grp, p, acc) {
    p = p || {};
    const filt = bp(1000, 1.4); const g = amp(); filt.connect(g).connect(dest);
    for (let i = 0; i < 3; i++) { const n = noise(); n.connect(filt); const s = t + i * 0.009; env2(g, s, g909(p, v, acc, 0.8), 0.018); n.start(s); n.stop(s + 0.03); }
    const n2 = noise(); n2.connect(filt); env(g, t + 0.027, g909(p, v, acc, 0.6), 0.12, 0.003); n2.start(t + 0.027); n2.stop(t + 0.2);
  },
  '909lowtom'(t, v, dest, grp, p, acc) { tom(t, v, dest, 110, 0.32, p, acc); },
  '909midtom'(t, v, dest, grp, p, acc) { tom(t, v, dest, 165, 0.30, p, acc); },
  '909hitom'(t, v, dest, grp, p, acc) { tom(t, v, dest, 250, 0.26, p, acc); },
  '909rim'(t, v, dest, grp, p, acc) {
    p = p || {};
    const o = osc('triangle', 1700); const g = amp(); o.connect(bp(1700, 8)).connect(g).connect(dest);
    env(g, t, g909(p, v, acc, 0.7), 0.026); o.start(t); o.stop(t + 0.05);
  },
  '909closedhat'(t, v, dest, grp, p, acc) {
    p = p || {};
    chokeHat('d909', t);
    const n = noise(); const g = amp();
    n.connect(hp(9000)).connect(bp(11500, 1.1)).connect(g).connect(dest);
    env(g, t, g909(p, v, acc, 0.5), 0.05); n.start(t); n.stop(t + 0.1);
  },
  '909openhat'(t, v, dest, grp, p, acc) {
    p = p || {};
    chokeHat('d909', t);
    const n = noise(); const g = amp();
    n.connect(hp(8000)).connect(bp(10500, 1)).connect(g).connect(dest);
    env(g, t, g909(p, v, acc, 0.42), 0.4); n.start(t); n.stop(t + 0.5);
    openHatVoice.d909 = g;
  },
  '909crash'(t, v, dest, grp, p, acc) {
    p = p || {};
    const tm = tuneMul(p.tune, 5);              // TUNE (sample playback pitch)
    const g = amp(); const n = noise(); n.connect(hp(4500 * tm)).connect(g).connect(dest);
    const pk = g909(p, v, acc, 0.42);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(pk, t + 0.003);
    g.gain.exponentialRampToValueAtTime(pk * 0.3, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    n.start(t); n.stop(t + 1.7);
    const mfilt = hp(6500 * tm); const mout = amp(); mfilt.connect(mout).connect(dest);
    METAL_808.forEach(f => { const o = osc('square', f * 4 * tm); o.connect(mfilt); o.start(t); o.stop(t + 1.6); });
    env(mout, t, g909(p, v, acc, 0.12), 1.5, 0.002);
  },
  '909ride'(t, v, dest, grp, p, acc) {
    p = p || {};
    const tm = tuneMul(p.tune, 5);              // TUNE
    const n = noise(); const g = amp(); n.connect(hp(5500 * tm)).connect(bp(8000 * tm, 0.8)).connect(g).connect(dest);
    env(g, t, g909(p, v, acc, 0.28), 0.7, 0.002);
    const bell = amp(); bell.connect(dest);
    [1, 2.7, 4.16].forEach((r, i) => { const o = osc('square', 440 * r * tm); const bg = amp(); o.connect(lp(9000)).connect(bg).connect(bell); env(bg, t, g909(p, v, acc, i === 0 ? 0.25 : 0.12), 0.45, 0.002); o.start(t); o.stop(t + 0.5); });
    n.start(t); n.stop(t + 0.8);
  },

  /* ============================ TR-808 ============================ */
  // 808 voices read their hardware knobs from `p`: TONE, DECAY, SNAPPY, TUNING,
  // LEVEL (all 0..1), plus the global ACCENT amount `acc`.
  '808kick'(t, v, dest, grp, p, acc) {
    p = p || {};
    const dk = decS(p.decay, 0.9);                    // DECAY -> the long boom
    const tone = p.tone != null ? p.tone : 0.5;        // TONE  -> attack click amount
    const o = osc('sine', 50);
    const g = amp(); o.connect(g).connect(dest);
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(49, t + 0.05);
    env(g, t, g808(p, v, acc, 1.35), dk, 0.004);
    const c = osc('triangle', 220); const cg = amp(); c.connect(cg).connect(dest);
    cg.gain.setValueAtTime(g808(p, v, acc, 0.2 + tone * 0.6), t);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.008 + tone * 0.02);
    c.start(t); c.stop(t + 0.04);
    o.start(t); o.stop(t + dk + 0.1);
  },
  '808snare'(t, v, dest, grp, p, acc) {
    p = p || {};
    const tone = p.tone != null ? p.tone : 0.5;        // TONE   -> shell body/brightness
    const snap = p.snappy != null ? p.snappy : 0.5;    // SNAPPY -> noise amount + length
    const o1 = osc('sine', 185), o2 = osc('sine', 330);
    const tg = amp(); o1.connect(tg); o2.connect(tg); tg.connect(dest);
    env(tg, t, g808(p, v, acc, 0.35 + tone * 0.4), 0.1);
    const n = noise(); const ng = amp(); n.connect(hp(1000 + tone * 1200)).connect(bp(2200, 0.7)).connect(ng).connect(dest);
    env(ng, t, g808(p, v, acc, 0.3 + snap * 0.7), 0.06 + snap * 0.14);
    o1.start(t); o2.start(t); n.start(t); o1.stop(t + 0.14); o2.stop(t + 0.14); n.stop(t + 0.24);
  },
  '808clap'(t, v, dest, grp, p, acc) {
    p = p || {};
    const filt = bp(1000, 1.1); const g = amp(); filt.connect(g).connect(dest);
    for (let i = 0; i < 3; i++) { const n = noise(); n.connect(filt); const s = t + i * 0.012; env2(g, s, g808(p, v, acc, 0.65), 0.02); n.start(s); n.stop(s + 0.03); }
    const n2 = noise(); n2.connect(filt); env(g, t + 0.036, g808(p, v, acc, 0.45), 0.16, 0.003); n2.start(t + 0.036); n2.stop(t + 0.25);
  },
  '808lowconga'(t, v, dest, grp, p, acc) { conga(t, v, dest, 165, p, acc); },
  '808midconga'(t, v, dest, grp, p, acc) { conga(t, v, dest, 250, p, acc); },
  '808hiconga'(t, v, dest, grp, p, acc) { conga(t, v, dest, 370, p, acc); },
  '808rim'(t, v, dest, grp, p, acc) {
    p = p || {};
    const o = osc('square', 1700); const g = amp(); o.connect(bp(1700, 9)).connect(g).connect(dest);
    env(g, t, g808(p, v, acc, 0.55), 0.024); o.start(t); o.stop(t + 0.04);
  },
  // Closed/open hats: the six-oscillator metal bank through a highpass.
  '808closedhat'(t, v, dest, grp, p, acc) {
    p = p || {};
    chokeHat('d808', t);
    const g = amp(); const filt = hp(7500); filt.connect(bp(9000, 1.2)).connect(g).connect(dest);
    metalBank(t, t + 0.12, filt);
    env(g, t, g808(p, v, acc, 0.4), 0.06);
  },
  '808openhat'(t, v, dest, grp, p, acc) {
    p = p || {};
    chokeHat('d808', t);
    const dk = decS(p.decay, 0.42);                    // DECAY
    const g = amp(); const filt = hp(7000); filt.connect(bp(8500, 1.1)).connect(g).connect(dest);
    metalBank(t, t + dk + 0.1, filt);
    env(g, t, g808(p, v, acc, 0.34), dk, 0.002);
    openHatVoice.d808 = g;
  },
  // Cymbal: same metal bank, two-stage decay (bright ping into a long wash).
  '808cymbal'(t, v, dest, grp, p, acc) {
    p = p || {};
    const tone = p.tone != null ? p.tone : 0.5;        // TONE  -> brightness
    const dk = decS(p.decay, 1.0);                     // DECAY -> length
    const g = amp(); const filt = hp(3000 + tone * 4000); filt.connect(bp(5000 + tone * 3000, 0.7)).connect(g).connect(dest);
    metalBank(t, t + dk + 0.1, filt);
    const pk = g808(p, v, acc, 0.3);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(pk, t + 0.003);
    g.gain.exponentialRampToValueAtTime(pk * 0.33, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dk);
  },
  '808cowbell'(t, v, dest, grp, p, acc) {
    p = p || {};
    // two square oscillators (540 & 800 Hz), lightly band-shaped, plucky envelope
    const o1 = osc('square', 540), o2 = osc('square', 800);
    const pre = AC.createGain(); o1.connect(pre); o2.connect(pre);
    const g = amp(); pre.connect(bp(1100, 0.9)).connect(lp(6000)).connect(g).connect(dest);
    const pk = g808(p, v, acc, 0.55);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(pk, t + 0.002);
    g.gain.exponentialRampToValueAtTime(pk * 0.36, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o1.start(t); o2.start(t); o1.stop(t + 0.42); o2.stop(t + 0.42);
  },
};

// alternate env that adds onto existing schedule (used by clap retriggers)
function env2(node, time, peak, decay) {
  node.gain.setValueAtTime(0.0001, time);
  node.gain.exponentialRampToValueAtTime(peak, time + 0.001);
  node.gain.exponentialRampToValueAtTime(0.0001, time + decay);
}
function tom(t, v, dest, f, decay, p, acc) {
  p = p || {};
  const ff = f * tuneMul(p.tune, 12);          // TUNE (±1 octave)
  const dk = decS(p.decay, decay || 0.3);       // DECAY
  const o = osc('sine', ff); const g = amp(); o.connect(g).connect(dest);
  o.frequency.setValueAtTime(ff * 1.5, t);
  o.frequency.exponentialRampToValueAtTime(ff, t + 0.06);
  env(g, t, g909(p, v, acc, 0.85), dk);
  // noise attack skin
  const n = noise(); const ng = amp(); n.connect(hp(2500)).connect(ng).connect(dest);
  env(ng, t, g909(p, v, acc, 0.15), 0.02); n.start(t); n.stop(t + 0.03);
  o.start(t); o.stop(t + dk + 0.1);
}
function conga(t, v, dest, f, p, acc) {
  p = p || {};
  const ff = f * tuneMul(p.tune, 12);          // TUNING (±1 octave)
  const o = osc('sine', ff); const g = amp(); o.connect(g).connect(dest);
  o.frequency.setValueAtTime(ff * 1.12, t);
  o.frequency.exponentialRampToValueAtTime(ff, t + 0.04);
  env(g, t, g808(p, v, acc, 0.72), 0.16);
  o.start(t); o.stop(t + 0.3);
}

/* ----------------------------------------------------------------------- */
/*  State / pattern model                                                  */
/* ----------------------------------------------------------------------- */

const STEPS = 16;

function blank303() {
  return {
    muted: false, solo: false,
    steps: Array.from({ length: STEPS }, () => ({ on: false, note: 0, accent: false, slide: false })),
    // cutoff/reso/envmod/decay/accentAmt are normalized 0..1 (like the real 303)
    params: { cutoff: 0.5, reso: 0.5, envmod: 0.35, decay: 0.2, accentAmt: 0.5, tune: 0, octave: 0, wave: 'sawtooth', drive: 0.25, delay: 0.15, reverb: 0.12, sweep: 0, volume: 0.9 },
  };
}

const DRUM909_KIT = [
  ['909kick', 'BD'], ['909snare', 'SD'], ['909clap', 'CP'], ['909lowtom', 'LT'],
  ['909midtom', 'MT'], ['909hitom', 'HT'], ['909rim', 'RS'], ['909closedhat', 'CH'],
  ['909openhat', 'OH'], ['909crash', 'CR'], ['909ride', 'RD'],
];
const DRUM808_KIT = [
  ['808kick', 'BD'], ['808snare', 'SD'], ['808clap', 'CP'], ['808lowconga', 'LC'],
  ['808midconga', 'MC'], ['808hiconga', 'HC'], ['808rim', 'RS'], ['808closedhat', 'CH'],
  ['808openhat', 'OH'], ['808cymbal', 'CY'], ['808cowbell', 'CB'],
];

// The real TR-909's per-instrument controls (all knob positions stored 0..1).
const KIT909_PARAMS = {
  '909kick': { tune: 0.5, attack: 0.5, decay: 0.5, level: 0.85 },
  '909snare': { tune: 0.5, tone: 0.5, snappy: 0.55, level: 0.75 },
  '909clap': { level: 0.7 },
  '909lowtom': { tune: 0.5, decay: 0.5, level: 0.7 },
  '909midtom': { tune: 0.5, decay: 0.5, level: 0.7 },
  '909hitom': { tune: 0.5, decay: 0.5, level: 0.7 },
  '909rim': { level: 0.7 },
  '909closedhat': { level: 0.6 },  // HI-HAT: CLOSED level
  '909openhat': { level: 0.6 },    // HI-HAT: OPEN level
  '909crash': { tune: 0.5, level: 0.55 },
  '909ride': { tune: 0.5, level: 0.6 },
};

// The real TR-808's per-instrument controls (fewer than the 909; stored 0..1).
const KIT808_PARAMS = {
  '808kick': { tone: 0.5, decay: 0.6, level: 0.95 },
  '808snare': { tone: 0.5, snappy: 0.5, level: 0.75 },
  '808clap': { level: 0.7 },
  '808lowconga': { tune: 0.5, level: 0.7 },
  '808midconga': { tune: 0.5, level: 0.7 },
  '808hiconga': { tune: 0.5, level: 0.7 },
  '808rim': { level: 0.7 },
  '808closedhat': { level: 0.6 },  // CLOSED HIHAT: Level
  '808openhat': { decay: 0.5, level: 0.6 },  // OPEN HIHAT: Decay + Level
  '808cymbal': { tone: 0.5, decay: 0.5, level: 0.55 },
  '808cowbell': { level: 0.6 },
};

function blankDrum(kit, paramsMap) {
  return {
    volume: 0.9,
    muted: false, solo: false,
    accent: 0.6, // global ACCENT amount (used by the 909)
    rows: kit.map(([voice, label]) => ({
      voice, label, steps: new Array(STEPS).fill(0),
      p: paramsMap ? { ...(paramsMap[voice] || {}) } : {},
    })),
  };
}

const state = {
  bpm: 130,
  swing: 0,
  masterVol: 0.85,
  playing: false,
  currentStep: 0,
  b1: blank303(),
  b2: blank303(),
  d909: blankDrum(DRUM909_KIT, KIT909_PARAMS),
  d808: blankDrum(DRUM808_KIT, KIT808_PARAMS),
};

// a couple of tasty defaults so it makes noise immediately
// Loads the note-for-note 303 line over a nervous, shuffled breakbeat in the
// spirit of "Higher State of Consciousness" (broken kick, backbeat snare,
// 16th ghost hats split across both machines).
function seedDemo() {
  state.bpm = 128;
  state.swing = 0.24;   // shuffle the off-16ths

  // ---- 909: the main break — syncopated kick + backbeat snare + 8th hats ----
  const k = state.d909.rows;   // 0 BD,1 SD,2 CP,3 LT,7 CH,8 OH
  k[0].steps[0] = 2; k[0].steps[6] = 1; k[0].steps[10] = 1; k[0].steps[11] = 1;  // broken kick
  k[1].steps[4] = 2; k[1].steps[12] = 2; k[1].steps[15] = 1;                     // backbeat + ghost pickup
  [0, 2, 4, 6, 8, 10, 12, 14].forEach(i => k[7].steps[i] = 1);                   // 8th closed hats
  [2, 6, 10, 14].forEach(i => k[7].steps[i] = 2);                                // accented offbeats
  k[8].steps[2] = 1; k[8].steps[14] = 1;                                         // open-hat lifts

  // ---- 808: the "nervous" layer — shuffled 16th ghost hats + rim ticks ----
  const e = state.d808.rows;   // 0 BD,3 LC,6 RS,7 CH
  [1, 3, 5, 9, 13].forEach(i => e[7].steps[i] = 1);   // ghost hats between the 909 hats (these swing)
  e[6].steps[3] = 1; e[6].steps[11] = 1;              // syncopated rim ticks
  e[3].steps[15] = 1;                                  // low conga pickup
  e[0].steps[0] = 1;                                   // sub-kick reinforcement on the one

  // ---- 303 #1: the transcription (index 0 = C2, so G2 = 7, B2 = 11, G3 = 19) ----
  // every step on & accented; slides on 1, 3, 4, 10, 13, 14
  const s = state.b1.steps;
  const line = [
    [7, 1, 1], [19, 1, 0], [7, 1, 1], [7, 1, 1],
    [7, 1, 0], [7, 1, 0], [11, 1, 0], [7, 1, 0],
    [11, 1, 0], [7, 1, 1], [7, 1, 0], [11, 1, 0],
    [7, 1, 1], [7, 1, 1], [7, 1, 0], [11, 1, 0],
  ];
  line.forEach(([note, acc, sld], i) => { s[i].on = true; s[i].note = note; s[i].accent = !!acc; s[i].slide = !!sld; });
  // Josh Wink's researched recipe (MusicRadar/Roland): sawtooth, fairly closed
  // cutoff, high resonance, generous envmod, and the metal-style OVERDRIVE that
  // gives HSOC its grit. tune sits a hair flat so it beats against 303 #2.
  Object.assign(state.b1.params, {
    wave: 'sawtooth', octave: 0, tune: -0.07, cutoff: 0.35, reso: 0.8,
    envmod: 0.6, decay: 0.25, accentAmt: 0.66, drive: 0.55, delay: 0.12, reverb: 0.26, sweep: 0.4, volume: 0.9,
  });

  // ---- 303 #2: the same line on a second 303, detuned sharp so the pair beat
  // against each other — Wink tracked "Higher State" with two stock 303s ----
  const s2 = state.b2.steps;
  line.forEach(([note, acc, sld], i) => { s2[i].on = true; s2[i].note = note; s2[i].accent = !!acc; s2[i].slide = !!sld; });
  Object.assign(state.b2.params, {
    wave: 'sawtooth', octave: 0, tune: 0.07, cutoff: 0.35, reso: 0.8,
    envmod: 0.6, decay: 0.25, accentAmt: 0.66, drive: 0.55, delay: 0.12, reverb: 0.26, sweep: 0.4, volume: 0.8,
  });
}

/* ----------------------------------------------------------------------- */
/*  Pattern banks (A/B/C/D) + share-to-URL                                 */
/* ----------------------------------------------------------------------- */
// A "pattern" is just the note/step data; the sound-design knobs stay global,
// so switching banks changes the notes while the timbre carries across.

function blankPatternData() {
  const empty303 = () => Array.from({ length: STEPS }, () => ({ on: false, note: 0, accent: false, slide: false }));
  return {
    b1: empty303(), b2: empty303(),
    d909: state.d909.rows.map(() => new Array(STEPS).fill(0)),
    d808: state.d808.rows.map(() => new Array(STEPS).fill(0)),
  };
}
function snapshotPattern() {
  return {
    b1: state.b1.steps.map(s => ({ ...s })),
    b2: state.b2.steps.map(s => ({ ...s })),
    d909: state.d909.rows.map(r => r.steps.slice()),
    d808: state.d808.rows.map(r => r.steps.slice()),
  };
}
function applyPattern(p) {
  state.b1.steps = p.b1.map(s => ({ ...s }));
  state.b2.steps = p.b2.map(s => ({ ...s }));
  p.d909.forEach((st, i) => { if (state.d909.rows[i]) state.d909.rows[i].steps = st.slice(); });
  p.d808.forEach((st, i) => { if (state.d808.rows[i]) state.d808.rows[i].steps = st.slice(); });
}
function switchPattern(slot) {
  if (slot === state.curPattern) return;
  state.bank[state.curPattern] = snapshotPattern(); // keep any edits
  state.curPattern = slot;
  applyPattern(state.bank[slot]);
  renderAll();
  updateBankUI();
}
function updateBankUI() {
  document.querySelectorAll('.bank-btn').forEach(b => b.classList.toggle('on', b.dataset.slot === state.curPattern));
}
function serialize() {
  state.bank[state.curPattern] = snapshotPattern();
  const data = {
    v: 1, bpm: state.bpm, sw: state.swing, mv: state.masterVol, cur: state.curPattern,
    p1: state.b1.params, p2: state.b2.params,
    v909: state.d909.volume, v808: state.d808.volume,
    a909: state.d909.accent, kp909: state.d909.rows.map(r => r.p),
    a808: state.d808.accent, kp808: state.d808.rows.map(r => r.p),
    mute: { b1: state.b1.muted, b2: state.b2.muted, d909: state.d909.muted, d808: state.d808.muted },
    solo: { b1: state.b1.solo, b2: state.b2.solo, d909: state.d909.solo, d808: state.d808.solo },
    bank: state.bank,
  };
  return btoa(unescape(encodeURIComponent(JSON.stringify(data))));
}
function loadFromHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return false;
  try {
    const data = JSON.parse(decodeURIComponent(escape(atob(h))));
    if (!data || data.v !== 1) return false;
    state.bpm = data.bpm; state.swing = data.sw; state.masterVol = data.mv;
    Object.assign(state.b1.params, data.p1);
    Object.assign(state.b2.params, data.p2);
    state.d909.volume = data.v909; state.d808.volume = data.v808;
    if (data.a909 != null) state.d909.accent = data.a909;
    if (data.kp909) data.kp909.forEach((p, i) => { if (state.d909.rows[i]) state.d909.rows[i].p = p; });
    if (data.a808 != null) state.d808.accent = data.a808;
    if (data.kp808) data.kp808.forEach((p, i) => { if (state.d808.rows[i]) state.d808.rows[i].p = p; });
    if (data.mute) MODULE_IDS.forEach(id => { if (data.mute[id] != null) state[id].muted = data.mute[id]; });
    if (data.solo) MODULE_IDS.forEach(id => { if (data.solo[id] != null) state[id].solo = data.solo[id]; });
    state.bank = data.bank;
    state.curPattern = data.cur || 'A';
    applyPattern(state.bank[state.curPattern]);
    return true;
  } catch (e) { return false; }
}

/* ----------------------------------------------------------------------- */
/*  Scheduler (lookahead — "A Tale of Two Clocks")                         */
/* ----------------------------------------------------------------------- */

let nextStepTime = 0;
let schedulerTimer = null;
let voice303 = { b1: null, b2: null };
const LOOKAHEAD = 0.1;       // seconds scheduled ahead
const TICK = 25;             // ms between scheduler wakeups

function stepDuration() { return 60 / state.bpm / 4; }

function scheduleStep(stepIndex, time) {
  const dur = stepDuration();

  // swing: push odd 16ths later
  let t = time;
  if (stepIndex % 2 === 1) t += dur * state.swing * 0.66;

  // 303s
  for (const id of ['b1', 'b2']) {
    const cfg = { id, params: state[id].params };
    const step = state[id].steps[stepIndex];
    const prev = state[id].steps[(stepIndex + STEPS - 1) % STEPS];
    play303(cfg, voice303[id], step, prev, t, dur);
  }

  // drums
  for (const [devId, chId] of [['d909', 'd909'], ['d808', 'd808']]) {
    const dev = state[devId];
    for (const row of dev.rows) {
      const v = row.steps[stepIndex];
      if (v > 0) DRUMS[row.voice](t, v, channels[chId].gain, chId, row.p, dev.accent);
    }
  }

  // UI beat indicator
  uiFlashStep(stepIndex, t);
}

function scheduler() {
  while (nextStepTime < AC.currentTime + LOOKAHEAD) {
    scheduleStep(state.currentStep, nextStepTime);
    nextStepTime += stepDuration();
    state.currentStep = (state.currentStep + 1) % STEPS;
  }
  schedulerTimer = setTimeout(scheduler, TICK);
}

function startTransport() {
  if (state.playing) return;
  if (!AC) buildAudioGraph();
  if (AC.state === 'suspended') AC.resume();

  // rebuild live 303 voices (fresh engines so slides/legato start clean)
  voice303.b1 = create303Voice({ id: 'b1', params: state.b1.params });
  voice303.b2 = create303Voice({ id: 'b2', params: state.b2.params });
  updateEngineBadges();
  updateModules();   // apply current mute/solo to the freshly-built voice gates
  retimeDelay();

  state.playing = true;
  state.currentStep = 0;
  nextStepTime = AC.currentTime + 0.08;
  scheduler();
  document.getElementById('playBtn').classList.add('active');
  document.getElementById('playBtn').textContent = '■ STOP';
}

function stopTransport() {
  if (!state.playing) return;
  state.playing = false;
  clearTimeout(schedulerTimer);
  for (const id of ['b1', 'b2']) {
    const v = voice303[id];
    if (v) {
      try {
        if (v.script) {
          v.eng.send({ t: 'clr' });
          const n = v.node;
          setTimeout(() => { try { n.onaudioprocess = null; n.disconnect(); } catch (e) {} }, 250);
        } else {
          v.vca.gain.cancelScheduledValues(AC.currentTime);
          v.vca.gain.setTargetAtTime(0.0001, AC.currentTime, 0.02);
          v.osc.stop(AC.currentTime + 0.2);
        }
      } catch (e) {}
      voice303[id] = null;
    }
  }
  document.getElementById('playBtn').classList.remove('active');
  document.getElementById('playBtn').textContent = '▶ PLAY';
  clearBeatCursor();
}

function retimeDelay() {
  if (!delayBus) return;
  const st = 60 / state.bpm / 2;
  delayBus.dL.delayTime.setTargetAtTime(st, AC.currentTime, 0.05);
  delayBus.dR.delayTime.setTargetAtTime(st * 1.5, AC.currentTime, 0.05);
}

/* ----------------------------------------------------------------------- */
/*  Live param application                                                 */
/* ----------------------------------------------------------------------- */

const P303_MSG = { cutoff: 'cut', reso: 'res', envmod: 'env', decay: 'dec', accentAmt: 'acc' };
function apply303Param(id, key, val) {
  state[id].params[key] = val;
  const v = voice303[id];
  if (!v) return;
  if (v.script) {
    // filter/env knobs go to the engine; drive/delay/volume stay in the node graph
    if (P303_MSG[key]) v.eng.send({ t: 'p', [P303_MSG[key]]: val });
    else if (key === 'wave') v.eng.send({ t: 'p', wave: waveFlag(val) });
    else if (key === 'drive') { v.shaper.curve = make303Curve(val); v.odGain.gain.value = overdriveGain(val); }
    else if (key === 'delay') v.send.gain.value = val;
    else if (key === 'reverb') v.revSend.gain.value = val;
    else if (key === 'sweep') v.eng.send({ t: 'p', swDepth: val });
    else if (key === 'volume') v.level.gain.value = val;
    return;
  }
  // biquad fallback: cutoff/envmod/decay/accent are read live at note time
  if (key === 'reso') { v.filter.Q.value = reso303Q(val); }
  else if (key === 'wave') v.osc.type = val;
  else if (key === 'drive') v.shaper.curve = make303Curve(val);
  else if (key === 'delay') v.send.gain.value = val;
  else if (key === 'volume') v.level.gain.value = val;
}

/* ----------------------------------------------------------------------- */
/*  UI                                                                     */
/* ----------------------------------------------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

let stepCells = { b1: [], b2: [], d909: [], d808: [] }; // for beat cursor highlighting

/* ----- per-module power (mute) + solo switches ----- */
const MODULE_IDS = ['b1', 'b2', 'd909', 'd808'];
const MODULE_LABEL = { b1: 'BASS LINE ①', b2: 'BASS LINE ②', d909: 'TR-909', d808: 'TR-808' };
let modulePanels = {};      // id -> panel element (for dimming when off)
let moduleSyncers = {};     // id -> fn to re-sync its buttons to state

// Any solo active -> only soloed modules sound (solo overrides mute). No solo
// active -> the mute (power) switches decide. Standard mixer behaviour.
function anySolo() { return MODULE_IDS.some(id => state[id].solo); }
function moduleAudible(id) { return anySolo() ? !!state[id].solo : !state[id].muted; }

function updateModules() {
  const t = AC ? AC.currentTime : 0;
  MODULE_IDS.forEach(id => {
    const g = moduleAudible(id) ? 1 : 0;
    if (id === 'b1' || id === 'b2') {
      // 303s mute at the per-voice gate so the reverb/delay sends cut too
      const v = voice303[id];
      if (v && v.gate) v.gate.gain.setTargetAtTime(g, t, 0.006); // click-free
    } else if (channels[id] && channels[id].mute) {
      channels[id].mute.gain.setTargetAtTime(g, t, 0.006);
    }
    if (modulePanels[id]) modulePanels[id].classList.toggle('module-off', g === 0);
    if (moduleSyncers[id]) moduleSyncers[id]();
  });
}
function toggleMute(id) { state[id].muted = !state[id].muted; updateModules(); }
function toggleSolo(id) { state[id].solo = !state[id].solo; updateModules(); }

// power switch + solo button, with a shared syncer that reflects live state
function makeModuleControls(id) {
  const wrap = el('div', 'module-ctrls');
  const power = el('button', 'power-btn');
  power.appendChild(el('span', 'power-glyph', '⏻'));
  const solo = el('button', 'solo-btn', 'S');
  const sync = () => {
    const on = !state[id].muted;
    power.classList.toggle('on', on);
    power.setAttribute('aria-pressed', String(on));
    power.title = (on ? 'ON — click to mute ' : 'MUTED — click to enable ') + MODULE_LABEL[id];
    solo.classList.toggle('on', !!state[id].solo);
    solo.setAttribute('aria-pressed', String(!!state[id].solo));
    solo.title = (state[id].solo ? 'SOLO on — click to clear ' : 'SOLO — hear only this ') + MODULE_LABEL[id];
  };
  power.onclick = () => toggleMute(id);
  solo.onclick = () => toggleSolo(id);
  moduleSyncers[id] = sync;
  sync();
  wrap.appendChild(power); wrap.appendChild(solo);
  return wrap;
}

function uiFlashStep(stepIndex, time) {
  // schedule a visual pulse aligned to audio time
  const delay = Math.max(0, (time - AC.currentTime) * 1000);
  setTimeout(() => {
    if (!state.playing) return;
    document.querySelectorAll('.cursor').forEach(n => n.classList.remove('cursor'));
    document.querySelectorAll(`[data-col="${stepIndex}"]`).forEach(n => n.classList.add('cursor'));
  }, delay);
}
function clearBeatCursor() {
  document.querySelectorAll('.cursor').forEach(n => n.classList.remove('cursor'));
}

/* ----- reusable rotary knob ----- */
function makeKnob(label, min, max, value, opts, onChange) {
  opts = opts || {};
  const wrap = el('div', 'knob');
  const holder = el('div', 'dial-holder');
  const dial = el('div', 'dial');
  const ind = el('div', 'ind');
  dial.appendChild(ind);
  holder.appendChild(dial);
  const name = el('div', 'knob-label', label);
  const read = el('div', 'knob-val');
  wrap.appendChild(holder); wrap.appendChild(name); wrap.appendChild(read);

  const range = max - min;
  const fmt = opts.fmt || (v => (Math.abs(v) >= 100 ? Math.round(v) : v.toFixed(2)));
  const set = (v, fire) => {
    v = Math.min(max, Math.max(min, v));
    value = v;
    const frac = (v - min) / range;
    dial.style.transform = `rotate(${-135 + frac * 270}deg)`;
    read.textContent = (opts.unit ? '' : '') + fmt(v) + (opts.unit || '');
    if (fire) onChange(v);
  };
  set(value, false);

  let startY = 0, startV = 0, dragging = false;
  const down = e => {
    dragging = true; startY = (e.touches ? e.touches[0].clientY : e.clientY); startV = value;
    document.body.style.cursor = 'ns-resize';
    e.preventDefault();
  };
  const move = e => {
    if (!dragging) return;
    const y = (e.touches ? e.touches[0].clientY : e.clientY);
    const dv = (startY - y) / 150 * range * (e.shiftKey ? 0.2 : 1);
    set(startV + dv, true);
  };
  const up = () => { dragging = false; document.body.style.cursor = ''; };
  dial.addEventListener('mousedown', down); dial.addEventListener('touchstart', down, { passive: false });
  window.addEventListener('mousemove', move); window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('mouseup', up); window.addEventListener('touchend', up);
  dial.addEventListener('dblclick', () => set(opts.def != null ? opts.def : value, true));

  if (opts.cls) opts.cls.split(' ').forEach(c => wrap.classList.add(c));
  wrap._set = set;
  return wrap;
}

/* ----- 303 waveform slide switch (mirrors the hardware saw/square switch) ----- */
function makeWaveSwitch(id) {
  const cfg = state[id];
  const wrap = el('div', 'wave-switch');
  const top = el('div', 'ws-top', '⋀ SAW');
  const track = el('div', 'ws-track');
  track.appendChild(el('div', 'ws-knob'));
  const bot = el('div', 'ws-bot', '⊓ SQR');
  const label = el('div', 'knob-label', 'WAVEFORM');
  wrap.appendChild(top); wrap.appendChild(track); wrap.appendChild(bot); wrap.appendChild(label);
  const refresh = () => {
    const saw = cfg.params.wave === 'sawtooth';
    wrap.classList.toggle('is-saw', saw);
    wrap.classList.toggle('is-sqr', !saw);
  };
  track.onclick = () => { apply303Param(id, 'wave', cfg.params.wave === 'sawtooth' ? 'square' : 'sawtooth'); refresh(); };
  refresh();
  return wrap;
}

/* ----- build a 303 panel (silver hardware faceplate + dark sequencer) ----- */
function build303Panel(id, title) {
  const cfg = state[id];
  const P = cfg.params;
  const panel = el('div', 'panel synth-panel' + (moduleAudible(id) ? '' : ' module-off'));
  modulePanels[id] = panel;

  /* ---- silver faceplate: brand strip + hardware control row ---- */
  const face = el('div', 'faceplate');
  const brand = el('div', 'face-brand');
  brand.appendChild(makeModuleControls(id));
  brand.appendChild(el('div', 'brand-name', title));
  brand.appendChild(el('div', 'brand-sub', 'TRANSISTOR BASS SYNTHESIZER'));
  const eng = el('div', 'engine-badge', 'ENGINE: press ▶ to init');
  brand.appendChild(eng);
  engineBadges.push(eng);
  face.appendChild(brand);

  const knobs = el('div', 'face-knobs');
  knobs.appendChild(makeWaveSwitch(id));
  const add = (lbl, min, max, key, opts) => {
    opts = opts || {}; opts.cls = 'roland';
    knobs.appendChild(makeKnob(lbl, min, max, P[key], opts, v => apply303Param(id, key, v)));
  };
  // hardware order, left to right — knobs read 0..100% like the real panel
  const pct = v => Math.round(v * 100);
  add('TUNING', -12, 12, 'tune', { def: 0, fmt: v => (v > 0 ? '+' : '') + Math.round(v) });
  add('CUT OFF FREQ', 0, 1, 'cutoff', { def: 0.5, fmt: pct });
  add('RESONANCE', 0, 1, 'reso', { def: 0.5, fmt: pct });
  add('ENV MOD', 0, 1, 'envmod', { def: 0.35, fmt: pct });
  add('DECAY', 0, 1, 'decay', { def: 0.2, fmt: pct });
  add('ACCENT', 0, 1, 'accentAmt', { def: 0.5, fmt: pct });
  add('VOLUME', 0, 1.2, 'volume', { def: 0.9, fmt: v => v.toFixed(2) });
  face.appendChild(knobs);
  panel.appendChild(face);

  /* ---- dark sequencer area (our additions + step editor) ---- */
  const seq = el('div', 'seq-area');
  const bar = el('div', 'seq-bar');

  const octWrap = el('div', 'oct-group');
  octWrap.appendChild(el('span', 'opt-label', 'OCTAVE'));
  [-2, -1, 0, 1, 2].forEach(o => {
    const b = el('button', 'oct-btn' + (cfg.params.octave === o ? ' on' : ''), o === 0 ? '0' : (o > 0 ? '+' + o : '' + o));
    b.onclick = () => { apply303Param(id, 'octave', o); octWrap.querySelectorAll('.oct-btn').forEach(x => x.classList.remove('on')); b.classList.add('on'); };
    octWrap.appendChild(b);
  });
  bar.appendChild(octWrap);

  bar.appendChild(el('span', 'opt-label', 'OVERDRIVE'));
  bar.appendChild(makeKnob('', 0, 1, P.drive, { def: 0.3, cls: 'mini', fmt: v => v.toFixed(2) }, v => apply303Param(id, 'drive', v)));
  bar.appendChild(el('span', 'opt-label', 'DELAY'));
  bar.appendChild(makeKnob('', 0, 0.7, P.delay, { def: 0.15, cls: 'mini', fmt: v => v.toFixed(2) }, v => apply303Param(id, 'delay', v)));
  bar.appendChild(el('span', 'opt-label', 'REVERB'));
  bar.appendChild(makeKnob('', 0, 0.7, P.reverb != null ? P.reverb : 0, { def: 0.12, cls: 'mini', fmt: v => v.toFixed(2) }, v => apply303Param(id, 'reverb', v)));
  bar.appendChild(el('span', 'opt-label', 'SWEEP'));
  bar.appendChild(makeKnob('', 0, 1, P.sweep != null ? P.sweep : 0, { def: 0, cls: 'mini', fmt: v => Math.round(v * 100) }, v => apply303Param(id, 'sweep', v)));

  const clr = el('button', 'small-btn', 'CLR');
  clr.onclick = () => { cfg.steps.forEach(s => { s.on = false; s.accent = false; s.slide = false; }); render303Grid(id, grid); };
  const rnd = el('button', 'small-btn', 'RND');
  rnd.onclick = () => { randomize303(id); render303Grid(id, grid); };
  const spacer = el('div', 'seq-spacer'); bar.appendChild(spacer);
  bar.appendChild(clr); bar.appendChild(rnd);
  seq.appendChild(bar);

  const grid = el('div', 'grid303');
  seq.appendChild(grid);
  render303Grid(id, grid);
  panel.appendChild(seq);

  return panel;
}

const ROLL_NOTES = 25; // two octaves + top, index 0 = bottom (low)
function render303Grid(id, grid) {
  grid.innerHTML = '';
  const cfg = state[id];

  // note grid: rows from high (top) to low (bottom)
  const roll = el('div', 'roll');
  for (let r = ROLL_NOTES - 1; r >= 0; r--) {
    const rowEl = el('div', 'roll-row' + ([1, 3, 6, 8, 10].includes(((r % 12) + 12) % 12) ? ' black' : ''));
    const lbl = el('div', 'roll-label', noteLabel(r) + (r % 12 === 0 ? Math.floor(r / 12) + 2 : ''));
    rowEl.appendChild(lbl);
    for (let c = 0; c < STEPS; c++) {
      const cell = el('div', 'roll-cell');
      cell.dataset.col = c;
      cell.dataset.note = r;
      const st = cfg.steps[c];
      if (st.on && st.note === r) cell.classList.add('on');
      cell.onclick = () => {
        if (st.on && st.note === r) { st.on = false; }
        else { st.on = true; st.note = r; }
        render303Grid(id, grid);
      };
      if (c % 4 === 0) cell.classList.add('beat');
      rowEl.appendChild(cell);
    }
    roll.appendChild(rowEl);
  }
  grid.appendChild(roll);

  // accent + slide toggle rows
  [['ACCENT', 'accent'], ['SLIDE', 'slide']].forEach(([lbl, key]) => {
    const row = el('div', 'tog-row');
    row.appendChild(el('div', 'tog-label', lbl));
    for (let c = 0; c < STEPS; c++) {
      const cell = el('div', 'tog-cell' + (c % 4 === 0 ? ' beat' : ''));
      cell.dataset.col = c;
      if (cfg.steps[c][key]) cell.classList.add('on');
      cell.onclick = () => { cfg.steps[c][key] = !cfg.steps[c][key]; cell.classList.toggle('on'); };
      row.appendChild(cell);
    }
    grid.appendChild(row);
  });
}

function randomize303(id) {
  const cfg = state[id];
  const scale = [0, 2, 3, 5, 7, 8, 10, 12, 14, 15]; // minor-ish
  cfg.steps.forEach(s => {
    s.on = Math.random() < 0.62;
    s.note = scale[Math.floor(Math.random() * scale.length)];
    s.accent = Math.random() < 0.28;
    s.slide = Math.random() < 0.22;
  });
}

/* ----- build a drum panel ----- */
function buildDrumPanel(id, title) {
  const dev = state[id];
  const panel = el('div', 'panel drum-panel ' + (id === 'd808' ? 'tr808' : 'tr909') + (moduleAudible(id) ? '' : ' module-off'));
  modulePanels[id] = panel;
  const head = el('div', 'panel-head');
  const titleWrap = el('div', 'drum-title');
  titleWrap.appendChild(makeModuleControls(id));
  titleWrap.appendChild(el('div', 'panel-title', title));
  const model = id === 'd808' ? '808' : id === 'd909' ? '909' : '';
  if (model) titleWrap.appendChild(el('div', 'model-badge', model));
  head.appendChild(titleWrap);

  const gridWrap = el('div', 'drum-grid');
  gridWrap.appendChild(buildLedStrip());
  const rows = el('div', 'drum-rows');
  gridWrap.appendChild(rows);

  const tools = el('div', 'drum-tools');
  const clr = el('button', 'small-btn', 'CLR');
  clr.onclick = () => { dev.rows.forEach(r => r.steps.fill(0)); buildDrumGrid(id, rows); };
  const rnd = el('button', 'small-btn', 'RND');
  rnd.onclick = () => { randomizeDrum(id); buildDrumGrid(id, rows); };
  tools.appendChild(el('span', 'opt-label', 'LEVEL'));
  tools.appendChild(makeKnob('', 0, 1.3, dev.volume, { def: 0.9, fmt: v => v.toFixed(2) }, v => { dev.volume = v; if (channels[id]) channels[id].gain.gain.value = v; }));
  tools.appendChild(clr); tools.appendChild(rnd);
  head.appendChild(tools);
  panel.appendChild(head);

  if (id === 'd909') panel.appendChild(buildDrumControls(id, CTRL_909));
  if (id === 'd808') panel.appendChild(buildDrumControls(id, CTRL_808));

  panel.appendChild(gridWrap);
  buildDrumGrid(id, rows);
  return panel;
}

// The full set of real TR-909 per-instrument controls, in hardware order.
const CTRL_909 = [
  { name: 'ACCENT', accent: true, knobs: [['LEVEL', 'accent']] },
  { name: 'BASS DRUM', voice: '909kick', knobs: [['TUNE', 'tune'], ['ATTACK', 'attack'], ['DECAY', 'decay'], ['LEVEL', 'level']] },
  { name: 'SNARE DRUM', voice: '909snare', knobs: [['TUNE', 'tune'], ['TONE', 'tone'], ['SNAPPY', 'snappy'], ['LEVEL', 'level']] },
  { name: 'LOW TOM', voice: '909lowtom', knobs: [['TUNE', 'tune'], ['DECAY', 'decay'], ['LEVEL', 'level']] },
  { name: 'MID TOM', voice: '909midtom', knobs: [['TUNE', 'tune'], ['DECAY', 'decay'], ['LEVEL', 'level']] },
  { name: 'HI TOM', voice: '909hitom', knobs: [['TUNE', 'tune'], ['DECAY', 'decay'], ['LEVEL', 'level']] },
  { name: 'RIM SHOT', voice: '909rim', knobs: [['LEVEL', 'level']] },
  { name: 'HAND CLAP', voice: '909clap', knobs: [['LEVEL', 'level']] },
  { name: 'HI-HAT', knobs: [['CLOSED', { voice: '909closedhat', key: 'level' }], ['OPEN', { voice: '909openhat', key: 'level' }]] },
  { name: 'CRASH', voice: '909crash', knobs: [['TUNE', 'tune'], ['LEVEL', 'level']] },
  { name: 'RIDE', voice: '909ride', knobs: [['TUNE', 'tune'], ['LEVEL', 'level']] },
];
// The real TR-808 per-instrument controls, in hardware order.
const CTRL_808 = [
  { name: 'ACCENT', accent: true, knobs: [['LEVEL', 'accent']] },
  { name: 'BASS DRUM', voice: '808kick', knobs: [['TONE', 'tone'], ['DECAY', 'decay'], ['LEVEL', 'level']] },
  { name: 'SNARE DRUM', voice: '808snare', knobs: [['TONE', 'tone'], ['SNAPPY', 'snappy'], ['LEVEL', 'level']] },
  { name: 'LOW CONGA', voice: '808lowconga', knobs: [['TUNING', 'tune'], ['LEVEL', 'level']] },
  { name: 'MID CONGA', voice: '808midconga', knobs: [['TUNING', 'tune'], ['LEVEL', 'level']] },
  { name: 'HI CONGA', voice: '808hiconga', knobs: [['TUNING', 'tune'], ['LEVEL', 'level']] },
  { name: 'RIM SHOT', voice: '808rim', knobs: [['LEVEL', 'level']] },
  { name: 'HAND CLAP', voice: '808clap', knobs: [['LEVEL', 'level']] },
  { name: 'COW BELL', voice: '808cowbell', knobs: [['LEVEL', 'level']] },
  { name: 'CYMBAL', voice: '808cymbal', knobs: [['TONE', 'tone'], ['DECAY', 'decay'], ['LEVEL', 'level']] },
  { name: 'OPEN HIHAT', voice: '808openhat', knobs: [['DECAY', 'decay'], ['LEVEL', 'level']] },
  { name: 'CLOSED HIHAT', voice: '808closedhat', knobs: [['LEVEL', 'level']] },
];
function buildDrumControls(id, layout) {
  const dev = state[id];
  const wrap = el('div', 'drum-controls');
  const findRow = voice => dev.rows.find(r => r.voice === voice);
  layout.forEach(group => {
    const g = el('div', 'inst-group' + (group.accent ? ' accent-group' : ''));
    g.appendChild(el('div', 'inst-name', group.name));
    const kb = el('div', 'inst-knobs');
    group.knobs.forEach(([label, spec]) => {
      const opts = { cls: 'k909', fmt: v => Math.round(v * 100) };
      if (group.accent) {
        kb.appendChild(makeKnob(label, 0, 1, dev.accent, opts, v => { dev.accent = v; }));
        return;
      }
      const row = findRow(typeof spec === 'object' ? spec.voice : group.voice);
      const key = typeof spec === 'object' ? spec.key : spec;
      const val = row.p[key] != null ? row.p[key] : 0.5;
      kb.appendChild(makeKnob(label, 0, 1, val, opts, v => { row.p[key] = v; }));
    });
    g.appendChild(kb);
    wrap.appendChild(g);
  });
  return wrap;
}
function buildLedStrip() {
  const strip = el('div', 'led-strip');
  strip.appendChild(el('div', 'led-spacer'));
  for (let c = 0; c < STEPS; c++) {
    const l = el('div', 'led'); l.dataset.col = c; l.appendChild(el('span', 'dot')); strip.appendChild(l);
  }
  return strip;
}

function buildDrumGrid(id, wrap) {
  wrap.innerHTML = '';
  const dev = state[id];
  dev.rows.forEach((row, ri) => {
    const r = el('div', 'drum-row');
    const name = el('button', 'drum-name', row.label);
    name.title = 'preview';
    name.onclick = () => { if (!AC) buildAudioGraph(); if (AC.state === 'suspended') AC.resume(); DRUMS[row.voice](AC.currentTime + 0.01, 1, channels[id].gain, id, row.p, dev.accent); };
    r.appendChild(name);
    for (let c = 0; c < STEPS; c++) {
      const cell = el('div', 'drum-cell step-col' + (c % 4 === 0 ? ' beat' : ''));
      cell.dataset.col = c;
      const v = row.steps[c];
      if (v === 1) cell.classList.add('on');
      if (v === 2) cell.classList.add('on', 'accent');
      cell.onclick = () => {
        row.steps[c] = (row.steps[c] + 1) % 3; // off -> on -> accent -> off
        cell.classList.remove('on', 'accent');
        if (row.steps[c] === 1) cell.classList.add('on');
        if (row.steps[c] === 2) cell.classList.add('on', 'accent');
      };
      r.appendChild(cell);
    }
    wrap.appendChild(r);
  });
}

function randomizeDrum(id) {
  const dev = state[id];
  dev.rows.forEach((row, i) => {
    const density = i === 0 ? 0.3 : i < 3 ? 0.18 : 0.25;
    for (let c = 0; c < STEPS; c++) {
      row.steps[c] = Math.random() < density ? (Math.random() < 0.25 ? 2 : 1) : 0;
    }
    if (i === 0) [0, 8].forEach(x => row.steps[x] = 2); // keep a downbeat
  });
}

/* ----- transport bar ----- */
function buildTransport() {
  const bar = $('#transport');

  const play = el('button', 'play-btn', '▶ PLAY');
  play.id = 'playBtn';
  play.onclick = () => state.playing ? stopTransport() : startTransport();
  bar.appendChild(play);

  const bpmWrap = el('div', 'bpm-wrap');
  bpmWrap.appendChild(el('div', 'bpm-label', 'TEMPO'));
  const bpmVal = el('div', 'bpm-val', state.bpm + ' BPM');
  const bpmKnob = makeKnob('', 60, 200, state.bpm, { fmt: v => Math.round(v) + '' }, v => {
    state.bpm = Math.round(v); bpmVal.textContent = state.bpm + ' BPM';
    if (state.playing) { retimeDelay(); updateSweepRates(); }
  });
  bpmWrap.appendChild(bpmKnob);
  bpmWrap.appendChild(bpmVal);
  bar.appendChild(bpmWrap);

  const swingWrap = el('div', 'bpm-wrap');
  swingWrap.appendChild(el('div', 'bpm-label', 'SWING'));
  swingWrap.appendChild(makeKnob('', 0, 0.6, state.swing, { def: 0, fmt: v => Math.round(v * 100) + '%' }, v => state.swing = v));
  bar.appendChild(swingWrap);

  const volWrap = el('div', 'bpm-wrap');
  volWrap.appendChild(el('div', 'bpm-label', 'MASTER'));
  volWrap.appendChild(makeKnob('', 0, 1, state.masterVol, { def: 0.85, fmt: v => Math.round(v * 100) + '%' }, v => { state.masterVol = v; if (master) master.out.gain.value = v; }));
  bar.appendChild(volWrap);

  // pattern bank A/B/C/D
  const bank = el('div', 'bank-wrap');
  bank.appendChild(el('div', 'bpm-label', 'PATTERN'));
  const bankBtns = el('div', 'bank-btns');
  ['A', 'B', 'C', 'D'].forEach(slot => {
    const b = el('button', 'bank-btn' + (state.curPattern === slot ? ' on' : ''), slot);
    b.dataset.slot = slot;
    b.onclick = () => switchPattern(slot);
    bankBtns.appendChild(b);
  });
  bank.appendChild(bankBtns);
  bar.appendChild(bank);

  // share-to-URL
  const share = el('button', 'small-btn', '⇪ SHARE');
  share.onclick = () => {
    location.hash = serialize();
    const label = share.textContent;
    share.textContent = 'LINK COPIED ✓';
    if (navigator.clipboard) navigator.clipboard.writeText(location.href).catch(() => {});
    setTimeout(() => { share.textContent = label; }, 1500);
  };
  bar.appendChild(share);

  const allClr = el('button', 'small-btn wide', 'CLEAR ALL');
  allClr.onclick = () => {
    ['b1', 'b2'].forEach(id => state[id].steps.forEach(s => { s.on = false; s.accent = false; s.slide = false; }));
    ['d909', 'd808'].forEach(id => state[id].rows.forEach(r => r.steps.fill(0)));
    renderAll();
  };
  bar.appendChild(allClr);
}

/* ----------------------------------------------------------------------- */
/*  Boot                                                                    */
/* ----------------------------------------------------------------------- */

let panelRefs = {};
function renderAll() {
  ['b1', 'b2'].forEach(id => render303Grid(id, panelRefs[id]));
  ['d909', 'd808'].forEach(id => buildDrumGrid(id, panelRefs[id]));
}

function boot() {
  if (!loadFromHash()) {
    seedDemo();
    // Bank B = the same acid lines with the drums pulled out (breakdown).
    const breakdown = snapshotPattern();
    breakdown.d909 = state.d909.rows.map(() => new Array(STEPS).fill(0));
    breakdown.d808 = state.d808.rows.map(() => new Array(STEPS).fill(0));
    state.bank = { A: snapshotPattern(), B: breakdown, C: blankPatternData(), D: blankPatternData() };
    state.curPattern = 'A';
  }
  buildTransport();

  const synths = $('#synths');
  const p1 = build303Panel('b1', 'BASS LINE ①');
  const p2 = build303Panel('b2', 'BASS LINE ②');
  synths.appendChild(p1); synths.appendChild(p2);
  panelRefs.b1 = $('.grid303', p1);
  panelRefs.b2 = $('.grid303', p2);

  const drums = $('#drums');
  const d1 = buildDrumPanel('d909', 'RHYTHM COMPOSER');
  const d2 = buildDrumPanel('d808', 'RHYTHM COMPOSER');
  drums.appendChild(d1); drums.appendChild(d2);
  panelRefs.d909 = $('.drum-rows', d1);
  panelRefs.d808 = $('.drum-rows', d2);

  updateModules(); // reflect any loaded mute/solo state on the panels + buttons

  window.addEventListener('keydown', e => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); state.playing ? stopTransport() : startTransport(); }
  });
}

document.addEventListener('DOMContentLoaded', boot);
