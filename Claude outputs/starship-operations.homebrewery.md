# Starship Operations

{{note
##### Draft Rules
These rules are under review and may change.
}}

Build **Tempo** to act. Acting costs Tempo. Mistakes and damage add **Strain**, and every time Strain passes a multiple of the ship's **Mishap Threshold**, a **Mishap** strikes the ship.

Each round, every crewed station takes one turn: **Gain Tempo** or **Spend Tempo** on a station action.

## Ranges and Movement

**Ranges.** Point Blank, Short, Medium, Long, Extreme. A weapon fires at its designed range; one range farther is at disadvantage.

**Speed** is the ship's movement budget each round (minimum 1). Moving farther or turning harder in one round costs more, doubling each step.

##### Range Bands Moved in One Round
| Bands | Speed Cost |
|:-----:|:----------:|
| 1 | 1 |
| 2 | 2 |
| 3 | 4 |
| 4 | 8 |
| 5 (out of range) | 16 |

*Range-band costs are still under review.*

##### Clock Facings Turned in One Round
| Facings | Speed Cost |
|:-------:|:----------:|
| 1 | 1 |
| 2 | 2 |
| 3 | 4 |
| 4 | 8 |
| 5 | 16 |
| 6 (180°) | 32 |

\column

## Tempo

**Starting Tempo** equals the number of players, or 0 if the ship is surprised.

**Gain Tempo.** Choose a skill and describe how it readies the ship (a Persuasion pep talk, Acrobatics at the helm, Investigation on the engines). The DC equals the current Tempo. On a success, add your Proficiency Bonus in that skill to Tempo. On a failure, add 1 Strain.

**Critical Success.** On any check or attack, add 1 Tempo.

**Spend Tempo.** Take a station action and pay its Tempo cost. If your ship is out of Tempo, you may pay 2 Strain per Tempo cost instead.

## Strain

##### Strain
| Event | Strain |
|:------|:-------|
| Failed Gain Tempo | +1 |
| Fumble | +1 |
| Damage over the Damage Threshold | + the excess |
| Out of Tempo, acting anyway | +2 per Tempo cost |
| Engineer: Vent (1 Tempo) | −2 |
| Commander: Damage Control (2 Tempo) | next Correct removes 2 extra |
| Correcting a Mishap | − the ship's Mishap Threshold |

**Disabled.** When Strain reaches the ship's maximum Hit Points, the ship is disabled and no station can take actions. The only way to recover is to Correct Mishaps. Offline systems can leave a ship adrift, defenseless, or unable to attack long before its Hit Points run out.

\page

## Mishaps

**Trigger.** Each time Strain passes a multiple of the ship's **Mishap Threshold**, roll on the ship's Possible Mishaps list and drop that Mishap token on the struck system (or a random one). Passing the same multiple again after Strain drops triggers a new Mishap.

**Systems.** One Mishap token: that station's checks have disadvantage. Two: the system is offline and its actions are unavailable.

**Correct.** A player leaves their station for the turn and makes the check the Mishap names. When the Mishap reaches 0 HP, remove its token and Strain equal to the ship's Mishap Threshold.

## Stations

Players choose which stations to crew: Commander, Navigator, Helmsman, Gunner, and Engineer. Every station can Gain Tempo or take one of its actions. Stations can also be used creatively in Social, Exploration, and Combat scenes.

##### Any Station
| Action | Tempo | Effect |
|:-------|:-----:|:-------|
| Gain Tempo | +PB | Any skill you can justify; DC = current Tempo. Failure: +1 Strain. |
| Correct | — | Leave your station to work on a Mishap. Success removes Strain equal to the ship's Mishap Threshold. |

### Commander

*Coordinates the crew.*
**Skills:** Persuasion, Intimidation, Insight

##### Commander Actions
| Action | Tempo | Effect |
|:-------|:-----:|:-------|
| Rally | 1 | One station's next check this round has advantage. |
| Orders | 2 | One station that has already acted takes one more action (it still pays that action's cost). |
| Damage Control | 2 | The next Correct this round has advantage, and a success removes 2 extra Strain. |

\column

### Navigator

*Information, positioning, and electronic warfare.*
**Skills:** Insight, Perception, Investigation, Computers

##### Navigator Actions
| Action | Tempo | Effect |
|:-------|:-----:|:-------|
| Scan | 1 | Learn one enemy's AC, Strain, Active Mishaps, or weapon ranges. |
| Target Lock | 2 | Gunners firing into one arc (bow, stern, port, or starboard) have advantage this round. |
| Evasive Plot | 2 | Attacks from one arc have disadvantage until your next turn. |
| Electronic Warfare | 3 | Hack one enemy ship: a Computers check against DC 10 + the target's current Tempo. On a success, choose one: the target loses Tempo equal to your Proficiency Bonus, **or** gains Strain equal to your Proficiency Bonus, **or** one of its stations has disadvantage until the end of its next turn. |

### Helmsman

*Movement.*
**Skills:** Piloting, Acrobatics

##### Helmsman Actions
| Action | Tempo | Effect |
|:-------|:-----:|:-------|
| Maneuver | 1 | Spend the ship's Speed on moves and turns (see Ranges and Movement). Once per round. |
| Attack Position | 2 | Piloting check: shift one enemy 1 facing relative to your ship without spending Speed. |
| Roll with the Punch | 2 (reaction) | Piloting check when the ship is hit: reduce the damage by 2d8. |

##### Special Maneuvers
| Maneuver | Tempo | Effect |
|:---------|:-----:|:-------|
| Crazy Ivan | 3 | **Maneuverable** ships only. Piloting check to turn 180°. Take Strain equal to the Speed you are short. On a failure, the ship gains a Loss-of-Control Mishap. |
| Flee | 4 | Each enemy may make one opportunity attack against the ship, at disadvantage. The ship escapes at the end of that turn. |

\page

### Gunner

*Fire control.* Ship weapon attacks use the gunner's DEX (STR for melee) modifier and proficiency bonus.
**Skills:** Perception, or an attack roll

##### Gunner Actions
| Action | Tempo | Effect |
|:-------|:-----:|:-------|
| Fire | 1 | Attack with one weapon crewed at this station. |
| Suppressing Fire | 1 | One enemy's next attack has disadvantage. |
| Aimed Shot | 2 | Fire with advantage. |
| Empowered Shot | 4 | Fire with advantage. On a hit, add one extra damage die. |

### Engineer

*Power and repair.*
**Skills:** Engineering, Investigation

##### Engineer Actions
| Action | Cost | Effect |
|:-------|:----:|:-------|
| Vent | 1 | Remove 2 Strain. |
| Reroute Power | 2 (+1 Strain) | Push power to one system until the start of your next turn. Choose from the Reroute Power table. |
| Divert Power to Shields | 2 + 2 Strain (reaction) | When the ship is hit by an attack, before damage is rolled: +5 AC until the start of your next turn, including against the triggering attack. The ship must have a Shield component installed, and the Shields system cannot be offline. |
| Emergency Repair | 3 | Engineering check to Correct one Mishap without leaving the station. |

\column

##### Reroute Power
| System | Effect |
|:-------|:-------|
| One weapon system | Hits from that weapon system add one extra damage die. |
| One weapon system | That weapon system fires one range band farther without disadvantage. |
| Propulsion | The ship gains Speed equal to your Proficiency Bonus. |
| Navigation | The Navigator adds your Proficiency Bonus to their next check, including Electronic Warfare. |
| Command & Control | The Commander's next action costs 1 less Tempo (minimum 0). |

- Weapon systems are the weapon mounts on your ship; they vary from ship to ship.
- Rerouting power to a system with one Mishap cancels that Mishap's disadvantage while the reroute lasts.
- A system with two Mishaps (offline) cannot receive power.
