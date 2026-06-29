#!/usr/bin/env bun
import { connectome } from "./connectome.ts";
import type { CreatureKind } from "./creature.ts";
import { run } from "./app.ts";
import { runUpdate } from "./update.ts";

declare const __SQUIRM_VERSION__: string;
const VERSION = typeof __SQUIRM_VERSION__ === "string" ? __SQUIRM_VERSION__ : "0.1.0";

const HELP = `squirm — a virtual creature living in your terminal

A real-time simulation driven by the genuine C. elegans connectome (White et al.
1986, via NemaNode). Run it as the worm itself, or as a rabbit that wears the
same brain and hops around a meadow with real gravity.

Usage:
  squirm               Launch the worm (petri dish, crawling)
  squirm rabbit        Launch the rabbit (meadow, real jump physics)
  squirm worm          Launch the worm explicitly
  squirm info          Print connectome stats and exit
  squirm update        Update to the latest release (alias: upgrade)
  squirm version       Print the version
  squirm help          Show this help

  (--rabbit / --worm also work as flags.)

In the habitat:
  f    drop food         (worm: chemotaxes & dwells · rabbit: hops to the carrot)
  t    nose touch        (nociception → reversal)
  p    tail poke         (escape → reversal)
  space  pause/resume    r  reset      q / ctrl+c  quit`;

function info(): void {
    const chem = connectome.neurons.reduce((s, _n, i) => s + connectome.out[i].length, 0);
    const inhib = connectome.inhibitory.filter(Boolean).length;
    process.stdout.write(
        `squirm — connectome summary\n` +
            `  source       ${connectome.source}\n` +
            `  cells        ${connectome.size}\n` +
            `  chem synapse ${chem}\n` +
            `  gap junction ${connectome.gaps.length}\n` +
            `  GABAergic    ${inhib} (inhibitory)\n`,
    );
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.some((a) => ["-h", "--help", "help"].includes(a))) {
        process.stdout.write(`${HELP}\n`);
        return;
    }
    if (args.some((a) => ["-v", "--version", "version"].includes(a))) {
        process.stdout.write(`${VERSION}\n`);
        return;
    }
    if (args.some((a) => ["update", "upgrade"].includes(a))) {
        await runUpdate(VERSION, { force: args.includes("--force") || args.includes("-f") });
        return;
    }
    if (args.includes("info")) {
        info();
        return;
    }

    const kind: CreatureKind =
        args.some((a) => a === "rabbit" || a === "--rabbit") ? "rabbit" : "worm";
    run(kind);
}

main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
