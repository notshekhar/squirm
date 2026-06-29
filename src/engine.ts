// The brain. A deliberately simple discrete-time model run over the *real*
// connectome — the same reduction Timothy Busbice used to drive a Lego robot
// from the worm's wiring (and the spirit of OpenWorm's c302, minus the
// biophysics). Each neuron is a leaky accumulator; when its membrane crosses a
// threshold it "fires", dumps its (signed) synaptic weights into its targets,
// and resets. Gap junctions continuously diffuse charge between coupled cells.
//
// It is not biophysically accurate — there are no real spikes, ion channels, or
// timing. But it is wired from the genuine 3,549-synapse adult connectome, so
// stimulating the touch neurons really does propagate through the documented
// command interneurons and out to the motor pools that move the body.

import { connectome, type Connectome } from "./connectome.ts";

export interface EngineParams {
    /** Membrane level at which a neuron fires. */
    threshold: number;
    /** Per-tick membrane decay (leak toward rest). */
    leak: number;
    /** Fraction of charge that flows across a gap junction per tick. */
    gapCoupling: number;
    /** Per-tick decay of injected sensory drive. */
    stimDecay: number;
    /** Multiplier on chemical synaptic weight (overall excitability). */
    gain: number;
    /** Membrane jitter added every tick. */
    noise: number;
    /** Neurons given a near-threshold spontaneous nudge each tick (keeps an
     *  unstimulated worm faintly, restlessly alive — C. elegans never fully stops). */
    spontaneous: number;
    /** Clamp on |membrane| to stop runaway feedback loops. */
    clamp: number;
}

export const DEFAULT_PARAMS: EngineParams = {
    threshold: 20,
    leak: 0.78,
    gapCoupling: 0.04,
    stimDecay: 0.86,
    gain: 0.9,
    noise: 0.3,
    spontaneous: 1,
    clamp: 200,
};

export class Engine {
    readonly net: Connectome;
    private readonly params: EngineParams;
    /** Membrane potential per neuron. */
    private v: Float64Array;
    /** Sustained sensory drive injected per tick (decays on its own). */
    private stim: Float64Array;
    /** Smoothed firing activity per neuron, in [0,1] — the motor readout. */
    readonly activity: Float64Array;
    /** Which neurons fired on the most recent tick. */
    private fired: Uint8Array;
    private firedCount = 0;
    private tick = 0;

    constructor(net = connectome, params = DEFAULT_PARAMS) {
        this.net = net;
        this.params = params;
        const n = net.size;
        this.v = new Float64Array(n);
        this.stim = new Float64Array(n);
        this.activity = new Float64Array(n);
        this.fired = new Uint8Array(n);
    }

    /** Inject a pulse of drive into a set of neurons (a sensory stimulus). */
    inject(neurons: number[], amount: number): void {
        for (const i of neurons) this.stim[i] += amount;
    }

    get firedNeurons(): number {
        return this.firedCount;
    }

    get ticks(): number {
        return this.tick;
    }

    /** Mean smoothed activity over a pool of neurons, in [0,1]. */
    pool(neurons: number[]): number {
        if (neurons.length === 0) return 0;
        let s = 0;
        for (const i of neurons) s += this.activity[i];
        return s / neurons.length;
    }

    reset(): void {
        this.v.fill(0);
        this.stim.fill(0);
        this.activity.fill(0);
        this.fired.fill(0);
        this.firedCount = 0;
        this.tick = 0;
    }

    /** Advance the simulation by one time step. */
    step(): void {
        const { threshold, leak, gapCoupling, stimDecay, gain, noise, spontaneous, clamp } =
            this.params;
        const n = this.net.size;
        const v = this.v;
        const next = new Float64Array(n);

        // 1. Gap junctions: electrical coupling pulls coupled membranes together.
        //    Computed from the *current* state and applied to the next state.
        for (const g of this.net.gaps) {
            const flow = (v[g.a] - v[g.b]) * gapCoupling * Math.tanh(g.w / 4);
            next[g.a] -= flow;
            next[g.b] += flow;
        }

        // 2. Leak + chemical transmission from anything that fired this tick.
        this.firedCount = 0;
        for (let i = 0; i < n; i++) {
            const fires = v[i] >= threshold;
            this.fired[i] = fires ? 1 : 0;
            if (fires) {
                this.firedCount++;
                for (const e of this.net.out[i]) next[e.to] += e.w * gain;
                // refractory: hyperpolarize after firing so the cell can't
                // immediately re-fire — this is what stops recurrent saturation.
                next[i] -= threshold * 0.8;
            } else {
                next[i] += v[i] * leak;
            }
            // 3. Smoothed activity readout (what the body listens to).
            this.activity[i] = this.activity[i] * 0.88 + (fires ? 1 : 0) * 0.12;
        }

        // 4. Sustained sensory drive + a little membrane jitter.
        for (let i = 0; i < n; i++) {
            next[i] += this.stim[i];
            this.stim[i] *= stimDecay;
            if (noise > 0) next[i] += (Math.random() - 0.5) * noise;
            // 5. Clamp to keep recurrent loops bounded.
            if (next[i] > clamp) next[i] = clamp;
            else if (next[i] < -clamp) next[i] = -clamp;
        }

        // 6. Spontaneous activity: nudge a few random cells over threshold so an
        //    unstimulated worm still idles and fidgets instead of flatlining.
        for (let k = 0; k < spontaneous; k++) {
            next[(Math.random() * n) | 0] += threshold * 1.1;
        }

        this.v = next;
        this.tick++;
    }
}
