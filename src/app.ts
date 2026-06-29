// The terminal app. Owns the pi-tui lifecycle, the simulation clock, and input.
// The root component renders a title, the habitat+nervous-system scene, and a
// markdown-rendered key legend (via pi-tui's Markdown component).

import { type Component, TUI, ProcessTerminal, Markdown, matchesKey, type MarkdownTheme } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { Engine } from "./engine.ts";
import { Worm } from "./worm.ts";
import { Rabbit } from "./rabbit.ts";
import type { Creature, CreatureKind } from "./creature.ts";
import { connectome, sensory, chemo } from "./connectome.ts";
import { FoodField } from "./food.ts";
import { layout, renderScene, type Scene } from "./render.ts";

// Alternate screen buffer: paint in our own region, restore scrollback on exit.
const ENTER_ALT = "\x1b[?1049h";
const EXIT_ALT = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

const FRAME_MS = 60; // ~16 ticks/sec
const STIM_AMOUNT = 90;
const FOOD_LIFE = 1; // food intensity at drop; decays each tick
const FOOD_DECAY = 0.9994; // slow fade so a patch survives a long trek across a wide world
const EAT_RATE = 0.018; // depletion per tick while sitting on the patch
const HISTORY = 240;

const mdTheme: MarkdownTheme = {
    heading: chalk.bold.greenBright,
    link: chalk.cyan,
    linkUrl: chalk.cyan.dim,
    code: chalk.black.bgGreen,
    codeBlock: chalk.green,
    codeBlockBorder: chalk.gray,
    quote: chalk.gray,
    quoteBorder: chalk.gray,
    hr: chalk.gray,
    listBullet: chalk.green,
    bold: chalk.bold,
    italic: chalk.italic,
    strikethrough: chalk.strikethrough,
    underline: chalk.underline,
};

const WORM_LEGEND =
    "`f` food · `t` nose touch · `p` tail poke · `space` pause · `r` reset · `q` quit";

/** Build the key legend from the creature's stimulus hints (rabbit) or default. */
function legendFor(creature: Creature): string {
    const keys = creature.stimulusKeys?.();
    if (!keys) return WORM_LEGEND;
    const stim = keys.map((k) => `\`${k.key}\` ${k.label}`).join(" · ");
    return `${stim} · \`space\` pause · \`r\` reset · \`q\` quit`;
}

export class SquirmApp implements Component {
    private tui = new TUI(new ProcessTerminal());
    private engine = new Engine();
    private creature: Creature;
    private legend: Markdown;
    private firingHistory: number[] = [];
    private stimulus = "(idle — press a stimulus key)";
    private food: FoodField | null = null;
    private prevC = 0; // last-tick attractant concentration at the head
    private upGradient = false;
    private dwell = 0; // 0 roaming … 1 sitting on the food patch
    private paused = false;
    private quitting = false;
    private timer?: ReturnType<typeof setInterval>;

    constructor(kind: CreatureKind = "worm") {
        this.creature = kind === "rabbit" ? new Rabbit(this.engine) : new Worm(this.engine);
        this.legend = new Markdown(legendFor(this.creature), 0, 0, mdTheme);
    }

    start(): void {
        process.on("SIGINT", () => this.quit());
        process.on("exit", () => process.stdout.write(SHOW_CURSOR + EXIT_ALT));
        process.stdout.write(ENTER_ALT + HIDE_CURSOR);

        this.tui.addInputListener((data) => {
            if (matchesKey(data, "ctrl+c")) {
                this.quit();
                return { consume: true };
            }
            return undefined;
        });
        this.tui.addChild(this);
        this.tui.setFocus(this);
        // Enable raw mode + route stdin through the TUI to the focused component.
        // Without this, keypresses echo to the terminal and shift every frame.
        this.tui.start();

        this.timer = setInterval(() => this.tick(), FRAME_MS);
        this.tui.requestRender(true);
    }

    /** Inner habitat area (inside the box border), in grid cells. */
    private habitatDims(): { w: number; h: number } {
        const cols = this.tui.terminal.columns;
        const rows = this.tui.terminal.rows;
        const { habInnerW } = layout(cols);
        const legendH = this.legend.render(cols).length; // cached by the component
        const contentH = rows - 2 /* header */ - legendH;
        return { w: Math.max(10, habInnerW), h: Math.max(4, contentH - 2) };
    }

    private tick(): void {
        if (this.paused || this.quitting) return;
        this.engine.step();
        this.sense();
        const { w, h } = this.habitatDims();
        this.creature.update(w, h, this.food, this.dwell);

        this.firingHistory.push(this.engine.firedNeurons);
        if (this.firingHistory.length > HISTORY) this.firingHistory.shift();

        this.tui.requestRender();
    }

    /**
     * The brain↔food coupling, shared by every creature. It senses the local
     * attractant concentration at the creature's position and drives the real
     * chemosensory neurons — klinotaxis (ASEL on a rising gradient, ASER on a
     * falling one) plus klinokinesis (off-food → AWC turning/pirouette). The
     * geometric steering itself lives in each creature's update(), which reads
     * the same food field. Here we also track dwelling and the gradient sign for
     * the panel.
     */
    private sense(): void {
        const food = this.food;
        if (!food) {
            this.upGradient = false;
            this.dwell = 0;
            return;
        }
        food.intensity *= FOOD_DECAY;
        if (food.intensity < 0.02) {
            this.food = null;
            this.dwell = 0;
            this.stimulus = "(food consumed)";
            return;
        }

        const C = food.concentration(this.creature.x, this.creature.y);
        const dC = C - this.prevC;
        this.prevC = C;
        this.upGradient = dC >= 0;
        this.dwell = Math.min(1, C / Math.max(1e-6, food.intensity));

        // Eating: once the creature is actually on the patch it nibbles the food
        // down — so the patch shrinks and finally disappears.
        if (this.dwell > 0.55) {
            food.intensity -= EAT_RATE;
            this.stimulus = this.creature.kind === "rabbit" ? "nibbling the carrot" : "grazing the lawn";
        }

        this.engine.inject(sensory.food, STIM_AMOUNT * 0.25 * C);
        if (dC >= 0) this.engine.inject(chemo.aseL, STIM_AMOUNT * 0.5);
        else {
            this.engine.inject(chemo.aseR, STIM_AMOUNT * 0.5);
            if (Math.random() < 0.06 + Math.min(0.25, -dC * 40)) {
                this.engine.inject(chemo.awc, STIM_AMOUNT * 0.4);
            }
        }
    }

    handleInput(data: string): void {
        if (matchesKey(data, "q") || data === "q") return this.quit();
        if (matchesKey(data, "space") || data === " ") {
            this.paused = !this.paused;
            this.tui.requestRender();
            return;
        }
        switch (data) {
            case "f": {
                // drop a food patch wherever this habitat wants it (worm: anywhere
                // in the dish; rabbit: a carrot on the ground).
                const { w, h } = this.habitatDims();
                const spot = this.creature.suggestFood(w, h);
                this.food = new FoodField(spot.x, spot.y, spot.sigma, FOOD_LIFE);
                this.prevC = this.food.concentration(this.creature.x, this.creature.y);
                this.stimulus = this.creature.kind === "rabbit" ? "carrot dropped → hop to it" : "food dropped → chemotaxis";
                break;
            }
            case "t":
                this.engine.inject(sensory.nose, STIM_AMOUNT);
                this.creature.perceive?.("touch_front");
                this.stimulus = this.creature.kind === "rabbit" ? "nose touched → startle" : "nose touch → reversal";
                break;
            case "p":
                // posterior touch is carried by just PLMR + PVM, so it needs a
                // harder poke to register than the densely-wired nose.
                this.engine.inject(sensory.tail, STIM_AMOUNT * 1.8);
                this.creature.perceive?.("touch_back");
                this.stimulus = this.creature.kind === "rabbit" ? "tail poked → startle" : "tail poke → reversal";
                break;
            case "d":
                // predator: a strong nociceptive blast → freeze then flee
                this.engine.inject(sensory.nose, STIM_AMOUNT * 2);
                this.creature.perceive?.("predator");
                this.stimulus = "predator! → freeze & flee";
                break;
            case "s":
                // a sound/rustle → alert (ears up, scan)
                this.engine.inject(sensory.nose, STIM_AMOUNT * 0.5);
                this.creature.perceive?.("sound");
                this.stimulus = "a rustle → alert";
                break;
            case "c":
                // petting / calm → soothes, induces grooming
                this.creature.perceive?.("pet");
                this.stimulus = "petting → calm";
                break;
            case "r":
                this.engine.reset();
                this.creature.reset();
                this.firingHistory = [];
                this.food = null;
                this.prevC = 0;
                this.stimulus = "(reset)";
                break;
        }
        this.tui.requestRender();
    }

    render(width: number): string[] {
        const rows = this.tui.terminal.rows;
        const who =
            this.creature.kind === "rabbit"
                ? "a rabbit hopping on the C. elegans connectome"
                : "a virtual C. elegans, wired from its real connectome";
        const title =
            chalk.bold.greenBright("  squirm") +
            chalk.green(" ~ ") +
            chalk.white(who) +
            (this.paused ? chalk.yellowBright("   [paused]") : "");
        const sub = chalk.gray(
            `  ${connectome.size} cells · ${connectome.gaps.length} gap junctions · White et al. 1986`,
        );

        const legendLines = this.legend.render(width);
        const header = [title, sub];
        const contentH = rows - header.length - legendLines.length;

        const scene: Scene = {
            creature: this.creature,
            engine: this.engine,
            firingHistory: this.firingHistory,
            stimulus: this.stimulus,
            food: this.food,
            upGradient: this.upGradient,
        };
        const body = contentH > 2 ? renderScene(scene, width, contentH) : [];
        return [...header, ...body, ...legendLines];
    }

    /** No cached render state of our own; the legend caches itself. */
    invalidate(): void {
        this.legend.invalidate();
    }

    private quit(): void {
        if (this.quitting) return;
        this.quitting = true;
        if (this.timer) clearInterval(this.timer);
        this.tui.stop();
        process.stdout.write(SHOW_CURSOR + EXIT_ALT);
        process.exit(0);
    }
}

export function run(kind: CreatureKind = "worm"): void {
    new SquirmApp(kind).start();
}
