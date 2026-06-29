// The body-agnostic contract. The same brain (engine.ts + the real connectome)
// drives whatever creature implements this — a worm crawling a petri dish, or a
// rabbit hopping a meadow with real gravity. The app and the nervous-system
// panel only ever talk to a Creature; each creature owns its own physics and
// draws its own habitat.

import type { FoodField } from "./food.ts";

/** Activity read out of the shared motor neurons (same pools for every body). */
export interface MotorReadout {
    forward: number;
    backward: number;
    dorsal: number;
    ventral: number;
}

/** A point in habitat-cell coordinates. */
export interface Segment {
    x: number;
    y: number;
}

export type CreatureKind = "worm" | "rabbit";

/** A labelled meter for the panel (0..1), e.g. an energy or threat bar. */
export interface Vital {
    label: string;
    frac: number;
    color: (s: string) => string;
}

/** What the creature is feeling/perceiving, for the panel HUD. */
export interface Senses {
    mood: string;
    /** One-line "seeing/sensing" description (already styled). */
    seeing: string;
}

/** A stimulus key hint for the legend, e.g. { key: "d", label: "danger" }. */
export interface StimulusKey {
    key: string;
    label: string;
}

export interface Creature {
    readonly kind: CreatureKind;
    /** Box title + border colour for the habitat panel. */
    readonly habitatTitle: string;
    readonly habitatAccent: (s: string) => string;

    /** Position (meaning is creature-specific: worm head / rabbit feet). */
    x: number;
    y: number;
    /** +1 forward/right, -1 reverse/left. */
    heading: 1 | -1;
    /** Smoothed locomotor speed, for the panel. */
    speed: number;
    /** Current behavioural state label (drives the panel colour). */
    behavior: string;

    reset(): void;
    place(w: number, h: number): void;
    /** Advance one tick. `dwell` (0..1) = how much the worm is sitting on food. */
    update(w: number, h: number, food: FoodField | null, dwell: number): void;

    readMotor(): MotorReadout;
    /** e.g. "▸ anterior" / "◂ left". */
    headingLabel(): string;
    /** Short coloured status flag for the panel, or "" for none. */
    statusTag(): string;
    /** Where a dropped food patch should sit for this habitat. */
    suggestFood(w: number, h: number): { x: number; y: number; sigma: number };

    /** Paint the habitat (background, food, and the creature) into the grid. */
    drawWorld(grid: string[][], innerW: number, innerH: number, food: FoodField | null, ticks: number): void;

    // ── optional, creature-specific (the worm leaves these out) ──────────────
    /** React to a named stimulus key (e.g. "predator", "sound", "pet"). */
    perceive?(kind: string): void;
    /** Live drive meters for the panel HUD. */
    vitals?(): Vital[];
    /** Mood + what it's seeing/sensing, for the panel HUD. */
    senses?(food: FoodField | null): Senses;
    /** Stimulus key hints for the on-screen legend. */
    stimulusKeys?(): StimulusKey[];
}
