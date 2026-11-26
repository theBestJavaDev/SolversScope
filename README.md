<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/docs/img/banner-ltr-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/docs/img/banner-ltr-light.png">
    <img alt="SolversScope" src="docs/docs/img/banner-ltr-light.png">
  </picture>
</h1>

**SolversScope** is an advanced robot diagnostics, log review/analysis, and simulation/teleop data visualization application custom-developed and maintained by **FTC Team 23511 Seattle Solvers**. It reads logs in WPILOG, Hoot (CTRE), REVLOG (REV Robotics), Road Runner, CSV, NI DS log, and RLOG file formats, plus live robot data viewing using NT4, Phoenix, RLOG, or FTC Dashboard streaming. 

SolversScope includes the following features & tools:
- High-accuracy 6-DoF rigid body physics engine with stochastic randomness tolerance and non-linear impulse bouncing
- Interactive Teleop SIM test driving with **WASD**, **QE** (turning), **Spacebar** (launching), **Enter** (intake), and **P** (Pollinator arm toggle)
- A wide selection of flexible graphs and charts
- 2D and 3D field visualizations of pose data, with custom FTC Team 23511 Seattle Solvers CAD robots
- Synchronized video playback from a separately loaded match video
- Joystick visualization, showing driver actions on customizable controller representations
- Swerve drive module vector displays
- Console message review
- Log statistics analysis
- Flexible export options, with support for CSV and WPILOG

---

## 🛠️ Building & Running on macOS

If you build the app from source on macOS and encounter a "quit unexpectedly" security prompt when launching, run the following command in your terminal to sign the app locally and clear the macOS quarantine attribute:

```bash
codesign --force --deep --sign - /Applications/SolversScope.app && xattr -cr /Applications/SolversScope.app
```

For questions, feedback, or support regarding SolversScope, contact FTC Team 23511 Seattle Solvers at **software@seattlesolvers.com**.

![Example screenshot](/docs/docs/img/screenshot-light.png)
