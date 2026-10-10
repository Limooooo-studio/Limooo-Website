#!/usr/bin/env python3

# Limooo - 统一配置与公共工具
#
# Copyright (C) 2026 Limooo <https://limooo.cn/>
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""README 事实读取器：把「可预测可变」的信息一律从当下权威来源读出来。

README（`site/README.md` 与 docs 站四份副本）里有大量会变但可推导的事实：
cron 表、D1 保留期、cookie TTL、缓存头、语言数、信任 ASN 数、目录树……
写死一次就会过期。本脚本负责：

    python3 ops/readme_facts.py            # 读仓库（不联网），打印事实清单
    python3 ops/readme_facts.py --check    # 校验 README 与仓库事实一致，漂移即失败
    python3 ops/readme_facts.py --live     # 读线上（D1 / Pages / Workers / DNS / WAF / List）
    python3 ops/readme_facts.py --json     # 机器可读输出（键值全英文）

面向终端的输出一律英文（AGENTS.md：脚本 stdout 用英文，代码注释保留中文）。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
README = os.path.join(BASE_DIR, "README.md")
CONTRACT = os.path.join(BASE_DIR, "config-contract.json")
STATUS_WORKER = os.path.join(BASE_DIR, "ops", "status-worker")
DB_ID = "e2f29d54-29c0-46af-938d-e13995a11d7f"
TREE_LINE = re.compile(r"^([│├└─\s]*)(\S.*)$")
CRON_ROW = re.compile(r"^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|", re.M)


def read(path: str) -> str:
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def contract() -> dict:
    return json.loads(read(CONTRACT))


def wrangler_facts() -> list[dict]:
    """每个 wrangler.toml → {path, name, crons}（cron 由 Worker 自己声明）。"""
    out = []
    for root, _dirs, files in os.walk(BASE_DIR):
        if "node_modules" in root or ".venv" in root:
            continue
        if "wrangler.toml" not in files:
            continue
        path = os.path.join(root, "wrangler.toml")
        text = read(path)
        name = re.search(r'^name\s*=\s*"([^"]+)"', text, re.M)
        crons = re.search(r"^crons\s*=\s*\[([^\]]*)\]", text, re.M)
        rel = os.path.relpath(root, BASE_DIR)
        out.append(
            {
                "dir": "." if rel == "." else rel,
                "name": name.group(1) if name else "?",
                "crons": re.findall(r'"([^"]+)"', crons.group(1)) if crons else [],
            }
        )
    return sorted(out, key=lambda item: item["dir"])


def retention_facts() -> dict:
    text = read(os.path.join(STATUS_WORKER, "src", "retention.ts"))
    buckets = re.findall(r"(\w+):\s*(\d+)\s*\*\s*DAY_SECONDS", text)
    return {table: int(days) for table, days in buckets}


def gate_trust_facts() -> dict:
    """信任清单计数：ASN 读 data/whitelist.txt（唯一事实源），CIDR 读生成产物。

    ASN 不再 emit 进 functions/_data/gateTrust.ts（运行时只消费 verified_bot /
    ip_cidrs，ASN 是 WAF 的输入，见 docs/22 W4-4），所以计数必须从 whitelist.txt
    现读；继续对生成物做正则只会读到 0。ip_cidrs 仍以生成物为准，顺便能发现
    “白名单改了但没重新 build”的漂移。
    """
    whitelist = read(os.path.join(BASE_DIR, "data", "whitelist.txt"))
    asns = {
        int(match.group(1))
        for match in re.finditer(r"^ASN/(\d{1,10})\s*$", whitelist, re.I | re.M)
    }
    text = read(os.path.join(BASE_DIR, "functions", "_data", "gateTrust.ts"))
    cidrs = re.search(r'"ip_cidrs":\s*\[(.*?)\]\s*\}', text, re.S)
    return {
        "verified_bot": '"verified_bot": true' in text,
        "asns": len(asns),
        "ip_cidrs": len(re.findall(r"\[", cidrs.group(1))) if cidrs else 0,
    }


def cache_facts() -> dict:
    """页面缓存头：逐条指令解析，缺哪条就说哪条缺，绝不伪造 0。

    以前这里用一条写死的正则把 `max-age / s-maxage / swr` 三段一口气匹配下来，
    任一段缺失（例如按 W2-1 拍板去掉 `s-maxage`）就整条失配，然后回退成
    `0/0/0` —— 于是校验反过来要求 README 写「s-maxage=0」，把解析器的 bug
    变成了文档的错。现在按指令取值：没有的键就是 None，`check()` 只校验
    真正存在的指令。
    """
    text = read(os.path.join(BASE_DIR, "functions", "_middleware.ts"))
    directive = re.search(r'PAGE_CACHE_CONTROL\s*=\s*"([^"]*)"', text)
    if not directive:
        raise RuntimeError("cannot find PAGE_CACHE_CONTROL in functions/_middleware.ts")
    raw = directive.group(1)
    if not raw.startswith("public,"):
        raise RuntimeError(f"unexpected PAGE_CACHE_CONTROL value: {raw!r}")

    values: dict[str, int | None] = {"max-age": None, "s-maxage": None, "stale-while-revalidate": None}
    for part in raw.split(",")[1:]:
        key, _, value = part.strip().partition("=")
        if key in values:
            if not value.isdigit():
                raise RuntimeError(f"non-numeric cache directive: {part.strip()!r}")
            values[key] = int(value)

    if values["max-age"] is None:
        raise RuntimeError(f"PAGE_CACHE_CONTROL has no max-age: {raw!r}")

    vary = re.search(r'PAGE_CACHE_VARY\s*=\s*"([^"]+)"', text)
    if not vary:
        raise RuntimeError("cannot find PAGE_CACHE_VARY in functions/_middleware.ts")
    return {
        "max_age": values["max-age"],
        "s_maxage": values["s-maxage"],
        "swr": values["stale-while-revalidate"],
        "vary": vary.group(1),
    }


def timeout_facts() -> dict:
    gate = read(os.path.join(BASE_DIR, "functions", "_lib", "gate.ts"))
    access = read(os.path.join(BASE_DIR, "functions", "_lib", "access.ts"))
    siteverify = re.search(r"SITEVERIFY_TIMEOUT_MS\s*=\s*([\d_]+)", gate)
    jwks = re.search(r"JWKS_TTL_MS\s*=\s*([\d_]+)", access)
    return {
        "siteverify_ms": int(siteverify.group(1).replace("_", "")) if siteverify else 0,
        "jwks_ms": int(jwks.group(1).replace("_", "")) if jwks else 0,
    }


def migration_facts() -> dict:
    names = sorted(os.listdir(os.path.join(BASE_DIR, "ops", "migrations")))
    sql = [n for n in names if n.endswith(".sql")]
    versions = sorted({int(n[:3]) for n in sql})
    return {"files": len(sql), "min": versions[0], "max": versions[-1], "versions": versions}


def tree_paths() -> list[str]:
    """README 目录树里出现的路径（用于「树上写的都真的存在」校验）。

    树是按缩进分层的，这里按每层 4 个字符（``│   `` / ``├── `` / ``└── ``）还原层级，
    再把名字接到父目录后面；一行写多个名字（``a.py / b.py``）也算同级。
    """
    block = re.search(r"## Project structure\n\n```\n(.*?)```", read(README), re.S)
    if not block:
        return []
    paths: list[str] = []
    stack: list[str] = []
    for line in block.group(1).splitlines():
        line = line.split("#", 1)[0].rstrip()
        match = TREE_LINE.match(line)
        if not match:
            continue
        depth = max(1, len(match.group(1)) // 4)
        parent = stack[: depth - 1]
        for name in match.group(2).split():
            if not re.fullmatch(r"[A-Za-z0-9_.\-]+/?", name):
                continue
            if name.endswith("/"):
                stack = parent + [name.rstrip("/")]
                paths.append("/".join(stack))
            else:
                paths.append("/".join(parent + [name]))
    return paths


def repo_facts() -> dict:
    cfg = contract()
    return {
        "wrangler": wrangler_facts(),
        "migrations": migration_facts(),
        "retention_days": retention_facts(),
        "gate_trust": gate_trust_facts(),
        "cache": cache_facts(),
        "timeouts": timeout_facts(),
        "langs": cfg["supported_langs"],
        "default_lang": cfg["default_lang"],
        "gate_ttl_seconds": cfg["gate_ttl_seconds"],
        "session_ttl_seconds": cfg["session_ttl_seconds"],
        "managed_hosts": cfg["managed_hosts"],
        "image_asset_host": cfg["image_asset_host"],
        "image_watermark_host": cfg["image_watermark_host"],
    }


def print_repo_facts(facts: dict) -> None:
    print("worker schedules")
    for item in facts["wrangler"]:
        crons = ", ".join(item["crons"]) or "-"
        print(f"  {item['dir']:<22} {item['name']:<24} {crons}")
    mig = facts["migrations"]
    print("migrations")
    print(f"  {'files':<22} {mig['files']} (versions {mig['min']:03d}-{mig['max']:03d})")
    print("d1 retention")
    for table, days in facts["retention_days"].items():
        print(f"  {table:<22} {days}d")
    trust = facts["gate_trust"]
    print("gate trust")
    print(f"  {'low_risk_asns':<22} {trust['asns']}")
    print(f"  {'ip_cidrs':<22} {trust['ip_cidrs']}")
    print(f"  {'verified_bot':<22} {trust['verified_bot']}")
    cache = facts["cache"]
    print("cache / timeouts")
    s_maxage = "-" if cache["s_maxage"] is None else cache["s_maxage"]
    swr = "-" if cache["swr"] is None else cache["swr"]
    print(f"  {'page cache':<22} max-age={cache['max_age']} s-maxage={s_maxage} swr={swr}")
    print(f"  {'vary':<22} {cache['vary']}")
    print(f"  {'siteverify timeout':<22} {facts['timeouts']['siteverify_ms']}ms")
    print(f"  {'jwks ttl':<22} {facts['timeouts']['jwks_ms']}ms")
    print(f"  {'gate cookie ttl':<22} {facts['gate_ttl_seconds']}s")
    print("languages")
    print(f"  {'supported':<22} {', '.join(facts['langs'])}")
    print(f"  {'default':<22} {facts['default_lang']}")
    print("hosts (managed by the Pages Functions)")
    print(f"  {', '.join(facts['managed_hosts'])}")


def _git_check_ignore(path: str, root: str) -> bool:
    try:
        done = subprocess.run(
            ["git", "check-ignore", "-q", "--", path],
            cwd=root,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        return False
    return done.returncode == 0


def git_ignored(path: str, root: str = BASE_DIR) -> bool:
    """该路径是否被 .gitignore 排除（`secrets/` 这类只在本机存在、不入库的东西）。

    目录树校验要在「CI 的干净 checkout」里也成立，所以不能只看本机文件系统：
    被忽略的路径本来就不进仓库，本机有、CI 没有都算正常。
    路径不存在时 git 分不清它是文件还是目录，因此带尾斜杠再问一次 —— `secrets/`
    这种只匹配目录的规则，写成 `secrets` 会答「没被忽略」，带尾斜杠才认（就是
    2026-10-11 那次 CI 变红的坑）。
    git 不可用（无 git、非仓库）时返回 False，由调用方按文件系统兜底。
    """
    return any(_git_check_ignore(candidate, root) for candidate in (path, f"{path}/"))


def tree_problems(root: str, paths: list[str]) -> list[str]:
    """目录树里写了、但干净的 checkout 里并不存在的路径。

    两类豁免：被 .gitignore 排除的条目（`secrets/` 在本机存在、CI 里没有）、
    以及父目录链本身就缺的条目（父目录自己已经算过一次了）。其余一律报漂移。
    """
    problems: list[str] = []
    for path in paths:
        full = os.path.join(root, path)
        if os.path.exists(full) or git_ignored(path, root):
            continue
        parent = os.path.dirname(full)
        if parent and os.path.exists(parent):
            problems.append(f"tree lists a path that does not exist: {path}")
    return problems


def check(facts: dict) -> list[str]:
    """README 与仓库事实对账；返回漂移清单（空 = 一致）。"""
    text = read(README)
    problems: list[str] = []

    # cron 表必须覆盖每个 Worker 声明的调度，且不能写不存在的调度
    table = {(worker, cron) for cron, worker in CRON_ROW.findall(text) if "*" in cron}
    for item in facts["wrangler"]:
        for cron in item["crons"]:
            if (item["dir"], cron) not in table:
                problems.append(f"cron table is missing: {cron} @ {item['dir']} ({item['name']})")
    known = {(item["dir"], cron) for item in facts["wrangler"] for cron in item["crons"]}
    for entry in sorted(table - known):
        problems.append(f"cron table lists an undeclared schedule: {entry[1]} @ {entry[0]}")

    # 保留期
    for table_name, days in facts["retention_days"].items():
        if not re.search(rf"`{table_name}`[^)\n]*\({days}d\)", text) and f"`{table_name}` ({days}d)" not in text:
            problems.append(f"retention table does not state {table_name} = {days}d")

    # 缓存头与 Vary：只校验**真的存在**的指令，缺的指令不要求文档写「=0」
    cache = facts["cache"]
    if f"max-age={cache['max_age']}" not in text:
        problems.append(f"cache header max-age={cache['max_age']} not stated")
    if cache["s_maxage"] is not None and f"s-maxage={cache['s_maxage']}" not in text:
        problems.append(f"cache header s-maxage={cache['s_maxage']} not stated")
    if cache["swr"] is not None and f"stale-while-revalidate={cache['swr']}" not in text:
        problems.append(f"cache header stale-while-revalidate={cache['swr']} not stated")
    if cache["s_maxage"] is None and "s-maxage" in text:
        problems.append("README states s-maxage but the page cache header has none")
    if cache["vary"] not in text:
        problems.append(f"Vary header '{cache['vary']}' not stated")

    # TTL / 超时
    ttl_hours = facts["gate_ttl_seconds"] // 3600
    if "1h TTL" not in text and f"({ttl_hours}h" not in text:
        problems.append(f"gate cookie TTL ({ttl_hours}h) not stated")
    timeout_s = facts["timeouts"]["siteverify_ms"] // 1000
    if f"{timeout_s}-second server-side timeout" not in text:
        problems.append(f"Turnstile {timeout_s}s server-side timeout not stated")
    jwks_hours = facts["timeouts"]["jwks_ms"] // 3_600_000
    if f"JWKS cached {jwks_hours}h" not in text:
        problems.append(f"JWKS cache ({jwks_hours}h) not stated")

    # 语言数
    count = len(facts["langs"])
    if f"{count} languages" not in text and f"in {count} language" not in text:
        problems.append(f"language count ({count}) not stated")

    # 目录树里的路径必须存在（判据见 tree_problems：被 .gitignore 排除的本机
    # 目录不计，否则本地有 secrets/ 时通过、CI 的干净 checkout 上必红）。
    problems.extend(tree_problems(BASE_DIR, tree_paths()))

    # 信任清单计数
    trust = facts["gate_trust"]
    if str(trust["asns"]) not in text or str(trust["ip_cidrs"]) not in text:
        problems.append(
            f"gate trust counts ({trust['asns']} ASNs / {trust['ip_cidrs']} IPs) not stated"
        )
    return problems


def live_facts() -> dict:
    """线上事实：D1 / Pages / Workers / DNS / WAF / IP List / cron。"""
    import urllib.error
    import urllib.request

    env_path = os.path.join(BASE_DIR, "secrets", "webauthn.env")
    for line in read(env_path).splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    token = os.environ["CLOUDFLARE_API_TOKEN"]

    def api(method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        last: Exception | None = None
        for _ in range(4):
            request = urllib.request.Request(
                f"https://api.cloudflare.com/client/v4{path}", data=data, method=method
            )
            request.add_header("Authorization", f"Bearer {token}")
            request.add_header("Content-Type", "application/json")
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    return json.loads(response.read())
            except urllib.error.HTTPError as exc:
                return {"success": False, "errors": [f"HTTP {exc.code}"]}
            except Exception as exc:  # 瞬时读错误重试
                last = exc
        return {"success": False, "errors": [str(last)]}

    def d1(sql: str):
        out = api("POST", f"/accounts/{account}/d1/database/{DB_ID}/query", {"sql": sql})
        if not out.get("success"):
            return {"error": out.get("errors")}
        return out["result"][0].get("results", [])

    facts: dict = {"d1": {}, "pages": {}, "workers": [], "dns": [], "waf": [], "lists": [], "crons": {}}
    for label, sql in [
        ("tables", "select count(*) n from sqlite_master where type='table'"),
        ("schema_version_rows", "select count(*) n from schema_version"),
        ("schema_versions", "select group_concat(version, ',') v from (select version from schema_version order by version)"),
        ("apple_accounts", "select count(*) n from apple_accounts"),
        ("blocked_ips_total", "select count(*) n from blocked_ips"),
        ("blocked_ips_active", "select count(*) n from blocked_ips where active=1"),
    ]:
        rows = d1(sql)
        if isinstance(rows, dict):
            facts["d1"][label] = rows
        elif rows:
            facts["d1"][label] = list(rows[0].values())[0]

    project = api("GET", f"/accounts/{account}/pages/projects/limooo")
    if project.get("success"):
        result = project["result"]
        facts["pages"] = {
            "name": result.get("name"),
            "subdomain": result.get("subdomain"),
            "domains": sorted(d if isinstance(d, str) else d.get("name", "?") for d in result.get("domains", [])),
            "secrets": sorted(
                ((result.get("deployment_configs") or {}).get("production") or {}).get("env_vars", {}).keys()
            ),
        }

    scripts = api("GET", f"/accounts/{account}/workers/scripts")
    if scripts.get("success"):
        facts["workers"] = sorted(item["id"] for item in scripts["result"])

    zone = api("GET", "/zones?name=limooo.cn")
    if zone.get("success") and zone["result"]:
        zone_id = zone["result"][0]["id"]
        records = api("GET", f"/zones/{zone_id}/dns_records?per_page=100")
        if records.get("success"):
            facts["dns"] = sorted(
                f"{r['name']} {r['type']} {r['content']} proxied={r['proxied']}" for r in records["result"]
            )
        for phase in ("http_request_firewall_custom", "http_request_cache_settings", "http_request_dynamic_redirect"):
            ruleset = api("GET", f"/zones/{zone_id}/rulesets/phases/{phase}/entrypoint")
            if ruleset.get("success"):
                for rule in ruleset["result"].get("rules") or []:
                    facts["waf"].append(
                        f"{phase}: enabled={rule.get('enabled')} action={rule.get('action')} {rule.get('description') or ''}"
                    )

    lists = api("GET", f"/accounts/{account}/rules/lists")
    if lists.get("success"):
        facts["lists"] = sorted(f"{entry.get('name')} ({entry.get('kind')})" for entry in lists["result"])
    for name in ("limooo-status", "limooo-blocklist-sync", "limooo-d1-archive"):
        schedules = api("GET", f"/accounts/{account}/workers/scripts/{name}/schedules")
        if schedules.get("success"):
            facts["crons"][name] = sorted(s["cron"] for s in schedules["result"].get("schedules", []))
    return facts


def print_live_facts(facts: dict) -> None:
    print("D1")
    for key, value in facts["d1"].items():
        print(f"  {key:<22} {value}")
    print("Pages")
    print(f"  {'project':<22} {facts['pages'].get('name')} ({facts['pages'].get('subdomain')})")
    print(f"  {'domains':<22} {', '.join(facts['pages'].get('domains', []))}")
    print(f"  {'production secrets':<22} {', '.join(facts['pages'].get('secrets', []))}")
    print("Workers")
    print(f"  {', '.join(facts['workers'])}")
    print("DNS (proxied records)")
    for record in facts["dns"]:
        if "proxied=True" in record:
            print(f"  {record}")
    print("WAF / cache rules")
    if facts["waf"]:
        for rule in facts["waf"]:
            print(f"  {rule}")
    else:
        print("  none")
    print(f"Lists\n  {', '.join(facts['lists']) or '-'}")
    print("Worker schedules")
    for name, crons in facts["crons"].items():
        print(f"  {name:<24} {', '.join(crons) or '-'}")


def main() -> int:
    check_only = "--check" in sys.argv
    as_json = "--json" in sys.argv
    facts = live_facts() if "--live" in sys.argv else repo_facts()
    if check_only and "--live" not in sys.argv:
        problems = check(facts)
        if problems:
            print("readme facts: FAIL")
            for problem in problems:
                print(f"  {problem}")
            return 1
        print("readme facts: OK (README matches the repository)")
        return 0
    if as_json:
        print(json.dumps(facts, ensure_ascii=False, indent=2, sort_keys=True))
    elif "--live" in sys.argv:
        print_live_facts(facts)
    else:
        print_repo_facts(facts)
    return 0


if __name__ == "__main__":
    sys.exit(main())
