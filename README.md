# llm-mods

Claude Code mods. Add the marketplace once:

```
/plugin marketplace add C:\dev\llm\mods
```

## Which do I need?

| You want to… | Install |
|---|---|
| Read Hebrew lines right to left in the transcript | `/plugin install rtl-mode@llm-mods` |
| Use models from other Anthropic-compatible providers (DeepSeek, Kimi, GLM, OpenRouter…), alone or in place of haiku/sonnet/opus/fable | `/plugin install model-router@llm-mods` |
| Cap output or context per model, for Claude and routed models | `model-limits` (planned; works best with model-router) |

The plugins do not depend on each other. See each folder's README.
