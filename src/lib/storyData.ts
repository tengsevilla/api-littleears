// The 5 POV story sounds (90 s each) for src/scripts/generateStories.ts. Kid-friendly, exciting,
// never scary: no crashes, sirens, injuries, or real brand / team / person / place names.
// Timeline seconds are approximate for dialogue (its length is known only after generation —
// tune atSec and re-run with --remix, which never calls a vendor).
import type { Story, StoryDialogue, StorySfx, VoiceRole } from "./stories.js";

// ElevenLabs premade (default library) voices, used with eleven_v3:
//   engineer  — George  JBFqnCBsd6RMkjVDRZzb  warm, calm, mature British male (race engineer / mission control / worker)
//   hero      — Liam    TX3LPaxmHKxFdv7VOQHJ  energetic young-adult American male (driver / dog's farmer friend / astronaut)
//   announcer — Daniel  onwK4e9ZLuTAKqWW03F9  clear, friendly British broadcaster (station announcer / worker)
//   conductor — Jessica cgSgspJ2msm6clMCkdW9  bright, cheerful young American female (conductor / farmer / worker)
export const VOICES: Record<VoiceRole, { id: string; name: string }> = {
  engineer: { id: "JBFqnCBsd6RMkjVDRZzb", name: "George" },
  hero: { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam" },
  announcer: { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel" },
  conductor: { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica" },
};

/** Spot effect. */
const spot = (id: string, atSec: number, durationSec: number, gainDb: number, prompt: string, extra: Partial<StorySfx> = {}): StorySfx => ({
  id,
  atSec,
  durationSec,
  gainDb,
  prompt,
  ...extra,
});
/** Looped bed from atSec to untilSec, made of ≤30 s loop:true clips of durationSec. */
const bed = (id: string, atSec: number, untilSec: number, durationSec: number, gainDb: number, prompt: string, extra: Partial<StorySfx> = {}): StorySfx => ({
  id,
  atSec,
  untilSec,
  durationSec,
  gainDb,
  prompt,
  loop: true,
  fadeInSec: atSec === 0 ? 0 : 1,
  fadeOutSec: untilSec >= 90 ? 0 : 1,
  ...extra,
});
const say = (id: string, atSec: number, radio: boolean, lines: [VoiceRole, string][], gainDb = 0): StoryDialogue => ({
  id,
  atSec,
  radio,
  gainDb,
  lines: lines.map(([voice, text]) => ({ voice, text })),
});

// Shared prompts: identical prompt + length = identical cache key, so a repeat is bought once.
const CARS = {
  beep: "A single short electronic start-light beep, one clean mid-pitched tone, close and clear.",
  shifts: "Racing car rapid gear upshifts heard from the cockpit: three crisp popping clicks, the engine note dropping and racing back up each time.",
  kerb: "Race car tyres bouncing over a rumble-strip kerb at speed: a fast brrrrrr rattling vibration, very close to the microphone.",
};

const cars: Story = {
  slug: "cars",
  title: "Race Day",
  cover: "A friendly little race car with big eyes and a big smile zooming along a colourful race track, a checkered flag waving and bunting over a small grandstand.",
  sfx: [
    bed("grid-crowd", 0, 23, 23, -10, "Race-car starting grid ambience: an excited crowd cheering and murmuring in big grandstands, light wind, mechanics' tools whirring nearby. No voices or words.", { fadeOutSec: 2 }),
    spot("visor-click", 0.2, 1.5, -2, "A racing helmet visor snapping shut with a crisp plastic click, heard from inside the helmet, very close."),
    spot("belts", 1.6, 3, -3, "Racing seat harness belts pulled tight: nylon straps zipping and metal buckles clicking shut, very close to the microphone."),
    spot("engine-start", 4.5, 4, -2, "A race car starter whining, then a high-revving racing engine firing up and settling into a loud lumpy idle, heard from inside the cockpit."),
    bed("engine-idle", 7.5, 22, 15, -6, "A racing car engine idling heard from inside the cockpit: a lumpy, high-pitched burble with small throttle blips, close and loud.", { fadeInSec: 0.5, fadeOutSec: 0.5 }),
    spot("revs", 14, 2.5, -3, "A racing car engine revving hard twice from the cockpit: a sharp high-pitched rev and quick drop."),
    spot("beep-1", 16, 0.6, -4, CARS.beep),
    spot("beep-2", 17, 0.6, -4, CARS.beep),
    spot("beep-3", 18, 0.6, -4, CARS.beep),
    spot("beep-4", 19, 0.6, -4, CARS.beep),
    spot("beep-5", 20, 0.6, -4, CARS.beep),
    spot("launch", 21.2, 5, -1, "A race car launching from a standing start, from the cockpit: the engine roaring to full revs, tyres chirping and gripping, rapid upshifts, roaring away."),
    bed("crowd-far", 22, 90, 30, -16, "A big happy crowd cheering in grandstands far away: a warm, continuous, distant roar. No voices or words.", { fadeInSec: 2 }),
    bed("tyre-hum", 24, 78, 20, -12, "Racing tyres humming over smooth asphalt at high speed: a steady low road roar, close to the wheels.", { fadeOutSec: 2 }),
    bed("race-engine", 25, 76, 30, -5, "Onboard a racing car at full speed: a loud high-pitched engine whine at high revs, wind rushing past the helmet, steady and continuous.", { takes: 2, fadeOutSec: 1.5 }),
    spot("shifts-1", 29, 3, -4, CARS.shifts),
    spot("whoosh-1", 34, 3, -4, "A race car zooming past a cheering grandstand: a loud crowd whoosh sweeping from left to right. No voices or words."),
    spot("kerb-1", 39, 2.5, -4, CARS.kerb),
    spot("downshift", 50, 3, -4, "A race car downshifting for a corner: quick popping exhaust crackles and throttle blips, then accelerating hard out again."),
    spot("whoosh-2", 56, 3, -4, "Rushing past a crowd at very high speed: cheering swelling up and whooshing by, fading behind. No voices or words."),
    spot("shifts-2", 60.5, 3, -4, CARS.shifts),
    spot("kerb-2", 67, 2.5, -4, CARS.kerb),
    spot("braking", 76, 3.5, -3, "A race car braking hard from high speed: the engine note falling with downshift blips, tyres scrubbing, slowing down."),
    spot("slowing", 79, 4, -5, "A race car slowing down gently: the engine dropping to a low burble, tyres rolling slower and slower."),
    bed("pit-limiter", 82.5, 87, 4.5, -6, "A race car rolling slowly down the pit lane on the speed limiter: a steady pulsing engine buzz at low speed.", { fadeInSec: 0.5, fadeOutSec: 0.8 }),
    spot("cheer", 84, 6, -5, "A pit crew and crowd cheering and clapping happily close by, a joyful celebration. No words.", { fadeOutSec: 0 }),
    spot("cooling", 86.5, 3.5, -4, "A hot race-car engine just switched off and cooling: soft metallic ticking and pinging, a gentle hiss.", { fadeOutSec: 0 }),
  ],
  dialogue: [
    say("radio-check", 8.5, true, [
      ["hero", "Radio check, how do you hear me?"],
      ["engineer", "[warmly] Loud and clear! Tyres are warm. You're ready to go."],
    ]),
    say("radio-lap", 43, true, [
      ["engineer", "[excited] Great lap! Keep pushing!"],
      ["hero", "[excited] Woohoo! The car feels amazing!"],
    ]),
    say("radio-fast", 62.5, true, [
      ["engineer", "Fastest sector! You are flying!"],
      ["hero", "[laughs] This is so much fun!"],
    ]),
    say("radio-box", 71, true, [
      ["engineer", "Box box, box box. Bring it home."],
      ["hero", "Copy, coming in!"],
    ]),
    say("radio-finish", 84, true, [
      ["engineer", "[happy] Amazing driving today!"],
      ["hero", "[laughs] Thank you, team!"],
    ]),
  ],
};

const FARM = {
  grass: "A dog running fast on soft grass: quick light paw thumps and happy panting, very close to the microphone, low to the ground.",
  barks: "Two happy, excited dog barks, close up and friendly.",
  moo: "A big friendly cow mooing slowly right up close: one deep, long, gentle moo.",
};

const farm: Story = {
  slug: "farm",
  title: "Farm Dog",
  cover: "A happy fluffy farm dog with floppy ears running across a green meadow past a red barn, a cow, a sheep, a pig, a duck and chickens.",
  sfx: [
    bed("farmyard", 0, 90, 30, -12, "Sunny farmyard heard close to the ground: birds chirping, a gentle breeze in the grass, hens clucking softly far away.", { takes: 2 }),
    bed("paws-grass-1", 0, 30, 15, -6, FARM.grass),
    spot("barks-1", 1.5, 2.5, -3, FARM.barks),
    spot("chickens", 8, 4, -3, "Chickens flapping their wings and clucking in surprise right next to the microphone, feathers fluttering."),
    spot("moo-1", 14, 3.5, -2, FARM.moo),
    spot("rooster", 20, 3, -5, "A cheerful rooster crowing nearby on a sunny morning."),
    spot("barks-2", 25, 2.5, -3, FARM.barks),
    bed("paws-gravel", 30, 46, 16, -6, "Dog paws trotting on crunchy gravel with happy panting, close up, low to the ground."),
    spot("gate", 31, 3, -3, "An old wooden farm gate creaking open slowly, then swinging shut with a soft knock."),
    spot("sheep", 36, 4, -3, "Sheep baaing close by, a small flock bleating gently and shuffling in the grass."),
    spot("barks-3", 40.5, 2.5, -3, FARM.barks),
    spot("splash", 44, 2.5, -2, "A dog jumping into a muddy puddle with a big playful splash, water spraying everywhere."),
    spot("shake", 47, 2.5, -4, "A wet dog shaking off water: ears flapping, collar tags jingling, droplets spraying."),
    bed("paws-grass-2", 46, 76, 15, -6, FARM.grass),
    spot("pig", 51, 4, -3, "A pig oinking and snuffling happily in straw, very close to the microphone."),
    spot("ducks", 57, 3.5, -3, "Ducks quacking excitedly and flapping their wings near a pond, close up."),
    spot("horse", 63, 4, -3, "A horse whinnying cheerfully and snorting, hooves shuffling on straw."),
    spot("barks-4", 68, 2.5, -3, FARM.barks),
    spot("happy-whine", 76, 4, -4, "A happy dog panting and wagging, collar tags jingling, a soft excited whine."),
    bed("hay-rest", 76, 90, 14, -6, "A dog lying down in soft hay: slow contented panting, straw rustling, a gentle breeze and birds."),
    spot("moo-2", 84, 3.5, -2, FARM.moo, { fadeOutSec: 0 }),
  ],
  dialogue: [
    say("farmer-1", 71, false, [
      ["conductor", "[happy] Hey there! Good dog! Who's a good dog?"],
      ["conductor", "Come on, let's get you a treat!"],
    ]),
    say("farmer-2", 80.5, false, [["conductor", "[laughs] You said hello to everyone today. Good dog!"]]),
  ],
};

const TRAIN = {
  station: "Busy, friendly train station platform in a big echoey hall: footsteps, soft chatter with no clear words, a rolling suitcase, pigeons cooing.",
  toot: "A cheerful steam train whistle: a classic choo-choo toot, close and bright.",
};

const train: Story = {
  slug: "train",
  title: "Train Driver",
  cover: "A smiling little steam engine with colourful carriages puffing round clouds of steam as it leaves a cosy station with a big clock.",
  sfx: [
    bed("station-1", 0, 24, 24, -10, TRAIN.station, { fadeOutSec: 2 }),
    bed("cab-idle", 0, 24, 24, -8, "A steam train standing at the platform, heard from inside the driver's cab: a steady hiss of steam and soft rhythmic huffing, close up."),
    spot("whistle", 11, 2, -3, "A conductor blowing a short, bright platform whistle."),
    spot("doors-close", 13.5, 3, -3, "Train doors sliding shut with a soft pneumatic hiss and a clunk."),
    spot("chug-start", 23, 8, -2, "A steam train starting to move: slow heavy chuffs speeding up gradually, wheels creaking, steam hissing."),
    bed("running", 30, 76, 30, -5, "Inside a steam train cab at speed: the rhythmic chuff chuff of the engine and clickety-clack of wheels on the rails, steady and continuous.", { takes: 2, fadeInSec: 1.5 }),
    spot("toot-1", 30.5, 3, -3, TRAIN.toot),
    spot("horn", 40, 2.5, -4, "A deep, friendly train horn blowing twice."),
    spot("tunnel", 48, 6, -2, "A train rushing into a tunnel: the sound turns into a deep echoey whoosh, then bursts back out into the open air."),
    spot("toot-2", 63, 3, -3, TRAIN.toot),
    spot("coal", 66, 4, -4, "Shovelling coal into a steam engine firebox: the scrape of a shovel and a soft whoosh of the fire."),
    spot("slowing", 74, 8, -2, "A steam train slowing down into a station: brakes squealing softly, chuffing getting slower, a long hiss of steam."),
    bed("station-2", 80, 90, 24, -10, TRAIN.station),
    spot("doors-open", 86.5, 3, -4, "Train doors sliding open with a soft hiss and a gentle ding.", { fadeOutSec: 0 }),
  ],
  dialogue: [
    say("announce-1", 1, false, [["announcer", "[cheerful] Good morning! The ten o'clock train is now ready on platform two."]], -2),
    say("all-aboard", 7.5, false, [["conductor", "[cheerful] All aboard! All aboard!"]]),
    say("radio-depart", 16.5, true, [
      ["hero", "Control, this is the ten o'clock train. Ready to go."],
      ["engineer", "[warmly] Ten o'clock train, you are clear to go. Have a lovely trip!"],
    ]),
    say("radio-run", 56, true, [
      ["engineer", "Lovely speed, driver. Next station in two minutes."],
      ["hero", "Copy that, control!"],
    ]),
    say("announce-2", 81, false, [["announcer", "[cheerful] We have now arrived at Sunny Hill. Thank you for travelling with us!"]], -2),
  ],
};

const SITE = {
  crane: "A big tower crane motor whirring and a winch chain rattling as it lifts a heavy load high above, close by.",
};

const construction: Story = {
  slug: "construction",
  title: "Building Site",
  cover: "A friendly tower crane, a yellow digger, a cement mixer and a little dump truck with big eyes working together on a sunny building site with orange cones.",
  sfx: [
    bed("site", 0, 90, 30, -12, "A busy, friendly construction site a little way off: engines humming, light hammering, gravel shifting, steady and continuous. No voices.", { takes: 2 }),
    bed("footsteps", 0, 90, 20, -10, "Close-up footsteps walking at a steady pace on crunchy gravel in heavy work boots."),
    spot("crane-1", 3, 8, -4, SITE.crane),
    bed("mixer", 12, 28, 16, -5, "A cement mixer drum turning and churning wet gravel: rhythmic sloshing and a chugging diesel motor, close by."),
    spot("forklift", 26, 6, -4, "A small forklift reversing with friendly beep beep beeps, then hydraulics whining as the forks lift."),
    spot("clang", 33, 4, -4, "Metal beams clanging gently as they are set down: ringing metallic clinks and a soft thud."),
    spot("welding", 37, 5, -5, "Welding sizzle and crackle close up: a steady buzzing hiss with little sparks popping."),
    spot("hammering", 43, 5, -3, "Rhythmic hammering of nails into wood close by, steady confident strikes."),
    spot("saw", 49, 5, -4, "A hand saw cutting through a wooden plank: back-and-forth rasping, then the cut piece dropping onto wood."),
    spot("chainsaw", 59, 3, -10, "A short chainsaw burst far away across a building site, softened by the distance."),
    spot("dump-truck", 63, 8, -3, "A dump truck tipping its load: a hydraulic whine, then a big pile of gravel pouring out and rumbling down."),
    spot("digger", 72, 6, -4, "A digger scooping dirt: the engine revving, hydraulic arm moving, the bucket scraping and dumping soil."),
    spot("crane-2", 80, 8, -4, SITE.crane),
    spot("toots", 87, 2.5, -5, "A friendly truck horn giving two short toots.", { fadeOutSec: 0 }),
  ],
  dialogue: [
    say("lift-1", 6.5, false, [
      ["announcer", "[shouting cheerfully] Lift it up!"],
      ["engineer", "[calling out] Nice and steady!"],
    ]),
    say("great-job", 54, false, [
      ["hero", "[cheerful] Great job, team!"],
      ["conductor", "Thanks! Nearly done with this wall!"],
    ]),
    say("lift-2", 79, false, [
      ["announcer", "[shouting cheerfully] Lift it up! Up, up, up!"],
      ["engineer", "[happy] Nice and steady... perfect!"],
    ]),
  ],
};

const SPACE = {
  breathing: "Calm, slow breathing inside a space helmet, very close: a soft inhale and exhale with a gentle air hiss.",
  switches: "Spacecraft cockpit switches flipped one by one: crisp toggle clicks and soft button beeps.",
};

const rocket: Story = {
  slug: "rocket",
  title: "Rocket Ride",
  cover: "A friendly round rocket with a big smile flying up through puffy clouds into a starry sky, the round blue Earth glowing below.",
  sfx: [
    bed("cabin", 0, 90, 30, -10, "Inside a small spacecraft cabin: soft fans humming, a gentle electronic hum, quiet occasional beeps.", { takes: 2 }),
    bed("breathing-1", 0, 40, 20, -6, SPACE.breathing, { fadeOutSec: 3 }),
    spot("switches-1", 1, 4, -3, SPACE.switches),
    spot("switches-2", 19, 4, -3, SPACE.switches),
    spot("ignition", 29.5, 6, -1, "Rocket engines igniting with a deep, powerful roar building up, heard from inside the capsule."),
    bed("rumble", 31, 58, 27, -3, "Inside a rocket climbing into the sky: a deep continuous rumble, the cabin shaking and rattling gently.", { fadeInSec: 0.5, fadeOutSec: 6 }),
    spot("rattle", 36, 4, -6, "Small loose things rattling in a gently shaking cabin, a soft metallic buzz."),
    spot("separation", 52, 3, -3, "A soft thunk and whoosh as a rocket stage separates, then the rumble fades away smoothly."),
    bed("glide", 56, 90, 30, -8, "A calm spacecraft gliding through space: a soft low hum and a gentle airy hiss, peaceful and smooth.", { fadeInSec: 4 }),
    spot("beeps", 60, 5, -6, "Gentle, soft computer beeps in a spacecraft: a calm, friendly blip pattern."),
    bed("breathing-2", 66, 90, 20, -6, SPACE.breathing, { fadeInSec: 3 }),
    spot("floating", 72, 8, -6, "Floating weightless in a spacecraft: soft fabric rustling, a gentle bump against a padded wall, a quiet hum."),
  ],
  dialogue: [
    say("prep", 4, true, [
      ["engineer", "[calm] Crew, this is mission control. Systems check, please."],
      ["hero", "Power, good. Air, good. Fuel, good!"],
    ]),
    say("go", 13, true, [
      ["engineer", "All systems are go. You are go for launch."],
      ["hero", "[excited] Copy, we are go!"],
    ]),
    say("countdown", 21, true, [["engineer", "Ten. Nine. Eight. Seven. Six. Five. Four. Three. Two. One. [excited] Lift off!"]]),
    say("climb", 42, true, [
      ["engineer", "[calm] Looking great. Engines running perfectly."],
      ["hero", "[laughs] Wow, we are going so fast!"],
    ]),
    say("welcome", 64, true, [
      ["engineer", "[warmly] Welcome to space! You did it!"],
      ["hero", "[whispers] Wow... I can see the whole Earth. It's beautiful."],
    ]),
    say("float", 80, true, [
      ["engineer", "[softly] Enjoy the view, astronaut. Float and relax."],
      ["hero", "[whispers] Copy. Floating..."],
    ]),
  ],
};

export const STORIES: Story[] = [cars, farm, train, construction, rocket];
