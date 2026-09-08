from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Optional, SupportsFloat, Tuple

from gem.core import Env
from gem.utils.constants import TERMINAL_STATE

INSTRUCTION_TEMPLATE = """{problem_statement}

## Workspace

You are given a snapshot of the `{repo}` repository at commit `{commit}`. The repository root is your filesystem workspace. Fix the issue described above by editing files under `src/` only.

## How to run the tests

Run `python run_tests.py <pytest args>` from your workspace (the directory that contains `run_tests.py`). For example: `python run_tests.py tests/ -q`. The helper picks the pinned test environment for you; do not install packages.

## Rules

- Do NOT modify anything outside `src/` (tests, config files, packaging). The grader verifies their integrity with hashes.
- The grader runs hidden tests derived from this issue; making the visible suite pass by special-casing will not pass grading variants.
- When you believe the fix is complete, call the `claim_done_claim_done` tool.
"""


class SweRepoFixEnv(Env):
    """SWE-bench Verified instance wrapped as a deterministic LOCA coding task.

    Judging (all must hold, binary):
      1. integrity: every baseline file outside ``src/`` is byte-identical
      2. fail-to-pass tests all pass after the hidden test patch is applied
      3. pass-to-pass tests all stay green
    """

    def __init__(self, task_dir: Optional[str] = None, instance_id: Optional[str] = None, **_: Any) -> None:
        super().__init__()
        if not task_dir:
            raise ValueError("task_dir is required")
        if not instance_id:
            raise ValueError("instance_id is required (prepare it with scripts/swe-bench-prepare.ts)")
        repo_root = Path(__file__).resolve().parents[4]
        self.material_dir = repo_root / "tests" / "performance" / ".cache" / "swe-materials" / instance_id
        meta_path = self.material_dir / "meta.json"
        if not self.material_dir.exists() or not meta_path.exists():
            raise ValueError(
                f"SWE-bench materials missing for {instance_id}. "
                "Run: npx tsx scripts/swe-bench-prepare.ts --instance " + instance_id
            )
        self.meta = json.loads(meta_path.read_text(encoding="utf-8"))
        self.task_dir = Path(task_dir)
        self.agent_workspace = self.task_dir / "agent_workspace"
        self.repo_dir = self.agent_workspace / "repo"
        self.venv_python = (self.material_dir / self.meta["venv_python_relative"]).resolve()
        self.pytest_args = list(self.meta.get("pytest_args", []))
        self.test_patch_path = self.material_dir / "test.patch"
        self._baseline_hashes: dict[str, str] = {}

    # -- helpers -------------------------------------------------------------

    def _hash_repo_files(self) -> dict[str, str]:
        hashes: dict[str, str] = {}
        for path in sorted(self.repo_dir.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(self.repo_dir).as_posix()
            if (
                rel.startswith(".git/")
                or rel.startswith("src/")
                or "/__pycache__/" in f"/{rel}"
                or rel.startswith("__pycache__/")
                or rel.startswith(".pytest_cache/")
                or rel.endswith(".pyc")
            ):
                continue
            hashes[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
        return hashes

    def _git(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        result = subprocess.run(
            ["git", "-c", "core.autocrlf=false", "-C", str(self.repo_dir), *args],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if check and result.returncode != 0:
            raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()[:200]}")
        return result

    def _run_pytest(self, test_ids: list[str]) -> Tuple[int, int, int]:
        """Returns (total, failed, errored) parsed from a junit report."""
        junit = self.task_dir / ("junit-%s.xml" % hashlib.md5(("|".join(test_ids)).encode()).hexdigest()[:8])
        env = {**os.environ, "PYTHONPATH": str(self.repo_dir / "src")}
        subprocess.run(
            [str(self.venv_python), "-m", "pytest", *test_ids, *self.pytest_args,
             "--junitxml=" + str(junit), "-q", "--tb=no"],
            cwd=str(self.repo_dir), capture_output=True, text=True, env=env, timeout=600,
        )
        try:
            root = ET.parse(junit).getroot()
        except ET.ParseError:
            return 0, 0, 1
        total = failed = errored = 0
        for suite in root.iter("testsuite"):
            total += int(suite.get("tests", 0))
            failed += int(suite.get("failures", 0))
            errored += int(suite.get("errors", 0))
        return total, failed, errored

    def _write_run_tests_helper(self) -> None:
        helper = self.agent_workspace / "run_tests.py"
        helper.write_text(
            "import os, subprocess, sys\n"
            "HERE = os.path.dirname(os.path.abspath(__file__))\n"
            f"VENV_PY = r'{self.venv_python}'\n"
            f"PYTEST_ARGS = {self.pytest_args!r}\n"
            "repo = os.path.join(HERE, 'repo')\n"
            "env = {**os.environ, 'PYTHONPATH': os.path.join(repo, 'src')}\n"
            "raise SystemExit(subprocess.call(\n"
            "    [VENV_PY, '-m', 'pytest'] + PYTEST_ARGS + sys.argv[1:], cwd=repo, env=env))\n",
            encoding="utf-8",
        )

    def _evaluate(self) -> dict[str, Any]:
        info: dict[str, Any] = {"instance_id": self.meta["instance_id"]}
        current = self._hash_repo_files()
        changed = sorted(rel for rel, digest in self._baseline_hashes.items() if current.get(rel) != digest)
        if changed:
            info.update(failure_reason="tampered", detail=f"modified outside src/: {', '.join(changed[:5])}")
            return info
        try:
            self._git("apply", str(self.test_patch_path))
        except RuntimeError as error:
            info.update(failure_reason="tampered", detail=f"hidden test patch conflicts: {error}")
            return info
        try:
            total, failed, errored = self._run_pytest(self.meta["fail_to_pass"])
            info["f2p"] = f"{total - failed - errored}/{total}"
            if failed or errored:
                info["failure_reason"] = "f2p"
                return info
            total, failed, errored = self._run_pytest(self.meta["pass_to_pass"])
            info["p2p"] = f"{total - failed - errored}/{total}"
            if failed or errored:
                info["failure_reason"] = "p2p"
                return info
            info["failure_reason"] = "pass"
            return info
        finally:
            # 撤销隐藏测试补丁,保留 agent 对 src/ 的修改
            self._git("apply", "-R", str(self.test_patch_path), check=False)

    # -- Env API -------------------------------------------------------------

    def reset(self, seed: Optional[int] = None) -> Tuple[str, dict[str, Any]]:
        super().reset(seed)
        self.agent_workspace.mkdir(parents=True, exist_ok=True)
        if self.repo_dir.exists():
            for attempt in range(3):
                try:
                    shutil.rmtree(self.repo_dir)
                    break
                except PermissionError:
                    if attempt == 2:
                        raise
                    time.sleep(1)
        shutil.copytree(self.material_dir / "repo", self.repo_dir, ignore=shutil.ignore_patterns(".git"))
        self._baseline_hashes = self._hash_repo_files()
        (self.task_dir / "baseline-hashes.json").write_text(
            json.dumps(self._baseline_hashes, indent=1), encoding="utf-8"
        )
        self._write_run_tests_helper()
        instruction = INSTRUCTION_TEMPLATE.format(
            problem_statement=self.meta["problem_statement"].strip(),
            repo=self.meta["repo"],
            commit=self.meta["base_commit"][:10],
        )
        return instruction, {"instance_id": self.meta["instance_id"]}

    def step(self, action: str) -> Tuple[str, SupportsFloat, bool, bool, dict[str, Any]]:
        if "claim_done" not in str(action):
            return TERMINAL_STATE, 0.0, True, True, {"failure_reason": "not-finished"}
        info = self._evaluate()
        reward = 1.0 if info.get("failure_reason") == "pass" else 0.0
        return TERMINAL_STATE, reward, True, True, info
