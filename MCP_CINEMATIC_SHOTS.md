# 📸 Taking Cinematic Robot Shots with Claude Code & SolversScope MCP

SolversScope features a built-in **Model Context Protocol (MCP)** server located in `tools/solverscope-mcp`. This allows AI assistants like **Claude Code** to directly control your running SolversScope session, orchestrate camera angles, trigger teleop physics simulations, and capture high-definition cinematic shots of your robot.

---

## 🛠️ 1. Configuring the Local MCP Server

Add the SolversScope MCP server to your Claude configuration (`~/.claude/mcp.json`):

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

## 🎬 2. Prompting Claude Code

Ask Claude Code to stage shots in natural language:
- *"Switch 3D Field to Cinematic mode with soft shadows and orbit the camera around our robot at a low angle."*
- *"Trigger a physics simulation shot and capture a cinematic render of the ball launching into the basket."*
