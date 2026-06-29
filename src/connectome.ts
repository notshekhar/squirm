// The wiring diagram. Loads the bundled White et al. 1986 adult-hermaphrodite
// connectome (sourced from NemaNode, zhenlab-ltri) and turns it into the data
// structures the simulator needs: a sign-folded chemical adjacency list and a
// list of (symmetric) gap-junction edges.
//
// Biology in one paragraph: C. elegans has exactly 302 neurons (the dataset
// also carries body-wall muscles and a few other cells, ~447 in total). Two
// kinds of wires connect them: chemical synapses (directed, pre → post) and
// gap junctions (electrical, bidirectional). A synapse's sign depends on the
// transmitter the presynaptic neuron releases — GABAergic neurons inhibit,
// everything else here we treat as excitatory.

import raw from "./data/connectome.json";

export interface Neuron {
    name: string;
    /** Anatomical class, e.g. ADAL/ADAR both belong to class "ADA". */
    class: string;
    /** Neurotransmitter code(s): a=ACh, l=glutamate, g=GABA, d=dopamine, s=serotonin, … */
    nt: string;
    /** Role code: s=sensory, i=inter, m=motor, b=muscle, … (often combined). */
    type: string;
    head: boolean;
    tail: boolean;
}

interface RawConnection {
    pre: string;
    post: string;
    type: "chem" | "gap";
    /** Synapse count (used as connection weight). */
    weight: number;
}

interface RawData {
    source: string;
    ntLegend: Record<string, string>;
    neurons: Neuron[];
    connections: RawConnection[];
}

const data = raw as RawData;

/** A presynaptic neuron is inhibitory when its primary transmitter is GABA. */
function isInhibitory(nt: string): boolean {
    return nt.includes("g") && !nt.includes("a") && !nt.includes("l");
}

/** One outgoing chemical synapse, with the presynaptic sign already folded in. */
export interface ChemEdge {
    to: number;
    /** Signed weight: positive for excitatory pre, negative for GABAergic pre. */
    w: number;
}

/** One gap junction — symmetric electrical coupling between two cells. */
export interface GapEdge {
    a: number;
    b: number;
    w: number;
}

/**
 * The whole nervous system, indexed for fast simulation. Neurons are referred
 * to by integer index everywhere in the engine; use `index`/`name` to convert.
 */
export class Connectome {
    readonly source = data.source;
    readonly ntLegend = data.ntLegend;
    readonly neurons: Neuron[] = data.neurons;
    /** name → index */
    readonly index = new Map<string, number>();
    /** Per-neuron outgoing chemical synapses. */
    readonly out: ChemEdge[][];
    readonly gaps: GapEdge[] = [];
    readonly inhibitory: boolean[];

    constructor() {
        this.neurons.forEach((n, i) => this.index.set(n.name, i));
        this.out = this.neurons.map(() => []);
        this.inhibitory = this.neurons.map((n) => isInhibitory(n.nt));

        for (const c of data.connections) {
            const from = this.index.get(c.pre);
            const to = this.index.get(c.post);
            if (from === undefined || to === undefined) continue;
            if (c.type === "gap") {
                this.gaps.push({ a: from, b: to, w: c.weight });
            } else {
                const sign = this.inhibitory[from] ? -1 : 1;
                this.out[from].push({ to, w: c.weight * sign });
            }
        }
    }

    get size(): number {
        return this.neurons.length;
    }

    idsOf(...names: string[]): number[] {
        const out: number[] = [];
        for (const n of names) {
            const i = this.index.get(n);
            if (i !== undefined) out.push(i);
        }
        return out;
    }

    /** Indices of every neuron whose name matches a pattern (e.g. /^VB\d+$/). */
    matching(re: RegExp): number[] {
        const out: number[] = [];
        this.neurons.forEach((n, i) => {
            if (re.test(n.name)) out.push(i);
        });
        return out;
    }
}

export const connectome = new Connectome();

// ── Named circuits ─────────────────────────────────────────────────────────
// The famous C. elegans locomotion command circuit and its sensory inputs.
// These are the handful of cells whose activity we read out to move the body
// and whose stimulation produces real, documented behaviours.

const ids = (...names: string[]) => connectome.idsOf(...names);

/** Command interneurons that gate locomotion. */
export const command = {
    /** AVA, AVD, AVE drive *backward* locomotion (reversal). */
    backward: ids("AVAL", "AVAR", "AVDL", "AVDR", "AVEL", "AVER"),
    /** AVB, PVC drive *forward* locomotion. */
    forward: ids("AVBL", "AVBR", "PVCL", "PVCR"),
};

/** Motor neuron pools. Dorsal (D*) vs ventral (V*); A/B drive reverse/forward. */
export const motor = {
    forward: connectome.matching(/^(DB|VB)\d+$/), // B-class → forward
    backward: connectome.matching(/^(DA|VA|AS)\d+$/), // A-class → backward
    dorsalExc: connectome.matching(/^(DA|DB)\d+$/),
    ventralExc: connectome.matching(/^(VA|VB)\d+$/),
    dorsalInh: connectome.matching(/^DD\d+$/), // GABAergic, relax dorsal muscle
    ventralInh: connectome.matching(/^VD\d+$/),
};

/** Sensory entry points, keyed by the stimulus that excites them. */
export const sensory = {
    /** Chemoattractants / food sensing → drives forward runs. */
    food: ids("ASEL", "ASER", "AWAL", "AWAR", "AWCL", "AWCR", "ADFL", "ADFR", "ASIL", "ASIR"),
    /** Anterior gentle touch + nose nociception → drives reversal. */
    nose: ids("ALML", "ALMR", "AVM", "ASHL", "ASHR", "FLPL", "FLPR"),
    /** Posterior gentle touch → drives forward escape. */
    tail: ids("PLML", "PLMR", "PVM"),
};

/** The chemotaxis amphid neurons, split left/right for klinotaxis. ASEL fires on
 *  rising attractant, ASER on falling — the asymmetry the worm steers by. */
export const chemo = {
    aseL: ids("ASEL"),
    aseR: ids("ASER"),
    awc: ids("AWCL", "AWCR"), // turning/pirouette when concentration drops
};
