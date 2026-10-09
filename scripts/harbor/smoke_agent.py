"""No-inference agent for the adapter's container and isolation regression test."""

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class EmptyReviewAgent(BaseAgent):
    @staticmethod
    def name() -> str:
        return "reviewbench-empty-smoke"

    def version(self) -> str:
        return "1.0.0"

    async def setup(self, environment: BaseEnvironment) -> None:
        pass

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        result = await environment.exec(
            command="""python3 - <<'PY'
import json
import os
import pathlib
import subprocess

assert not pathlib.Path("/tests").exists(), "Reviewer can access verifier assets"
assert not pathlib.Path("/solution").exists(), "Reviewer can access oracle assets"
assert not os.environ.get("RB_HARBOR_JUDGE_TOKEN"), "Judge host secret leaked"
assert not os.environ.get("COPILOT_GITHUB_TOKEN"), "Judge phase secret leaked"
assert not os.environ.get("RB_HARBOR_JUDGE_KEY"), "Judge host key leaked"
assert not os.environ.get("ANTHROPIC_API_KEY"), "Judge phase key leaked"
blocked = subprocess.run(
    ["curl", "--silent", "--show-error", "--noproxy", "*", "--max-time", "10",
     "https://example.com"], capture_output=True
)
assert blocked.returncode != 0, "Reviewer can reach a non-allowlisted host"
pr = json.loads(pathlib.Path("/work/pr/pr.json").read_text())
pathlib.Path("/work/out/findings.json").write_text(
    json.dumps({"pr": pr, "agent": "empty-smoke", "findings": []})
)
print("Reviewer isolation, blocked egress, and empty findings checks passed")
PY""",
            timeout_sec=30,
        )
        if result.return_code != 0:
            raise RuntimeError(
                f"ReviewBench smoke agent failed: {result.stdout}\n{result.stderr}"
            )
        (self.logs_dir / "isolation.txt").write_text(result.stdout or "")
