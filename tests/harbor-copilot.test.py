"""Test the pinned native reviewer without model requests or real credentials."""

import asyncio
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import uuid

if os.environ.get("REVIEWBENCH_TEST_INSTALLED") == "1":
    from reviewbench_copilot import local_agent as adapter, native_review as native
else:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "harbor" / "copilot"))
    import local_agent as adapter
    import native_review as native


def result(stdout="", return_code=0, stderr=""):
    return SimpleNamespace(stdout=stdout, return_code=return_code, stderr=stderr)


class ArchiveTests(unittest.TestCase):
    def test_download_is_pinned_verified_and_reused(self):
        content = b"fixture archive, not an executable"
        with tempfile.TemporaryDirectory() as temp, patch.dict(
            os.environ, {"XDG_CACHE_HOME": temp},
        ), patch.object(adapter, "COPILOT_SHA256", hashlib.sha256(content).hexdigest()), patch.object(
            adapter.urllib.request, "urlopen", return_value=io.BytesIO(content),
        ) as download:
            archive = adapter.copilot_archive()
            self.assertEqual(archive.read_bytes(), content)
            self.assertEqual(adapter.copilot_archive(), archive)
            download.assert_called_once_with(adapter.COPILOT_URL, timeout=120)
            archive.write_bytes(b"corrupt")
            with self.assertRaisesRegex(RuntimeError, "Cached Copilot CLI checksum mismatch"):
                adapter.copilot_archive()
            self.assertEqual(download.call_count, 1)

    def test_failed_download_never_persists_an_archive(self):
        for failure in ("checksum", "network"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp, patch.dict(
                os.environ, {"XDG_CACHE_HOME": temp},
            ), patch.object(adapter.urllib.request, "urlopen") as download:
                if failure == "network":
                    download.side_effect = OSError("Download failed")
                else:
                    download.return_value = io.BytesIO(b"wrong archive")
                with self.assertRaises((RuntimeError, OSError)):
                    adapter.copilot_archive()
                self.assertEqual(list((Path(temp) / "reviewbench-copilot").iterdir()), [])


class LoginTests(unittest.TestCase):
    @staticmethod
    def login(home, *, legacy=False):
        config = {
            "lastLoggedInUser": {"host": "https://github.com", "login": "selected"},
            "loggedInUsers": [
                {"host": "https://github.com", "login": "other"},
                {"host": "https://github.com", "login": "selected"},
            ],
            "copilotTokens": {
                "https://github.com:other": "gho_other_fixture",
                "https://github.com:selected": "gho_selected_fixture",
            },
            "storeTokenPlaintext": True,
        }
        if legacy:
            config = {name: config[camel] for name, camel in (
                ("last_logged_in_user", "lastLoggedInUser"), ("logged_in_users", "loggedInUsers"),
                ("copilot_tokens", "copilotTokens"), ("store_token_plaintext", "storeTokenPlaintext"),
            )}
        (home / "config.json").write_text("// Copilot state\n" + json.dumps(config))
        return config

    def test_saved_login_selects_active_account_with_jsonc_and_legacy_keys(self):
        for legacy in (False, True):
            with self.subTest(legacy=legacy), tempfile.TemporaryDirectory() as temp, patch.dict(
                os.environ, {"COPILOT_HOME": temp}, clear=True,
            ), patch.object(adapter.subprocess, "run") as keychain:
                self.login(Path(temp), legacy=legacy)
                self.assertEqual(adapter.reviewer_token(), "gho_selected_fixture")
                keychain.assert_not_called()

    def test_ubuntu_auth_tokens_selects_active_github_credential(self):
        for suffix in (":github", ""):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as temp, patch.dict(
                os.environ, {"COPILOT_HOME": temp}, clear=True,
            ), patch.object(adapter.subprocess, "run") as keychain:
                home = Path(temp)
                config = self.login(home)
                config["authTokens"] = {
                    "https://github.com:other:github": {"token": "gho_other_fixture"},
                    f"https://github.com:selected{suffix}": {"token": "gho_ubuntu_fixture"},
                }
                (home / "config.json").write_text(json.dumps(config))
                self.assertEqual(adapter.reviewer_token(), "gho_ubuntu_fixture")
                keychain.assert_not_called()

    def test_invalid_auth_tokens_never_falls_back_to_a_different_credential(self):
        for saved in ("not-an-object", {}, {"token": "fixture\ninvalid"}):
            with self.subTest(saved=saved), tempfile.TemporaryDirectory() as temp, patch.dict(
                os.environ, {"COPILOT_HOME": temp}, clear=True,
            ):
                home = Path(temp)
                config = self.login(home)
                config["authTokens"] = {"https://github.com:selected:github": saved}
                (home / "config.json").write_text(json.dumps(config))
                with self.assertRaisesRegex(RuntimeError, "Invalid saved Copilot credential"):
                    adapter.reviewer_token()

    def test_explicit_ci_token_takes_precedence(self):
        with patch.dict(os.environ, {"COPILOT_GITHUB_TOKEN": "gho_ci_fixture"}, clear=True), patch.object(
            adapter, "_login_config",
        ) as config:
            self.assertEqual(adapter.reviewer_token(), "gho_ci_fixture")
            config.assert_not_called()

    def test_keychain_uses_only_selected_account_without_printing_token(self):
        for attribute in ("username", "account"):
            with self.subTest(attribute=attribute), tempfile.TemporaryDirectory() as temp, patch.dict(
                os.environ, {"COPILOT_HOME": temp}, clear=True,
            ), patch.object(adapter.shutil, "which", return_value="/usr/bin/secret-tool"), patch.object(
                adapter.subprocess, "run",
            ) as keychain:
                home = Path(temp)
                self.login(home)
                (home / "settings.json").write_text('{"storeTokenPlaintext": false,}')
                keychain.side_effect = (
                    [SimpleNamespace(returncode=0, stdout="gho_keychain_fixture\n", stderr="")]
                    if attribute == "username" else [
                        SimpleNamespace(returncode=1, stdout="", stderr=""),
                        SimpleNamespace(returncode=0, stdout="gho_keychain_fixture\n", stderr=""),
                    ]
                )
                self.assertEqual(adapter.reviewer_token(), "gho_keychain_fixture")
                self.assertEqual(keychain.call_args.args[0], [
                    "/usr/bin/secret-tool", "lookup", "service", "copilot-cli",
                    attribute, "https://github.com:selected",
                ])
                self.assertTrue(keychain.call_args.kwargs["capture_output"])
                self.assertNotIn("gho_keychain_fixture", str(keychain.call_args))

    def test_missing_selected_credential_never_uses_another_account(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(
            os.environ, {"COPILOT_HOME": temp}, clear=True,
        ):
            home = Path(temp)
            config = self.login(home)
            del config["copilotTokens"]["https://github.com:selected"]
            (home / "config.json").write_text(json.dumps(config))
            with self.assertRaisesRegex(RuntimeError, "Saved Copilot credential unavailable"):
                adapter.reviewer_token()

    def test_keychain_errors_are_actionable_and_do_not_disclose_output(self):
        for failure in (
            SimpleNamespace(returncode=1, stdout="secret-output", stderr="secret-error"),
            subprocess.TimeoutExpired(["secret-tool"], 10),
        ):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp, patch.dict(
                os.environ, {"COPILOT_HOME": temp}, clear=True,
            ), patch.object(adapter.shutil, "which", return_value="/usr/bin/secret-tool"), patch.object(
                adapter.subprocess, "run",
            ) as keychain:
                home = Path(temp)
                self.login(home)
                (home / "settings.json").write_text('{"storeTokenPlaintext": false}')
                if isinstance(failure, Exception):
                    keychain.side_effect = failure
                else:
                    keychain.return_value = failure
                with self.assertRaisesRegex(RuntimeError, "keychain lookup failed") as raised:
                    adapter.reviewer_token()
                self.assertNotIn("secret-output", str(raised.exception))
                self.assertNotIn("secret-error", str(raised.exception))

    def test_invalid_login_fails_without_disclosing_credentials(self):
        for invalid in ("invalid-json", "not-an-object", "wrong-host", "invalid-token", "no-login"):
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as temp, patch.dict(
                os.environ, {"COPILOT_HOME": temp}, clear=True,
            ):
                home = Path(temp)
                config = self.login(home)
                if invalid == "invalid-json":
                    text = '{"gho_private_fixture": ['
                elif invalid == "not-an-object":
                    text = "[]"
                else:
                    if invalid == "wrong-host":
                        config["lastLoggedInUser"]["host"] = "https://unapproved.example"
                    elif invalid == "invalid-token":
                        config["copilotTokens"]["https://github.com:selected"] = "gho_private_fixture\nextra"
                    else:
                        config.pop("lastLoggedInUser")
                        config.pop("loggedInUsers")
                    text = json.dumps(config)
                (home / "config.json").write_text(text)
                with self.assertRaises(RuntimeError) as raised:
                    adapter.reviewer_token()
                self.assertNotIn("gho_private_fixture", str(raised.exception))


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_setup_uploads_pinned_cli_and_prepares_frozen_base(self):
        environment = SimpleNamespace(
            exec=AsyncMock(side_effect=[
                result("Linux x86_64\n"),
                result("GitHub Copilot CLI 1.0.96.\nRun 'copilot update' to check for updates.\n"),
            ]),
            upload_file=AsyncMock(),
        )
        with tempfile.TemporaryDirectory() as temp, patch.object(
            adapter, "copilot_archive", return_value=Path(temp) / "copilot.tar.gz",
        ):
            await adapter.NativeCopilotReview(logs_dir=Path(temp)).setup(environment)
            uploads = environment.upload_file.await_args_list
            self.assertEqual(uploads[0].args, (Path(temp) / "copilot.tar.gz", "/tmp/reviewbench-copilot.tar.gz"))
            self.assertEqual(uploads[1].args[0], Path(adapter.__file__).with_name("native_review.py"))
            command = environment.exec.await_args_list[1].kwargs["command"]
            self.assertIn("git -C /work/repo rev-parse HEAD", command)
            self.assertIn("${RB_HEAD:?Frozen PR head required}", command)
            self.assertIn('update-ref refs/heads/main "${RB_BASE:?Frozen PR base required}"', command)
            self.assertIn("tar -xzf /tmp/reviewbench-copilot.tar.gz -C /usr/local/bin", command)
            for forbidden in ("npm ", "ANTHROPIC", "AZURE", "/tests", "RB_HARBOR_JUDGE_KEY"):
                self.assertNotIn(forbidden, command)

    async def test_unsupported_images_fail_before_download(self):
        for probe in (result("Linux aarch64\n"), result("Darwin x86_64\n"), result(return_code=1)):
            with self.subTest(probe=probe), tempfile.TemporaryDirectory() as temp, patch.object(
                adapter, "copilot_archive",
            ) as download:
                environment = SimpleNamespace(exec=AsyncMock(return_value=probe), upload_file=AsyncMock())
                with self.assertRaisesRegex(RuntimeError, "Linux x86-64"):
                    await adapter.NativeCopilotReview(logs_dir=Path(temp)).setup(environment)
                download.assert_not_called()
                environment.upload_file.assert_not_awaited()

    async def test_setup_errors_and_wrong_versions_are_not_accepted(self):
        for install in (
            result(return_code=1, stderr="Frozen HEAD mismatch"),
            result("GitHub Copilot CLI 1.0.960.\n"), result("GitHub Copilot CLI 1.0.98.\n"), result(""),
            result("GitHub Copilot CLI 1.0.96.\nGitHub Copilot CLI 1.0.98.\n"),
        ):
            with self.subTest(install=install), tempfile.TemporaryDirectory() as temp, patch.object(
                adapter, "copilot_archive", return_value=Path(temp) / "archive",
            ):
                environment = SimpleNamespace(
                    exec=AsyncMock(side_effect=[result("Linux x86_64\n"), install]),
                    upload_file=AsyncMock(),
                )
                with self.assertRaises(RuntimeError):
                    await adapter.NativeCopilotReview(logs_dir=Path(temp)).setup(environment)
                self.assertEqual(environment.upload_file.await_count, 1)

    async def test_setup_accepts_extraction_notice_before_exact_version_banner(self):
        environment = SimpleNamespace(
            exec=AsyncMock(side_effect=[
                result("Linux x86_64\n"),
                result("Package extraction took 5370ms\nGitHub Copilot CLI 1.0.96.\n"
                       "Run 'copilot update' to check for updates.\n"),
            ]),
            upload_file=AsyncMock(),
        )
        with tempfile.TemporaryDirectory() as temp, patch.object(
            adapter, "copilot_archive", return_value=Path(temp) / "archive",
        ):
            await adapter.NativeCopilotReview(logs_dir=Path(temp)).setup(environment)
            self.assertEqual(environment.upload_file.await_count, 2)

    async def test_run_forwards_only_reviewer_token_and_preserves_native_proof(self):
        proof = {
            "native_dispatch": True, "review_tool_success": True,
            "models": ["actual-native-model"], "output_tokens": 42,
        }
        environment = SimpleNamespace(
            exec=AsyncMock(side_effect=[result("Native review complete"), result(json.dumps(proof))]),
        )
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
            "COPILOT_GITHUB_TOKEN": "fake-reviewer",
            "RB_HARBOR_JUDGE_KEY": "fake-judge", "ANTHROPIC_API_KEY": "host-only-key",
        }, clear=True):
            agent = adapter.NativeCopilotReview(logs_dir=Path(temp))
            context = SimpleNamespace()
            await agent.run("unused task instruction", environment, context)
            call = environment.exec.await_args_list[0].kwargs
            self.assertEqual(call["env"], {"COPILOT_GITHUB_TOKEN": "fake-reviewer"})
            self.assertEqual(call["command"], "python3 /tmp/native_review.py")
            self.assertEqual(agent._parsed_model_name, "actual-native-model")
            self.assertEqual(context.n_output_tokens, 42)
            self.assertEqual((Path(temp) / "runner-output.txt").read_text(), "Native review complete")

    async def test_missing_reviewer_token_does_not_consult_judge_key(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(
            os.environ, {"COPILOT_HOME": temp, "RB_HARBOR_JUDGE_KEY": "fake-judge"}, clear=True,
        ):
            environment = SimpleNamespace(exec=AsyncMock())
            with self.assertRaisesRegex(RuntimeError, "run copilot login"):
                await adapter.NativeCopilotReview(logs_dir=Path(temp)).run("", environment, SimpleNamespace())
            environment.exec.assert_not_awaited()

    async def test_login_backed_review_forwards_only_selected_credential(self):
        proof = {
            "native_dispatch": True, "review_tool_success": True,
            "models": ["actual-native-model"], "output_tokens": 42,
        }
        environment = SimpleNamespace(
            exec=AsyncMock(side_effect=[result(), result(json.dumps(proof))]),
            upload_file=AsyncMock(),
        )
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
            "COPILOT_HOME": temp, "RB_HARBOR_JUDGE_KEY": "fake-judge",
        }, clear=True):
            LoginTests.login(Path(temp))
            await adapter.NativeCopilotReview(logs_dir=Path(temp)).run("", environment, SimpleNamespace())
            self.assertEqual(environment.exec.await_args_list[0].kwargs["env"], {
                "COPILOT_GITHUB_TOKEN": "gho_selected_fixture",
            })
            environment.upload_file.assert_not_awaited()

    async def test_native_failure_and_missing_proof_are_not_success(self):
        for replies in (
            [result(return_code=1)],
            [result(), result(return_code=1)],
            [result(), result(json.dumps({"native_dispatch": False, "review_tool_success": True}))],
        ):
            with self.subTest(replies=replies), tempfile.TemporaryDirectory() as temp, patch.dict(
                os.environ, {"COPILOT_GITHUB_TOKEN": "fake-reviewer"}, clear=True,
            ):
                environment = SimpleNamespace(exec=AsyncMock(side_effect=replies))
                with self.assertRaises(RuntimeError):
                    await adapter.NativeCopilotReview(logs_dir=Path(temp)).run("", environment, SimpleNamespace())


class NativeReviewTests(unittest.TestCase):
    def test_native_review_requests_complete_frozen_diff_without_repository_size_gate(self):
        base, head = "a" * 40, "b" * 40
        command = native.review_command(base, head)
        self.assertEqual(command[0], "copilot")
        self.assertEqual(command[-2], "-i")
        self.assertTrue(command[-1].startswith("/review "))
        self.assertIn(base, command[-1])
        self.assertIn(head, command[-1])
        self.assertIn("Do not stop or request a split", command[-1])
        self.assertIn("retaining the full pull-request scope", command[-1])
        self.assertIn("if unable to complete, state that failure explicitly", command[-1])
        for flag in ("--no-auto-update", "--deny-tool=web_fetch", "--deny-tool=web_search"):
            self.assertIn(flag, command)
        for flag in ("-p", "--prompt", "-m", "--model", "--no-custom-instructions"):
            self.assertNotIn(flag, command)
        for base, head in (("main", head), (base, "HEAD"), (None, head), (base, "b" * 41)):
            with self.subTest(base=base, head=head), self.assertRaises(ValueError):
                native.review_command(base, head)

    def test_native_dispatch_accepts_supported_review_prompt_arguments_not_plain_prompts(self):
        for transformed in (
            "The user has requested a code review via the /review command.",
            "The user has requested a code review via the /review command with this prompt: Review the full diff.",
        ):
            self.assertTrue(native.native_dispatch([
                {"type": "user.message", "data": {"transformedContent": transformed}},
            ], ""))
        self.assertFalse(native.native_dispatch([
            {"type": "user.message", "data": {"content": "Please review the code."}},
        ], ""))
        self.assertFalse(native.native_dispatch([
            {"type": "assistant.message", "data": {
                "transformedContent": "The user has requested a code review via the /review command.",
            }},
        ], ""))

    def test_issue_ranges_match_actual_hyphens_and_en_dashes(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            (repo / "source.py").write_text("first\nsecond\nthird\n")
            for location, start, end in (("source.py:2", 2, 2), ("source.py:1-3", 1, 3),
                                         ("source.py:1\u20133", 1, 3)):
                with self.subTest(location=location):
                    text = (
                        f"## Issue: Fixture\n**File:** `{location}`\n**Severity:** High\n"
                        "**Problem:** Broken\n**Evidence:** Source\n**Suggested fix:** Fix\n"
                    )
                    findings = native.findings_from_review(text, repo)
                    self.assertEqual(len(findings), 1)
                    self.assertEqual((findings[0]["file"], findings[0]["start_line"], findings[0]["end_line"]),
                                     ("source.py", start, end))

    def test_explicit_empty_results_allow_scope_and_validation_metadata(self):
        metadata = (
            "**Review scope:** Clean working tree; reviewed `main...HEAD`.",
            "Reviewed `main...HEAD`; the working tree is clean. Validation was limited to static inspection.",
            "**Review limitations:** Build tools are unavailable.",
            "Review limitation: Tests could not run.",
            "Validation: Focused checks passed.",
            "The working tree is clean; reviewed `main...HEAD`.",
            "Validation limited to static inspection: build tools are unavailable.",
            "\u2713 Review conducted following guidelines defined in `.github/copilot-instructions.md`",
            "Completed review of all six changed files, including relevant callers.\n\n"
            "Tests could not be run because Cargo is unavailable.",
            "**Completion status:** Completed review of all 11 changed files.\n\n"
            "Both shell scripts passed syntax checks. Automated tests were not run. No files modified.",
            "**Coverage:** Reviewed the entire frozen diff.\n\n"
            "**Validation remains incomplete:** Go is unavailable. Static review is complete.",
            "**Scope/completion:** Completed the entire frozen pull-request review.",
            "Full frozen diff review completed across all three files. Terraform was not run.",
        )
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            for empty in native.EMPTY_RESULTS:
                for note in metadata:
                    with self.subTest(empty=empty, note=note):
                        self.assertEqual(native.findings_from_review(f"{note}\n\n{empty}", repo), [])
                        self.assertEqual(native.findings_from_review(f"{empty}\n\n{note}", repo), [])

    def test_unknown_refused_or_contradictory_outputs_never_become_empty_reviews(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            for text in (
                "", "No issues.", "Review paused: the diff exceeds the review limit.",
                f"{native.EMPTY}\n\nReview paused: No correctness review was performed.",
                f"{native.EMPTY}\n\nFound a bug in source.py:1.",
                f"{native.EMPTY}\n\nIdentified 2 actionable issues.",
                f"{native.EMPTY}\n\n**File:** source.py:1",
                f"{native.EMPTY}\n\nUnable to complete the review.",
                f"{native.EMPTY}\n\nReview remains incomplete.",
                f"{native.EMPTY}\n\n## Issue: Missing fields",
                f"{native.EMPTY}\n\n{native.EMPTY}",
            ):
                with self.subTest(text=text), self.assertRaises(ValueError):
                    native.findings_from_review(text, repo)

    def test_preambles_multiple_ranges_and_files_preserve_one_issue_and_raw_text(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            for name in ("source.py", "other.py"):
                (repo / name).write_text("first\nsecond\nthird\n")
            for location in (
                "**File:** `source.py:1, 2\u20133`",
                "**Files:**\n- source.py:1\n- `other.py:2\u20133`",
                "**File:** source.py:1; other.py:2\u20133",
                "**File:** `source.py:1`; `other.py:2\u20133`",
            ):
                with self.subTest(location=location):
                    text = (
                        "Completed read-only review of all 177 changed files, including relevant callers.\n\n"
                        f"## Issue: Fixture\n{location}\n**Severity:** Medium\n"
                        "**Problem:** Broken\n**Evidence:** Source\n**Suggested fix:** Fix\n\n"
                        "**Validation limitation:** Tooling unavailable."
                    )
                    findings = native.findings_from_review(text, repo)
                    self.assertEqual(len(findings), 1)
                    self.assertEqual((findings[0]["file"], findings[0]["start_line"], findings[0]["end_line"]),
                                     ("source.py", 1, 1))
                    self.assertEqual(findings[0]["message"], text[text.index("## Issue:"):])

    def test_invalid_or_missing_secondary_locations_are_not_discarded(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            (repo / "source.py").write_text("first\nsecond\n")
            for location in (
                "**File:** source.py:1,99", "**File:** source.py:1,", "**File:** source.py:1-2-extra",
                "**File:**",
                "**Files:**\n- source.py:1\n- ../outside.py:1",
                "**Files:**\n- source.py:1\n- missing.py:1",
                "**File:** source.py:1; other.py:1",
                "**File:** source.py:1; source.py:99",
                "**File:** source.py:1;",
            ):
                with self.subTest(location=location), self.assertRaises(ValueError):
                    native.findings_from_review(
                        f"## Issue: Invalid\n{location}\n**Severity:** High\n"
                        "**Problem:** Broken\n**Evidence:** Source\n**Suggested fix:** Fix\n", repo,
                    )

    def test_empty_result_and_invalid_locations(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            (repo / "source.py").write_text("first\n")
            self.assertEqual(native.findings_from_review(native.EMPTY, repo), [])
            for text in ("", "No issues.", "## Issue: Missing fields"):
                with self.subTest(text=text), self.assertRaises(ValueError):
                    native.findings_from_review(text, repo)
            for location in ("source.py:0", "source.py:2", "source.py:2-1", "../outside.py:1"):
                with self.subTest(location=location), self.assertRaises(ValueError):
                    native.findings_from_review(
                        f"## Issue: Invalid\n**File:** `{location}`\n**Severity:** High\n"
                        "**Problem:** Broken\n**Evidence:** Source\n**Suggested fix:** Fix\n", repo,
                    )

    def test_native_dispatch_requires_successful_code_review_tool(self):
        events = [
            {"type": "tool.execution_start", "data": {
                "toolName": "task", "toolCallId": "review", "arguments": '{"agent_type":"code-review"}',
            }},
            {"type": "tool.execution_complete", "data": {
                "toolCallId": "other", "success": True, "result": "ignore",
            }},
        ]
        self.assertIsNone(native.review_result(events))
        complete = {"toolCallId": "review", "success": True, "result": {"content": native.EMPTY}}
        self.assertEqual(native.review_result([*events, {"type": "tool.execution_complete", "data": complete}]),
                         native.EMPTY)
        failed = [*events, {"type": "tool.execution_complete", "data": {**complete, "success": False}}]
        self.assertIsNone(native.review_result(failed))
        with self.assertRaisesRegex(RuntimeError, "without a successful retry"):
            native.review_result(failed, final=True)
        with self.assertRaisesRegex(RuntimeError, "Unexpected native task response shape"):
            native.review_result([*events, {"type": "tool.execution_complete", "data": {**complete, "result": None}}])

    def test_failed_native_task_can_retry_after_a_parent_turn_ends(self):
        events = [
            {"type": "tool.execution_start", "data": {
                "toolName": "task", "toolCallId": "invalid", "arguments": {"agent_type": "code-review"},
            }},
            {"type": "tool.execution_complete", "data": {
                "toolCallId": "invalid", "success": False, "error": "name: Required",
            }},
            {"type": "assistant.turn_end"},
        ]
        self.assertIsNone(native.review_result(events))
        self.assertFalse(native.review_settled(events, successful=False))
        events.append({"type": "tool.execution_start", "data": {
            "toolName": "task", "toolCallId": "retry",
            "arguments": {"agent_type": "code-review", "name": "frozen-pr-review"},
        }})
        self.assertIsNone(native.review_result(events))
        events.extend([
            {"type": "tool.execution_complete", "data": {
                "toolCallId": "retry", "success": True, "result": native.EMPTY,
            }},
            {"type": "assistant.turn_end"},
        ])
        self.assertEqual(native.review_result(events, final=True), native.EMPTY)
        self.assertTrue(native.review_settled(events, successful=True))

    def test_only_root_idle_ends_an_unsuccessful_native_session(self):
        events = [
            {"type": "tool.execution_start", "data": {
                "toolName": "task", "toolCallId": "review", "arguments": {"agent_type": "code-review"},
            }},
            {"type": "tool.execution_complete", "data": {"toolCallId": "review", "success": False}},
            {"type": "session.idle", "parentToolCallId": "review"},
        ]
        self.assertFalse(native.review_settled(events, successful=False))
        events.append({"type": "session.idle"})
        self.assertTrue(native.review_settled(events, successful=False))
        with self.assertRaisesRegex(RuntimeError, "without a successful retry"):
            native.review_result(events, final=True)
        events.append({"type": "tool.execution_start", "data": {
            "toolName": "task", "toolCallId": "retry", "arguments": {"agent_type": "code-review"},
        }})
        self.assertFalse(native.review_settled(events, successful=False))

    def test_judge_keys_are_never_accepted_in_reviewer_environment(self):
        for key in ("ANTHROPIC_API_KEY", "AZURE_OPENAI_API_KEY", "RB_HARBOR_JUDGE_KEY",
                    "CAPI_DEV_KEY", "RB_HARBOR_CAPI_KEY"):
            with self.subTest(key=key), patch.dict(os.environ, {key: "fixture"}, clear=True):
                with self.assertRaisesRegex(RuntimeError, "Judge credential exposed"):
                    native.require_no_judge_credentials()
        with patch.dict(os.environ, {"COPILOT_GITHUB_TOKEN": "fixture"}, clear=True):
            native.require_no_judge_credentials()


class DockerFixture:
    def __init__(self, container):
        self.container = container

    async def exec(self, *, command, timeout_sec):
        response = await asyncio.to_thread(
            subprocess.run, ["docker", "exec", self.container, "sh", "-c", command],
            capture_output=True, text=True, timeout=timeout_sec,
        )
        return result(response.stdout, response.returncode, response.stderr)

    async def upload_file(self, source, destination):
        await asyncio.to_thread(
            subprocess.run, ["docker", "cp", str(source), f"{self.container}:{destination}"],
            check=True, capture_output=True, timeout=60,
        )


@unittest.skipUnless(os.environ.get("RB_TEST_DOCKER") == "1", "Set RB_TEST_DOCKER=1 on Linux Docker")
class PublicSetupTests(unittest.IsolatedAsyncioTestCase):
    async def test_pinned_cli_bootstraps_without_reviewer_network_or_judge(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            repo.mkdir()

            def git(*args):
                return subprocess.run(
                    ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True,
                ).stdout.strip()

            git("init", "-q", "-b", "main")
            git("config", "user.email", "fixture@example.invalid")
            git("config", "user.name", "Offline fixture")
            (repo / "example.txt").write_text("base\n")
            git("add", "example.txt")
            git("-c", "commit.gpgsign=false", "commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            (repo / "example.txt").write_text("head\n")
            git("-c", "commit.gpgsign=false", "commit", "-qam", "head")
            head = git("rev-parse", "HEAD")
            git("checkout", "-q", "--detach")
            git("branch", "-D", "main")
            (root / "Dockerfile").write_text(
                "FROM node:22-bookworm-slim@sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562\n"
                "RUN apt-get update && apt-get install -y --no-install-recommends "
                "git ca-certificates curl python3 ripgrep && rm -rf /var/lib/apt/lists\n"
                "COPY repo /work/repo\nWORKDIR /work/repo\n"
                f"ENV RB_BASE={base} RB_HEAD={head}\n"
                "RUN git config --system --add safe.directory /work/repo\n"
            )
            image = f"reviewbench-copilot-setup-{uuid.uuid4().hex}"
            subprocess.run(["docker", "build", "--quiet", "-t", image, str(root)], check=True, timeout=600)
            container = None
            try:
                container = subprocess.run(
                    ["docker", "run", "-d", "--network", "none", image, "sleep", "300"],
                    check=True, capture_output=True, text=True,
                ).stdout.strip()
                environment = DockerFixture(container)
                await adapter.NativeCopilotReview(logs_dir=root / "logs").setup(environment)
                probe = await environment.exec(
                    command=(
                        "copilot --no-auto-update --version"
                        " && git rev-parse refs/heads/main && git rev-parse HEAD"
                        ' && git diff --exit-code "$RB_HEAD"'
                        " && test -f /tmp/native_review.py"
                        " && test ! -e /tests && test ! -e /solution"
                        ' && test -z "${ANTHROPIC_API_KEY-}${RB_HARBOR_JUDGE_KEY-}"'
                        " && copilot login --help"
                        ' && ! curl -fsS --noproxy "*" --max-time 5 https://example.com'
                    ),
                    timeout_sec=30,
                )
                self.assertEqual(probe.return_code, 0, probe.stderr)
                self.assertEqual(probe.stdout.splitlines()[0], "GitHub Copilot CLI 1.0.96.")
                self.assertIn(base, probe.stdout)
                self.assertIn(head, probe.stdout)
                self.assertIn("--device-code", probe.stdout)
            finally:
                if container:
                    subprocess.run(["docker", "rm", "-f", container], check=True, capture_output=True)
                subprocess.run(["docker", "image", "rm", image], check=True, capture_output=True)


if __name__ == "__main__":
    unittest.main()
