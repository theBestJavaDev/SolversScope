# Contributing to SolversScope

Thank you for your interest in contributing to **SolversScope**! This project is custom-developed for **FTC Team 23511 Seattle Solvers** (forked from AdvantageScope by Team 6328). To ensure that SolversScope remains reliable for all team members and simulations, we have established a set of guidelines for contributions.

Please remember to behave with **Gracious Professionalism** in all interactions.

## General Contribution Rules

- **Reliability is Paramount:** SolversScope is a critical diagnostic and simulation tool. Changes must not break existing visualization capabilities or log parsing.
- **Backward Compatibility:** Changes should support existing log formats and configurations where possible.
- **Platform Parity:** SolversScope runs as a desktop application (Windows, macOS, and Linux).
- **Documentation:** Most code changes require corresponding updates.

## Development Setup

SolversScope is a Node.js application using Electron and TypeScript, featuring a 6-DoF physics engine and interactive WASD/QE teleop test simulation for FTC Team 23511 Seattle Solvers.

1. **Node.js Version:** Ensure you have Node.js installed (LTS version recommended).
2. **Clone the Repository:**
```bash
git clone https://github.com/Mechanical-Advantage/AdvantageScope.git
cd AdvantageScope
```
3. **Install Dependencies & Start:**
```bash
npm install
npm run compile
npm start
```
