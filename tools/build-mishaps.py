"""Paradox 5E starship mishaps, v2: one shared library of mishap features that scale from the
owning actor (proficiency bonus, spellcasting-ability DC), and 160 mishap actors composed from it.

Scaling (actor roll data):
  prof        +2 (CR 1) .. +6 (CR 20)
  DC          @attributes.spell.dc  = 8 + prof + mod(actor's spellcasting ability = its primary stat)
  actions     prof - 1 per turn, reactions prof - 1 per round
  radius      5 * (prof - 1) ft;   countdown prof + 1;   Worsen heals 5 * (prof - 1)
  damage      (prof)d6 (single / area), hull (prof)d8, detonation (2*prof - 2)d6 fire + thunder
"""
import json, glob, hashlib, re, copy, sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
REF = os.environ.get("MISHAP_REF", "/tmp/claude-0/-home-claude/249ec0a9-683a-51c5-9699-e37cb1c1ca5e/scratchpad/mishaps/Mishaps")
MOD = "fvtt-neon-odyssey"
FEAT_IMG = "systems/dnd5e/icons/svg/items/feature.svg"
ABL = {"str": "Strength", "dex": "Dexterity", "con": "Constitution", "int": "Intelligence", "wis": "Wisdom", "cha": "Charisma"}
SKILL = {"ath": "Athletics", "acr": "Acrobatics", "arc": "Arcana", "ins": "Insight", "dec": "Deception"}

def hid(*parts):
    h = int(hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest(), 16)
    a = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; s = ""
    while len(s) < 16: s += a[h % 62]; h //= 62
    return s

R = "[[5 * (@prof - 1)]]"          # work radius (ft)
DC = "[[@attributes.spell.dc]]"
HEAL = "[[5 * (@prof - 1)]]"

# ---------------------------------------------------------------- activities
def base_act(aid, typ, kind):
    return {"_id": aid, "type": typ, "activation": {"type": kind, "value": 1, "override": False},
            "consumption": {"scaling": {"allowed": False}, "spellSlot": True, "targets": []}, "description": {},
            "duration": {"units": "inst", "concentration": False, "override": False}, "effects": [],
            "range": {"units": "self", "override": False},
            "target": {"template": {"contiguous": False, "units": "ft", "stationary": False}, "affects": {"choice": False}, "override": False, "prompt": True},
            "uses": {"spent": 0, "recovery": []}, "sort": 0}
def util(aid, kind, name=""):
    a = base_act(aid, "utility", kind); a["name"] = name; a["roll"] = {"formula": "", "name": "", "prompt": False, "visible": False}; return a
def save(aid, kind, abilities, formula=None, dtype=None, name="", onsave="half"):
    a = base_act(aid, "save", kind); a["name"] = name
    a["save"] = {"ability": abilities, "dc": {"calculation": "spellcasting", "formula": ""}}
    a["damage"] = {"onSave": onsave, "parts": ([{"custom": {"enabled": True, "formula": formula}, "types": dtype if isinstance(dtype, list) else [dtype]}] if formula else [])}
    return a
def damage(aid, kind, formula, dtype, name=""):
    a = base_act(aid, "damage", kind); a["name"] = name
    a["damage"] = {"critical": {"allow": False}, "parts": [{"custom": {"enabled": True, "formula": formula}, "types": [dtype]}]}; return a
def heal(aid, kind, formula, name=""):
    a = base_act(aid, "heal", kind); a["name"] = name
    a["healing"] = {"custom": {"enabled": True, "formula": formula}, "types": ["healing"]}; return a

def item(key, name, text, acts=()):
    iid = hid("lib", key)
    activities = {}
    for n, a in enumerate(acts):
        a["_id"] = hid("lib", key, n); a["sort"] = n * 100000; activities[a["_id"]] = a
    return {"_id": iid, "name": name, "type": "feat", "img": FEAT_IMG,
            "system": {"description": {"value": text, "chat": ""}, "activities": activities,
                       "uses": {"spent": 0, "recovery": []}, "identifier": re.sub(r"[^a-z0-9]+", "-", key.lower()).strip("-"),
                       "source": {"revision": 1, "rules": "2024", "custom": "Paradox 5E Starship Mishaps"},
                       "advancement": {}, "crewed": False, "enchant": {}, "prerequisites": {"level": None, "repeatable": False, "items": []},
                       "properties": [], "requirements": "Starship Mishap", "type": {"value": "monster", "subtype": ""}},
            "effects": [], "sort": 0, "flags": {MOD: {"mishapFeature": key}}, "ownership": {"default": 0}}
P = lambda *xs: "".join(f"<p>{x}</p>" for x in xs)

# ---------------------------------------------------------------- the library
LIB = {}
def add(key, name, text, acts=()): LIB[key] = item(key, name, text, list(acts))

add("nature", "Mishap Nature", P(
    f"<strong>Actions.</strong> This mishap takes its turn on initiative count 20 (losing initiative ties) and takes [[@prof - 1]] different actions from its options. It can’t take an action it took on its previous turn.",
    f"<strong>Reactions.</strong> It can take up to [[@prof - 1]] reactions per round and can’t take the same reaction it took most recently.",
    f"<strong>Work Radius.</strong> Its actions and reactions affect only creatures within {R} feet of it: those close enough to work on the affected system.",
    f"<strong>Countdown.</strong> It begins with [[@prof + 1]] countdown counters. At the end of each of its turns, if it still has at least 1 hit point, it loses 1 counter."))
add("obvious", "Obvious Hazard", P("This mishap doesn’t require Diagnosis; its effects are immediately apparent."))
add("hidden", "Hidden Hazard", P(f"This mishap is immune to Correct actions until it has been Diagnosed. A creature can use an action to Diagnose it with an Intelligence (Investigation or Arcana) or Computers check contested by the mishap’s Deception. On a success, the immunity ends."))
for sk, sn in SKILL.items():
    add(f"contest-{sk}", f"Resists Repair ({sn})", P(f"When a creature attempts to Correct this mishap, its ability check is contested by the mishap’s {sn}."))
add("feed", "Energy Feed", P("Whenever this mishap would take damage of a type it feeds on (listed with its damage immunities), it instead regains hit points equal to the damage dealt."))
add("completion", "Completion", P("When this mishap has no countdown counters remaining, it is removed and the ship immediately gains either the next-worse version of this mishap in the same location or its escalation mishap in the same or an adjacent location, determined by the GM. Both are listed in its description."))
add("worsen", "Worsen", P(f"This mishap regains {HEAL} hit points."), [heal(None, "action", "5 * (@prof - 1)")])
add("hamper", "Hamper Correction", P("Until the start of the next round, creatures have disadvantage on Correct and Diagnose checks against this mishap, and the area within the work radius is lightly obscured."), [util(None, "action")])
add("pin", "Pinning Hazard", P(f"One creature within the work radius must succeed on a DC {DC} Strength saving throw or be &Reference[Restrained apply=false] until the end of its next turn. While restrained this way, it has disadvantage on Strength and Dexterity saving throws."), [save(None, "action", ["str"], onsave="none")])
add("knockback", "Knockback", P(f"One creature within the work radius must succeed on a DC {DC} Strength saving throw or be pushed {R} feet in a direction of the GM’s choice and knocked &Reference[Prone apply=false]."), [save(None, "action", ["str"], onsave="none")])
add("footing", "Unstable Footing", P(f"Until the start of the next round, the area within the work radius is difficult terrain. A creature that starts its turn there must succeed on a DC {DC} Dexterity saving throw or fall &Reference[Prone apply=false] and drop one held item of the GM’s choice."), [save(None, "action", ["dex"], onsave="none")])
add("haze", "Obscuring Haze", P(f"Smoke, vapor, or fumes fill the work radius until the start of the next round. The area is heavily obscured, and a creature that starts its turn there must succeed on a DC {DC} Constitution saving throw or be &Reference[Poisoned apply=false] until the end of its next turn."), [save(None, "action", ["con"], onsave="none")])
add("mesmerize", "Mesmerize", P(f"One creature within the work radius must succeed on a DC {DC} Wisdom saving throw or be &Reference[Charmed apply=false] by this mishap until the end of its next turn. While charmed this way, its speed is 0 and it has disadvantage on checks made to Correct the mishap."), [save(None, "action", ["wis"], onsave="none")])
add("lockout", "System Lockout", P("The system this mishap afflicts (a weapon mount, station, engine, or ward) can’t be used until the start of the next round."), [util(None, "action")])
add("disruption", "Ship Disruption", P("The GM chooses one effect that fits the afflicted system, lasting until the start of the next round: the ship’s Speed drops by 1 (minimum 1); the ship turns 1 facing; the ship’s AC drops by 1; the next action at the afflicted station costs 1 more Tempo; or the afflicted station has disadvantage on its next check."), [util(None, "action")])
add("spread", "Spread", P(
    "<strong>Action.</strong> The mishap spreads to nearby material or systems: the ship gains a Minor version of this mishap (CR 1) in an unoccupied space within the work radius. A mishap of CR 15 or higher spreads its standard version (CR 5) instead.",
    "<strong>Reaction.</strong> When this mishap takes force damage, roll a d20. On 11 or higher, it spreads as above."), [util(None, "action", "Spread"), util(None, "reaction", "Force-driven Spread")])
add("hull", "Hull Stress", P("The afflicted structure buckles. The ship takes [[@prof]]d8 bludgeoning damage."), [damage(None, "action", "(@prof)d8", "bludgeoning")])
add("instability", "Trigger Instability", P("The mishap destabilizes a neighboring system. The ship gains this mishap’s escalation mishap, one severity lower than this mishap (Minor for Minor and standard mishaps), in the same or an adjacent location (GM’s choice). It is listed in this mishap’s description."), [util(None, "action")])
add("failure", "System Failure", P("The afflicted ship system gains a Mishap token (impaired; a second token takes it offline) until this mishap is Corrected."), [util(None, "action")])
add("feedback", "Feedback", P(f"<strong>Reaction.</strong> When the ship uses the system this mishap afflicts (fires its weapon, reroutes its power, maneuvers, raises its ward, and so on), roll a d20. On 11 or higher, this mishap regains {HEAL} hit points."), [heal(None, "reaction", "5 * (@prof - 1)")])
add("lurch", "Lurch", P(f"<strong>Reaction.</strong> When a creature succeeds on a Correct or Diagnose action against this mishap, that creature must succeed on a DC {DC} Strength saving throw or be pushed [[5 * (@prof - 2)]] feet and have disadvantage on its next ability check or attack roll before the end of its next turn."), [save(None, "reaction", ["str"], onsave="none")])
add("rebound", "Rebound", P(f"<strong>Reaction.</strong> When this mishap is reduced below half its hit points for the first time, each creature within the work radius must succeed on a DC {DC} Dexterity saving throw or be knocked &Reference[Prone apply=false]."), [save(None, "reaction", ["dex"], onsave="none")])
add("slam", "Slam", P("<strong>Reaction.</strong> When a creature is pushed or slid by this mishap, it takes [[@prof - 2]]d8 bludgeoning damage as it strikes bulkheads or fixed structures."), [damage(None, "reaction", "(@prof - 2)d8", "bludgeoning")])
# explosion family
add("detonation", "Detonation", P(
    f"When this mishap’s last countdown counter is removed, it detonates instead of Completing: each creature within [[5 * @prof]] feet of the affected system must make a DC {DC} Dexterity saving throw, taking [[2 * @prof - 2]]d6 fire damage and [[2 * @prof - 2]]d6 thunder damage on a failed save, or half as much damage on a successful one.",
    "After detonating, the mishap ends and the ship gains a Fire mishap and one random mishap, each one severity lower (Minor for Minor and standard explosions), in the same or adjacent locations."),
    [save(None, "special", ["dex"], "(2 * @prof - 2)d6", ["fire"]), damage(None, "special", "(2 * @prof - 2)d6", "thunder", "Thunder")])
add("volatile", "Volatile Pressure", P("If this mishap regains hit points for any reason, it vents violently and immediately uses Resist Correction against one creature within its work radius (GM’s choice)."))
add("portable", "Portable Threat", P(
    "This mishap can be &Reference[Grappled apply=false]. While grappled, it is treated as an object weighing [[150 * (@prof - 1)]] pounds for lifting, dragging, or throwing, and its affected system and detonation point move with it.",
    f"<strong>Violent Jolt (Reaction).</strong> When it is grappled or moved while grappled, the grappler must succeed on a DC {DC} Strength or Dexterity saving throw (grappler’s choice) or take [[@prof]]d6 thunder damage and be knocked &Reference[Prone apply=false]; on a success, the movement continues."),
    [save(None, "reaction", ["str", "dex"], "(@prof)d6", "thunder")])

# damage/save variant families: Resist Correction (Minor+) and Hazard Burst (Major+)
VARIANTS = {}
def variant(dtype, sav):
    key = f"{dtype}-{sav}"
    if key in VARIANTS: return key
    VARIANTS[key] = True
    label = dtype.title()
    add(f"resist-{key}", f"Resist Correction ({label}, {sav.title()})", P(
        f"<strong>Action.</strong> One creature within the work radius must make a DC {DC} {ABL[sav]} saving throw, taking [[@prof]]d6 {dtype} damage on a failed save, or half as much on a successful one, and it has disadvantage on its next ability check before the end of its next turn.",
        "<strong>Backfire (Reaction).</strong> When a creature fails a Correct action against this mishap, the mishap uses Resist Correction against that creature."),
        [save(None, "action", [sav], "(@prof)d6", dtype, "Resist Correction"), save(None, "reaction", [sav], "(@prof)d6", dtype, "Backfire")])
    add(f"burst-{key}", f"Hazard Burst ({label}, {sav.title()})", P(
        f"<strong>Action.</strong> Each creature within the work radius must make a DC {DC} {ABL[sav]} saving throw, taking [[@prof]]d6 {dtype} damage on a failed save, or half as much on a successful one.",
        f"<strong>Hazard Zone (Reaction).</strong> When a creature ends its turn within the work radius, it must succeed on a DC {DC} {ABL[sav]} saving throw or take [[@prof - 2]]d6 {dtype} damage."),
        [save(None, "action", [sav], "(@prof)d6", dtype, "Hazard Burst"), save(None, "reaction", [sav], "(@prof - 2)d6", dtype, "Hazard Zone", onsave="none")])
    return key

# knockdown family (Listing / Pitch and Roll / Wind Shear): Str or Dex, push + prone instead of damage
add("resist-knockdown", "Resist Correction (Knockdown)", P(
    f"<strong>Action.</strong> One creature within the work radius must succeed on a DC {DC} Strength or Dexterity saving throw (its choice) or be pushed {R} feet in a direction of the GM’s choice, knocked &Reference[Prone apply=false], and have disadvantage on its next ability check before the end of its next turn.",
    "<strong>Backfire (Reaction).</strong> When a creature fails a Correct action against this mishap, the mishap uses Resist Correction against that creature."),
    [save(None, "action", ["str", "dex"], onsave="none", name="Resist Correction"), save(None, "reaction", ["str", "dex"], onsave="none", name="Backfire")])
add("burst-knockdown", "Hazard Burst (Knockdown)", P(
    f"<strong>Action.</strong> Each creature within the work radius must succeed on a DC {DC} Dexterity saving throw or take [[@prof]]d8 bludgeoning damage from shifting cargo and structure and be knocked &Reference[Prone apply=false].",
    f"<strong>Hazard Zone (Reaction).</strong> When a creature ends its turn within the work radius, it must succeed on a DC {DC} Strength saving throw or have its speed reduced to 0 until the start of its next turn."),
    [save(None, "action", ["dex"], "(@prof)d8", "bludgeoning", "Hazard Burst", "none"), save(None, "reaction", ["str"], onsave="none", name="Hazard Zone")])

# ---------------------------------------------------------------- mishap types
# (display, component keys, resist variant (dtype, save) or "knockdown", skill, hidden, feeds, escalation display, pool[4], extras)
T = []
def typ(name, keys, var, skill, hidden, feeds, esc, pool, hp="mid", primary="con", icon=None, extras=(), explosion=False):
    T.append(dict(name=name, keys=keys, var=var, skill=skill, hidden=hidden, feeds=feeds, esc=esc, pool=pool, hp=hp, primary=primary, icon=icon, extras=list(extras), explosion=explosion))

KD = "knockdown"
# reference families
typ("Fire", ["Fire"], ("fire", "dex"), "acr", False, ["fire", "radiant"], "Explosion", ["spread", "haze", "mesmerize", "hull"], "high", "dex", "icons/magic/fire/flame-burning-campfire-orange.webp")
typ("Explosion", ["Explosion"], ("slashing", "dex"), "dec", True, [], "Fire", ["knockback", "pin", "lockout", "hull"], "high", "dex", "icons/magic/fire/explosion-fireball-large-red-orange.webp", ["volatile", "portable"], explosion=True)
typ("Listing", ["List"], KD, "ath", False, [], "Loss of Control", ["footing", "pin", "knockback", "hull"], "mid", "str", "icons/magic/water/wave-water-blue.webp")
typ("Pitch and Roll", [], KD, "ath", False, [], "Listing", ["footing", "knockback", "pin", "hull"], "mid", "str", "icons/magic/water/waves-water-blue.webp")
typ("Wind Shear", ["Wind-Sheer"], KD, "ath", False, [], "Loss of Control", ["pin", "knockback", "footing", "hull"], "mid", "str", "icons/magic/air/wind-tornado-funnel-gray.webp")
# component families (DRAFT)
typ("Weapon Break", ["Weapon-Break"], ("piercing", "dex"), "ath", False, ["thunder", "force"], "Explosion", ["lockout", "disruption", "knockback", "hull"], primary="str", icon="icons/weapons/guns/gun-pistol-flintlock-metal.webp")
typ("Operator Injury", ["Operator-Injury"], ("lightning", "con"), "ath", False, ["lightning"], "Crew Injury", ["pin", "lockout", "disruption", "knockback"], icon="icons/skills/wounds/injury-body-pain-gray.webp")
typ("Crew Injury", ["Crew-Injury"], ("bludgeoning", "con"), "ath", False, ["thunder"], "Loss of Control", ["mesmerize", "pin", "disruption", "knockback"], icon="icons/skills/wounds/injury-stitched-flesh-red.webp")
typ("Loss of Control", ["Loss-of-Control"], ("bludgeoning", "str"), "acr", False, [], "Loss of Speed", ["disruption", "knockback", "footing", "hull"], primary="dex", icon="icons/tools/navigation/compass-plain-blue.webp")
typ("Jam", ["Jam"], ("bludgeoning", "dex"), "ath", False, ["fire"], "Weapon Break", ["lockout", "disruption", "spread", "hull"], primary="str", icon="icons/tools/smithing/hammer-sledge-steel-grey.webp")
typ("Misfire", ["Misfire"], ("force", "dex"), "acr", False, ["force", "lightning"], "Explosion", ["lockout", "disruption", "spread", "hull"], primary="dex", icon="icons/skills/targeting/crosshair-pointed-orange.webp")
typ("Loss of Speed", ["Loss-of-Speed"], ("cold", "con"), "ath", False, ["cold"], "Loss of Power", ["disruption", "lockout", "haze", "hull"], icon="icons/magic/control/buff-flight-wings-runes-blue.webp")
typ("Backlash", ["Backlash"], ("force", "con"), "ath", False, ["force"], "Explosion", ["disruption", "lockout", "knockback", "hull"], icon="icons/magic/lightning/bolt-strike-blue.webp")
typ("Swivel Lock", ["Swivel-Lock"], ("bludgeoning", "str"), "ath", False, ["cold"], "Weapon Break", ["lockout", "disruption", "pin", "hull"], primary="str", icon="icons/tools/hand/wrench-steel-grey.webp")
typ("Wild-Magic", ["Wild-Magic"], ("force", "wis"), "arc", True, ["force", "radiant"], "Psychic Blast", ["mesmerize", "spread", "knockback", "disruption"], primary="cha", icon="icons/magic/symbols/runes-star-pentagon-magenta.webp")
typ("Wild Magic", ["Wild Magic"], ("force", "wis"), "arc", True, ["force", "radiant"], "Vulnerability", ["lockout", "disruption", "mesmerize", "spread"], primary="cha", icon="icons/magic/defensive/shield-barrier-flaming-diamond-teal.webp")
typ("Loss of Power", ["Loss-of-Power"], ("lightning", "con"), "ath", True, ["lightning"], "Electrical", ["lockout", "disruption", "haze", "spread"], icon="icons/magic/lightning/bolt-forked-large-blue.webp")
typ("Fuel Depletion", ["Fuel-Depletion"], ("poison", "con"), "ath", True, [], "Loss of Speed", ["haze", "disruption", "lockout", "spread"], icon="icons/consumables/potions/potion-tube-corked-green.webp")
typ("Psychic Blast", ["Psychic-Blast"], ("psychic", "wis"), "ins", False, [], "Wild-Magic", ["mesmerize", "pin", "disruption", "knockback"], primary="cha", icon="icons/magic/perception/eye-ringed-glow-angry-small-teal.webp")
typ("Gravity Spike", ["Gravity-Spike"], ("bludgeoning", "str"), "ath", False, ["force"], "Gravity Loss", ["pin", "footing", "knockback", "hull"], "high", "str", "icons/magic/earth/orb-stone-smoke-teal.webp")
typ("Gravity Loss", ["Gravity-Loss"], ("bludgeoning", "dex"), "acr", False, ["force"], "Gravity Spike", ["footing", "knockback", "disruption", "hull"], "high", "dex", "icons/magic/air/wind-vortex-swirl-blue.webp")
typ("Electrical", ["Electrical"], ("lightning", "dex"), "acr", True, ["lightning"], "Fire", ["haze", "lockout", "spread", "disruption"], "high", "dex", "icons/magic/lightning/bolt-strike-blue.webp")
typ("Founder", ["Founder"], ("cold", "con"), "ath", False, [], "Loss of Control", ["knockback", "disruption", "spread", "hull"], "high", icon="icons/magic/water/wave-water-blue.webp")
typ("Radiation", ["Radiation"], ("radiant", "con"), "ath", True, ["radiant", "fire"], "Core Overload", ["haze", "spread", "disruption", "hull"], "high", icon="icons/magic/light/explosion-star-glow-yellow.webp")
typ("Core Overload", ["Core-Overload"], ("fire", "con"), "ath", False, ["fire", "radiant"], "Explosion", ["haze", "lockout", "spread", "hull"], "high", icon="icons/magic/fire/explosion-embers-evade-silhouette.webp")
typ("Defect", ["Defect"], ("bludgeoning", "dex"), "dec", True, ["thunder"], "Vulnerability", ["disruption", "lockout", "hull", "spread"], primary="int", icon="icons/equipment/shield/heater-steel-worn.webp")
typ("Fuel Issue", ["Fuel-Issue"], ("poison", "con"), "ath", True, [], "Fuel Depletion", ["haze", "lockout", "disruption", "spread"], icon="icons/consumables/potions/bottle-round-corked-green.webp")
typ("Overpower", ["Overpower"], ("lightning", "con"), "ath", False, ["lightning"], "Core Overload", ["lockout", "disruption", "spread", "hull"], "high", icon="icons/magic/lightning/bolt-forked-large-blue.webp")
typ("Vulnerability", ["Vulnerability"], ("force", "dex"), "dec", True, ["force"], "Defect", ["disruption", "lockout", "hull", "spread"], primary="int", icon="icons/magic/defensive/shield-barrier-deflect-teal.webp")
typ("Loss of Lift", ["Loss-of-Lift"], ("bludgeoning", "dex"), "acr", False, [], "Loss of Control", ["footing", "disruption", "knockback", "hull"], primary="dex", icon="icons/magic/air/wind-vortex-swirl-blue.webp")
typ("Rigging Failure", ["Rigging-Failure"], ("slashing", "dex"), "ath", False, ["thunder"], "Loss of Lift", ["pin", "knockback", "disruption", "hull"], primary="str", icon="icons/sundries/survival/rope-wrapped-brown.webp")
typ("Break", ["Break"], ("piercing", "dex"), "ath", False, ["thunder", "cold"], "Loss of Power", ["lockout", "disruption", "spread", "hull"], primary="str", icon="icons/tools/smithing/hammer-sledge-steel-grey.webp")

TIERS = [("Minor", 1, 12, "sm", 11), ("", 5, 14, "med", 12), ("Major", 10, 16, "lg", 13), ("Critical", 15, 18, "huge", 14), ("Catastrophic", 20, 20, "grg", 15)]
HP = {"high": [20, 45, 70, 95, 120], "mid": [20, 35, 55, 75, 95]}
tn = lambda p, b: f"{p} {b}".strip()

def compose(t, ti):
    """Library keys for type t at tier index ti."""
    var = t["var"]
    vkey = "knockdown" if var == KD else variant(*var)
    keys = ["nature", "hidden" if t["hidden"] else "obvious", f"contest-{t['skill']}"]
    if t["feeds"]: keys.append("feed")
    keys.append("detonation" if t["explosion"] else "completion")
    keys += t["extras"]
    keys += [f"resist-{vkey}", "worsen", "hamper", t["pool"][0], "feedback"]
    if ti >= 1: keys += [t["pool"][1], "instability", "lurch"]
    if ti >= 2: keys += [f"burst-{vkey}", t["pool"][2]]
    if ti >= 3: keys += ["failure", "rebound"] + (["slam"] if var == KD or "knockback" in t["pool"] else [])
    if ti >= 4: keys += [t["pool"][3]]
    seen = []; [seen.append(k) for k in keys if k not in seen]
    return seen

def bio(t, ti):
    p, cr = TIERS[ti][0], TIERS[ti][1]
    nxt = TIERS[min(ti + 1, 4)]; low = TIERS[max(ti - 1, 0)]
    lines = [f"<p><em>Paradox 5E starship mishap{' (DRAFT)' if t['name'] not in REF_NAMES else ''}. Features come from the shared Mishap Features library and scale with this actor’s CR and stats.</em></p>"]
    if t["explosion"]:
        lines.append(f"<p><strong>Detonation creates:</strong> {tn(low[0], 'Fire')} (CR {low[1]}) and one random mishap (CR {low[1]}).</p>")
    else:
        lines.append(f"<p><strong>Completion:</strong> {tn(nxt[0], t['name'])} (CR {nxt[1]}) or {tn(p, t['esc'])} (CR {cr}).</p>")
    lines.append(f"<p><strong>Escalation mishap</strong> (Trigger Instability): {tn(low[0], t['esc'])} (CR {low[1]}).</p>")
    if t["feeds"]: lines.append(f"<p><strong>Feeds on:</strong> {', '.join(t['feeds'])} damage.</p>")
    return "".join(lines)

REF_NAMES = {"Fire", "Explosion", "Listing", "Pitch and Roll", "Wind Shear"}

# reference actors: keep their ids, names and stats
ref_by_name = {}
for f in glob.glob(REF + "/*.json"):
    d = json.load(open(f)); d["_id"] = re.search(r"-([A-Za-z0-9]{16})\.json$", f).group(1); ref_by_name[d["name"]] = d

def actor(t, ti):
    p, cr, dcx, size, ac = TIERS[ti]
    name = tn(p, t["name"])
    ref = ref_by_name.get(name)
    lib_items = []
    for k in compose(t, ti):
        it = copy.deepcopy(LIB[k]); src = it["_id"]
        it["_id"] = hid(name, k)
        acts = {}
        for aid, a in it["system"]["activities"].items():
            na = copy.deepcopy(a); na["_id"] = hid(name, k, aid); acts[na["_id"]] = na
        it["system"]["activities"] = acts
        it["_stats"] = {"compendiumSource": f"Compendium.{MOD}.monster-features.Item.{src}"}
        lib_items.append(it)
    if ref:
        s = copy.deepcopy(ref["system"])
        s["attributes"].setdefault("ac", {})
        if s["attributes"]["ac"].get("calc") != "flat" or not s["attributes"]["ac"].get("flat"):
            s["attributes"]["ac"] = {"calc": "flat", "flat": ac}
        # spellcasting (DC) ability = its highest physical/mental stat
        prof = 2 + max(0, (cr - 1) // 4)
        order = sorted(("str", "dex", "con", "wis", "int", "cha"), key=lambda k: -s["abilities"][k]["value"])
        best = next((k for k in order if 8 + prof + (s["abilities"][k]["value"] - 10) // 2 == dcx), order[0])
        s["attributes"]["spellcasting"] = best
        off = dcx - (8 + prof + (s["abilities"][best]["value"] - 10) // 2)
        if off: s.setdefault("bonuses", {}).setdefault("spell", {})["dc"] = str(off)   # keep the reference's printed DC
        aid, img, generated = ref["_id"], t["icon"], False
        orig = ref["img"]
    else:
        ab = 10 + 2 * ti + 2
        abil = {k: {"value": ab} for k in ABL}
        abil["int"]["value"] = 5; abil["cha"]["value"] = 5; abil["wis"]["value"] = ab - 2
        abil[t["primary"]]["value"] = ab + 2
        s = {"abilities": abil, "attributes": {"ac": {"calc": "flat", "flat": ac}, "hp": {"value": HP[t["hp"]][ti], "max": HP[t["hp"]][ti], "formula": "0"}, "spellcasting": t["primary"]},
             "details": {"cr": cr, "alignment": "Unaligned", "type": {"value": "custom", "subtype": "Hazard", "custom": "Mishap"}},
             "traits": {"size": size, "ci": {"value": ["charmed", "frightened", "paralyzed", "petrified", "poisoned", "stunned"], "custom": ""},
                        "di": {"value": ["poison", "psychic", "bludgeoning", "piercing", "slashing"], "bypasses": [], "custom": ""}, "languages": {"value": [], "custom": "—"}}}
        aid, img, generated, orig = hid(t["name"], ti, "actor"), t["icon"], True, None
    # skills: contested skill (+ Deception to resist Diagnosis)
    s["skills"] = {t["skill"]: {"value": 1}}
    if t["hidden"]: s["skills"]["dec"] = {"value": 1}
    s.setdefault("details", {})["biography"] = {"value": bio(t, ti), "public": ""}
    if t["feeds"]:
        di = s["traits"].setdefault("di", {"value": [], "bypasses": [], "custom": ""})
        di["value"] = sorted(set(di.get("value", [])) - set(t["feeds"]))
        di["custom"] = "Feeds on " + " and ".join(t["feeds"]) + " (see Energy Feed)"
    mflag = {"types": t["keys"], "base": t["name"], "tier": p or "Standard", "cr": cr, "generated": generated, "draft": generated, "features": compose(t, ti)}
    if orig: mflag["originalImg"] = orig
    tok = {"name": name, "actorLink": False, "disposition": -1, "displayName": 20, "texture": {"src": img},
           "width": {"sm": 1, "med": 1, "lg": 2, "huge": 3, "grg": 4}[s["traits"]["size"]]}
    tok["height"] = tok["width"]
    return {"_id": aid, "name": name, "type": "npc", "img": img, "system": s, "items": lib_items,
            "prototypeToken": tok, "flags": {MOD: {"mishap": mflag}}, "_folderType": t["name"]}

actors = [actor(t, ti) for t in T for ti in range(5)]
lib = list(LIB.values())
for it in lib:
    for n, (aid, a) in enumerate(list(it["system"]["activities"].items())): pass
names = [a["name"] for a in actors]; assert len(names) == len(set(names))
ids = [a["_id"] for a in actors]; assert len(ids) == len(set(ids))
for a in actors:
    for it in a["items"]:
        assert len(it["_id"]) == 16
        for k in it["system"]["activities"]: assert len(k) == 16
json.dump({"library": lib, "folders": sorted({a["_folderType"] for a in actors}), "actors": actors},
          open(os.path.join(HERE, "mishaps-data-v2.json"), "w"), ensure_ascii=False)
print("library items", len(lib), "actors", len(actors), "ref-based", sum(1 for a in actors if not a["flags"][MOD]["mishap"]["generated"]))
per = {}
for a in actors: per.setdefault(len(a["items"]), 0); per[len(a["items"])] += 1
print("items per actor:", dict(sorted(per.items())))
