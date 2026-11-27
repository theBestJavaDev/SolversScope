# 📸 Taking Cinematic Robot Shots with Claude Code & SolversScope MCP

SolversScope features a built-in **Model Context Protocol (MCP)** server located in `tools/solverscope-mcp`. This allows AI coding assistants like **Claude Code** to directly interface with your running SolversScope session, control camera angles, adjust 3D rendering modes, trigger shot simulations, and capture high-definition cinematic shots of your robot.

---

## 🛠️ 1. Configuring the Local MCP Server

To connect Claude Code to your local SolversScope instance, configure your Claude MCP settings (typically in `~/.claude/mcp.json` or your project config) to point to the local server:

```json
{
  "mcpServers": {
    "solvers-scope": {
      "command": "node",
      "args": ["/Users/brandon/StudioProjects/AdvantageScope/tools/solverscope-mcp/dist/index.js"]
    }
  }
}
```

---

## 🎬 2. Prompting Claude Code for Cinematic Shots

Once connected, you can prompt Claude Code in natural language to orchestrate camera views and render cinematic shots of your robot running your FTC Team 23511 Seattle Solvers code:

### Example Prompts:
- *"Set the 3D field rendering mode to Cinematic, enable soft shadows, and orbit the camera 45 degrees around our robot model at a low angle."*
- *"Run the `FullTeleOp` sim test, trigger a launch shot with the physics engine, and take a cinematic screenshot as the ball bounces off the goal."*
- *"Adjust the camera FOV to 35 degrees, enable Light Mode, and capture a clean overhead framing shot of our robot on the 2026 FTC field."*

---

## 🕹️ 3. Automated Teleop & Simulation Control via MCP

Claude Code can also trigger automated test sequences through the MCP server:
- Execute test scripts (`./gradlew :TeamCode:testDebugUnitTest`)
- Feed WASD/QE drive commands into the 6-DoF physics simulation
- Capture sequence frames for media presentation and team documentation.
