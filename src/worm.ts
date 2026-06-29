// The worm body. Reads the motor pools out of the engine and turns them into a
// C. elegans crawling around the 2-D petri dish: the head crawls along a heading,
// weaving gently; the real motor-neuron imbalance steers it; a surge of the
// reversal command (or a wall) makes it back up and reorient. With food present
// it climbs the concentration gradient (klinotaxis) and dwells on the patch.

import chalk from "chalk";
import type { Engine } from "./engine.ts";
import type { Creature, MotorReadout, Segment } from "./creature.ts";
import type { FoodField } from "./food.ts";
import { motor, command } from "./connectome.ts";

const WAVE_SPEED = 0.28; // base undulation frequency
const WEAVE = 0.32; // head weave amplitude, radians (gentle — not thrashing)
const BODY = 16; // physical body length in segments
const SEG_SPACING = 1.15; // arc-length between segments
const MIN_SPEED = 0.06; // a worm at rest still creeps — never fully frozen
const TRAIL_MAX = 600;

// Warm body palette: head-hot white → gold → amber → orange → ember tail, so it
// reads as a living, warm creature rather than a row of ASCII.
const WARM_STOPS: [number, number, number][] = [
    [255, 246, 214],
    [255, 211, 92],
    [255, 158, 44],
    [240, 110, 30],
    [150, 60, 20],
];

function warm(t: number): (s: string) => string {
    const x = Math.max(0, Math.min(1, t)) * (WARM_STOPS.length - 1);
    const i = Math.floor(x);
    const f = x - i;
    const a = WARM_STOPS[i];
    const b = WARM_STOPS[Math.min(WARM_STOPS.length - 1, i + 1)];
    return chalk.rgb(
        Math.round(a[0] + (b[0] - a[0]) * f),
        Math.round(a[1] + (b[1] - a[1]) * f),
        Math.round(a[2] + (b[2] - a[2]) * f),
    );
}

// Lawn glyphs by concentration band — denser/lusher toward the food source.
const LAWN = ["·", "∴", "∗", "✦"];

export class Worm implements Creature {
    readonly kind = "worm" as const;
    readonly habitatTitle = "petri dish";
    readonly habitatAccent = chalk.green.dim;

    x = 0;
    y = 0;
    /** Heading angle in radians (the direction the head crawls). */
    theta = 0;
    heading: 1 | -1 = 1;
    speed = 0;
    /** Undulation amplitude (rows) — scales with arousal. */
    amplitude = 1;
    phase = 0;
    behavior = "dwell";
    /** Ticks remaining in a wall/escape reorientation. */
    bumpTimer = 0;

    /** Recent head positions; the body follows this trail. Newest last. */
    private trail: Segment[] = [];
    private revBaseline = 0;
    private primed = false;
    private turnTarget = 0; // extra steering bias during an escape turn

    constructor(private engine: Engine) {}

    reset(): void {
        this.theta = Math.random() * Math.PI * 2;
        this.speed = 0;
        this.amplitude = 1;
        this.phase = 0;
        this.heading = 1;
        this.behavior = "dwell";
        this.bumpTimer = 0;
        this.revBaseline = 0;
        this.primed = false;
        this.turnTarget = 0;
        this.trail = []; // emptied → next update() re-centres in the dish
    }

    place(w: number, h: number): void {
        this.x = w / 2;
        this.y = h / 2;
        this.trail = [{ x: this.x, y: this.y }];
    }

    headingLabel(): string {
        return this.heading === 1 ? "▸ anterior" : "◂ posterior";
    }

    statusTag(): string {
        return this.bumpTimer > 0 ? chalk.redBright("↺ wall escape") : "";
    }

    suggestFood(w: number, h: number): { x: number; y: number; sigma: number } {
        let fx = 0;
        let fy = 0;
        for (let i = 0; i < 8; i++) {
            fx = 2 + Math.random() * (w - 4);
            fy = 2 + Math.random() * (h - 4);
            if (Math.hypot(fx - this.x, fy - this.y) > Math.min(w, h) * 0.3) break;
        }
        return { x: fx, y: fy, sigma: Math.max(4, Math.min(w, h) * 0.28) };
    }

    readMotor(): MotorReadout {
        return {
            forward: this.engine.pool(motor.forward),
            backward: this.engine.pool(motor.backward),
            dorsal: this.engine.pool(motor.dorsalExc) - 0.5 * this.engine.pool(motor.dorsalInh),
            ventral: this.engine.pool(motor.ventralExc) - 0.5 * this.engine.pool(motor.ventralInh),
        };
    }

    /** Klinotaxis: turn the head toward the up-gradient direction. */
    private foodSteer(food: FoodField | null): number {
        if (!food) return 0;
        const { gx, gy } = food.gradient(this.x, this.y);
        const mag = Math.hypot(gx, gy);
        if (mag < 1e-6) return 0;
        const target = Math.atan2(gy, gx);
        let d = target - this.theta;
        d = Math.atan2(Math.sin(d), Math.cos(d)); // wrap to [-π, π]
        return Math.max(-0.22, Math.min(0.22, d)) * 0.18 * Math.min(1, mag * 60);
    }

    update(w: number, h: number, food: FoodField | null, dwell = 0): void {
        if (this.trail.length === 0) this.place(w, h);

        const m = this.readMotor();
        const reverse = this.engine.pool(command.backward) + 0.4 * m.backward; // AVA/AVD/AVE
        const forward = this.engine.pool(command.forward) + 0.4 * m.forward; // AVB/PVC

        // Reversal is a *surge* of AVA above its slow baseline (the circuit is
        // recurrent and never silent). Default behaviour is forward foraging.
        if (!this.primed) {
            this.revBaseline = reverse;
            this.primed = true;
        }
        this.revBaseline = this.revBaseline * 0.99 + reverse * 0.01;
        const surge = reverse - this.revBaseline;
        const escaping = this.bumpTimer > 0;
        this.heading = escaping ? -1 : surge > 0.05 ? -1 : 1;

        // Arousal → vigour. On food (dwell→1) it down-shifts to the slow, local
        // "dwelling" gait; off food it "roams" fast — the documented switch.
        const arousal = Math.min(1, reverse + forward + m.forward + m.backward + 0.2);
        this.speed = this.speed * 0.8 + Math.max(MIN_SPEED, arousal * 0.9) * 0.2;
        this.speed *= 1 - 0.8 * dwell;
        this.amplitude = 0.6 + arousal * 1.6;

        this.phase += WAVE_SPEED + this.speed * 0.9;
        if (escaping) {
            this.theta += this.turnTarget * 0.12;
            this.bumpTimer--;
        } else {
            // Motor imbalance + chemotaxis bias + a little dwell wiggle.
            this.theta +=
                (m.dorsal - m.ventral) * 0.08 +
                this.foodSteer(food) +
                (Math.random() - 0.5) * 0.3 * dwell;
        }

        // The head weaves; the trail captures the wave so the body undulates.
        const weave = WEAVE * Math.sin(this.phase) * (this.amplitude / 1.6);
        const travel = this.theta + weave;
        const step = this.speed * this.heading;
        let nx = this.x + Math.cos(travel) * step;
        let ny = this.y + Math.sin(travel) * step;

        // Solid walls: reflect, then trigger an omega-turn escape.
        const pad = 0.5;
        let bumped = false;
        if (nx < pad) {
            nx = pad;
            this.theta = Math.PI - this.theta;
            bumped = true;
        } else if (nx > w - 1 - pad) {
            nx = w - 1 - pad;
            this.theta = Math.PI - this.theta;
            bumped = true;
        }
        if (ny < pad) {
            ny = pad;
            this.theta = -this.theta;
            bumped = true;
        } else if (ny > h - 1 - pad) {
            ny = h - 1 - pad;
            this.theta = -this.theta;
            bumped = true;
        }
        if (bumped && this.bumpTimer === 0) {
            this.bumpTimer = 14;
            this.turnTarget = (Math.random() < 0.5 ? -1 : 1) * (1.0 + Math.random());
        }

        this.x = nx;
        this.y = ny;
        this.trail.push({ x: nx, y: ny });
        if (this.trail.length > TRAIL_MAX) this.trail.shift();

        this.behavior = escaping
            ? "coil"
            : this.heading === -1
              ? "reverse"
              : arousal < 0.32
                ? "dwell"
                : "forward";
    }

    /** Sample the body as evenly-spaced points walking back along the trail. */
    private segments(spacing: number, count: number): Segment[] {
        const t = this.trail;
        if (t.length === 0) return [];
        const out: Segment[] = [{ ...t[t.length - 1] }];
        let cur = out[0];
        let i = t.length - 1;
        let need = spacing;
        while (out.length < count && i > 0) {
            const next = t[i - 1];
            const d = Math.hypot(next.x - cur.x, next.y - cur.y);
            if (d >= need) {
                const f = need / d;
                cur = { x: cur.x + (next.x - cur.x) * f, y: cur.y + (next.y - cur.y) * f };
                out.push(cur);
                need = spacing;
            } else {
                need -= d;
                cur = next;
                i--;
            }
        }
        return out;
    }

    drawWorld(grid: string[][], innerW: number, innerH: number, food: FoodField | null): void {
        // Bacterial lawn whose density follows the real concentration field.
        if (food) {
            const peak = food.intensity || 1;
            for (let y = 0; y < innerH; y++) {
                for (let x = 0; x < innerW; x++) {
                    const c = food.concentration(x, y) / peak;
                    if (c < 0.04) continue;
                    let s = (x * 374761393 + y * 668265263) >>> 0;
                    s = (s ^ (s >>> 13)) >>> 0;
                    if ((s % 1000) / 1000 < c * 0.9) {
                        const band = Math.min(LAWN.length - 1, Math.floor(c * LAWN.length));
                        const shade = c > 0.6 ? chalk.greenBright : c > 0.25 ? chalk.green : chalk.green.dim;
                        grid[y][x] = shade(LAWN[band]);
                    }
                }
            }
            const fx = Math.round(food.x);
            const fy = Math.round(food.y);
            if (fx >= 0 && fx < innerW && fy >= 0 && fy < innerH) grid[fy][fx] = chalk.bgGreen.black("❋");
        }

        // The body: a smooth, warm, tapering tube traced along the trail, drawn
        // tail → head so the bright head sits on top.
        const segs = this.segments(0.55, 34);
        const n = segs.length;
        const reversing = this.behavior === "reverse";
        for (let i = n - 1; i >= 0; i--) {
            const cx = Math.round(segs[i].x);
            const cy = Math.round(segs[i].y);
            if (cx < 0 || cx >= innerW || cy < 0 || cy >= innerH) continue;
            const t = i / Math.max(1, n - 1);
            const head = i === 0;
            const ch = head ? "◉" : t < 0.55 ? "●" : t < 0.8 ? "•" : "·";
            let color = warm(t);
            if (head) color = chalk.bold.rgb(255, 250, 235);
            else if (reversing) color = chalk.rgb(255, 196, 64);
            grid[cy][cx] = color(ch);
        }
    }
}
