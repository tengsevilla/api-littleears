// Soundscape definitions and the loop-seam math for the offline generator
// (src/scripts/generateSoundscapes.ts). No env, DB, S3 or providers. See CLAUDE.md "Sounds".

export const SAMPLE_RATE = 44_100;
export const CHANNELS = 2;
export const LOOP_SEC = 90;
export const LOOP_FRAMES = LOOP_SEC * SAMPLE_RATE; // 3,969,000
export const SEAM_SEC = 2;
export const SEAM_FRAMES = SEAM_SEC * SAMPLE_RATE;
// The shipped file is [last 1 s of loop] + loop + [first 1 s of loop], so the MP3 codec's start/end
// boundaries never sit on the seam; the player loops [LOOP_START, LOOP_END) and starts at LOOP_START.
export const LOOP_PAD_FRAMES = SAMPLE_RATE;
export const LOOP_START_SAMPLE = LOOP_PAD_FRAMES; // 44,100
export const LOOP_END_SAMPLE = LOOP_PAD_FRAMES + LOOP_FRAMES; // 4,013,100

export type Soundscape = {
  slug: string;
  title: string;
  /** 3 different 30 s takes of the same scene. No voices, speech, words or music; not scary. */
  prompts: [string, string, string];
  /** Cover scene for the image provider (STYLE_PROMPT is prepended). No names, no text. */
  cover: string;
};

const LOOP_HINT = " Steady, even ambience suitable for a seamless loop.";
const p = (a: string, b: string, c: string): [string, string, string] => [a + LOOP_HINT, b + LOOP_HINT, c + LOOP_HINT];

export const SOUNDSCAPES: Soundscape[] = [
  {
    slug: "construction",
    title: "Construction Site",
    prompts: p(
      "Busy, friendly construction site: a digger scooping gravel, rhythmic hammering on wood, a dump truck reversing with soft beeps, steady engine rumble in the background.",
      "Construction site heard from a little distance: an excavator engine humming, a metal shovel scraping dirt, light hammer taps, gentle truck backup beeping now and then.",
      "Cheerful building site ambience: a cement mixer turning, a bulldozer idling, steady nail hammering, gravel pouring from a truck, the soft beep beep of a reversing truck.",
    ),
    cover: "A friendly yellow digger and a little dump truck with big eyes working on a sunny construction site with a pile of sand and orange cones.",
  },
  {
    slug: "farm",
    title: "Farm Animals",
    prompts: p(
      "Peaceful farmyard in the morning: cows mooing softly, sheep baaing, hens clucking, a rooster far away, birds chirping and a light breeze.",
      "Sunny farm ambience: pigs oinking and snuffling in hay, ducks quacking by a pond, chickens pecking and clucking, gentle cowbells.",
      "Relaxed barnyard: goats bleating, a horse snorting and clip-clopping, hens clucking, sparrows chirping, wind through tall grass.",
    ),
    cover: "A happy cow, a fluffy sheep and a little chick standing together in front of a red barn on a green meadow.",
  },
  {
    slug: "cars",
    title: "Car Engines",
    prompts: p(
      "Friendly cars on a quiet road: engines revving gently, cars passing by smoothly one after another, tyres humming on the asphalt.",
      "Small race cars zooming around a track at a distance, playful engine revs rising and falling, the smooth whoosh of cars passing by.",
      "Cheerful town street: cars starting up with a soft vroom, idling engines, cars driving past, little friendly toots of a car horn.",
    ),
    cover: "Three cheerful little cars in bright colours with big eyes driving along a curvy road past round green hills.",
  },
  {
    slug: "rocket",
    title: "Rocket Launch",
    prompts: p(
      "Rocket on the launch pad: a deep steady pre-launch hum, hissing vents of white steam, low mechanical whirring, a distant rumble.",
      "Rocket engine ignition roar heard from far away, a powerful but smooth continuous rumble, crackling thrust softened by the distance.",
      "Rocket climbing into the sky far away: a long low rolling rumble, soft whooshing wind, a steady deep engine drone high above.",
    ),
    cover: "A friendly round rocket with a big smile lifting off from a launch pad on puffy white clouds into a starry sky.",
  },
  {
    slug: "train",
    title: "Train Ride",
    prompts: p(
      "Inside a train carriage on a smooth ride: rhythmic clickety-clack of wheels on the rails, a gentle rocking hum, the soft rattle of windows.",
      "Steam train chugging steadily through the countryside: rhythmic puffing, wheels clacking on the tracks, a friendly whistle far away.",
      "Train rolling along the tracks heard from a nearby hill: a steady rumble and rhythmic clatter of wheels, a soft distant horn.",
    ),
    cover: "A smiling little steam train with colourful carriages puffing round clouds of steam as it rides over a bridge through green hills.",
  },
  {
    slug: "ocean",
    title: "Ocean Waves",
    prompts: p(
      "Gentle ocean waves rolling onto a sandy beach and washing back, soft foam fizzing, a light sea breeze.",
      "Calm sea at a rocky shore: waves lapping against the rocks, water trickling between pebbles, seagulls far away.",
      "Steady surf on a wide beach: slow rhythmic waves breaking softly, a deep ocean whoosh, sand and shells rolling in the water.",
    ),
    cover: "Gentle blue waves rolling onto a sandy beach with a smiling crab, a starfish and a sandcastle under a warm sun.",
  },
  {
    slug: "jungle",
    title: "Jungle",
    prompts: p(
      "Lush daytime jungle: colourful birds chirping and calling, insects buzzing softly, leaves rustling, a trickling stream.",
      "Rainforest ambience: tropical birds calling, frogs croaking, gentle monkey hoots far away, water dripping from big leaves.",
      "Warm jungle afternoon: parrots squawking playfully, crickets and cicadas humming, a small waterfall in the distance, wind in the treetops.",
    ),
    cover: "A cheerful parrot, a little monkey and a frog peeking out from big green jungle leaves and hanging vines.",
  },
  {
    slug: "rain",
    title: "Rainstorm",
    prompts: p(
      "Gentle steady rain falling on leaves in a garden, soft pitter-patter, very soft distant thunder rolling now and then.",
      "Cozy rain on a window and a roof, raindrops tapping softly, water gurgling in a gutter, faint far-away thunder.",
      "Calm rainstorm in a forest: steady soft rainfall, drips from the branches, a low gentle rumble of thunder far away.",
    ),
    cover: "A smiling grey cloud with gentle raindrops falling on a cosy little house and a puddle with a rubber duck.",
  },
];

/**
 * Turns interleaved PCM into an exact `frames`-long seamless loop: takes the first
 * `frames + fadeFrames` frames, overlap-adds the tail (frames..frames+fadeFrames) into the head
 * with an equal-power crossfade (head fades in with sin, tail fades out with cos), and drops the
 * tail. out[0] equals the sample that originally followed out[frames-1], so the wrap is continuous.
 */
export function closeLoop(pcm: Float32Array, channels: number, frames: number, fadeFrames: number): Float32Array {
  const needed = (frames + fadeFrames) * channels;
  if (pcm.length < needed) {
    throw new Error(`closeLoop: need ${frames + fadeFrames} frames, got ${Math.floor(pcm.length / channels)}`);
  }
  const out = pcm.slice(0, frames * channels);
  for (let i = 0; i < fadeFrames; i++) {
    const t = (i / fadeFrames) * (Math.PI / 2);
    const gIn = Math.sin(t);
    const gOut = Math.cos(t);
    for (let c = 0; c < channels; c++) {
      const head = i * channels + c;
      out[head] = pcm[head]! * gIn + pcm[(frames + i) * channels + c]! * gOut;
    }
  }
  return out;
}

/**
 * Wraps a loop with `padFrames` of its own tail before and its own head after, so filters with
 * edge effects (loudnorm's internal 192 kHz resampling) see continuous audio at the seam. Trim
 * `padFrames` from both ends afterwards.
 */
export function padCircular(pcm: Float32Array, channels: number, padFrames: number): Float32Array {
  const n = padFrames * channels;
  if (n > pcm.length) throw new Error("padCircular: pad longer than the loop");
  const out = new Float32Array(pcm.length + 2 * n);
  out.set(pcm.subarray(pcm.length - n), 0);
  out.set(pcm, n);
  out.set(pcm.subarray(0, n), n + pcm.length);
  return out;
}

/** RIFF container check (WebP/WAV): "RIFF" magic and a little-endian size field equal to filesize − 8. */
export function hasValidRiffSize(file: Buffer): boolean {
  return file.length >= 12 && file.toString("ascii", 0, 4) === "RIFF" && file.readUInt32LE(4) === file.length - 8;
}

export type SeamStats = {
  /** Largest per-channel |pcm[loopEnd-1] − pcm[loopStart]|: the step a listener hears at the wrap. */
  seamStep: number;
  /** Share (0–100) of the ordinary in-loop steps that are smaller than seamStep. */
  percentile: number;
  maxStep: number;
  meanStep: number;
};

/**
 * Compares the wrap step (frame loopEnd-1 → loopStart) with every adjacent-sample step inside
 * [loopStart, loopEnd), all channels pooled. A smooth seam sits well inside the distribution.
 */
export function seamStats(pcm: Float32Array, channels: number, loopStart: number, loopEnd: number): SeamStats {
  if (loopStart < 0 || loopEnd <= loopStart + 1 || loopEnd * channels > pcm.length) {
    throw new Error(`seamStats: loop [${loopStart}, ${loopEnd}) outside ${pcm.length / channels} frames`);
  }
  let seamStep = 0;
  for (let c = 0; c < channels; c++) {
    seamStep = Math.max(seamStep, Math.abs(pcm[(loopEnd - 1) * channels + c]! - pcm[loopStart * channels + c]!));
  }
  let below = 0;
  let count = 0;
  let sum = 0;
  let maxStep = 0;
  for (let f = loopStart + 1; f < loopEnd; f++) {
    for (let c = 0; c < channels; c++) {
      const step = Math.abs(pcm[f * channels + c]! - pcm[(f - 1) * channels + c]!);
      if (step < seamStep) below++;
      if (step > maxStep) maxStep = step;
      sum += step;
      count++;
    }
  }
  return { seamStep, percentile: (below / count) * 100, maxStep, meanStep: sum / count };
}
