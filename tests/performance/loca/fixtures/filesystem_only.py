from __future__ import annotations

from pathlib import Path
from typing import Any, Optional, SupportsFloat, Tuple

from gem.core import Env
from gem.utils.constants import TERMINAL_STATE


class FilesystemOnlyEnv(Env):
    """Small deterministic LOCA task that exercises one filesystem write + claim_done."""

    def __init__(
        self, task_dir: Optional[str] = None, expected_answer: str = "CODEY-FILESYSTEM-ONLY-OK", **_: Any
    ) -> None:
        super().__init__()
        if not task_dir:
            raise ValueError("task_dir is required")
        self.task_dir = Path(task_dir)
        self.agent_workspace = self.task_dir / "agent_workspace"
        self.expected_answer = expected_answer
        self.agent_workspace.mkdir(parents=True, exist_ok=True)
        self.reset()

    def reset(self, seed: Optional[int] = None) -> Tuple[str, dict[str, Any]]:
        super().reset(seed)
        self.agent_workspace.mkdir(parents=True, exist_ok=True)
        answer_path = self.agent_workspace / "answer.txt"
        if answer_path.exists():
            answer_path.unlink()
        # Keep the fixture self-contained and action-oriented.  Requiring the
        # model to read a separate brief caused repeated read/list calls before
        # it attempted the actual write, which made the smoke test needlessly
        # dependent on model planning behavior.
        return (
            f"Complete this task in exactly two tool calls. "
            f"First call filesystem_write_file exactly once with path "
            f"{answer_path} and content {self.expected_answer}. "
            "After the write succeeds, immediately call the exposed claim_done_claim_done tool. "
            "Do not read or list files, do not repeat the write, do not use any "
            "other tool, and do not send a final text response instead of claim_done_claim_done.",
            {},
        )

    def step(
        self, action: str
    ) -> Tuple[str, SupportsFloat, bool, bool, dict[str, Any]]:
        answer_path = self.agent_workspace / "answer.txt"
        actual = answer_path.read_text(encoding="utf-8").strip() if answer_path.exists() else ""
        correct = actual == self.expected_answer
        return TERMINAL_STATE, 1.0 if correct else 0.0, True, True, {
            "answer_path": str(answer_path),
            "expected_answer": self.expected_answer,
            "actual_answer": actual,
        }
