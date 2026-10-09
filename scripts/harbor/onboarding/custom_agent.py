"""Starter adapter: implement installation and adapt the harness arguments."""

import shlex

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template


class CustomReviewAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "custom-review-agent"

    async def install(self, environment):
        raise NotImplementedError(
            "Install your harness with exec_as_agent or exec_as_root before running."
        )

    @with_prompt_template
    async def run(self, instruction, environment, context):
        arguments = [
            "my-reviewer",
            "--repo", "/work/repo",
            "--diff", "/work/pr/diff.patch",
            "--pr", "/work/pr/pr.json",
            "--output", "/work/out/findings.json",
            "--instruction", instruction,
        ]
        result = await self.exec_as_agent(
            environment, command=shlex.join(arguments),
        )
        if result.return_code != 0:
            raise RuntimeError(f"Review harness failed with exit code {result.return_code}")
        check = await self.exec_as_agent(
            environment, command="test -f /work/out/findings.json",
        )
        if check.return_code != 0:
            raise RuntimeError("Review harness did not write findings.json")
