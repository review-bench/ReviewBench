# Example vendor image: OpenAI Codex CLI's `codex review` on one pull request,
# wrapped to satisfy the agent contract (../../AGENT_CONTRACT.md).
#
# Credential (manifest secrets.env): OPENAI_API_KEY, entered in the portal and
# handed to the container at run time. It is never baked into the image.
# Egress (manifest egress): api.openai.com
#
# Configuration (manifest configuration, arrives as RB_CONFIG_*):
#   RB_CONFIG_MODEL    model id, for example gpt-5.5
#   RB_CONFIG_EFFORT   reasoning effort: low, medium or high
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --no-audit --no-fund @openai/codex@0.159.3 \
    && npm cache clean --force

WORKDIR /agent
COPY parse.mjs agent.mjs ./

ENTRYPOINT ["node", "/agent/agent.mjs"]
