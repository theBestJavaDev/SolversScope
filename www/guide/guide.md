# How to Use SolversScope

SolversScope lets you **watch, check and compare robot runs** without the robot. You open a _log_ (a recording of
everything the robot did) and SolversScope plays it back on a 3D field, checks every shot, and shows the numbers.

This guide is for everyone on the team, including people who have never used it. Every section says **what it's for**
and then **exactly what to click**.

**In this guide:** [Words you'll see](#words) · [Get it running](#install) · [Open a run](#open) ·
[Watch a run in 3D](#watch) · [Compare runs side by side](#compare) · [Check an auto's shots](#autocheck) ·
[Try a shot (Shot Lab)](#shotlab) · [Drive the robot (Drive Sim)](#drivesim) · [Save a report](#report) ·
[Something looks wrong](#help)

<a id="words"></a>

## Words you'll see

| Word              | What it means                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Run** / **log** | One recording of the robot, saved as a file (usually `.rlog`). One auto = one log.                                                       |
| **Sim**           | A pretend match. Our robot code runs on the computer instead of the robot and records a log.                                             |
| **Auto**          | The 30-second autonomous part of the match. AutoMax, AutoPro, TwoTip, etc. are our autos.                                                |
| **HIVE / CELL**   | The tipping goal in BioBuzz. Each HIVE has CELLs; the **mouth** is the open side the POLLEN goes into.                                   |
| **Timeline**      | The bar across the top with seconds on it. It's the "video scrubber" for the run.                                                        |
| **Tab**           | Each view (3D Field, Auto Check, Shot Lab…) is a tab along the top, like a web browser.                                                  |
| **Magnus**        | Spin on the ball curves its flight. Backspin makes it float a little.                                                                    |
| **Match error**   | Real robots aren't perfect: battery sag, flywheel wobble, aim error… SolversScope adds these in to show what a _real_ match would score. |

<a id="install"></a>

## Get it running

You only do this once per computer.

1. Install **Node.js** (the LTS version from nodejs.org) and **Git**.
2. Get the code. In a terminal, run `git clone https://github.com/theBestJavaDev/AdvantageScope.git`, then
   `cd AdvantageScope` and `git checkout solversscope-sim`.
3. In a terminal in that folder, run these three commands, one at a time:
   - `npm install` (downloads what it needs, including the official field models)
   - `npm run compile` (builds the app)
   - `npm start` (opens SolversScope)

After the first time, just run `npm start`. If someone pushed updates, run `git pull` and `npm run compile` first.

<a id="open"></a>

## Open a run

**Our sim runs are already on your computer** if you have built the robot code. They're in:

`BioBuzz-2026-auto\TeamCode\build\sim\`

For example `AutoMax.rlog`, `AutoMaxBlue.rlog`, `TwoTipRed.rlog`, `ThreeTipRed.rlog`.

**To open one:** File → **Open Log(s)…** (or Ctrl+O), go to that folder, pick a file, click Open.

When you open one of our sim runs, SolversScope sets everything up by itself: the 3D field, the graphs, and the
Auto Check tab. It starts playing from the beginning of the auto.

**To make a new sim run** of an auto: in the robot code folder, run
`./gradlew.bat :TeamCode:simAuto -Pauto=AutoMax` (change `AutoMax` to the auto you want). If SolversScope is open, the
new run opens in it automatically.

<a id="watch"></a>

## Watch a run in 3D

Click the **3D Field** tab.

- **Play / pause:** the ▶ button at the top right, or the space bar.
- **Jump to a moment:** click anywhere on the timeline. Drag on it to scrub.
- **Zoom the timeline:** scroll on it.
- **Move the camera:**
  - drag with the left mouse button to spin around,
  - drag with the right mouse button to slide,
  - scroll to zoom in and out.

What you're seeing: our robot (the CAD model), the POLLEN balls, the HIVEs tipping, and a **yellow arc** for the last
shot.

<a id="compare"></a>

## Compare runs side by side

Use this to answer "which auto is better?", for example a 2-tip auto next to a 3-tip auto, or red next to blue. Up to
**three** runs play **in one window, at the same time**, lined up so their autos start together.

**Run autos and compare them (Multisim):**

1. Add a **Multisim** tab: click **+** at the top right → Multisim.
2. Press **▶ Run autos…**. It lists the autos in your robot code (the ones in `RunAutos.java`).
   **Robot code** at the top picks which code runs: **Your checkout** (the robot project as it is on your
   computer, unsaved changes included) or any **branch** (as committed, e.g. `v1.5`). Branches run from a copy inside
   the project's `build` folder, so your own checkout is never changed. Ticking an auto picks it from the branch
   shown, so you can tick AutoMax, switch to another branch and tick AutoMax again to compare the two versions.
3. **Tick** up to three and press **Run**. The robot code sim runs each one (the first time also builds the code, so
   it can take a minute or two; **Cancel** stops it). When they finish, they play side by side from the auto's START.
4. **Overlay** puts every robot on one field: run A as itself, the others as see-through robots in their color, so
   you can see exactly where the paths split. Press it again to go back to side by side.
5. The **Compare** panel under the fields shows each run's numbers in its color (A gold, B blue, C pink):
   - **Scoring:** shots, scored, missed, hit rate, HIVE tips.
   - **Timing:** first and last shot and the last leg change (seconds after START), and time spent stopped.
   - **Driving:** path length, top speed, average speed while moving (during the 30 s auto).
   - **Now:** each robot's leg, speed and scored / shots at the playhead, and how far B and C are from A.

   B and C also show their difference from A, e.g. `(+2)`: green when it's better, red when it's worse. Press
   **Compare** to hide or show the panel.

Multisim uses the robot project whose runs you last opened. If it can't find it, open one run from that project with
**Choose runs… → Change folder…** (its `TeamCode\build\sim` folder) once.

**Runs you already have (just tick boxes):**

1. Add a **Multisim** tab: click **+** at the top right → Multisim.
2. Press **Choose runs…**. A list of your runs opens, newest first. Type in the search box to find one.
3. **Tick** up to three runs and press **Show**. The tab shows exactly the runs you ticked, one field each.

To swap just one field, press **Choose run…** under that field and **double-click** a run.

The list starts in your robot code's runs folder. If it's empty or wrong, press **Change folder…** and pick the
folder with your `.rlog` files. **Browse files instead…** opens the normal Windows file window (there, hold **Ctrl**
to pick more than one).

**From the File menu:**

1. File → **Compare Runs (up to 3)…** (or Ctrl+Alt+O).
2. Hold **Ctrl** and click two or three log files, then click Open.
3. A **Compare** tab opens with one field per run. Press ▶ to play them together.

Each field has its own camera, so you can look at them from different angles. **Details ▸** under a field shows what it
draws and which field model it uses (you can switch seasons there, e.g. BioBuzz and DECODE). The ✕ removes a field.

<a id="autocheck"></a>

## Check an auto's shots

Click the **Auto Check** tab (✅). It runs by itself when you open a sim run.

Our robot sim assumes a **perfect robot**. Auto Check flies every shot again with real-world problems added, so you
see what the auto would really score.

**The cards across the top, left to right:**

| Card                  | What it tells you                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| **Robot-code sim**    | What our robot code's sim scored. Perfect robot.                                                    |
| **Re-flown, no spin** | The same shots in SolversScope's physics. Should match the card before it.                          |
| **With Magnus**       | The same shots with the ball's spin. Shots near the edge of the mouth can miss.                     |
| **With match error**  | What to **expect in a real match**, plus a range ("6–12" means most matches land between 6 and 12). |
| **With tuned speeds** | What it _could_ score if each shot's speed were adjusted (see the Tune column).                     |

**The table:** one row per shot.

- **Chance in:** how often that shot goes in during a real match.
- **Crosses the mouth:** how far from the middle of the CELL's mouth the ball goes in. "Low" means near the bottom lip.
- **Tune:** how much to change the exit speed to center that shot, and the chance it would have then.

**This random match:** your robot sim is a perfect robot, so its replay looks the same every time. Auto Check also
plays a **random match**: every shot once, with fresh random errors, like a real match where some shots just miss.
Misses show on the **3D Field** with a **red trail** and land where they would really go. Press **🎲 New random
match** to roll another one; each is different, and over many rolls they average out to the "With match error" card.

The gold box above the table sums it up in one sentence. The error settings it uses come from the **Shot Lab** tab.

> Treat the Tune numbers as a direction ("we're aiming low, aim higher"), then confirm on the real robot.

<a id="shotlab"></a>

## Try a shot (Shot Lab)

Click **+** → **Shot Lab**. It runs once when it opens, so you see results right away.

- Change the **robot position**, **exit speed** or **hood angle** on the left, then press **Run**.
- **Solve** finds the exit speed that hits the center of the target.
- **Hit rate** (top left card) is how many shots out of 300 go in with match error.
- The **side view** shows the ball's path; the **target plane** shows where each shot landed (green = in, red = miss).
- **Error sources** (bottom left) turns each real-world problem on or off. **Run + error budget** shows which one hurts
  the most.

<a id="drivesim"></a>

## Drive the robot (Drive Sim)

Click **+** → **Drive Sim**, then click on the field.

| Key         | Does                 |
| ----------- | -------------------- |
| **W A S D** | drive                |
| **Q E**     | turn                 |
| **Space**   | shoot                |
| **Shift**   | slow mode            |
| **F**       | field-centric on/off |
| **R**       | reset the robot      |
| **C**       | clear shots and reload |

Like a real robot, yours holds at most **4** POLLEN (the chip at the top says **HOLDING 4 / 4**). Every shot uses
one up. When it says **EMPTY**, drive the front of the robot over a ball that missed to pick it back up. Balls that
scored are in the CELL and can't be picked up. **C** reloads you with 4.

A gamepad works too. **▶ Live 3D view** opens a 3D window that follows your driving. If it says **"Can't score from
here"**, drive in front of the CELL's open side (the **MOUTH** arrow).

<a id="report"></a>

## Save a report

To share results with the team, use the **Telemetry** tab (📟):

1. Press **● Record**, play the part of the run you care about, then press it again to stop. (Skip this to report the
   whole log.)
2. Press **⬇ Download .md** and choose where to save it.

The report includes the Auto Check results when the log is a sim run.

<a id="help"></a>

## Something looks wrong

| What you see                               | What to do                                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A plain gray robot instead of ours         | SolversScope asks you to **choose your robot's CAD** (a `.glb` file). Pick it once and it's remembered. "Use Default Robot" is fine too. |
| The HIVEs don't tip                        | The tipping HIVE models aren't on this computer. Run `sim/advantagescope/make_field_model.py` from the robot code.                       |
| A field shows "No run here yet"            | Press **Choose run…** under it and pick one or more logs.                                                                                |
| I only want plain AdvantageScope           | View → **Plain AdvantageScope Mode**. Untick it to get the SolversScope tabs back.                                                       |
| The app is light instead of black and gold | App → Preferences → Theme → **Black & Gold**.                                                                                            |
| Nothing happens when I press play          | Click the timeline first, or open a log (File → Open Log(s)…).                                                                           |
| Something else                             | Ask in the software channel, with a screenshot.                                                                                          |
