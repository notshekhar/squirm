// Drawing. Two side-by-side panels: the habitat (where the worm crawls) and the
// nervous system (live readout of the circuits driving it). Everything here is
// pure: state in, coloured lines out.

import chalk from "chalk";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Engine } from "./engine.ts";
import type { Creature } from "./creature.ts";
import type { FoodField } from "./food.ts";
import { command, motor } from "./connectome.ts";

export interface Scene {
    creature: Creature;
    engine: Engine;
    firingHistory: number[];
    stimulus: string;
    food: FoodField | null;
    /** Chemotaxis readout: is the creature currently climbing the gradient? */
    upGradient: boolean;
}

// ── small drawing helpers ───────────────────────────────────────────────────

function bar(frac: number, width: number, fill = "█", track = "·"): string {
    const f = Math.max(0, Math.min(1, frac));
    const n = Math.round(f * width);
    return fill.repeat(n) + track.repeat(width - n);
}

const SPARK = "▁▂▃▄▅▆▇█";
function sparkline(values: number[], width: number): string {
    const tail = values.slice(-width);
    const max = Math.max(1, ...tail);
    let out = "";
    for (const v of tail) {
        const idx = Math.min(SPARK.length - 1, Math.floor((v / max) * (SPARK.length - 1)));
        out += SPARK[idx];
    }
    return out.padStart(width, " ");
}

function pad(s: string, width: number): string {
    const w = visibleWidth(s);
    return w >= width ? truncateToWidth(s, width) : s + " ".repeat(width - w);
}

function box(title: string, inner: string[], width: number, accent: (s: string) => string): string[] {
    const innerW = width - 2;
    const t = ` ${title} `;
    const top = accent("╭" + t + "─".repeat(Math.max(0, innerW - visibleWidth(t))) + "╮");
    const lines = [top];
    for (const row of inner) lines.push(accent("│") + pad(row, innerW) + accent("│"));
    lines.push(accent("╰" + "─".repeat(innerW) + "╯"));
    return lines;
}

// ── habitat ─────────────────────────────────────────────────────────────────

// Behaviour-state → colour, spanning both creatures (default gray).
const BEHAVIOR_COLOR: Record<string, (s: string) => string> = {
    // worm
    forward: chalk.greenBright,
    reverse: chalk.yellowBright,
    coil: chalk.magentaBright,
    dwell: chalk.gray,
    // rabbit — locomotion
    walk: chalk.green,
    run: chalk.greenBright,
    hop: chalk.greenBright,
    leap: chalk.magentaBright,
    binky: chalk.magentaBright,
    chase: chalk.magentaBright,
    flee: chalk.redBright,
    forage: chalk.green,
    // rabbit — stationary / reactive
    eat: chalk.greenBright,
    sit: chalk.gray,
    sniff: chalk.cyan,
    periscope: chalk.cyan,
    groom: chalk.rgb(255, 150, 190),
    flop: chalk.gray,
    rest: chalk.gray,
    hide: chalk.rgb(120, 95, 70),
    alert: chalk.cyanBright,
    freeze: chalk.redBright,
    thump: chalk.yellowBright,
    land: chalk.yellow,
};

function behaviorColor(beh: string): (s: string) => string {
    return BEHAVIOR_COLOR[beh] ?? chalk.white;
}

function renderHabitat(scene: Scene, width: number, height: number): string[] {
    const innerW = width - 2;
    const innerH = height - 2;
    const grid: string[][] = Array.from({ length: innerH }, () => Array(innerW).fill(" "));
    // Each creature paints its own world (background, food, body).
    scene.creature.drawWorld(grid, innerW, innerH, scene.food, scene.engine.ticks);
    return grid.map((row) => row.join(""));
}

// ── nervous-system panel ─────────────────────────────────────────────────────

function renderPanel(scene: Scene, width: number, height: number): string[] {
    const { engine, creature } = scene;
    const innerW = width - 2;
    const lines: string[] = [];

    const beh = creature.behavior;
    const flag = creature.statusTag();
    const tag = flag ? "  " + flag : "";
    lines.push(behaviorColor(beh)(`◆ ${beh.toUpperCase()}`) + chalk.gray(`  t=${engine.ticks}`) + tag);
    lines.push(chalk.gray("heading ") + chalk.white(creature.headingLabel()));
    lines.push(chalk.gray("speed   ") + chalk.cyan(bar(creature.speed * 2, innerW - 8)));

    const fired = engine.firedNeurons;
    lines.push(chalk.gray(`firing  ${fired}/${engine.net.size}`));
    lines.push(chalk.cyanBright(sparkline(scene.firingHistory, innerW)));
    lines.push("");

    lines.push(chalk.bold("command interneurons"));
    const row = (label: string, color: (s: string) => string, pool: number[]) =>
        chalk.gray(pad(label, 6)) + color(bar(engine.pool(pool) * 3, innerW - 7));
    lines.push(row("AVB▸", chalk.greenBright, command.forward));
    lines.push(row("AVA◂", chalk.yellowBright, command.backward));
    lines.push("");

    lines.push(chalk.bold("motor pools"));
    lines.push(row("fwd B", chalk.green, motor.forward));
    lines.push(row("rev A", chalk.yellow, motor.backward));
    const mr = creature.readMotor();
    lines.push(chalk.gray(pad("dorsl", 6)) + chalk.blueBright(bar((mr.dorsal + 0.2) * 2, innerW - 7)));
    lines.push(chalk.gray(pad("ventr", 6)) + chalk.magentaBright(bar((mr.ventral + 0.2) * 2, innerW - 7)));

    // Creature-specific readout: the worm shows chemotaxis; the rabbit shows its
    // feelings (drive meters) + mood + what it's sensing.
    const vitals = creature.vitals?.();
    if (vitals) {
        lines.push(chalk.bold("feelings"));
        for (const v of vitals) {
            lines.push(chalk.gray(pad(v.label, 7)) + v.color(bar(v.frac, innerW - 8)));
        }
        const s = creature.senses?.(scene.food);
        if (s) {
            lines.push("");
            lines.push(chalk.gray("mood   ") + chalk.white(s.mood));
            lines.push(chalk.gray("seeing ") + s.seeing);
        }
        lines.push("");
    } else if (scene.food) {
        const d = Math.round(Math.hypot(creature.x - scene.food.x, (creature.y - scene.food.y) * 2));
        const climb = scene.upGradient
            ? chalk.greenBright("↗ climbing gradient")
            : chalk.yellow("↘ off-food, turning");
        lines.push(chalk.bold("chemotaxis"));
        lines.push(chalk.gray("food    ") + chalk.green(`❋ ${d} cells away`));
        lines.push(climb);
        lines.push("");
    }

    // "a life so far" — carrots eaten, binkies, hops, joy streak (rabbit only)
    const stats = creature.lifeStats?.();
    if (stats) {
        lines.push(chalk.bold("a life so far"));
        for (const s of stats) lines.push(s);
        lines.push("");
    }

    lines.push(chalk.gray("stimulus"));
    lines.push(chalk.white("→ " + scene.stimulus));

    // pad/truncate to box height
    while (lines.length < height - 2) lines.push("");
    return lines.slice(0, height - 2);
}

// ── compose ──────────────────────────────────────────────────────────────────

/** Split the screen width into habitat + panel. Shared so the body kinematics
 *  (which need the habitat's inner width to wrap) stay in sync with drawing. */
export function layout(width: number): { habW: number; panelW: number; habInnerW: number } {
    const panelW = Math.min(34, Math.max(24, Math.floor(width * 0.38)));
    const habW = width - panelW - 1;
    return { habW, panelW, habInnerW: habW - 2 };
}

export function renderScene(scene: Scene, width: number, height: number): string[] {
    const { habW, panelW } = layout(width);

    const habInner = renderHabitat(scene, habW, height);
    const hab = box(
        scene.creature.habitatAccent(scene.creature.habitatTitle),
        habInner,
        habW,
        scene.creature.habitatAccent,
    );

    const panelInner = renderPanel(scene, panelW, height);
    const panel = box(chalk.cyanBright("nervous system"), panelInner, panelW, chalk.cyan.dim);

    const out: string[] = [];
    for (let r = 0; r < height; r++) {
        out.push((hab[r] ?? " ".repeat(habW)) + " " + (panel[r] ?? " ".repeat(panelW)));
    }
    return out;
}
