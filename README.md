# squirm

A virtual **C. elegans** living in your terminal, driven by its real connectome.

`squirm` keeps a nematode on screen and actually simulates its nervous system.
The wiring is not invented: it's the genuine adult-hermaphrodite connectome
(White et al. 1986 — 447 cells, ~3,500 chemical synapses, ~1,100 gap junctions),
sourced from [NemaNode](https://nemanode.org). Poke the worm's touch neurons and
the signal propagates through the documented command interneurons and out to the
motor pools that crawl the body — you watch the reflex happen in real time.

> The name is just what a worm does. C. elegans is the only animal whose entire
> nervous system has been mapped end to end, so it's the obvious worm to keep as
> a pet in your terminal — and wired to its real connectome, it genuinely squirms.

By default it runs as a **rabbit** 🐇 — the exact same connectome brain, wearing a
different body (run `squirm worm` for the worm in its dish). The rabbit lives in a
side-view meadow with real gravity and jumps in genuine parabolic arcs; a surge of
forward-command activity fires its legs into a hop, a big surge into a leap. (A
rabbit has no mapped connectome — this is the worm's brain in a rabbit suit, and
that's the joke.) It has a **name**, lives under a slow **day→night sky** (sun,
moon, stars, fireflies, drifting clouds and birds), **chases a butterfly** for the
fun of it when it's content — the thrill drives its real forward command — and
**bolts down a burrow** to hide when something scares it. The panel keeps **a life
so far**: carrots eaten, binkies, hops, and its longest streak of contentment.

```
╭ petri dish ───────────────────────────────╮ ╭ nervous system ────────────────╮
│        ∴            ∴          ∴           │ │◆ REVERSE  t=1966               │
│   o      ·                                 │ │heading ◂ posterior             │
│  o        ◍●                       ∴       │ │speed   ██████████████······    │
│ o           ∴       ∴                      │ │firing  3/447                   │
│   ∴            ∴            ∴              ∴│ │▆▇▂█▃▄▄▃▃▅▅▃▆▃▇▅▅▆▄▁▇▃▂▂▁▁▆▆▃▆▃▅│
│            ∴                ∴       ∴       │ │command interneurons            │
│      ∴               ∴            ∴        │ │AVB▸  ████····················  │
╰────────────────────────────────────────────╯ │AVA◂  ███████████············  │
                                                ╰────────────────────────────────╯
```

## Install

Prebuilt binary, no runtime needed.

**macOS & Linux** (x64 / arm64):

```sh
curl -fsSL https://raw.githubusercontent.com/notshekhar/squirm/main/install.sh | bash
```

**Windows** (x64) — PowerShell:

```powershell
irm https://raw.githubusercontent.com/notshekhar/squirm/main/install.ps1 | iex
```

…or Command Prompt (`cmd.exe`):

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/notshekhar/squirm/main/install.ps1 | iex"
```

Then `squirm` (rabbit 🐇) or `squirm worm`. Update in place any time with
`squirm update` (it re-runs the right installer for your platform). Uninstall
with `SQUIRM_UNINSTALL=1 curl -fsSL .../install.sh | bash` (macOS/Linux), or on
Windows `$env:SQUIRM_UNINSTALL=1; irm .../install.ps1 | iex` (PowerShell) /
`set SQUIRM_UNINSTALL=1&& powershell -NoProfile -ExecutionPolicy Bypass -Command "irm .../install.ps1 | iex"` (cmd).

## Run from source

```sh
bun install
bun start                 # launch the rabbit (meadow, jump physics)
bun src/cli.ts worm       # launch the worm (petri dish)
bun src/cli.ts info       # print connectome stats
```

Pick the creature with a positional arg or flag: `squirm worm` / `squirm rabbit`
(or `--worm` / `--rabbit`). Needs [Bun](https://bun.sh). Build a standalone
binary with `bun run build` (output in `dist/bin/<target>/squirm`).

## In the habitat

**Worm** (petri dish):

| key | stimulus |
| --- | --- |
| `f` | drop a food patch — the worm chemotaxes to it and dwells there |
| `t` / `p` | nose touch / tail poke → reversal escape |

Drop food with `f` and watch the worm climb the concentration gradient (panel
shows `↗ climbing gradient`), then slow into "dwelling" once it arrives.

**Rabbit** (scrolling meadow):

| key | stimulus |
| --- | --- |
| `f` | drop a carrot (on the ground *or* a ledge, in view) — it navigates over and eats it |
| `t` / `p` | nose touch / tail poke → startle |
| `d` | predator! → **freeze, then bolt for the burrow** (or flee in the open) |
| `s` | a rustle → **alert** (ears up, scanning) |
| `c` | pet / calm → soothes it into a **groom** |

`space` pause · `r` reset (reshuffles the meadow **and gives it a new name**) · `q` quit.

Left to its own devices a content rabbit will **chase a butterfly** that drifts in
on sunny afternoons (it always just misses), and the whole meadow runs on a slow
**day→night cycle** — sun and moon arcing over, stars and fireflies after dark.

The rabbit lives in a **side-scrolling world wider than the screen** (the camera
follows it) and behaves like a real rabbit: it is **mostly still** — loafing,
grooming, sitting up to *periscope* and scan — and when it does travel it goes in
**short bursts of hops broken by pauses**, never a steady glide. It **walks** and
**runs** on flat ground and only **jumps** to clear a step or reach food up high,
climbing the terrain by an actual reachability graph. It has **drives** (energy,
hunger, comfort, alertness, threat) that produce an emergent ethogram — *walk,
run, hop, leap, binky, zoomies, forage, eat, sniff, groom, periscope, flop, sit,
alert, freeze, flee, thump, chase, hide* — all shown live in the panel HUD along
with its **mood**, what it's **seeing**, and **a life so far** (carrots eaten,
binkies, hops, longest contentment streak); the choice of action is biased by the
forward-command **arousal** read straight out of the connectome.

## How it works

The simulation is layered so the **brain is body-agnostic**: `engine.ts` +
`connectome.ts` drive anything that implements the `Creature` interface
(`creature.ts`). The worm and the rabbit are two creatures sharing one nervous
system — the `nervous system` panel is identical for both because it *is* the
same brain; only the habitat and physics differ.

- **`connectome.ts`** — loads the bundled wiring diagram and builds a signed
  adjacency list (GABAergic neurons inhibit; everything else excites) plus the
  symmetric gap-junction edges. It also names the famous locomotion circuit: the
  command interneurons (AVA/AVD/AVE drive reversal, AVB/PVC drive forward), the
  A/B/D motor-neuron pools, and the sensory entry points for touch and food.

- **`engine.ts`** — the brain. A discrete-time **leaky integrate-and-fire** model
  run over the real connectome: each neuron accumulates input, fires and dumps
  its synaptic weights into its targets when it crosses threshold, then enters a
  brief refractory dip. Gap junctions continuously diffuse charge between coupled
  cells. This is the same reduction Timothy Busbice used to drive a robot from
  the worm's wiring, and the spirit of [OpenWorm](https://openworm.org)'s c302 —
  minus the biophysics.

- **`worm.ts`** — the body. It reads the motor pools and command circuit and
  turns them into a worm that crawls around the **2-D dish**. The head follows a
  heading, weaving gently; the dorsal/ventral motor imbalance steers it, so the
  nervous system decides where it wanders. A *surge* of reversal-command activity
  above its running baseline flips the worm into backward escape — default
  forward foraging, a poke triggers a transient reversal, the canonical reflex.
  The dish walls are **solid**: on contact the worm reflects, backs up, and
  reorients away (an omega-turn escape).

- **`food.ts`** — a bacterial patch as a Gaussian concentration field. The worm
  reads the local concentration and its gradient and chemotaxes the way the real
  animal does: **klinotaxis** (ASEL fires on a rising gradient, ASER on a falling
  one — the left/right asymmetry steers the head up-hill) plus **klinokinesis**
  (heading down-gradient drives the AWC turning pathway → pirouettes that re-aim
  it at the food). On the patch it switches from fast, straight **roaming** to
  slow, local **dwelling** — the documented C. elegans foraging states.

- **`rabbit.ts`** — the other body, same brain. A side-view meadow with real
  gravity: the rabbit is a point mass with velocity, it falls, lands (with a
  squash), and launches in true parabolic arcs over a little staircase + a low
  wall (all reachable — high ground is climbed step by step, never one giant
  jump). The nervous system decides *when and how hard* it jumps — a forward /
  B-motor surge → a hop, a bigger surge → a leap, an obstacle ahead → a clearing
  leap, and a touch-driven reversal surge → a **startle** panic-leap. Drop a
  carrot and it hops over, then **eats** it (the patch shrinks and disappears)
  before going back to roaming. On top of that it has a **life**: a name, a
  **day→night sky** it lives under, a **butterfly** it chases when it's content
  (the chase injects the real forward command, so play genuinely revs the brain),
  and a **burrow** it dives into to hide when threatened — plus a running tally of
  carrots, binkies, hops and contentment shown on the panel.

It is **not** biophysically accurate — no real spikes, ion channels, or timing —
but it is wired from the genuine connectome, so the behaviour you see emerges
from the actual graph, not a script.

## Data & attribution

The bundled `src/data/connectome.json` is derived from
[zhenlab-ltri/NemaNode](https://github.com/zhenlab-ltri/NemaNode) (GPL-3.0),
which digitises the connectome of **White, J.G. et al. (1986)**, *The structure
of the nervous system of the nematode Caenorhabditis elegans*, Phil. Trans. R.
Soc. B. The molecular companion map (gene expression per neuron type) is
[CeNGEN](https://cengen.org) (Taylor et al., Cell 2021).

Built with [Bun](https://bun.sh) and
[pi-tui](https://github.com/earendil-works/pi) (the same terminal renderer behind
`markdown`). Code is MIT; the connectome data retains NemaNode's GPL-3.0 license.
