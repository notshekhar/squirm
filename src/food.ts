// Food. A patch of bacteria sitting somewhere in the dish, modelled as a
// Gaussian concentration field. The worm senses the local concentration and its
// gradient — exactly the inputs C. elegans uses to chemotax. Cells in a terminal
// are about twice as tall as they are wide, so distances in the y direction are
// scaled to keep the patch looking round on screen.

export interface Gradient {
    gx: number;
    gy: number;
}

const Y_ASPECT = 2.0; // a row is ~2× a column, so weight vertical distance

export class FoodField {
    constructor(
        public x: number,
        public y: number,
        public sigma: number,
        public intensity = 1,
    ) {}

    /** Attractant concentration at a point, in [0, intensity]. */
    concentration(px: number, py: number): number {
        const dx = px - this.x;
        const dy = (py - this.y) * Y_ASPECT;
        return this.intensity * Math.exp(-(dx * dx + dy * dy) / (2 * this.sigma * this.sigma));
    }

    /** Spatial gradient (points up-hill, toward the food) via finite differences. */
    gradient(px: number, py: number): Gradient {
        const e = 0.6;
        const gx = (this.concentration(px + e, py) - this.concentration(px - e, py)) / (2 * e);
        const gy = (this.concentration(px, py + e) - this.concentration(px, py - e)) / (2 * e);
        return { gx, gy };
    }
}
