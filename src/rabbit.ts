// The rabbit body — the same C. elegans brain, a completely different animal.
//
// A side-scrolling meadow (wider than the screen; the camera follows the rabbit)
// with real gravity: the rabbit is a point mass with velocity, it falls, lands
// with a squash, and only leaves the ground when it actually needs to — it WALKS
// and RUNS on flat ground and JUMPS to clear a step, a gap, or reach food on a
// ledge. On top of the physics it runs a small ethogram driven by internal drives
// (energy, hunger, comfort, alertness, threat) plus the shared connectome
// (arousal from the forward command, startle from the reversal command): freeze,
// flee, forage, eat, sniff, groom, flop, sit, alert, thump, binky…
//
// A rabbit has no mapped connectome — this is the worm's brain wearing a rabbit
// suit, and proudly so. 🐇

import chalk from "chalk";
import type { Engine } from "./engine.ts";
import type { Creature, MotorReadout, Senses, StimulusKey, Vital } from "./creature.ts";
import type { FoodField } from "./food.ts";
import { motor, command } from "./connectome.ts";

// World / camera
const WORLD_SCALE = 2.6; // world is this many screens wide

// Physically-limited jumps (apex = v²/2g): hop ~4 rows, leap ~6.5, startle ~7.5.
const GRAVITY = 0.16;
const HOP_V = 1.15;
const LEAP_V = 1.45;
const STARTLE_V = 1.55;
const MAX_UP_V = 1.6;
const HOP_VX = 0.6; // horizontal speed in a clearing leap
// Rabbits travel by HOPPING, not walking: a "walk" is a string of little lollops,
// a "run" is a string of bigger bounds. Each is a small launch → the body bobs up
// and down like a real bunny instead of sliding along the ground.
const LOLLOP_UP = 0.72; // gentle amble hop (~1.6-row bob)
const LOLLOP_VX = 0.46;
const BOUND_UP = 1.05; // running bound (~3.4-row arc)
const BOUND_VX = 0.74;
const GROUND_FRICTION = 0.6;
const MIN_COOLDOWN = 7; // between big clearing leaps
const GAIT_CD = 2; // between travel hops → they chain into a smooth gait
const SQUASH_TICKS = 4;
const HARD_LANDING = 1.0; // only impacts faster than this squash on landing
const STARTLE_SURGE = 0.1;

// Energy & drives (all 0..1). Resting is emergent: low energy forces a flop.
const E_HOP = 0.05;
const E_LEAP = 0.09;
const E_RUN = 0.008; // per tick running
const E_FLEE = 0.013;
const E_REST = 0.006;
const E_EAT = 0.025;
const E_TIRED = 0.12;
const HUNGER_RISE = 0.0009;

// Warm rabbit palette.
const FUR = chalk.rgb(214, 168, 122);
const FUR_DK = chalk.rgb(170, 120, 80);
const FACE = chalk.rgb(255, 234, 210);
const NOSE = chalk.rgb(255, 150, 170);

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** A grassy block. `solid` ones (steps/walls) block sideways motion; non-solid
 *  ones are floating shelves — land on top, bonk the head from below. */
interface Obstacle {
    x0: number;
    x1: number;
    top: number;
    solid: boolean;
}

type Surface = { x0: number; x1: number; top: number };

export class Rabbit implements Creature {
    readonly kind = "rabbit" as const;
    readonly habitatTitle = "meadow";
    readonly habitatAccent = chalk.rgb(120, 160, 90);

    x = 0;
    y = 0; // feet, in WORLD coords
    heading: 1 | -1 = 1;
    speed = 0;
    behavior = "sit";

    // physics
    private vx = 0;
    private vy = 0;
    private onGround = true;
    private surface: Obstacle | null = null;
    private floor = 0;
    private binky = false;

    // world + camera
    private worldW = 0;
    private viewW = 0;
    private camX = 0;
    private placed = false;
    private obstacles: Obstacle[] = [];
    private surfaces: Surface[] = [];
    private adj: number[][] = []; // reachable-hop graph between surfaces
    private spawnX = 0;

    // drives
    energy = 0.8;
    private hunger = 0.3;
    private comfort = 0.5;
    private alertness = 0;
    private threat = 0;

    // timers / state
    private cooldown = 0;
    private squash = 0;
    private turnLock = 0;
    private freezeTimer = 0;
    private fleeTimer = 0;
    private fleeDir: 1 | -1 = 1;
    private pendingFlee = false; // freeze first, then bolt
    private action = "sit"; // current sustained ambient action
    private actionTimer = 0;
    private perceptText = "";
    private perceptTimer = 0;
    private revBaseline = 0;
    private primed = false;
    private gait = 0; // steady tick counter → drives animation cycles
    private bounding: string | null = null; // current travel gait while airborne (walk/run/flee)
    private lastForageX = 0; // progress watchdog while foraging
    private forageStuck = 0;
    private hopsLeft = 0; // remaining lollops in the current walk burst
    private pauseTimer = 0; // stand-and-look pause between walk bursts

    constructor(private engine: Engine) {}

    reset(): void {
        this.vx = this.vy = this.speed = 0;
        this.heading = 1;
        this.behavior = "sit";
        this.onGround = true;
        this.surface = null;
        this.binky = false;
        this.camX = 0;
        this.placed = false;
        this.energy = 0.8;
        this.hunger = 0.3;
        this.comfort = 0.5;
        this.alertness = 0;
        this.threat = 0;
        this.cooldown = MIN_COOLDOWN;
        this.squash = 0;
        this.turnLock = 0;
        this.freezeTimer = 0;
        this.fleeTimer = 0;
        this.pendingFlee = false;
        this.action = "sit";
        this.actionTimer = 0;
        this.perceptText = "";
        this.perceptTimer = 0;
        this.revBaseline = 0;
        this.primed = false;
        this.bounding = null;
        this.lastForageX = 0;
        this.forageStuck = 0;
        this.hopsLeft = 0;
        this.pauseTimer = 0;
    }

    /** Travel by hopping. A small launch in the heading direction; chains into a
     *  smooth gait via the short GAIT_CD cooldown. `label` keeps walk/run/flee
     *  showing on the panel through the airborne arc. */
    private gaitHop(up: number, vxBase: number, label: string, ecost: number): void {
        this.vy = -up;
        this.vx = this.heading * vxBase * (0.85 + 0.3 * Math.random());
        this.onGround = false;
        this.surface = null;
        this.cooldown = GAIT_CD;
        this.bounding = label;
        this.behavior = label;
        this.energy = Math.max(0, this.energy - ecost);
    }

    place(viewW: number, h: number): void {
        this.viewW = viewW;
        this.worldW = Math.max(viewW + 20, Math.round(viewW * WORLD_SCALE));
        this.floor = h - 1;
        this.buildMeadow(this.worldW, h);
        this.x = this.spawnX;
        this.y = this.floor;
        this.onGround = true;
        this.surface = null;
        this.camX = Math.max(0, Math.min(this.worldW - viewW, this.x - viewW / 2));
        this.placed = true;
    }

    private clearGround(x: number): boolean {
        return !this.obstacles.some((o) => o.solid && x >= o.x0 - 1 && x <= o.x1 + 1);
    }

    private clearColumn(w: number, frac: number): number {
        const start = Math.round(w * frac);
        for (let d = 0; d < w; d++) {
            for (const cand of [start + d, start - d]) {
                if (cand > 3 && cand < w - 3 && this.clearGround(cand)) return cand;
            }
        }
        return Math.round(w / 2);
    }

    /** Randomised, provably-reachable terrain across the WHOLE (wide) world. */
    private buildMeadow(w: number, h: number): void {
        const floor = h - 1;
        const VSTEP = 3;
        const HREACH = 5;
        const clampTop = (t: number) => Math.max(2, Math.min(floor - 1, t));
        this.obstacles = [];
        this.surfaces = [{ x0: 0, x1: w - 1, top: floor }];

        // one or two solid stepped hills with stairs on BOTH sides + a plateau
        const hills = w > 120 ? 1 + Math.floor(Math.random() * 2) : 1;
        for (let hI = 0; hI < hills; hI++) {
            const levels = 2 + Math.floor(Math.random() * 2);
            const sw = 4; // wider steps / plateaus (still ≤ HREACH so reachable)
            const cx = Math.round(w * ((hI + 0.5) / hills) + (Math.random() - 0.5) * 10);
            for (let i = 1; i <= levels; i++) {
                const top = clampTop(floor - i * 2);
                const half = (levels - i + 1) * sw;
                this.obstacles.push({ x0: Math.max(1, cx - half), x1: Math.min(w - 2, cx + half), top, solid: true });
                if (i === levels) this.surfaces.push({ x0: cx - sw, x1: cx + sw, top });
                else {
                    this.surfaces.push({ x0: cx - half, x1: cx - half + sw - 1, top });
                    this.surfaces.push({ x0: cx + half - sw + 1, x1: cx + half, top });
                }
            }
        }

        // floating shelves spread across the whole width with gaps
        const tryShelf = (cxWanted: number, pw: number): boolean => {
            let support = this.surfaces[0];
            for (const s of this.surfaces) {
                const near = cxWanted >= s.x0 - HREACH && cxWanted <= s.x1 + HREACH;
                if (near && s.top < support.top) support = s;
            }
            const top = clampTop(support.top - VSTEP);
            if (top >= support.top - 1) return false;
            const x0 = Math.max(2, Math.min(w - 2 - pw, cxWanted - (pw >> 1)));
            const x1 = x0 + pw - 1;
            if (this.surfaces.some((s) => Math.abs(s.top - top) < 2 && !(x1 < s.x0 - 2 || x0 > s.x1 + 2))) return false;
            if (Math.max(0, Math.max(support.x0 - x1, x0 - support.x1)) > HREACH) return false;
            this.obstacles.push({ x0, x1, top, solid: false });
            this.surfaces.push({ x0, x1, top });
            return true;
        };
        // sparse floating shelves — wide zones, most left open for a clean meadow
        const zones = Math.max(3, Math.floor(w / 18));
        for (let z = 0; z < zones; z++) {
            if (Math.random() < 0.45) continue; // lots of open space
            const cx = Math.round(((z + 0.5) / zones) * w + (Math.random() - 0.5) * 6);
            tryShelf(cx, 7 + Math.floor(Math.random() * 4)); // wider ledges (7–10)
        }
        // at most one little tower to climb
        if (Math.random() < 0.6) {
            const base = this.surfaces[1 + Math.floor(Math.random() * Math.max(1, this.surfaces.length - 1))];
            if (base) tryShelf(Math.round((base.x0 + base.x1) / 2) + (Math.random() < 0.5 ? -3 : 3), 7);
        }

        this.spawnX = this.clearColumn(w, 0.5);

        // reachable-hop graph: edge i→j if j is within HREACH horizontally and at
        // most VSTEP above i (dropping down is always allowed). Used to navigate.
        this.adj = this.surfaces.map(() => []);
        for (let i = 0; i < this.surfaces.length; i++) {
            for (let j = 0; j < this.surfaces.length; j++) {
                if (i === j) continue;
                const a = this.surfaces[i];
                const b = this.surfaces[j];
                const hgap = Math.max(0, Math.max(b.x0 - a.x1, a.x0 - b.x1));
                if (hgap > HREACH) continue;
                if (a.top - b.top > VSTEP) continue; // b too high above a to hop
                this.adj[i].push(j);
            }
        }
    }

    /** Index of the surface the rabbit/food is standing on. */
    private surfaceAt(x: number, topY: number): number {
        let best = -1;
        let bestd = 1e9;
        for (let i = 0; i < this.surfaces.length; i++) {
            const s = this.surfaces[i];
            if (x >= s.x0 - 1 && x <= s.x1 + 1) {
                const d = Math.abs(s.top - topY);
                if (d < bestd) {
                    bestd = d;
                    best = i;
                }
            }
        }
        return best;
    }

    /** First surface to hop to on the shortest path from→to (BFS), or -1. */
    private nextWaypoint(from: number, to: number): number {
        if (from < 0 || to < 0 || from === to) return to;
        const prev = new Array(this.surfaces.length).fill(-1);
        const seen = new Array(this.surfaces.length).fill(false);
        const q = [from];
        seen[from] = true;
        while (q.length) {
            const u = q.shift() as number;
            if (u === to) break;
            for (const v of this.adj[u]) {
                if (!seen[v]) {
                    seen[v] = true;
                    prev[v] = u;
                    q.push(v);
                }
            }
        }
        if (!seen[to]) return -1;
        let cur = to;
        while (prev[cur] !== from && prev[cur] !== -1) cur = prev[cur];
        return cur;
    }

    headingLabel(): string {
        return this.heading === 1 ? "▸ right" : "◂ left";
    }

    statusTag(): string {
        if (this.squash > 0) return chalk.yellow("▼ landing");
        if (!this.onGround) return chalk.cyanBright("⤒ airborne");
        return "";
    }

    suggestFood(viewW: number, h: number): { x: number; y: number; sigma: number } {
        // food only appears within the visible window, on a reachable surface
        const lo = this.camX;
        const hi = this.camX + viewW;
        const visible = this.surfaces.filter((s) => s.x1 >= lo + 2 && s.x0 <= hi - 2);
        const pool = visible.length ? visible : this.surfaces;
        const s = pool[Math.floor(Math.random() * pool.length)] ?? { x0: 2, x1: viewW - 2, top: h - 1 };
        const x0 = Math.max(s.x0, Math.round(lo) + 2);
        const x1 = Math.min(s.x1, Math.round(hi) - 2);
        const x = x1 >= x0 ? x0 + Math.floor(Math.random() * (x1 - x0 + 1)) : Math.round((s.x0 + s.x1) / 2);
        return { x, y: s.top, sigma: 4 };
    }

    readMotor(): MotorReadout {
        return {
            forward: this.engine.pool(motor.forward),
            backward: this.engine.pool(motor.backward),
            dorsal: this.engine.pool(motor.dorsalExc) - 0.5 * this.engine.pool(motor.dorsalInh),
            ventral: this.engine.pool(motor.ventralExc) - 0.5 * this.engine.pool(motor.ventralInh),
        };
    }

    private supported(x: number): boolean {
        if (!this.surface) return true;
        return x >= this.surface.x0 - 0.5 && x <= this.surface.x1 + 0.5;
    }

    private obstacleAhead(): boolean {
        const probe = this.x + this.heading * 2;
        for (const o of this.obstacles) {
            if (o.solid && probe >= o.x0 - 0.5 && probe <= o.x1 + 0.5 && this.y > o.top) return true;
        }
        return false;
    }

    private launch(vy: number, vx: number, behavior: string): void {
        this.vy = Math.max(-MAX_UP_V, vy);
        this.vx = vx;
        this.onGround = false;
        this.surface = null;
        this.cooldown = MIN_COOLDOWN;
        this.behavior = behavior;
        this.bounding = null; // a real (climbing/reaction) leap, not a travel gait
        this.energy = Math.max(0, this.energy - (behavior === "leap" ? E_LEAP : E_HOP));
    }

    // ── stimuli ──────────────────────────────────────────────────────────────
    perceive(kind: string): void {
        switch (kind) {
            case "predator":
                this.threat = 1;
                this.alertness = 1;
                this.freezeTimer = 12 + Math.floor(Math.random() * 6);
                this.pendingFlee = true;
                this.flash(chalk.redBright("‼ predator!"), 75);
                break;
            case "touch_front":
            case "touch_back":
                this.threat = Math.max(this.threat, 0.6);
                this.alertness = Math.max(this.alertness, 0.7);
                this.freezeTimer = 4;
                this.pendingFlee = true;
                this.flash(chalk.yellowBright(kind === "touch_back" ? "! poked" : "! touched"), 45);
                break;
            case "sound":
                this.alertness = 1;
                this.freezeTimer = 7;
                this.flash(chalk.yellow("… a rustle"), 55);
                break;
            case "pet":
                this.threat = 0;
                this.alertness = 0;
                this.comfort = clamp01(this.comfort + 0.45);
                this.action = "groom";
                this.actionTimer = 30;
                this.flash(chalk.rgb(255, 150, 190)("♥ being petted"), 70);
                break;
        }
    }

    private flash(text: string, ticks: number): void {
        this.perceptText = text;
        this.perceptTimer = ticks;
    }

    /** Rest only refuels up to a ceiling that falls as hunger rises — so without
     *  food, energy plateaus low and the rabbit turns sluggish until it eats. */
    private rest(amount: number): void {
        const ceil = clamp01(1 - this.hunger * 0.85);
        if (this.energy < ceil) this.energy = Math.min(ceil, this.energy + amount);
    }

    // ── per-tick brain → drives → behaviour ──────────────────────────────────
    update(viewW: number, h: number, food: FoodField | null, dwell = 0): void {
        if (!this.placed) this.place(viewW, h);
        this.viewW = viewW;
        this.floor = h - 1;

        const m = this.readMotor();
        const reverse = this.engine.pool(command.backward) + 0.4 * m.backward;
        const forward = this.engine.pool(command.forward) + 0.4 * m.forward;
        if (!this.primed) {
            this.revBaseline = reverse;
            this.primed = true;
        }
        this.revBaseline = this.revBaseline * 0.99 + reverse * 0.01;
        const surge = reverse - this.revBaseline;
        const arousal = Math.min(1, forward + m.forward + m.backward + 0.25);
        const prevFeet = this.y;

        if (this.onGround) this.think(surge, arousal, food, dwell, h);

        if (!this.onGround) {
            this.vy += GRAVITY;
            // a travel hop keeps its walk/run/flee label through the arc; a real
            // leap shows leap (rising) / hop (falling).
            this.behavior = this.binky ? "binky" : this.bounding ? this.bounding : this.vy < 0 ? "leap" : "hop";
        }

        this.integrate(prevFeet);

        // camera: dead-zone follow
        const margin = Math.max(6, Math.floor(viewW * 0.34));
        const sx = this.x - this.camX;
        if (sx < margin) this.camX = this.x - margin;
        else if (sx > viewW - margin) this.camX = this.x - (viewW - margin);
        this.camX = Math.max(0, Math.min(Math.max(0, this.worldW - viewW), this.camX));

        // Locomotor speed for the panel bar. Eased toward a per-gait target
        // rather than read from raw velocity — the instantaneous velocity is
        // dominated by the vertical hop, so it spiked mid-bound and fell to ~0
        // between bounds, flicking the bar 0↔full. Easing gives a steady value
        // that ramps up/down and cleanly separates amble < bound < flee.
        this.speed += (this.locomotorTarget() - this.speed) * 0.12;
    }

    // Representative ground speed per gait, in 0..0.5 so the panel's ×2 bar
    // spans empty→full. Resting states read 0; the bar settles there as the
    // rabbit comes to rest.
    private locomotorTarget(): number {
        switch (this.behavior) {
            case "flee":
                return 0.5;
            case "zoomies":
                return 0.48;
            case "leap":
                return 0.46;
            case "run":
                return 0.42;
            case "binky":
                return 0.34;
            case "hop":
                return 0.3;
            case "walk":
            case "forage":
                return 0.24;
            default:
                return 0; // sit / sniff / groom / thump / freeze / flop / alert / eat
        }
    }

    /** Decide what to do this grounded tick (drives + brain + terrain). */
    private think(surge: number, arousal: number, food: FoodField | null, dwell: number, h: number): void {
        this.cooldown = Math.max(0, this.cooldown - 1);
        this.turnLock = Math.max(0, this.turnLock - 1);
        if (this.squash > 0) this.squash--;
        if (this.perceptTimer > 0) this.perceptTimer--;
        if (this.actionTimer > 0) this.actionTimer--;

        // drives drift
        this.hunger = clamp01(this.hunger + HUNGER_RISE);
        this.alertness = clamp01(this.alertness * 0.985 + (surge > 0.05 ? surge * 0.4 : 0));
        this.threat *= 0.96;
        const safe = this.threat < 0.12 && this.alertness < 0.25;
        // Comfort is real contentment: a rabbit can only feel comfortable when it
        // is safe AND fed AND rested. Hunger and exhaustion each eat into it, so a
        // starving or worn-out bunny is never "comfortable" even if nothing
        // threatens it. Comfort eases toward this needs-based target.
        let comfortTarget = safe ? 1 : 0.15;
        comfortTarget -= this.hunger * 0.7; // hungry → uneasy
        comfortTarget -= (1 - clamp01(this.energy / 0.5)) * 0.5; // exhausted → uneasy
        this.comfort = clamp01(this.comfort + (clamp01(comfortTarget) - this.comfort) * 0.03);

        const eating = dwell > 0.55;
        if (eating) {
            // food is the real fuel — eating refills energy and stomach
            this.energy = Math.min(1, this.energy + E_EAT);
            this.hunger = Math.max(0, this.hunger - 0.03);
            this.comfort = clamp01(this.comfort + 0.01);
        } else {
            this.rest(E_REST); // rest only tops up to the hunger-limited ceiling
        }
        const rested = this.energy > E_TIRED;

        // walked off an edge → fall
        if (!this.supported(this.x)) {
            this.onGround = false;
            this.surface = null;
            return;
        }

        // touch surge with no explicit stimulus (spontaneous) → mild startle
        if (rested && surge > STARTLE_SURGE && this.threat < 0.3 && this.cooldown === 0) {
            this.threat = Math.max(this.threat, 0.5);
        }

        // ── priority ethogram ────────────────────────────────────────────────
        if (this.freezeTimer > 0) {
            this.freezeTimer--;
            this.vx = 0;
            this.behavior = "freeze";
            if (this.freezeTimer === 0 && (this.pendingFlee || this.threat > 0.5)) {
                this.fleeTimer = 35;
                this.fleeDir = this.x < this.worldW / 2 ? 1 : -1; // bolt to the open side
                this.pendingFlee = false;
            }
            return;
        }
        if (this.fleeTimer > 0 || this.threat > 0.5 || this.pendingFlee) {
            if (this.fleeTimer <= 0) {
                this.fleeTimer = 30;
                this.fleeDir = this.x < this.worldW / 2 ? 1 : -1;
                this.pendingFlee = false;
            }
            this.fleeTimer--;
            this.heading = this.fleeDir;
            if (this.obstacleAhead() && this.cooldown === 0) {
                this.launch(-LEAP_V, this.heading * HOP_VX, "leap");
            } else if (this.cooldown === 0) {
                this.gaitHop(BOUND_UP * 1.05, BOUND_VX * 1.05, "flee", E_FLEE); // panic bounds
            } else {
                this.vx *= GROUND_FRICTION;
                this.behavior = "flee";
            }
            return;
        }
        // Eating and reaching food come BEFORE flopping: a hungry rabbit will drag
        // itself to visible food (that's the only way out of an energy slump).
        if (eating) {
            this.vx *= GROUND_FRICTION;
            this.behavior = "eat";
            return;
        }
        if (food) {
            this.forage(food);
            return;
        }
        if (!rested) {
            this.vx *= GROUND_FRICTION;
            this.rest(E_REST * 0.9); // no food in sight + tired → flop and conserve
            this.comfort = clamp01(this.comfort + 0.002);
            this.behavior = "flop";
            return;
        }
        if (this.alertness > 0.5) {
            this.vx *= GROUND_FRICTION;
            if (this.alertness > 0.72 && Math.random() < 0.05) {
                this.behavior = "thump";
                this.alertness -= 0.18;
            } else this.behavior = "alert";
            return;
        }
        this.ambient(arousal);
    }

    /** Go to the carrot. Travel toward its column by hops; when it sits up on a
     *  ledge, use the reachability graph to find that ledge, creep out to its
     *  nearest EDGE and hop up *inward* from beside it — so the arc lands on top.
     *  (The old version leapt at the carrot's column, which headbutted the ledge
     *  underside forever whenever the rabbit ended up directly below it.) */
    private forage(food: FoodField): void {
        const dx = food.x - this.x;
        const adx = Math.abs(dx);
        const myTop = this.surface ? this.surface.top : this.floor;
        const higher = food.y < myTop - 1.2;
        const onLevel = Math.abs(food.y - myTop) <= 1.2;

        // arrived: same level, over the carrot
        if (onLevel && adx < 1.5) {
            this.vx *= GROUND_FRICTION;
            this.behavior = "forage";
            this.forageStuck = 0;
            return;
        }

        // face the carrot (deadzone avoids jitter at the target)
        if (this.turnLock === 0 && adx > 1.5) this.heading = (dx >= 0 ? 1 : -1) as 1 | -1;

        // progress watchdog → if wedged, force a leap toward the carrot
        if (Math.abs(this.x - this.lastForageX) < 0.3) this.forageStuck++;
        else this.forageStuck = 0;
        this.lastForageX = this.x;

        // brief ground contact between travel hops: settle, keep the gait label
        if (this.cooldown > 0) {
            this.vx *= GROUND_FRICTION;
            this.behavior = this.bounding ?? "walk";
            return;
        }

        // wary approach: a calm, only-peckish rabbit creeps up on food in fits and
        // starts, stopping to check for danger between hops — a starving one barely
        // pauses. (Skipped below when it has to climb/clear or it's wedged.)
        if (this.pauseTimer > 0) {
            this.pauseTimer--;
            this.vx *= GROUND_FRICTION;
            this.bounding = null;
            this.behavior = "sniff";
            return;
        }

        // The carrot is up on a FLOATING ledge → reach it by its open edge, never
        // by leaping at its column from underneath (that just headbutts the ledge's
        // underside forever). We climb ONE floating level at a time, and rather than
        // guess the geometry we *simulate* candidate leaps against the real terrain
        // (planClimb) and only commit to a launch spot + speed the physics confirms
        // lands on the ledge — so it can't bonk an intermediate shelf or overshoot a
        // narrow one. Solid stepped hills fall through to the greedy climb below
        // (you can never stand *under* a solid hill).
        if (higher && adx < 18) {
            // lowest floating shelf above us that sits under the carrot's column
            const ledge = this.obstacles
                .filter((o) => !o.solid && o.top < myTop - 1.2 && o.top >= food.y - 0.5 && food.x >= o.x0 - 8 && food.x <= o.x1 + 8)
                .sort((a, b) => b.top - a.top)[0];
            const plan = ledge ? this.planClimb(ledge, myTop) : null;
            if (plan && ledge) {
                // Only spring once the physics confirms a leap from THIS exact spot
                // lands on the ledge — launching even half a cell early clips the
                // underside. Until then, creep along the ground toward the planned
                // launch column (a low shuffle, no hop, so we don't bonk the ledge).
                if (this.leapLands(this.x, myTop, plan.vx, ledge)) {
                    this.heading = (plan.vx >= 0 ? 1 : -1) as 1 | -1;
                    this.launch(-LEAP_V, plan.vx, "leap");
                    this.forageStuck = 0;
                    return;
                }
                this.heading = (plan.x > this.x ? 1 : -1) as 1 | -1;
                this.vx = this.heading * LOLLOP_VX * 0.9;
                this.behavior = "walk";
                this.forageStuck = 0;
                return;
            }
        }

        // clear a solid step in the way, unwedge if stuck, or climb a stepped hill
        // by leaping toward the carrot (each leap gains a step).
        if (this.obstacleAhead() || this.forageStuck > 24 || (higher && adx < 11)) {
            const dir = (adx < 1.5 ? this.heading : dx >= 0 ? 1 : -1) as 1 | -1;
            this.heading = dir;
            this.launch(-LEAP_V, dir * HOP_VX, "leap");
            this.forageStuck = 0;
            return;
        }

        // travel toward the carrot by hopping (lollop, or bound if hungry/far)
        const urgent = this.hunger > 0.5 || adx > 12;
        if (urgent) {
            this.gaitHop(BOUND_UP, BOUND_VX, "run", E_RUN * 1.5);
        } else {
            this.gaitHop(LOLLOP_UP, LOLLOP_VX, "walk", E_RUN * 0.6);
            // sometimes pause after this hop to look around — rarer the hungrier it is
            if (Math.random() < 0.2 * (1 - this.hunger)) this.pauseTimer = 6 + Math.floor(Math.random() * 12);
        }
    }

    /** Find a launch spot + horizontal velocity that lands the rabbit ON ledge `L`.
     *  Scans columns just outside L's two edges (nearest first) and a few launch
     *  speeds, simulating each parabola against the real obstacles; returns the
     *  closest one the physics confirms lands on L, or null (→ greedy fallback). */
    private planClimb(L: Obstacle, myTop: number): { x: number; vx: number } | null {
        const onSurface = (x: number) =>
            Math.abs(myTop - this.floor) <= 0.6 || this.surfaces.some((s) => Math.abs(s.top - myTop) <= 0.6 && x >= s.x0 - 0.5 && x <= s.x1 + 0.5);
        let best: { x: number; vx: number } | null = null;
        let bestD = Infinity;
        for (let d = 1; d <= 6; d++) {
            for (const [lx, inward] of [[L.x0 - d, 1], [L.x1 + d, -1]] as const) {
                if (!onSurface(lx)) continue;
                const dd = Math.abs(lx - this.x);
                if (dd >= bestD) continue;
                for (const vmag of [HOP_VX * 0.45, HOP_VX * 0.7, HOP_VX]) {
                    if (this.leapLands(lx, myTop, inward * vmag, L)) {
                        best = { x: lx, vx: inward * vmag };
                        bestD = dd;
                        break; // gentlest speed that lands from this column
                    }
                }
            }
        }
        return best;
    }

    /** Simulate a leap from (x0, feet0) with velocity (vx, -LEAP_V) using the same
     *  rules as integrate(), and report whether it lands cleanly on top of `L`. */
    private leapLands(x0: number, feet0: number, vx: number, L: Obstacle): boolean {
        let x = x0;
        let y = feet0;
        let vy = -LEAP_V;
        for (let t = 0; t < 80; t++) {
            const py = y;
            vy += GRAVITY;
            x += vx;
            y += vy;
            if (vy < 0) {
                // rising: bonk a shelf underside → blocked
                for (const o of this.obstacles) {
                    if (o.solid) continue;
                    if (x >= o.x0 - 0.5 && x <= o.x1 + 0.5 && py - 2 >= o.top - 0.001 && y - 2 < o.top) return false;
                }
            } else {
                // descending: land on the first surface crossed
                for (const o of this.obstacles) {
                    if (x >= o.x0 - 0.5 && x <= o.x1 + 0.5 && py <= o.top + 0.001 && y >= o.top) return o === L;
                }
                if (y >= this.floor) return false; // back to the ground, missed
            }
            // a solid block in the flight path stops us short
            for (const o of this.obstacles) {
                if (o.solid && y > o.top + 0.001 && x >= o.x0 - 0.5 && x <= o.x1 + 0.5) return false;
            }
        }
        return false;
    }

    /** Idle life: pick an action and live it for a natural little while. A real
     *  rabbit is mostly STILL — loafing, grooming, scanning — and when it does
     *  travel it goes in short bursts of hops broken by pauses, never a steady
     *  continuous bounce. */
    private ambient(arousal: number): void {
        if (this.actionTimer <= 0) {
            const calm = this.comfort > 0.55 && this.energy > 0.5;
            // "liveliness" from the brain: the forward-command arousal (≈0.25
            // baseline) and how rested it is decide whether it lazes or bustles.
            // Active behaviours scale up with it, still ones scale down — so the
            // ethogram you see is genuinely driven by the nervous-system readout.
            const live = clamp01((arousal - 0.25) * 1.6 + (this.energy - 0.4) * 0.6);
            const still = 1.4 - 0.9 * live; // weight multiplier for resting states
            const move = 0.5 + 1.3 * live; // weight multiplier for active states
            const opts: [string, number][] = [
                ["sit", 4 * still], // loafing — the default state of a relaxed rabbit
                ["sniff", 3 * still], // nose to the ground, investigating
                ["walk", 3 * move], // a short burst of lollops, then a pause
                ["groom", (calm ? 3 : 1.2) * still],
                ["periscope", 2], // sit up tall and scan the meadow
                ["flop", calm ? 1.6 * still : 0], // the contented "dead-bunny" flop
                ["hop", 0.8 * move],
                ["binky", calm && this.energy > 0.6 ? 1.2 * move : 0],
                ["zoomies", calm && this.energy > 0.7 && live > 0.4 ? 1.1 * move : 0], // the "mad half-hour"
                ["thump", 0.25],
            ];
            const total = opts.reduce((s, o) => s + o[1], 0);
            let r = Math.random() * total;
            let pick = "sit";
            for (const [name, wgt] of opts) {
                r -= wgt;
                if (r <= 0) {
                    pick = name;
                    break;
                }
            }
            this.action = pick;
            const dur: Record<string, [number, number]> = {
                sit: [28, 66], // long, still loafs
                sniff: [16, 32],
                walk: [26, 64],
                groom: [28, 54],
                periscope: [18, 36],
                flop: [70, 150], // a good, lazy flop
                zoomies: [22, 46], // a frantic happy dash
                thump: [8, 14],
                hop: [0, 0],
                binky: [0, 0],
            };
            const [a, b] = dur[pick] ?? [16, 24];
            this.actionTimer = a + Math.floor(Math.random() * Math.max(1, b - a + 1));
            if (pick === "walk") {
                this.hopsLeft = 1 + Math.floor(Math.random() * 3);
                this.pauseTimer = 0;
                if (Math.random() < 0.4) {
                    this.heading = (this.heading === 1 ? -1 : 1) as 1 | -1;
                    this.turnLock = 12;
                }
            }
        }

        // steer away from world edges while wandering
        if (this.turnLock === 0) {
            if (this.x > this.worldW - 6) this.heading = -1;
            else if (this.x < 6) this.heading = 1;
        }

        switch (this.action) {
            case "walk": {
                // a stop-start amble: a run of 1–3 little lollops, then settle and
                // look around for a beat — rabbits travel in bursts, never glide.
                if (this.pauseTimer > 0) {
                    this.pauseTimer--;
                    this.vx *= GROUND_FRICTION;
                    this.bounding = null;
                    this.behavior = "sniff"; // standing between bursts, nose twitching
                    break;
                }
                if (this.cooldown > 0) {
                    this.vx *= GROUND_FRICTION;
                    this.behavior = this.bounding ?? "walk";
                    break;
                }
                if (this.hopsLeft <= 0) {
                    // burst done → pause, look, sometimes turn before the next burst
                    this.pauseTimer = 8 + Math.floor(Math.random() * 18);
                    this.hopsLeft = 1 + Math.floor(Math.random() * 3);
                    if (Math.random() < 0.3) {
                        this.heading = (this.heading === 1 ? -1 : 1) as 1 | -1;
                        this.turnLock = 10;
                    }
                    break;
                }
                if (this.obstacleAhead()) this.launch(-HOP_V, this.heading * HOP_VX, "hop");
                else this.gaitHop(LOLLOP_UP, LOLLOP_VX, "walk", E_RUN * 0.4);
                this.hopsLeft--;
                break;
            }
            case "periscope":
                // up on the haunches, scanning — alert but relaxed (curiosity, not fear)
                this.vx *= GROUND_FRICTION;
                this.bounding = null;
                this.behavior = "periscope";
                break;
            case "flop":
                // flump onto one side and laze — only a safe, content rabbit does this
                this.vx *= GROUND_FRICTION;
                this.bounding = null;
                this.behavior = "flop";
                this.comfort = clamp01(this.comfort + 0.004);
                this.rest(E_REST);
                break;
            case "zoomies":
                // the "mad half-hour": a giddy sprint that keeps changing its mind,
                // flipping direction mid-dash. Burns energy fast so it self-limits.
                if (this.cooldown > 0) {
                    this.vx *= GROUND_FRICTION;
                    this.behavior = this.bounding ?? "zoomies";
                } else {
                    if (this.turnLock === 0 && Math.random() < 0.14) {
                        this.heading = (this.heading === 1 ? -1 : 1) as 1 | -1;
                        this.turnLock = 6;
                    }
                    if (this.obstacleAhead()) this.launch(-LEAP_V, this.heading * HOP_VX, "leap");
                    else this.gaitHop(BOUND_UP * 1.05, BOUND_VX * 1.15, "zoomies", E_RUN * 1.4);
                    this.energy = Math.max(0, this.energy - 0.003);
                    this.comfort = clamp01(this.comfort + 0.004);
                }
                break;
            case "hop":
                if (this.cooldown === 0) this.launch(-HOP_V * (0.85 + 0.3 * Math.random()), this.heading * HOP_VX * (0.6 + 0.4 * Math.random()), "hop");
                this.actionTimer = 0; // one-shot
                break;
            case "binky":
                if (this.cooldown === 0 && this.energy > 0.5) {
                    this.binky = true;
                    this.launch(-LEAP_V, this.heading * HOP_VX * 0.5, "binky");
                    this.energy = Math.max(0, this.energy - 0.04);
                    this.comfort = clamp01(this.comfort + 0.06);
                } else this.behavior = "sit";
                this.actionTimer = 0;
                break;
            case "sniff":
                this.vx *= GROUND_FRICTION;
                this.behavior = "sniff";
                break;
            case "groom":
                this.vx *= GROUND_FRICTION;
                this.behavior = "groom";
                this.comfort = clamp01(this.comfort + 0.003);
                break;
            case "thump":
                this.vx *= GROUND_FRICTION;
                this.behavior = "thump";
                break;
            default:
                this.vx *= GROUND_FRICTION;
                this.behavior = "sit";
        }
    }

    /** Apply velocity + terrain collision (world coords). */
    private integrate(prevFeet: number): void {
        let nx = this.x + this.vx;
        let ny = this.y + this.vy;

        if (ny < 0.5) {
            ny = 0.5;
            if (this.vy < 0) this.vy = 0;
        }

        // horizontal: solid blocks (only while feet below their top → climb over)
        for (const o of this.obstacles) {
            if (o.solid && ny > o.top + 0.001 && nx >= o.x0 - 0.5 && nx <= o.x1 + 0.5 && !(this.x >= o.x0 - 0.5 && this.x <= o.x1 + 0.5)) {
                nx = this.x < o.x0 ? o.x0 - 0.6 : o.x1 + 0.6;
            }
        }

        if (this.vy >= 0) {
            // descending: land on the highest surface crossed
            let landTop = Infinity;
            let landSurface: Obstacle | null = null;
            let landed = false;
            if (ny >= this.floor && prevFeet <= this.floor + 0.001) {
                landTop = this.floor;
                landSurface = null;
                landed = true;
            }
            for (const o of this.obstacles) {
                if (nx >= o.x0 - 0.5 && nx <= o.x1 + 0.5 && prevFeet <= o.top + 0.001 && ny >= o.top && o.top < landTop) {
                    landTop = o.top;
                    landSurface = o;
                    landed = true;
                }
            }
            if (landed) {
                // only a real landing (a leap/bound) squashes; gentle lollops don't
                if (!this.onGround && this.vy > HARD_LANDING) this.squash = SQUASH_TICKS;
                ny = landTop;
                this.vy = 0;
                this.onGround = true;
                this.surface = landSurface;
                this.binky = false;
            }
        } else {
            // rising: bonk the head on a shelf underside (no pass-through)
            const headPrev = prevFeet - 2;
            const head = ny - 2;
            let bonk = -Infinity;
            for (const o of this.obstacles) {
                if (o.solid) continue;
                if (nx >= o.x0 - 0.5 && nx <= o.x1 + 0.5 && headPrev >= o.top - 0.001 && head < o.top && o.top > bonk) bonk = o.top;
            }
            if (bonk > -Infinity) {
                ny = bonk + 2;
                this.vy = 0;
            }
        }

        // world walls
        const pad = 2;
        if (nx < pad) {
            nx = pad;
            this.vx = Math.abs(this.vx);
            this.heading = 1;
            this.turnLock = 30;
        } else if (nx > this.worldW - 1 - pad) {
            nx = this.worldW - 1 - pad;
            this.vx = -Math.abs(this.vx);
            this.heading = -1;
            this.turnLock = 30;
        }

        this.x = nx;
        this.y = ny;
        this.gait++; // steady counter for animation cycling (dust, motion lines)
    }

    // ── panel HUD ────────────────────────────────────────────────────────────
    vitals(): Vital[] {
        return [
            { label: "energy", frac: this.energy, color: chalk.greenBright },
            { label: "hunger", frac: this.hunger, color: chalk.rgb(255, 160, 40) },
            { label: "comfort", frac: this.comfort, color: chalk.rgb(255, 150, 190) },
            { label: "alert", frac: this.alertness, color: chalk.cyanBright },
            { label: "threat", frac: this.threat, color: chalk.redBright },
        ];
    }

    senses(food: FoodField | null): Senses {
        const mood =
            this.threat > 0.4
                ? "scared"
                : this.alertness > 0.5
                  ? "alert"
                  : this.energy < E_TIRED + 0.06
                    ? "sleepy"
                    : this.hunger > 0.6
                      ? "hungry"
                      : this.comfort > 0.65 && this.energy > 0.6
                        ? "playful"
                        : this.comfort > 0.45
                          ? "content"
                          : "calm";

        let seeing: string;
        if (this.perceptTimer > 0) seeing = this.perceptText;
        else if (this.threat > 0.4) seeing = chalk.redBright("‼ predator!");
        else if (food) {
            const dx = food.x - this.x;
            const up = this.y - food.y;
            const dir = up > 2 ? " (up)" : up < -2 ? " (below)" : "";
            seeing = chalk.green(`▸ carrot ${Math.round(Math.abs(dx))} away${dir}`);
        } else if (this.alertness > 0.4) seeing = chalk.yellow("… something rustled");
        else seeing = chalk.gray("nothing nearby");

        return { mood, seeing };
    }

    stimulusKeys(): StimulusKey[] {
        return [
            { key: "f", label: "food" },
            { key: "t", label: "nose" },
            { key: "p", label: "poke" },
            { key: "d", label: "danger" },
            { key: "s", label: "sound" },
            { key: "c", label: "calm" },
        ];
    }

    // ── drawing (maps world → screen via camX) ───────────────────────────────
    drawWorld(grid: string[][], innerW: number, innerH: number, food: FoodField | null): void {
        const groundRow = innerH - 1;
        const cam = Math.round(this.camX);
        const scr = (sx: number, y: number, s: string) => {
            if (sx >= 0 && sx < innerW && y >= 0 && y < innerH) grid[y][sx] = s;
        };
        const world = (wx: number, y: number, s: string) => scr(Math.round(wx) - cam, y, s);

        // sky clouds + grass blades scroll with the world (parallax)
        for (let sx = 0; sx < innerW; sx++) {
            const wx = sx + cam;
            if ((wx * 7) % 23 === 0) scr(sx, 1, chalk.rgb(150, 170, 200).dim("˘"));
            scr(sx, groundRow, chalk.rgb(90, 140, 60)("▄"));
            if ((wx * 13 + 5) % 9 === 0) scr(sx, groundRow - 1, chalk.rgb(110, 165, 75)("ʼ"));
        }

        // terrain
        for (const o of this.obstacles) {
            if (o.x1 - cam < 0 || o.x0 - cam >= innerW) continue;
            for (let x = o.x0; x <= o.x1; x++) {
                world(x, o.top, chalk.rgb(110, 165, 75)("▀"));
                if (o.solid) for (let y = o.top + 1; y < groundRow; y++) world(x, y, chalk.rgb(120, 95, 70)("▓"));
                else world(x, o.top + 1, chalk.rgb(120, 95, 70).dim("▔"));
            }
        }

        // carrot (only if on-screen)
        if (food) {
            const fx = Math.round(food.x);
            const fy = Math.round(food.y);
            world(fx - 1, fy - 1, chalk.green("❀"));
            world(fx + 1, fy - 1, chalk.green("❀"));
            world(fx, fy - 1, chalk.rgb(255, 140, 0).bold("¥"));
        }

        this.drawRabbit(world, groundRow);
    }

    private drawRabbit(world: (wx: number, y: number, s: string) => void, groundRow: number): void {
        const cx = this.x;
        const feet = Math.round(this.y);
        const right = this.heading === 1;
        const b = this.behavior;
        const airborne = !this.onGround;

        // landing squash
        if (this.squash > 0 && !airborne) {
            world(cx - 2, feet - 1, FUR("("));
            world(cx - 1, feet - 1, FUR("\\"));
            world(cx, feet - 1, NOSE("ᴥ"));
            world(cx + 1, feet - 1, FUR("/"));
            world(cx + 2, feet - 1, FUR(")"));
            world(cx, feet, FUR_DK("◡"));
            return;
        }

        // flop / doze — lying down
        if (b === "flop") {
            world(cx - 2, feet, FUR("("));
            world(cx - 1, feet, FACE("-"));
            world(cx, feet, NOSE("ᴥ"));
            world(cx + 1, feet, FACE("-"));
            world(cx + 2, feet, FUR(")"));
            world(cx + (right ? 3 : -3), feet - 1, chalk.gray.dim("z"));
            return;
        }

        // periscope — sat up tall on the haunches, slowly scanning the meadow
        if (b === "periscope") {
            const scan = Math.floor(this.gait / 4) % 3; // slow look left/centre/right
            const tip = scan === 0 ? -1 : scan === 2 ? 1 : 0;
            world(cx - 1, feet - 4, FUR("│"));
            world(cx + 1, feet - 4, FUR("│"));
            world(cx - 1, feet - 3, FACE(right ? "•" : "◕"));
            world(cx, feet - 3, NOSE("ᴥ"));
            world(cx + 1, feet - 3, FACE(right ? "◕" : "•"));
            world(cx, feet - 2, FUR("┃")); // upright chest
            world(cx - 1, feet - 1, FUR("("));
            world(cx, feet - 1, FUR_DK("o")); // tucked front paws
            world(cx + 1, feet - 1, FUR(")"));
            world(cx, feet, FUR_DK('"'));
            if (tip !== 0) world(cx + tip, feet - 5, chalk.gray.dim("˙")); // ear/nose flick
            return;
        }

        // grazing — head dipped to the grass, nibbling (over a carrot, or eating it)
        if (b === "eat" || b === "forage") {
            const munch = Math.floor(this.gait / 3) % 2; // slow chew bob
            world(cx - 2, feet - 2, FUR("("));
            world(cx - 1, feet - 2, FUR("\\"));
            world(cx, feet - 2, FUR("_"));
            world(cx + 1, feet - 2, FUR("/"));
            world(cx + 2, feet - 2, FUR(")"));
            world(cx - 2, feet - 1, FUR("(")); // hunched shoulders, eyes half-shut
            world(cx - 1, feet - 1, FACE(munch ? "-" : "•"));
            world(cx, feet - 1, FUR_DK("‿"));
            world(cx + 1, feet - 1, FACE(munch ? "-" : "•"));
            world(cx + 2, feet - 1, FUR(")"));
            world(cx - 1, feet, FUR_DK('"'));
            world(cx + 1, feet, FUR_DK('"'));
            world(cx + this.heading, feet, NOSE(munch ? "ᵕ" : "ᴥ")); // nose to the grass
            return;
        }

        const running = b === "run" || b === "flee" || b === "zoomies";
        const ph = Math.floor(this.gait) % 4; // 4-phase leg cycle
        const back = this.heading; // +1 right → tail/ears trail left

        // ears: erect (alert/freeze/thump), swept back (run/flee/air), or normal
        const erect = b === "alert" || b === "freeze" || b === "thump";
        if (erect) {
            world(cx - 1, feet - 2, FUR("│"));
            world(cx + 1, feet - 2, FUR("│"));
        } else if (running || airborne) {
            // ears stream backwards (opposite the heading)
            world(cx - back, feet - 2, FUR(right ? "\\" : "/"));
            world(cx - back * 2, feet - 2, FUR(right ? "\\" : "/"));
        } else {
            world(cx - 2, feet - 2, FUR("("));
            world(cx - 1, feet - 2, FUR("\\"));
            world(cx, feet - 2, FUR("_"));
            world(cx + 1, feet - 2, FUR("/"));
            world(cx + 2, feet - 2, FUR(")"));
        }

        // eyes (lean forward when running)
        const eyeL = b === "freeze" ? "O" : b === "binky" ? "^" : b === "groom" ? "-" : right ? "•" : "◕";
        const eyeR = b === "freeze" ? "O" : b === "binky" ? "^" : b === "groom" ? "-" : right ? "◕" : "•";
        world(cx - 2, feet - 1, FUR("("));
        world(cx - 1, feet - 1, FACE(eyeL));
        world(cx, feet - 1, NOSE("ᴥ"));
        world(cx + 1, feet - 1, FACE(eyeR));
        world(cx + 2, feet - 1, FUR(")"));

        // feet / haunches — the part that actually animates
        if (airborne) {
            world(cx - 1, feet, FUR_DK("‿"));
            world(cx + 1, feet, FUR_DK("‿"));
            world(cx, groundRow - 1, chalk.rgb(60, 90, 45).dim("‗")); // shadow
        } else if (running) {
            // a stretched bounding stride: legs reach out front & back, kicking dust
            const reach = ph < 2;
            world(cx - 2, feet, FUR_DK(reach ? "ʼ" : "‚"));
            world(cx + 2, feet, FUR_DK(reach ? "‚" : "ʼ"));
            world(cx - back * 3, feet, chalk.rgb(150, 130, 90).dim(ph % 2 ? "∴" : "·")); // dust
        } else if (b === "walk") {
            // alternating two-beat amble: one paw plants, the other lifts
            const lift = ph < 2;
            world(cx - 1, feet, FUR_DK(lift ? '"' : "ˎ"));
            world(cx + 1, feet, FUR_DK(lift ? "ˏ" : '"'));
        } else if (b === "sniff") {
            world(cx - 1, feet, FUR_DK('"'));
            world(cx + 1, feet, FUR_DK('"'));
            world(cx + this.heading * 2, feet - 1, chalk.gray(ph % 2 ? "·" : "˙")); // nose twitch
        } else {
            world(cx - 1, feet, FUR_DK('"'));
            world(cx + 1, feet, FUR_DK('"'));
        }

        // per-state flourishes
        if (running) {
            world(cx - back * 3, feet - 1, chalk.gray.dim(ph % 2 ? "≫" : "›"));
            if (b === "zoomies") world(cx, feet - 3, chalk.yellowBright(ph % 2 ? "✦" : "✧")); // giddy sparkle
        } else if (b === "binky") {
            world(cx, feet - 3, chalk.yellowBright(ph % 2 ? "✦" : "✧"));
            world(cx + back * 2, feet - 2, chalk.yellowBright.dim("˞"));
        } else if (b === "thump") {
            world(cx - this.heading, feet, chalk.rgb(150, 130, 90)(ph % 2 ? "✺" : "✷"));
        }
    }
}
