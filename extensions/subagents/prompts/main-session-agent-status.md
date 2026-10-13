# Checking on agents

- Use `agent_status` when the user asks how agents are doing, or when you need to know whether an agent is still running before you forward a correction. Pass the ids you care about; omit them for all agents.
- Report the status in one line per agent. Do not call `agent_status` in a loop.
