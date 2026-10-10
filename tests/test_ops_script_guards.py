"""ops/deploy.sh 与 ops/migrate_d1.sh 的安全闸门（docs/22 · W3）。

这些用例全部离线运行：
  * deploy.sh 只走 --dry-run，或在临时 git 仓库里换成 stub 的 pages/docs 步骤；
  * migrate_d1.sh 用 WRANGLER_BIN 指向假 wrangler，绝不接触 Cloudflare / 生产 D1。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
BASH = "/bin/bash"
DEPLOY = ROOT / "ops" / "deploy.sh"
MIGRATE = ROOT / "ops" / "migrate_d1.sh"
MIGRATIONS_DIR = ROOT / "ops" / "migrations"


# ── 辅助 ──────────────────────────────────────────────────────────────


def run(args, cwd=ROOT, env=None, timeout=60):
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    return subprocess.run(
        args, cwd=str(cwd), env=full_env, capture_output=True, text=True, timeout=timeout
    )


def git(args, cwd):
    return subprocess.run(
        ["git", *args], cwd=str(cwd), capture_output=True, text=True, check=True
    )


def make_repo(tmp_path: Path, branch: str = "main") -> Path:
    """建一个干净的临时 git 仓库，并把 deploy.sh 与 stub 步骤脚本放进去。"""
    repo = tmp_path / "repo"
    (repo / "ops").mkdir(parents=True)
    shutil.copy2(DEPLOY, repo / "ops" / "deploy.sh")
    for name, body in (
        ("ci_check.sh", '#!/bin/bash\necho "STUB ci_check ran (args: $*)"\n'),
        ("pages_deploy.sh", '#!/bin/bash\necho "STUB pages_deploy ran"\n'),
        ("docs_deploy.sh", '#!/bin/bash\necho "STUB docs_deploy ran"\n'),
    ):
        path = repo / "ops" / name
        path.write_text(body)
        path.chmod(0o755)
    (repo / "tracked.txt").write_text("v1\n")
    git(["-c", "init.defaultBranch=main", "init", "-q"], repo)
    git(["add", "-A"], repo)
    git(
        ["-c", "user.name=w3", "-c", "user.email=w3@example.com", "commit", "-q", "-m", "init"],
        repo,
    )
    if branch != "main":
        git(["checkout", "-q", "-b", branch], repo)
    return repo


def migration_names() -> list[str]:
    return sorted(p.name for p in MIGRATIONS_DIR.glob("*.sql"))


def expected_tables() -> list[str]:
    text = MIGRATE.read_text()
    match = re.search(r"^\s*expected=\(([^)]*)\)", text, re.M)
    assert match, "could not read the expected table list from ops/migrate_d1.sh"
    tables = match.group(1).split()
    if (MIGRATIONS_DIR / "004_auth_sessions.sql").exists():
        tables.append("auth_sessions")
    return tables


def wrangler_payload(names: list[str]) -> str:
    return json.dumps(
        [{"results": [{"name": n} for n in names], "success": True, "meta": {"rows_read": len(names)}}],
        indent=2,
    )


def write_fake_wrangler(path: Path, file_error: str, versions: list[int]) -> Path:
    """假 wrangler：--file 一律按 file_error 失败，SELECT version 返回 versions。"""
    rows = ",".join('{"version":%d}' % v for v in versions)
    path.write_text(
        "#!/bin/bash\n"
        'cmd=""; file=""\n'
        "while [ $# -gt 0 ]; do\n"
        '    case "$1" in\n'
        '        --command) cmd="$2"; shift ;;\n'
        '        --file) file="$2"; shift ;;\n'
        "    esac\n"
        "    shift\n"
        "done\n"
        'if [ -n "$file" ]; then\n'
        f'    echo "{file_error}"\n'
        "    exit 1\n"
        "fi\n"
        'case "$cmd" in\n'
        f'    *"FROM schema_version"*) echo \'[{{"results":[{rows}],"success":true,"meta":{{"rows_read":{len(versions)}}}}}]\'; exit 0 ;;\n'
        '    *) echo "ok"; exit 0 ;;\n'
        "esac\n"
    )
    path.chmod(0o755)
    return path


# ── W3-2：--worker= 空值 ──────────────────────────────────────────────


def test_deploy_rejects_empty_worker_value():
    result = run([BASH, "ops/deploy.sh", "--worker=", "--dry-run"])
    assert result.returncode == 2, result.stdout + result.stderr
    assert "FATAL: --worker= needs a Worker name" in result.stderr
    # 旧行为是静默落到「无参数 = --all」，这里必须什么都不部署
    assert "would-run: bash ops/pages_deploy.sh" not in result.stdout
    assert "Deploy: dry-run done" not in result.stdout


def test_deploy_rejects_worker_name_with_unsafe_characters():
    result = run([BASH, "ops/deploy.sh", "--worker=../evil", "--dry-run"])
    assert result.returncode == 2
    assert "FATAL: invalid Worker name" in result.stderr


# ── W3-1：非 main 分支不得 commit / push ─────────────────────────────


def test_deploy_dry_run_on_feature_branch_is_fatal(tmp_path):
    repo = make_repo(tmp_path, branch="tmp/w3-check")
    result = run([BASH, "ops/deploy.sh", "--dry-run"], cwd=repo)
    assert result.returncode == 2, result.stdout + result.stderr
    assert "FATAL: commit/push must run on branch main" in result.stderr
    assert "tmp/w3-check" in result.stderr
    # 没有真正开跑
    assert "Deploy: start (dry-run)" not in result.stdout


def test_deploy_dry_run_on_detached_head_is_fatal(tmp_path):
    repo = make_repo(tmp_path)
    git(["checkout", "-q", "--detach"], repo)
    result = run([BASH, "ops/deploy.sh", "--dry-run"], cwd=repo)
    assert result.returncode == 2
    assert "FATAL: commit/push must run on branch main" in result.stderr
    assert "detached HEAD" in result.stderr


def test_deploy_dry_run_on_main_is_allowed(tmp_path):
    repo = make_repo(tmp_path)
    result = run([BASH, "ops/deploy.sh", "--dry-run"], cwd=repo)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "branch: main" in result.stdout
    assert "Deploy: dry-run done" in result.stdout


# ── W3-3：Pages / docs 前先跑 CI，脏树要拒绝 ─────────────────────────


def test_deploy_pages_runs_ci_first_on_a_clean_tree(tmp_path):
    repo = make_repo(tmp_path)
    result = run([BASH, "ops/deploy.sh", "--pages"], cwd=repo)
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.index("Check: done") < result.stdout.index("Pages: done")


def test_deploy_pages_refuses_a_dirty_tree(tmp_path):
    repo = make_repo(tmp_path)
    (repo / "tracked.txt").write_text("v1\nuncommitted\n")
    result = run([BASH, "ops/deploy.sh", "--pages"], cwd=repo)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "FATAL: working tree has uncommitted changes" in result.stderr
    assert "tracked.txt" in result.stderr
    # 拒绝要发生在 CI 与 Pages 之前
    assert "Check: done" not in result.stdout
    assert "STUB pages_deploy ran" not in result.stdout


def test_deploy_pages_allows_a_dirty_tree_with_the_escape_hatch(tmp_path):
    repo = make_repo(tmp_path)
    (repo / "tracked.txt").write_text("v1\nuncommitted\n")
    result = run(
        [BASH, "ops/deploy.sh", "--pages"], cwd=repo, env={"LIMOOO_ALLOW_DIRTY": "1"}
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Warning: deploying a dirty working tree (LIMOOO_ALLOW_DIRTY=1)" in result.stdout
    assert result.stdout.index("Check: done") < result.stdout.index("Pages: done")


# ── W3-4 / W3-5：--remote 必需，--dry-run 完全离线 ────────────────────


def test_migrate_apply_requires_remote():
    result = run(
        [BASH, "ops/migrate_d1.sh"],
        env={"WRANGLER_BIN": "/nonexistent/wrangler", "D1_STATE_FILE": "/tmp/w3-unused"},
    )
    assert result.returncode == 2, result.stdout + result.stderr
    assert "FATAL: --remote is required" in result.stderr
    assert "unbound variable" not in result.stderr


def test_migrate_check_schema_without_remote_does_not_crash():
    result = run([BASH, "ops/migrate_d1.sh", "--check-schema"])
    assert result.returncode == 2, result.stdout + result.stderr
    assert "FATAL: --remote is required" in result.stderr
    assert "unbound variable" not in result.stderr
    assert "unbound variable" not in result.stdout


def test_migrate_dry_run_is_offline_and_lists_every_migration(tmp_path):
    cache = tmp_path / "applied"
    result = run(
        [BASH, "ops/migrate_d1.sh", "--dry-run"],
        env={"WRANGLER_BIN": "/nonexistent/wrangler", "D1_STATE_FILE": str(cache)},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    names = migration_names()
    assert f"{len(names)} migration files" in result.stdout
    for name in names:
        assert name in result.stdout
    assert result.stdout.count("key=") == len(names)
    # 空缓存 → 全部 cache=no；假 wrangler 不存在也不能被调用
    assert "cache=yes" not in result.stdout
    assert not cache.exists()


# ── W3-7：--check-schema 用精确表名，不做子串匹配 ────────────────────


def test_check_schema_does_not_accept_a_prefix_table(tmp_path):
    """visitors_v2 存在但 visitors 丢失时必须报缺表（W3-7）。"""
    tables = [t for t in expected_tables() if t not in ("visitors", "ray_log")]
    assert "visitors_v2" in tables and "ray_log_v2" in tables
    payload = tmp_path / "trap.json"
    payload.write_text(wrangler_payload(tables))
    result = run(
        [BASH, "ops/migrate_d1.sh", "--check-schema"],
        env={"LIMOOO_D1_SCHEMA_JSON": str(payload)},
    )
    assert result.returncode == 1, result.stdout + result.stderr
    assert "FATAL: D1 missing expected tables: visitors ray_log" in result.stderr
    assert "visitors_v2" not in result.stderr


def test_check_schema_passes_when_every_table_is_present(tmp_path):
    payload = tmp_path / "full.json"
    payload.write_text(wrangler_payload(expected_tables() + ["gate_assets", "probes"]))
    result = run(
        [BASH, "ops/migrate_d1.sh", "--check-schema"],
        env={"LIMOOO_D1_SCHEMA_JSON": str(payload)},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "schema check: OK" in result.stdout


# ── W3-5 / W3-6 / W3-8：D1 schema_version 是唯一事实源 ────────────────


def test_apply_ignores_the_local_cache_and_reads_d1_state(tmp_path):
    names = migration_names()
    prefixes = sorted({int(n.split("_")[0]) for n in names})
    legacy = prefixes[:-1]  # 生产库现状：旧式纯版本号，缺最新那条
    newest = [n for n in names if int(n.split("_")[0]) == prefixes[-1]][0]

    fake = write_fake_wrangler(
        tmp_path / "wrangler", "D1_ERROR: duplicate column name: last_alert_at", legacy
    )
    cache = tmp_path / "applied"
    # 故意埋一份「谎报最新迁移已应用」的本地缓存
    cache.write_text(f"{newest}\n")

    result = run(
        [BASH, "ops/migrate_d1.sh", "--remote"],
        env={"WRANGLER_BIN": str(fake), "D1_STATE_FILE": str(cache)},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    # 本地缓存不能决定跳过：最新迁移仍要执行
    assert f"[d1] apply: {newest}" in result.stdout
    assert "skip (recorded legacy version" in result.stdout
    # ALTER 重复报错要被识别成「已应用」而不是 FATAL
    assert f"already applied (schema already present, record was missing): {newest}" in result.stdout
    assert f"[d1] recorded: {newest} key=" in result.stdout
    # 跑完后缓存被覆盖成 D1 的权威集合
    assert cache.read_text().split() == names


def test_apply_failure_does_not_touch_the_local_cache(tmp_path):
    names = migration_names()
    prefixes = sorted({int(n.split("_")[0]) for n in names})
    fake = write_fake_wrangler(
        tmp_path / "wrangler", "D1_ERROR: near SELEC: syntax error", prefixes[:-1]
    )
    cache = tmp_path / "applied"
    cache.write_text("POISON\n")
    result = run(
        [BASH, "ops/migrate_d1.sh", "--remote"],
        env={"WRANGLER_BIN": str(fake), "D1_STATE_FILE": str(cache)},
    )
    assert result.returncode == 1, result.stdout + result.stderr
    assert "FATAL: migration failed" in result.stderr
    assert cache.read_text() == "POISON\n"


@pytest.mark.parametrize("name", ["ops/deploy.sh", "ops/migrate_d1.sh"])
def test_scripts_are_syntactically_valid(name):
    result = run([BASH, "-n", name])
    assert result.returncode == 0, result.stderr
