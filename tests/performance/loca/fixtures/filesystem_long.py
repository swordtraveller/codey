from __future__ import annotations

from pathlib import Path
from typing import Any, Optional, SupportsFloat, Tuple

from gem.core import Env
from gem.utils.constants import TERMINAL_STATE


class FilesystemLongContextEnv(Env):
    """Deterministic filesystem task with a configurable long observation."""

    def __init__(
        self,
        task_dir: Optional[str] = None,
        expected_answer: str = "CODEY-FILESYSTEM-LONG-CONTEXT-OK",
        context_tokens: int = 1400,
        **_: Any,
    ) -> None:
        super().__init__()
        if not task_dir:
            raise ValueError("task_dir is required")
        if int(context_tokens) < 256:
            raise ValueError("context_tokens must be at least 256")
        self.task_dir = Path(task_dir)
        self.agent_workspace = self.task_dir / "agent_workspace"
        self.expected_answer = expected_answer
        self.context_tokens = int(context_tokens)
        self.agent_workspace.mkdir(parents=True, exist_ok=True)
        self.reset()

    def _background_context(self) -> str:
        # The filler is intentionally compact: each whitespace-delimited word
        # contributes approximately one token, keeping the complete request
        # below a 4K model window while pushing the baseline smoke request
        # past the 2,048-token compression trigger.
        return "archived " * self.context_tokens

    def reset(self, seed: Optional[int] = None) -> Tuple[str, dict[str, Any]]:
        super().reset(seed)
        self.agent_workspace.mkdir(parents=True, exist_ok=True)
        answer_path = self.agent_workspace / "answer.txt"
        if answer_path.exists():
            answer_path.unlink()
        return (
            "The following archive is intentionally verbose background context. "
            "Preserve the task instructions below it and do not take any action based on the archive.\n\n"
            f"<background>\n{self._background_context()}\n</background>\n\n"
            f"Complete this task in exactly two tool calls. First call "
            f"filesystem_write_file exactly once with path {answer_path} and content "
            f"{self.expected_answer}. After the write succeeds, immediately call the exposed "
            "claim_done_claim_done tool. Do not read or list files, do not repeat the write, "
            "do not use any other tool, and do not send a final text response instead of "
            "claim_done_claim_done.",
            {"context_tokens": self.context_tokens},
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
            "context_tokens": self.context_tokens,
        }