# Liar's Dice at the Dead Man's Hand

A table of Liar's Dice for chapter 15 of The Crooked Moon. One link, any device.
Each player sees only their own five dice; the dealer sees everything.

**Live at <https://lhowlett99.github.io/liar-s-dice>** (repo: `liar-s-dice`).
The rest of this file is the setup walkthrough, kept for reference or for
standing it back up if the Firebase project ever goes away.

- Ones are wild
- Bids, permanent dice loss and elimination are tracked
- All six special traits, **once each per game**, and only for the character who
  has the proficiency. Defaults come off the party's real sheets and the dealer
  can grant or revoke any of them in the lobby
- Hard Read and Sly Reveal do real private reveals
- The Sinner's pool grows by one die per character who sits down
- A **Cast** button hides your own hand so you can share your screen
- Three tables, each with its own look and sound: a plain test, Murkwater Bend and the crocodile

---

## What you need

A Google account (for Firebase) and a GitHub account (for hosting). Both free,
and this stays inside the free tier at this scale by a wide margin.

---

## 1. Make the Firebase project

1. Go to <https://console.firebase.google.com> and click **Create a project**
2. Name it something like `liars-dice`. Turn **Google Analytics off**, you do not need it
3. Wait for it to finish, then **Continue**

## 2. Add a web app

1. On the project overview, click the **`</>`** (web) icon
2. Nickname it `table`. **Do not** tick Firebase Hosting
3. Click **Register app**
4. It shows you a `firebaseConfig` block. **Copy the whole thing**
5. Paste the values into `firebase-config.js` in this folder

## 3. Create the Realtime Database

This is the step people miss. It is **Realtime Database**, not Firestore.

1. Left sidebar, **Build** → **Realtime Database**
2. **Create Database**
3. Pick a location near you (`europe-west1` for the UK)
4. Start in **locked mode**, you will paste proper rules in a moment
5. Once created, go to the **Rules** tab, replace everything with the contents
   of `database.rules.json` from this folder, and **Publish**

Now go back to **Project settings → General → your web app → Config** and check
the config block has a `databaseURL` line in it. Copy that into
`firebase-config.js` too if it was not there the first time.

### What those rules do

Anyone who knows a four-letter table code can read and write that table, and
nothing else. There is no login. A table is only as private as its code, which
is the right trade for a twenty-minute minigame among friends. Nobody can list
the tables, delete the database, or reach anything outside `rooms/`.

## 4. Put it on GitHub Pages

```bash
cd liars-dice
git init
git add .
git commit -m "Liar's Dice table"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/liars-dice.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / `root` → Save**.

A minute later it is live at `https://YOUR-USERNAME.github.io/liars-dice/`.

## 5. Test it before session

1. Open the link, hit **Deal a new table**
2. Set the seats, choose the opponent, **Deal the first round**
3. Open the same link in a private window, put in the four-letter code, and take a seat
4. Check that the private window only shows that one player's dice

---

## Running it at the table

**You** open the link and hit **Deal a new table**. You get a four-letter code.
**Copy the link** and send it to the group; it already has the code in it.

Each player opens it on their phone and taps their name to sit down. You stay on
the dealer view, which shows every hand and a running tally of each face.

Then: **Deal the first round** → they bid in turn on their own phones → someone
challenges → the reveal flips every hand face up at once, lights the matching
dice, counts them up, and names who lost a die. **Next round** carries on.

If a player cannot get on a phone, the dealer table has a **Copy** button per
seat that puts `Sassafras — your hand: 3 5 5 1 2 (ones are wild)` on your
clipboard, along with the cheats they have not spent yet, ready to paste into a DM.

### Cheats

Each trait is once per game per proficiency (twice with expertise), not three uses
from a shared pool. A player only sees the cheats their character has. Uses left
are shown on each button.

| | Hard Read | Deft Hands | Sly Reveal | Poker Face | Daring Dicer | Fated Luck |
|---|---|---|---|---|---|---|
| Sassafras | 1 | 2 | 1 | 2 | 1 | 1 |
| Ryn | 1 | | | 1 | | |
| Fizzwick | | 1 | | 1 | | |
| Sister Maple | 1 | | | | | |

The grants are set by character name in the `PROFICIENCIES` list at the top of
`app.js`. A seat with a name that is not on that list gets no cheats.

### The three tables

Pick one in the lobby under **Who are they playing against?** before you deal. The
whole app changes dress to match, for everyone at the table, the moment you pick.

- **A plain test table.** One house seat, "The House", on five dice. No theme, no
  texture. For trying things out.
- **Murkwater Bend.** Vander Boone and Lyla Webb, five dice each. You play both,
  and they signal each other under the table, so let that show once or twice.
  Lantern-lit gambling den: weathered timber, baize felt, brass studs, aged ivory dice.
- **Roll the Bones.** Mister Crossroads, the crocodile, opening on five dice plus one
  for every character who sits down. He bids his most common face plus one,
  aggressively. The moment he is eliminated he flips the table and forfeits.
  Swamp scales, a jaw of teeth along the felt, bone dice with blood-red pips.

You bid and challenge for the house from the **Dealer** panel on its turn.

### Sound

Everything is made from filtered noise in the browser, so there are no audio files and
nothing pings: dice clattering on timber, knuckles on the rail, cloth, creaking boards
and water. It is quiet on purpose, to sit under your music. The **Sound** button in
the top bar cycles three ways, remembered per device:

- **all**: the table sounds plus the odd noise from the room (creaks, drips and
  rustles at Murkwater Bend; splashes, bubbles and a low growl in the swamp)
- **dice**: just the table sounds
- **off**

The plain test table has no atmosphere noises. Phones only allow sound after a first tap,
so a player's very first sound can be skipped.

---

## Files

| File | What it is |
|---|---|
| `index.html` | Structure |
| `styles.css` | The whole look |
| `app.js` | Game rules and Firebase sync |
| `firebase-config.js` | **The only file you edit** |
| `database.rules.json` | Paste into the Firebase Rules tab |

## If something breaks

**"Not connected" on the landing page.** `firebase-config.js` still has
`PASTE_ME` in it, or the file has a syntax error.

**Nothing syncs between devices.** Almost always the rules were never published,
or you made a Firestore instead of a Realtime Database. Check step 3.

**"No table with that code".** Codes are per-database. If you re-created the
Firebase project, old links die with it. Deal a new table.

**Player sees somebody else's dice.** They claimed the wrong chair. Only the dealer
has the **Seat** button in the top bar: hit it to send everyone back to the lobby and
re-pick.
