"""ops/readme_facts.py 的目录树校验：干净 checkout 里也要成立。

背景（2026-10-11 的 CI 红）：README 的目录树里写了 `secrets/`，本机存在、
`.gitignore` 排除、CI 的干净 checkout 里没有。校验只看文件系统时，本机通过、
CI 必红 —— 所以判据要落在 git（被忽略 = 不入库 = 不算漂移），而不是落在本机。
"""

import shutil
import subprocess

import pytest

import ops.readme_facts as readme_facts

requires_git = pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")


@pytest.fixture
def clean_repo(tmp_path):
    """一个只有 .gitignore 的临时 git 仓库（模拟干净 checkout 的判定环境）。"""
    (tmp_path / ".gitignore").write_text("secrets/\n", encoding="utf-8")
    (tmp_path / "src").mkdir()
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    return tmp_path


@requires_git
def test_git_ignored_detects_local_only_paths(clean_repo):
    assert readme_facts.git_ignored("secrets", str(clean_repo)) is True
    assert readme_facts.git_ignored("secrets/webauthn.env", str(clean_repo)) is True
    assert readme_facts.git_ignored("src/config.py", str(clean_repo)) is False


@requires_git
def test_tree_problems_skips_gitignored_but_keeps_real_drift(clean_repo):
    # secrets/ 不存在于这个 checkout，但被忽略：不算漂移（CI 上就是这种情况）。
    # src/config.py 不存在且没被忽略：仍是漂移，校验没被削弱。
    problems = readme_facts.tree_problems(str(clean_repo), ["src", "secrets", "src/config.py"])

    assert problems == ["tree lists a path that does not exist: src/config.py"]


@requires_git
def test_tree_problems_accepts_missing_parent_chain(clean_repo):
    """父目录本身就不存在时不再重复报（secrets/ 的子条目）。"""
    assert readme_facts.tree_problems(str(clean_repo), ["secrets/webauthn.env"]) == []


def test_readme_tree_check_has_no_drift():
    """真实仓库：README 的目录树相对当前提交无漂移。"""
    assert readme_facts.tree_problems(readme_facts.BASE_DIR, readme_facts.tree_paths()) == []
